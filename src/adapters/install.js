'use strict';
// Wires the robot into an agent's own hook system, so state comes from
// the agent itself rather than from guessing at its output.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const HOME = os.homedir();
// Our own entries are recognised by the hook script they point at, so uninstall
// still works if the checkout gets renamed or moved. `signalhead` stays in the
// pattern on purpose: someone upgrading from the old name must be able to
// disconnect the hooks it left behind.
const isOurs = (cmd) => /baoanlight|signalhead|src[\\/]+hooks[\\/]+(?:claude|codex|event|codebuddy)\.js/.test(String(cmd || ''));

const hookScript = (name) => path.join(ROOT, 'src', 'hooks', `${name}.js`).replace(/\\/g, '/');
const nodeBin = process.execPath.replace(/\\/g, '/');
const cmdFor = (name) => `"${nodeBin}" "${hookScript(name)}"`;
// 复用 claude.js 那份脚本（同一套 hook 协议），只是把 agent 标成 codebuddy。
const cmdForAgent = (agent) => `"${nodeBin}" "${hookScript('claude')}" --agent ${agent}`;

// Hook commands carry an absolute path to a script in this install. If that
// install is a working checkout, every hook invocation — and they fire on every
// tool call — executes a file inside it, which on Windows holds the folder open
// and makes it unrenameable. Worse, the hooks break silently the day the
// checkout moves. A global install lives somewhere stable and outside any
// project, which is where hook paths belong.
const isCheckout = () => fs.existsSync(path.join(ROOT, '.git'));

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const bak = `${file}.baoanlight-backup-${Date.now()}`;
  fs.copyFileSync(file, bak);
  // 反复 connect / disconnect 会在用户家目录里堆一串时间戳备份，而它们只是
  // 「上一次改动前长什么样」。留最近 5 份足够回滚，也不会把 ~/.claude 塞满。
  try {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.baoanlight-backup-`;
    const olds = fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).sort();
    while (olds.length > 5) {
      try { fs.unlinkSync(path.join(dir, olds.shift())); } catch { /* 删不掉就留着 */ }
    }
  } catch { /* 清理是礼貌，不是职责 */ }
  return bak;
}

// 读不出来就**不要写**。
//
// 这里原来把「解析失败」和「读不到」一律降级成 `{}`，随后 writeJson 把 `{}`
// 连同我们的 hooks 一起写回去 —— 用户的 permissions / env / model 全没了，
// 只留下一句「备份在 xxx」。一次权限抖动、或者 Claude Code 自己正在写这个
// 文件，就足以触发。
function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};   // 真的还没有这个文件
    throw new Error(`cannot read ${file} (${err.code || err.message}); refusing to overwrite it`);
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}); refusing to overwrite it`);
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

// ---------------------------------------------------------------- Claude Code

// SubagentStop 刻意不在列表里：它总在 Stop 之后几秒才到，映射成 busy 会把刚
// 变绿的灯重新点亮，映射成别的又没有任何信息量。hooks/claude.js 已经把它列入
// IGNORED —— 装一个只会空转的钩子（每次子代理结束都起一个 node 进程）不是
// 「更全」，是让用户多付一份启动开销。
const CLAUDE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'PreCompact',
  'SessionEnd',
];
const NEEDS_MATCHER = new Set(['PreToolUse', 'PostToolUse', 'PreCompact']);

function claudeSettingsPath(scope) {
  return scope === 'project'
    ? path.join(process.cwd(), '.claude', 'settings.json')
    : path.join(HOME, '.claude', 'settings.json');
}

function stripOurs(groups = []) {
  return groups
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h.command)) }))
    .filter((g) => (g.hooks || []).length > 0);
}

function installClaude({ scope = 'user' } = {}) {
  const file = claudeSettingsPath(scope);
  const bak = backup(file);
  const settings = readJson(file);
  settings.hooks = settings.hooks || {};

  for (const event of CLAUDE_EVENTS) {
    const existing = stripOurs(settings.hooks[event] || []);
    const entry = { hooks: [{ type: 'command', command: cmdFor('claude'), timeout: 5 }] };
    if (NEEDS_MATCHER.has(event)) entry.matcher = '*';
    settings.hooks[event] = [...existing, entry];
  }

  writeJson(file, settings);
  return { file, backup: bak, events: CLAUDE_EVENTS.length, fromCheckout: isCheckout(), root: ROOT };
}

function uninstallClaude({ scope = 'user' } = {}) {
  const file = claudeSettingsPath(scope);
  if (!fs.existsSync(file)) return { file, removed: 0 };
  const settings = readJson(file);
  let removed = 0;

  for (const event of Object.keys(settings.hooks || {})) {
    const before = JSON.stringify(settings.hooks[event]);
    const after = stripOurs(settings.hooks[event]);
    if (JSON.stringify(after) !== before) removed++;
    if (after.length) settings.hooks[event] = after;
    else delete settings.hooks[event];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

  // 什么都没卸掉就别动这个文件：重排一次用户的 JSON、改掉缩进、再留一份备份，
  // 只是白改。
  if (!removed) return { file, backup: null, removed: 0 };
  // 备份放在真正要写之前：它保存的是「改之前」的那份。
  const bak = backup(file);
  writeJson(file, settings);
  return { file, backup: bak, removed };
}

// --------------------------------------------------------------------- Codex

function codexConfigPath() {
  return path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'config.toml');
}

// `notify` 在 TOML 里只能有一个。可能被格式化成多行数组，所以按「括号配平」
// 而不是按行来裁 —— 只删第一行会在文件里留下没人认领的 `"..."`，整个
// config.toml 从此是非法 TOML，Codex 直接起不来。
const NOTIFY_RE = /^\s*notify\s*=/;
const bracketDelta = (line) => (line.match(/\[/g) || []).length - (line.match(/\]/g) || []).length;

function stripNotify(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!NOTIFY_RE.test(lines[i])) { out.push(lines[i]); continue; }
    if (!isOurs(lines[i])) { out.push(lines[i]); continue; }
    let depth = bracketDelta(lines[i]);
    while (depth > 0 && i + 1 < lines.length) { i++; depth += bracketDelta(lines[i]); }
  }
  return out;
}

function installCodex() {
  const file = codexConfigPath();
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const notify = `notify = ["${nodeBin}", "${hookScript('codex')}"]`;

  // 用户自己已经配了 notify？那我们不能悄悄吃掉它——一个已有通知钩子的
  // 人，正在用的可能是桌面提醒或他自己的脚本。告诉他，让他决定。
  const foreign = existing.split(/\r?\n/).find((l) => NOTIFY_RE.test(l) && !isOurs(l));
  if (foreign) {
    // 还没有动过文件，就不要留备份：跳过时也备份，会让反复尝试 `bao connect
    // codex` 的用户在每个目录里攒下一堆时间戳副本。
    return { file, backup: null, skipped: true, foreign: foreign.trim() };
  }
  const bak = backup(file);

  // `notify` is a top-level key, so it has to sit above the first [table] header.
  const lines = stripNotify(existing.split(/\r?\n/));
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  if (firstTable === -1) lines.push(notify);
  else lines.splice(firstTable, 0, notify, '');

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n').replace(/\n{3,}/g, '\n\n').trimStart() + '\n');
  return { file, backup: bak, fromCheckout: isCheckout(), root: ROOT };
}

function uninstallCodex() {
  const file = codexConfigPath();
  if (!fs.existsSync(file)) return { file, removed: 0 };
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const kept = stripNotify(lines);
  // 没有可删的东西就别备份：否则「本来就没装」的一次调用也会留下副本。
  if (kept.length === lines.length) return { file, removed: 0 };
  const bak = backup(file);
  fs.writeFileSync(file, kept.join('\n'));
  return { file, backup: bak, removed: lines.length - kept.length };
}

// ------------------------------------------------------------------- Generic

// For agents with no hook system and no need for a full wrapper: print the two
// commands to drop into whatever start/finish hook the tool does offer.
function genericSnippet(agent = 'my-agent') {
  const cli = path.join(ROOT, 'src', 'cli.js').replace(/\\/g, '/');
  const set = (state) => `"${nodeBin}" "${cli}" set ${state} --agent ${agent}`;
  return [
    '# when the agent starts working',
    set('busy'),
    '',
    '# when it needs a human',
    set('waiting'),
    '',
    '# when it finishes a turn',
    set('idle'),
    '',
    `# if \`bao\` is on PATH (npm install -g baoanlight), this is shorter:`,
    `bao set waiting --agent ${agent} --detail "needs you"`,
    '',
    '# or straight over HTTP, from anything at all (writes need the local token):',
    "$h = @{ 'x-bao-token' = (bao token) }",
    `Invoke-RestMethod -Headers $h "http://127.0.0.1:4747/set/busy?agent=${agent}&session=manual"`,
  ].join('\n');
}

// The command to paste into an agent that can run a shell command on each
// lifecycle event. Same script, but it reads the event on stdin.
function hookCommand(agent = 'my-agent') {
  return `"${nodeBin}" "${hookScript('event')}" --agent ${agent}`;
}

// MCP is the "agents pull and push through one protocol" route. Any MCP client
// points at this stdio server. Paths are normalised to forward slashes so the
// same snippet works in JSON (Claude Code) and TOML (Codex).
function mcpSnippet() {
  const script = path.join(ROOT, 'src', 'mcp-server.js').replace(/\\/g, '/');
  const launch = `"${nodeBin}" "${script}"`;
  const claudeJson = JSON.stringify({
    mcpServers: { baoanlight: { command: nodeBin, args: [script] } },
  }, null, 2);
  return [
    `MCP server (stdio): ${launch}`,
    '',
    '-- Claude Code ----------------------------------------------------------',
    '# one line, then restart Claude Code:',
    `claude mcp add baoanlight -- "${nodeBin}" "${script}"`,
    '',
    '# or drop this into .mcp.json (project) / ~/.claude.json (user):',
    claudeJson,
    '',
    '-- Codex ----------------------------------------------------------------',
    '# add to ~/.codex/config.toml (or $CODEX_HOME/config.toml):',
    '[mcp_servers.baoanlight]',
    `command = "${nodeBin}"`,
    `args = ["${script}"]`,
    '',
    '-- DeepSeek Harness / WorkBuddy / anything else -------------------------',
    '# any MCP client that speaks stdio: run this command, then call:',
    '#   report_status(agent, state, detail?)   push a state in',
    '#   get_agents_status()                    read every agent\'s state',
    launch,
  ].join('\n');
}

// How many of our hook entries are live, so the CLI can tell a fresh install
// from a wired-up one and give the right next step.
// "Configured" is not the same as "working": a hook can point at a script from
// an older install or another machine, and then it is just a dead line in a
// settings file. Counting those as connected made `bao start` end with a green
// "Claude Code is connected" while nothing would ever arrive.
function hookScriptExists(command) {
  const quoted = String(command || '').match(/"[^"]+\.js"/g) || [];
  const script = quoted.map((q) => q.slice(1, -1)).find((p) => /hooks[\\/]/.test(p));
  if (!script) return true;   // unparsable: do not claim it is broken
  try { return fs.existsSync(script); } catch { return false; }
}

function claudeHookCount(scope = 'user') {
  try {
    const settings = readJson(claudeSettingsPath(scope));
    return Object.values(settings.hooks || {})
      .flat()
      .flatMap((g) => g.hooks || [])
      .filter((h) => isOurs(h.command) && hookScriptExists(h.command)).length;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------- CodeBuddy
//
// CodeBuddy（与 WorkBuddy 同源）跑的是 Claude Code 那套 hook 协议：settings.json
// 里一个 `hooks` 对象，每个事件下是 `[{ matcher, hooks: [{ type, command }] }]`。
// 为什么需要它：CodeBuddy 的 transcript 只在**一轮结束**时才落盘，中途看不到绿灯；
// hook 是实时的（它自己那份 .wb-switch 就是靠 hook 收事件的）。
//
// 事件名用 Claude 那套；CodeBuddy 不认识的会被忽略（不会被调用，也不会报错），
// 所以多注册几个是安全的 —— 少注册一个，那一类变化就永远看不见。
const CODEBUDDY_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'FinalStop',
  'SessionEnd',
];

function codebuddySettingsPath() {
  return path.join(HOME, '.codebuddy', 'settings.json');
}

function installCodebuddy() {
  const file = codebuddySettingsPath();
  const bak = backup(file);
  const settings = readJson(file);
  settings.hooks = settings.hooks || {};

  for (const event of CODEBUDDY_EVENTS) {
    // 保留别人的 hook（这台机器上 .wb-switch 就在用同一份文件），只替换我们自己的。
    const existing = stripOurs(settings.hooks[event] || []);
    settings.hooks[event] = [
      ...existing,
      { matcher: '', hooks: [{ type: 'command', command: cmdForAgent('codebuddy') }] },
    ];
  }

  writeJson(file, settings);
  return {
    file,
    backup: bak,
    events: CODEBUDDY_EVENTS.length,
    fromCheckout: isCheckout(),
    root: ROOT,
    // hook 表是 CodeBuddy 启动时读的：已经开着的窗口要重启一次才会生效。
    needsRestart: true,
  };
}

function uninstallCodebuddy() {
  const file = codebuddySettingsPath();
  if (!fs.existsSync(file)) return { file, removed: 0, backup: null };
  const settings = readJson(file);
  let removed = 0;

  for (const event of Object.keys(settings.hooks || {})) {
    const before = JSON.stringify(settings.hooks[event]);
    const after = stripOurs(settings.hooks[event]);
    if (JSON.stringify(after) !== before) removed++;
    if (after.length) settings.hooks[event] = after;
    else delete settings.hooks[event];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  if (!removed) return { file, removed: 0, backup: null };

  const bak = backup(file);
  writeJson(file, settings);
  return { file, removed, backup: bak, needsRestart: true };
}

function codebuddyHookCount() {
  try {
    const settings = readJson(codebuddySettingsPath());
    return Object.values(settings.hooks || {})
      .flat()
      .flatMap((g) => g.hooks || [])
      .filter((h) => isOurs(h.command) && hookScriptExists(h.command)).length;
  } catch {
    return 0;
  }
}

module.exports = {
  isCheckout,
  claudeHookCount,
  installClaude,
  uninstallClaude,
  installCodebuddy,
  uninstallCodebuddy,
  codebuddySettingsPath,
  codebuddyHookCount,
  installCodex,
  uninstallCodex,
  genericSnippet,
  hookCommand,
  mcpSnippet,
  claudeSettingsPath,
  codexConfigPath,
};
