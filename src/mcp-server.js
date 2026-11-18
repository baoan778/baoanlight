#!/usr/bin/env node
'use strict';
// bao mcp — the desktop robot as a Model Context Protocol server.
//
// Any MCP client (Claude Code, Codex, DeepSeek Harness, WorkBuddy, …) can point
// at this server and call two tools:
//
//   report_status      the agent tells the robot what it is doing right now
//   get_agents_status  the agent asks the robot what every agent is doing
//
// This is the "pull" side of the machine: hooks and log watchers push state in
// from the outside, and this server lets the agents themselves reach in and
// both read and write it through the one protocol they all already speak.
//
// Transport is stdio, so each client spawns its own instance:
//
//   node src/mcp-server.js
//
// The server talks to the running robot over its HTTP API (127.0.0.1:<port>),
// which must already be up (`bao start`). If it is not, report_status degrades
// to a no-op and get_agents_status reports that nothing is listening.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const config = require('./config');
const auth = require('./auth');

// MCP 是 agent 自己拉起的进程，读不到 `bao start --port` 的环境变量 ——
// runningPort() 会接着读运行中服务端写下的端口文件。
const PORT = Number(process.env.BAOANLIGHT_PORT) || config.runningPort() || 4747;
const BASE = `http://127.0.0.1:${PORT}`;

// The robot's state vocabulary. Anything else is rejected, not guessed — a
// wrong colour is worse than no colour.
const STATES = ['busy', 'waiting', 'error', 'done', 'idle', 'offline'];
// 已知的四个只是「建议值」，不是白名单：MCP 的意义就是任何客户端都能上报，
// 硬编码四个 id 会把 `my-bot` 这类自研代理挡在门外，而 `bao hook` 是接受的。
const KNOWN_AGENTS = ['claude', 'codex', 'deepseek', 'workbuddy'];
const AGENT_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/i;

function writeErrorHint(err) {
  const msg = String((err && err.message) || err);
  if (/replied 401|replied 403/.test(msg)) {
    return 'the robot refused the write (token mismatch) — run `bao doctor`, or `bao stop && bao start`';
  }
  return `Robot not reachable at ${BASE} (is \`bao start\` running?)`;
}

// 上报通道不能比别的通道更“黏”：钩子走 client.js 是 1200ms 超时就放弃，而 MCP
// 之前只靠 undici 默认的数百秒 —— 服务端卡住时，agent 的工具调用会一直挂着，
// 看起来像它自己死机了。1.5 秒足够，超时就按「机器人没响应」返回给模型。
const MCP_TIMEOUT_MS = 1500;

async function postJson(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    // 写接口要证明「我在这台机器上」：token 与钩子读的是同一个文件。
    headers: { 'content-type': 'application/json', 'x-bao-token': auth.token() },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`robot replied ${res.status}`);
  return res.json();
}

async function getJson(path) {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(MCP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`robot replied ${res.status}`);
  return res.json();
}

const server = new McpServer(
  { name: 'baoanlight', version: require('../package.json').version },
  { capabilities: { tools: {} } },
);

server.registerTool('report_status', {
  title: 'Report AI agent status',
  description:
    'Tell the desktop robot what this AI agent is doing right now. ' +
    'Call it at meaningful moments: when a task starts (busy), when it needs ' +
    'the user (waiting), when something failed (error), when it finished (done), ' +
    'and when it goes quiet (idle).',
  inputSchema: {
    agent: z.string().describe(`Agent id. Common: ${KNOWN_AGENTS.join(', ')}; any short id is accepted`),
    state: z.enum(STATES).describe('The state to report'),
    detail: z.string().optional().describe('One short line of context'),
    cwd: z.string().optional().describe('Project folder name'),
  },
}, async (args) => {
  const agent = String(args.agent || '').trim().toLowerCase();
  if (!AGENT_RE.test(agent)) {
    return {
      content: [{ type: 'text', text: `Invalid agent "${args.agent}". Use a short id (letters, digits, . _ -), e.g. claude, codex, ${KNOWN_AGENTS.join(', ')}, my-bot.` }],
      isError: true,
    };
  }
  if (!STATES.includes(args.state)) {
    return { content: [{ type: 'text', text: `Unknown state "${args.state}". Use one of: ${STATES.join(', ')}.` }], isError: true };
  }
  try {
    await postJson(`/set/${args.state}`, {
      agent,
      state: args.state,
      detail: args.detail || '',
      cwd: args.cwd || '',
      session: `mcp:${agent}`,
      source: 'mcp',
      event: 'set_state',
    });
    return { content: [{ type: 'text', text: `Reported ${agent} as ${args.state}.` }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `${writeErrorHint(err)} ${err.message}` }], isError: true };
  }
});

server.registerTool('get_agents_status', {
  title: 'Read all AI agent statuses',
  description:
    'Ask the desktop robot what every AI agent is doing. Returns each agent\'s ' +
    'current state (busy / waiting / error / done / idle / offline) plus the ' +
    'aggregate worst state, so one agent can see whether another is blocked.',
  inputSchema: {},
}, async () => {
  try {
    const snap = await getJson('/state');
    const slots = (snap.slots || [])
      .filter((s) => s.count > 0)
      .map((s) => `${s.agent}: ${s.state}${s.detail ? ` (${s.detail})` : ''}`);
    const lines = slots.length ? slots : ['no agents reporting'];
    const text = [
      `overall: ${snap.overall || 'offline'}`,
      ...lines,
    ].join('\n');
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `${writeErrorHint(err)} ${err.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // A broken stdio pipe must never hang the agent that spawned us.
  process.stderr.write(`bao mcp: ${err && err.message}\n`);
  process.exit(1);
});
