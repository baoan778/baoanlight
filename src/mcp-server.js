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

const PORT = Number(process.env.BAOANLIGHT_PORT) || config.port() || 4747;
const BASE = `http://127.0.0.1:${PORT}`;

// The robot's state vocabulary. Anything else is rejected, not guessed — a
// wrong colour is worse than no colour.
const STATES = ['busy', 'waiting', 'error', 'done', 'idle', 'offline'];
const AGENTS = ['claude', 'codex', 'deepseek', 'workbuddy'];

async function postJson(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`robot replied ${res.status}`);
  return res.json();
}

async function getJson(path) {
  const res = await fetch(BASE + path);
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
    agent: z.string().describe('Agent id: claude, codex, deepseek or workbuddy'),
    state: z.enum(STATES).describe('The state to report'),
    detail: z.string().optional().describe('One short line of context'),
    cwd: z.string().optional().describe('Project folder name'),
  },
}, async (args) => {
  const agent = String(args.agent || '').toLowerCase();
  if (!AGENTS.includes(agent)) {
    return { content: [{ type: 'text', text: `Unknown agent "${args.agent}". Use one of: ${AGENTS.join(', ')}.` }], isError: true };
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
    });
    return { content: [{ type: 'text', text: `Reported ${agent} as ${args.state}.` }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Robot not reachable at ${BASE} (is \`bao start\` running?). ${err.message}` }], isError: true };
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
    return { content: [{ type: 'text', text: `Robot not reachable at ${BASE} (is \`bao start\` running?). ${err.message}` }], isError: true };
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
