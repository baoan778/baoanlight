#!/usr/bin/env node
'use strict';

const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const config = require('./config');
const client = require('./client');
const install = require('./adapters/install');
const agents = require('./adapters/agents');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- arg parsing

function parse(argv) {
  const flags = {};
  const positional = [];
  const rest = [];
  let afterDoubleDash = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (afterDoubleDash) { rest.push(a); continue; }
    if (a === '--') { afterDoubleDash = true; continue; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      // 只把 `--` 开头的下一个参数当成另一个选项：`--detail -1`、`--agent -x`
      // 这类负值/短横线开头的值曾经被静默吞成布尔 true。
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { flags, positional, rest };
}

// -------------------------------------------------------------------- output

const c = process.stdout.isTTY
  ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`, yel: (s) => `\x1b[33m${s}\x1b[0m`, grn: (s) => `\x1b[32m${s}\x1b[0m` }
  : { dim: (s) => s, b: (s) => s, red: (s) => s, yel: (s) => s, grn: (s) => s };

// Same colours as the robot, in the same order of alarm. `idle` is green too,
// dimmed — alive but not working, which is a different thing from running.
const DOT = {
  error: () => c.red('●'),
  waiting: () => c.yel('●'),
  busy: () => c.grn('●'),
  done: () => c.grn('○'),
  idle: () => c.dim('●'),
  unknown: () => c.dim('◐'),
  offline: () => c.dim('○'),
};

// Windows consoles default to a legacy code page (936 on Chinese systems), so
// the UTF-8 bytes this CLI writes render as "鈼?" instead of the dots above.
// Switching the console to 65001 fixes it for every run that follows. Only do
// it for an interactive terminal: piped output must stay raw bytes.
function enableUtf8Console() {
  if (process.platform !== 'win32' || !process.stdout.isTTY) return;
  try {
    const out = execFileSync('chcp.com', [], { encoding: 'utf8', timeout: 1500, windowsHide: true });
    const page = (out.match(/(\d{3,5})/) || [])[1];
    if (page && page !== '65001') {
      execFileSync('chcp.com', ['65001'], { stdio: 'ignore', timeout: 1500, windowsHide: true });
    }
  } catch {
    // No chcp, locked-down console, whatever: keep going with the old code
    // page rather than failing a status command over typography.
  }
}

function usage() {
  console.log(`
${c.b('baoanlight')} — a small tracked robot that sits on your desktop and shows
what every AI coding agent is doing.

  ${c.grn('●')} green   an agent is working (bright) or finished (dim)
  ${c.yel('●')} yellow  an agent stopped and needs you (permission, question, choice)
  ${c.red('●')} red     a run failed or is blocked

${c.b('USAGE')}
  bao start                    start it in the background and hand the prompt back
  bao start --foreground       keep it attached to this terminal (Ctrl+C to stop)
  bao server                   state server only (no robot window)
  bao overlay                  robot window only (server must already run)
  bao stop                     shut everything down

  bao connect claude           wire into Claude Code hooks   ${c.dim('(exact)')}
  bao connect codex            wire into Codex notify        ${c.dim('(red + green)')}
  bao connect generic          print snippets for any other tool
  bao disconnect claude|codex  remove those again

  bao wrap -- <command>        run any agent in a watched terminal
                               ${c.dim('e.g. bao wrap -- gemini')}

  bao watch codex              read Codex's own session logs      ${c.dim('(all 3 states)')}
  bao watch deepseek           read DeepSeek Harness projections  ${c.dim('(all 3 states)')}
  bao watch workbuddy          read WorkBuddy's task board
  bao watch all                run every log-based watcher at once
                               ${c.dim('codex + deepseek + workbuddy')}
  bao watch <agent> --dir <p>  point the watcher at that agent's folder
                               ${c.dim('--jsonl forces the generic JSONL reader')}

  bao hook --agent <name>      generic hook: reads one JSON event on stdin
  bao agents                   list every agent and how it connects

  bao mcp                      run the robot as an MCP server (stdio transport)
                               ${c.dim('agents call report_status / get_agents_status')}

  bao set <busy|waiting|error|idle|unknown|offline> [--agent name] [--session id] [--detail text]
  bao fuel <percent> [--used] [--agent name] [--label text]
                               drive the fuel gauge from anything
  bao status                   print current states
  bao status --json            same, as JSON, for scripts and overlays
  bao token                    print the local write token (for curl / scripts)
  bao clear [--session id]     forget sessions left behind by a crashed agent
  bao setup                    download the Electron runtime for the window
  bao autostart on|off|status  start the robot at login (all platforms)
  bao onboard                  first-run guide: detect agents and connect one
  bao doctor                   check this machine is wired up correctly
  bao demo                     cycle the states to check the robot animates
  bao log                      print recent events (state changes, refused writes)

${c.b('OPTIONS')}
  --port <n>       server port (default ${config.DEFAULTS.port})
  --scope project  install hooks into ./.claude instead of ~/.claude
  --agent <name>   label shown next to the robot
  --dir <path>     for \`watch\`: where that agent keeps its session logs
  --no-overlay     for \`start\`: server only
  --browser        for \`start\`: open the robot in a browser tab instead of a window
`);
}

// ------------------------------------------------------------------ commands

async function cmdServer(flags, { detached = false } = {}) {
  const { start } = require('./server');
  const port = Number(flags.port) || config.port();

  let bound;
  try {
    ({ port: bound } = await start({ port }));
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`${c.red('●')} port ${port} is already in use.`);
      console.error(c.dim('  baoanlight may already be running:  bao status'));
      console.error(c.dim(`  or pick another port:               bao start --port ${port + 1}`));
      process.exit(1);
    }
    throw err;
  }
  if (!detached) console.log(`${c.grn('●')} server listening on http://127.0.0.1:${bound}`);
  return bound;
}

function spawnOverlay(port) {
  let electron;
  try {
    electron = require('electron');
  } catch {
    return null;
  }
  // Deliberately NOT the install directory. A process's working directory is an
  // open handle to that folder, and on Windows that makes it unrenameable and
  // undeletable for as long as the robot runs — which surfaces to the user as
  // "the file is in use by another application" from whatever else touches the
  // folder next. Nothing here needs the project cwd: the entry point is passed
  // as an absolute path and everything else resolves from __dirname or $HOME.
  const child = spawn(String(electron), [path.join(ROOT, 'src', 'overlay', 'main.js')], {
    cwd: os.tmpdir(),
    env: { ...process.env, BAOANLIGHT_PORT: String(port), ELECTRON_NO_ATTACH_CONSOLE: '1' },
    stdio: 'ignore',
    detached: false,
  });
  child.on('error', () => {});
  return child;
}

// `bao start` detaches by default: a desk robot should not hold a shell
// hostage, and closing that terminal should not take the robot down.
async function cmdStartDetached(flags) {
  const port = Number(flags.port) || config.port();

  const running = await client.health();
  if (running && (running.clients > 0 || flags['no-overlay'])) {
    console.log(`${c.dim('already running on port ' + running.port)}`);
    console.log(c.dim('  stop it with:  bao stop'));
    return;
  }

  // A server with no robot attached is not a desk robot — you closed the
  // window and the state kept flowing to nobody.
  if (running) {
    console.log(c.dim('server already running — opening the robot'));
    return cmdOverlay(flags);
  }

  const args = [path.join(ROOT, 'src', 'cli.js'), 'start', '--foreground', '--port', String(port)];
  if (flags['no-overlay']) args.push('--no-overlay');
  if (flags.browser) args.push('--browser');

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    cwd: os.tmpdir(),
    windowsHide: true,
  });
  child.unref();

  // Do not claim success before it is listening — a premature "it's up" would
  // be a lie. How long to allow depends on whether the window runtime has to be
  // fetched first, which is minutes on a cold cache and seconds otherwise.
  let hasRuntime = true;
  try { require('electron'); } catch { hasRuntime = false; }
  if (!hasRuntime) console.log(c.dim('  fetching the window runtime, once — this can take a minute…'));

  const budgetMs = hasRuntime ? 20_000 : 180_000;
  const deadline = Date.now() + budgetMs;
  let up = null;
  while (Date.now() < deadline) {
    up = await client.health();
    if (up) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  if (!up) {
    console.error(`${c.red('●')} it did not come up within ${Math.round(budgetMs / 1000)}s.`);
    console.error(c.dim('  run it attached to see the error:  bao start --foreground'));
    process.exitCode = 1;
    return;
  }

  console.log(`${c.grn('●')} baoanlight is running in the background.`);
  console.log(c.dim('  drag the robot anywhere; hover it for controls'));
  console.log('');
  await printSelfCheck(port);
  printNextStep();
}

// The robot shows nothing until an agent reports to it. Ending `start` with
// "stop it with: bao stop" told people how to quit something they had not
// finished setting up — so say what the actual next step is, and only say it
// when it is still outstanding.
function printNextStep() {
  const connected = install.claudeHookCount('user') > 0 || install.claudeHookCount('project') > 0;

  if (connected) {
    console.log(`${c.grn('✓')} Claude Code is connected — the robot wakes on your next message.`);
    console.log(c.dim('  bao status   what the robot says right now'));
    console.log(c.dim('  bao stop     quit'));
    return;
  }

  console.log(`${c.yel('→')} Nothing is connected yet, so the robot will stay asleep.`);
  console.log('  Connect an agent:');
  console.log(`    ${c.b('bao connect claude')}     ${c.dim('Claude Code')}`);
  console.log(`    ${c.b('bao watch codex')}        ${c.dim('Codex (leave it running)')}`);
  console.log(`    ${c.b('bao watch deepseek')}     ${c.dim('DeepSeek Harness')}`);
  console.log(`    ${c.b('bao watch workbuddy')}    ${c.dim('WorkBuddy')}`);
  console.log(`    ${c.b('bao wrap -- gemini')}     ${c.dim('Gemini, Aider, or any other CLI')}`);
  console.log('');
  console.log(c.dim('  bao agents   everything that is supported'));
  console.log(c.dim('  bao stop     to quit'));
}

// 启动自检：server 启动时已跑过，这里只把结果念一遍（只念有问题的）。
async function printSelfCheck(port) {
  let sc = null;
  try { sc = await client.get('/selfcheck'); } catch { return; }
  if (!sc || !Array.isArray(sc.checks) || !sc.checks.length) return;
  const fails = sc.checks.filter((x) => x.status === 'fail');
  const warns = sc.checks.filter((x) => x.status === 'warn');
  if (!fails.length && !warns.length) {
    console.log(`${c.grn('✓')} 自检通过（${sc.checks.length} 项全绿）`);
    return;
  }
  if (fails.length) {
    console.log(`${c.red('●')} 自检发现 ${fails.length} 个问题：`);
    for (const f of fails) {
      console.log(`    ${c.red('✖')} ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
      if (f.fix) console.log(`      ${c.dim('-> ' + f.fix)}`);
    }
  }
  if (warns.length) {
    console.log(`${c.yel('○')} 自检有 ${warns.length} 个可选项缺失（不影响运行）：`);
    for (const w of warns) console.log(`    ${c.dim(w.name + (w.detail ? ' — ' + w.detail : ''))}`);
  }
  console.log(c.dim('  bao doctor  完整体检'));
}

async function cmdStart(flags) {
  const port = Number(flags.port) || config.port();

  const running = await client.health();
  if (running) {
    console.log(`${c.dim('server already running on port ' + running.port)}`);
  } else {
    await cmdServer({ port });
  }

  // Same reason as the overlay's cwd: this process outlives the command that
  // started it, so it must not sit holding the directory it was launched from.
  // Everything the server serves resolves from __dirname.
  const hold = () => {
    try { process.chdir(os.tmpdir()); } catch { /* not fatal, just keeps the lock */ }
    return new Promise(() => {});
  };
  if (flags['no-overlay']) {
    console.log('');
    await printSelfCheck(port);
    printNextStep();
    return hold();
  }

  if (flags.browser) {
    const url = `http://127.0.0.1:${port}/`;
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [url], { shell: process.platform === 'win32', stdio: 'ignore' }).on('error', () => {});
    console.log(`robot in browser: ${url}`);
    return hold();
  }

  let child = spawnOverlay(port);

  // Upgrading with `npm i -g` replaces node_modules, and npm 11 blocks
  // Electron's postinstall — so the runtime disappears on every upgrade and the
  // window silently stops appearing. Fetch it rather than leaving the user to
  // work out that `bao setup` exists. The archive is cached after the first
  // time, so this is usually a quick unpack.
  if (!child) {
    console.log(`${c.yel('!')} the window runtime is missing — fetching it now`);
    const setup = require('child_process').spawnSync(
      process.execPath, [path.join(ROOT, 'scripts', 'setup.js')], { stdio: 'inherit' });
    if (setup.status === 0) child = spawnOverlay(port);
  }

  if (!child) {
    console.log(`${c.yel('!')} could not start the robot window.`);
    console.log(`  ${c.dim('run')} bao setup  ${c.dim('to install it, or')} bao start --browser`);
    console.log(c.dim(`  the server is still running on http://127.0.0.1:${port}`));
    return hold();
  }

  console.log(`${c.grn('●')} robot up. Drag it anywhere; hover for controls.`);
  console.log(c.dim(`  server  http://127.0.0.1:${port}`));
  console.log(c.dim('  stop    Ctrl+C here, or `bao stop` from another terminal'));
  console.log('');
  await printSelfCheck(port);
  printNextStep();

  // Take the window down with us, rather than leaving an orphan holding files.
  // Killing the parent does not kill the child on Windows.
  const shutdown = () => { try { child.kill(); } catch {} };
  process.on('exit', shutdown);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { shutdown(); process.exit(0); });
  child.on('exit', () => process.exit(0));

  try { process.chdir(os.tmpdir()); } catch { /* see hold() */ }
}

async function cmdOverlay(flags) {
  const running = await client.health();
  if (!running) {
    console.error(`${c.red('●')} no server on port ${Number(flags.port) || config.runningPort()}. Run: bao start`);
    process.exit(1);
  }
  // 用服务端**自报**的端口开窗口：它可能和配置端口不同（`--port 5000`、`port: 0`）。
  // 用配置端口算的话，overlay 会连一个不存在的地址，然后静默退出。
  const port = Number(running.port) || Number(flags.port) || config.runningPort();
  const child = spawnOverlay(port);
  if (!child) {
    console.error('Electron is not installed. Run `npm install` here, or `bao start --browser`.');
    process.exit(1);
  }
  child.on('exit', (code) => process.exit(code || 0));
}

// 打印本机写入 token。`curl`、脚本、第二屏要用它证明「我是这台机器上的用户」；
// 它本来就存在 0600 的文件里，打印出来不会让权限变宽。
function cmdToken() {
  console.log(require('./auth').token());
}

async function cmdStop() {
  const running = await client.health();
  if (!running) return console.log(c.dim('nothing running'));
  // 「stopped」必须等价于「它真的停了」：401、超时、连接被拒都返回 null，
  // 以前照样打印 stopped —— 用户以为关了，机器人还在桌面上跑。
  const r = await client.quitServer();
  if (!r || !r.ok) {
    console.error(`${c.red('●')} stop failed — the server did not confirm. It is probably still running.`);
    console.error(c.dim('  check the token:  bao token  ·  or end the process manually'));
    process.exitCode = 1;
    return;
  }
  console.log('stopped');
}

function cmdAutostart(positional) {
  const autostart = require('./autostart');
  const action = String(positional[0] || 'status').toLowerCase();

  if (action === 'on' || action === 'install' || action === 'enable') {
    const file = autostart.install();
    console.log(`${c.grn('●')} 开机自启已开启`);
    console.log(c.dim(`  ${file}`));
    return;
  }
  if (action === 'off' || action === 'remove' || action === 'disable' || action === 'uninstall') {
    const r = autostart.uninstall();
    console.log(r.removed ? `${c.grn('●')} 开机自启已关闭` : c.dim('  开机自启本来就是关的'));
    return;
  }
  if (action !== 'status') {
    console.error('usage: bao autostart on|off|status');
    process.exit(1);
  }
  const s = autostart.status();
  console.log(s.enabled ? `${c.grn('●')} 开机自启：已开启` : `${c.dim('○')} 开机自启：已关闭`);
  console.log(c.dim(`  ${s.file}`));
}

async function cmdSet(positional, flags) {
  const state = positional[0];
  if (!state) { console.error('usage: bao set <busy|waiting|error|idle|unknown|offline>'); process.exit(1); }
  const res = await client.setState({
    state,
    agent: flags.agent || 'agent',
    session: flags.session || `${flags.agent || 'agent'}:manual`,
    detail: flags.detail || '',
    cwd: flags.cwd || '',
  });
  if (!res) {
    console.error(c.dim('(no server listening — start it with `bao start`)'));
    return;
  }
  if (res.error) {
    console.error(`${c.red('●')} ${res.error}`);
    process.exitCode = 1;
  }
}

async function cmdFuel(positional, flags) {
  const raw = Number(positional[0]);
  if (!Number.isFinite(raw)) {
    console.error('usage: bao fuel <percent-remaining> [--used] [--agent name] [--label text]');
    process.exit(1);
  }
  // --used lets a reporter that counts consumption skip the arithmetic.
  const remaining = flags.used ? 100 - raw : raw;
  const agent = flags.agent || 'agent';
  const res = await client.setState({
    session: flags.session || `${agent}:manual`,
    agent,
    fuel: { remaining, label: flags.label || 'remaining' },
    // 人手敲的「这个软件额度是这个数」：允许它建一格会话。watcher 顺带读到的
    // 额度不带这个标记，否则一条迟到的 token_count 就能点亮一格假的绿色「就绪」。
    create: true,
    ...(flags.state ? { state: flags.state } : {}),
  });
  if (!res) {
    console.error(c.dim('(no server listening — start it with `bao start`)'));
    return;
  }
  if (res.error) {
    console.error(`${c.red('●')} ${res.error}`);
    process.exitCode = 1;
  }
}

async function cmdClear(flags) {
  if (flags.session) {
    await client.setState({ session: flags.session, state: 'offline' });
    console.log(`cleared ${flags.session}`);
    return;
  }
  const res = await client.post('/clear', {});
  if (!res) return console.error(c.dim('(no server listening)'));
  console.log('cleared all sessions');
}

// 最近事件：状态切换、被拒绝的写入、读不懂的事件。环形缓冲最多 200 条，
// 不落盘，重启即清 —— 它回答的是「刚刚发生了什么」，不是审计日志。
async function cmdLog() {
  const running = await client.health();
  if (!running) return console.log(c.dim('nothing running — start with `bao start`'));
  const data = await client.get('/log');
  const events = (data && data.events) || [];
  if (!events.length) return console.log(c.dim('no events yet'));
  for (const e of events) {
    const t = new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`${c.dim(t)}  ${e.what}`);
  }
}

async function cmdStatus(flags = {}) {
  const snap = await client.snapshot();
  // Scripts (a stream deck, OBS, a shell prompt) want the numbers, not the
  // dots. Machine shape, no colours, one object.
  if (flags.json) {
    console.log(JSON.stringify(snap ? { running: true, ...snap } : { running: false }, null, 2));
    return;
  }
  if (!snap) { console.log(`${c.dim('○')} server not running`); return; }
  console.log(`${DOT[snap.overall]()} ${c.b(snap.overall)}`);
  if (!snap.sessions.length) return console.log(c.dim('  no active agents'));
  for (const s of snap.sessions) {
    const age = Math.round((Date.now() - s.since) / 1000);
    const note = s.quiet
      ? `${s.detail || ''} (silent ${Math.round(s.quietFor / 60000)}m)`.trim()
      : s.detail || '';
    console.log(`  ${DOT[s.state]()} ${s.agent.padEnd(12)} ${String(s.state).padEnd(8)} ${c.dim(`${age}s  ${note}`)}`);
  }
}

async function cmdDemo() {
  // 五种状态都要演一遍：出错闪烁和完成转圈是最容易被写坏的动效，恰恰只有
  // 真按顺序走一遍才看得见。只演 busy/waiting/idle 等于跳过了最该检查的两段。
  const seq = [
    ['busy', 'reading files'],
    ['busy', 'editing src/server.js'],
    ['waiting', 'wants to run a command'],
    ['error', 'a command failed'],
    ['done', 'finished the task'],
    ['idle', ''],
  ];
  for (const [state, detail] of seq) {
    process.stdout.write(`${DOT[state]()} ${state}${detail ? ' — ' + detail : ''}\n`);
    await client.setState({ state, detail, agent: 'demo', session: 'demo:1' });
    await new Promise((r) => setTimeout(r, 2400));
  }
  await client.setState({ state: 'offline', session: 'demo:1' });
  console.log(c.dim('demo done'));
}

function cmdAgents() {
  const order = { hooks: 0, log: 1, pty: 2 };
  const rows = agents.names()
    .map((n) => ({ n, ...agents.AGENTS[n] }))
    .sort((a, b) => (order[a.tier] - order[b.tier]) || a.n.localeCompare(b.n));

  console.log(`\n${c.b('Agents')}\n`);
  console.log(`  ${c.dim('agent'.padEnd(12))} ${c.dim('how it reports'.padEnd(30))} ${c.dim('setup')}`);
  for (const r of rows) {
    const setup = r.tier === 'pty' ? `bao wrap -- ${r.n === 'claude' ? 'claude' : r.n}`
      : r.tier === 'log' ? `bao watch ${r.n}`
        : `bao connect ${r.n}`;
    console.log(`  ${r.n.padEnd(12)} ${String(r.how).padEnd(30)} ${setup}`);
  }
  console.log('');
  console.log(c.dim('  Anything else: bao hook --agent <name>  (one JSON event on stdin)'));
  console.log(c.dim('  Or over HTTP (writes need the local token):'));
  console.log(c.dim('    curl -H "x-bao-token: $(bao token)" "http://127.0.0.1:4747/set/busy?agent=my-bot"\n'));
}

function cmdWatch(positional, flags) {
  const requested = (positional[0] || '').toLowerCase();
  if (!requested) {
    console.error('usage: bao watch <agent> [--dir <path>] [--fuel quota|context]');
    console.error(`       agents with a log: ${agents.names().filter((n) => agents.AGENTS[n].tier === 'log').join(', ')}`);
    process.exit(1);
  }
  const entry = agents.find(requested);
  const target = entry ? entry.name : requested;

  if (requested === 'all') return cmdWatchAll(flags);

  // dsh does not write a tail-able JSONL (its session is zstd), but it does
  // keep a plain JSON projection per session — a dedicated reader is the only
  // honest way to get all three states out of it. --dir still means "the same
  // format, somewhere else"; --jsonl opts into the generic reader instead.
  const useDsh = (target === 'deepseek' || requested === 'dsh') && !flags.jsonl;
  // WorkBuddy rewrites its task files in place, so it needs snapshot reads
  // rather than the append-only tailer every other agent gets.
  const useTasks = target === 'workbuddy' && !flags.jsonl;
  const watcher = useDsh ? require('./adapters/dsh-watch')
    : useTasks ? require('./adapters/task-watch')
      : require('./adapters/log-watch');

  watcher.run({
    agent: target,
    dir: flags.dir,
    interval: flags.interval,
    lookback: flags.lookback,
    fuel: flags.fuel,
    quiet: flags.quiet,
  });
}

// The three agents with no hook of their own all report through files on disk,
// and they should all be watched at once. Each gets its own process on purpose:
// if one agent's logs move or are missing, that watcher exits and says why, and
// the other two keep reporting instead of dying with it.
function cmdWatchAll(flags = {}) {
  const targets = ['codex', 'deepseek', 'workbuddy'];
  const children = [];

  const prefix = (stream, tag) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) process.stdout.write(`${c.dim(`[${tag}]`)} ${line}\n`);
      }
    });
  };

  for (const t of targets) {
    const args = [path.join(ROOT, 'src', 'cli.js'), 'watch', t];
    if (flags.quiet) args.push('--quiet');
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    prefix(child.stdout, t);
    prefix(child.stderr, t);
    child.on('error', () => {});
    child.on('exit', (code) => {
      if (code) console.error(`${c.yel('!')} ${t} watcher exited (${code}) — run \`bao watch ${t}\` to see why`);
    });
    children.push(child);
  }

  console.log(`${c.grn('●')} watching ${targets.join(' · ')} — Ctrl+C to stop`);

  const stop = () => { for (const ch of children) { try { ch.kill(); } catch { /* already gone */ } } };
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stop(); process.exit(0); });

  return new Promise(() => {});
}

function cmdInstall(positional, flags) {
  const target = (positional[0] || '').toLowerCase();
  const scope = flags.scope === 'project' ? 'project' : 'user';

  if (target === 'claude') {
    let r;
    try {
      r = install.installClaude({ scope });
    } catch (err) {
      // 文件读不出来 / 不是合法 JSON：什么都不写，并把原因说清楚。这条路径
      // 以前会静默地把整份 settings.json 换成 `{}`。
      console.error(`${c.red('✗')} ${err.message}`);
      console.error(c.dim('  Nothing was written. Fix or move that file, then run it again.'));
      process.exitCode = 1;
      return;
    }
    console.log(`${c.grn('●')} Claude Code hooks installed (${r.events} events)`);
    console.log(c.dim(`  ${r.file}`));
    if (r.backup) console.log(c.dim(`  backup: ${r.backup}`));
    console.log(c.dim('  It takes effect immediately — no restart needed.'));
    console.log('');
    console.log(`${c.grn('✓')} Send Claude Code a message and the robot turns busy.`);
    console.log(c.dim('  Ask it something it must stop and ask you about, and it waves for you.'));
    if (r.fromCheckout) {
      console.log('');
      console.log(`${c.yel('!')} These hooks point at a git checkout:`);
      console.log(c.dim(`  ${r.root}`));
      console.log(c.dim('  Hooks run on every tool call, so that folder stays open — on Windows it'));
      console.log(c.dim('  cannot be renamed or deleted while an agent is running, and other apps'));
      console.log(c.dim('  touching it report "file in use". The hooks also break if it ever moves.'));
      console.log(c.dim('  For everyday use, install once and wire up from there:'));
      console.log(c.dim('    npm install -g baoanlight && bao connect claude'));
    }
    return;
  }
  if (target === 'codex') {
    const r = install.installCodex();
    if (r.skipped) {
      // 不覆盖用户已有的通知钩子。一个 notify 槽位只能有一个主人。
      console.log(`${c.yel('!')} Codex already has its own notify hook — left untouched:`);
      console.log(c.dim(`  ${r.foreign}`));
      console.log(c.dim(`  ${r.file}`));
      console.log('');
      console.log(`  To hand that slot to baoanlight, delete that line and run this again.`);
      console.log(c.dim(`  Nothing else changes: \`bao watch codex\` still reads the sessions.`));
      return;
    }
    console.log(`${c.grn('●')} Codex notify hook installed`);
    console.log(c.dim(`  ${r.file}`));
    if (r.backup) console.log(c.dim(`  backup: ${r.backup}`));
    console.log(c.dim('  Codex only notifies on turn end / approval, so you get two states.'));
    console.log(c.dim('  For the full picture: bao watch codex'));
    return;
  }
  if (target === 'generic') {
    console.log(install.genericSnippet(flags.agent || 'my-agent'));
    return;
  }
  if (target === 'mcp') {
    console.log(install.mcpSnippet());
    return;
  }

  const agent = agents.find(target);
  if (agent) {
    console.log(`${c.grn('●')} ${agent.label} — ${agent.how}`);
    console.log(c.dim(`  ${agent.detail}`));
    console.log('');
    console.log(`${c.b('1.')} Let it report directly (best):`);
    console.log(`   ${c.dim('$')} bao hook --agent ${agent.name}`);
    console.log(c.dim(`   Reads one JSON event on stdin: {"state":"busy"} or {"event":"task_complete"}`));
    console.log('');
    console.log(`${c.b('2.')} Or read its session log:`);
    console.log(`   ${c.dim('$')} bao watch ${agent.name}`);
    if (agent.name !== 'codex') {
      console.log(c.dim(`   Not where we expect? add --dir <path>`));
    }
    console.log('');
    console.log(`${c.b('3.')} Or just shell:`);
    console.log(`   ${c.dim('$')} bao set busy --agent ${agent.name} --detail "building"`);
    return;
  }

  const others = agents.names().filter((n) => n !== 'claude' && n !== 'codex');
  console.error(`usage: bao connect <claude|codex|generic|${others.join('|')}>`);
  console.error(c.dim('       bao agents   for the full list'));
  process.exit(1);
}

function cmdUninstall(positional, flags) {
  const target = (positional[0] || '').toLowerCase();
  const scope = flags.scope === 'project' ? 'project' : 'user';
  if (target === 'claude') {
    let r;
    try {
      r = install.uninstallClaude({ scope });
    } catch (err) {
      console.error(`${c.red('✗')} ${err.message}`);
      console.error(c.dim('  Nothing was written.'));
      process.exitCode = 1;
      return;
    }
    console.log(r.removed ? `removed baoanlight hooks from ${r.file}` : `no baoanlight hooks in ${r.file} — nothing to do`);
    return;
  }
  if (target === 'codex') {
    const r = install.uninstallCodex();
    console.log(r.removed ? `removed baoanlight notify from ${r.file}` : `no baoanlight notify in ${r.file} — nothing to do`);
    return;
  }
  console.error('usage: bao disconnect <claude|codex>');
  process.exit(1);
}

// ---- first-run onboarding ---------------------------------------------------
// A guided walkthrough for the first time the robot is run: detect which coding
// agents are actually on this machine, wire up the one the user picks, and leave
// them with a working setup. No external dependencies — readline is enough.
function cmdOnboard() {
  const fs = require('fs');
  const readline = require('readline');

  const question = (rl, q) => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim().toLowerCase())));

  const claudeHooked = install.claudeHookCount('user') > 0 || install.claudeHookCount('project') > 0;
  const claudePresent = claudeHooked || fs.existsSync(install.claudeSettingsPath('user'));

  const cfg = config.load();
  const detect = (n) => {
    const dir = agents.logDir(n, { config: cfg });
    if (dir && fs.existsSync(dir)) return true;
    return agents.candidates(n).some((d) => fs.existsSync(d));
  };
  const has = { codex: detect('codex'), deepseek: detect('deepseek'), workbuddy: detect('workbuddy') };

  console.log(`\n${c.b('baoanlight onboarding')}\n`);
  console.log('  在这台机器上发现：');
  console.log(`    ${'Claude Code'.padEnd(15)}${claudeHooked ? c.grn('✓ 已装钩子') : (claudePresent ? c.yel('○ 已安装，未接') : c.dim('○ 未找到'))}`);
  console.log(`    ${'Codex'.padEnd(15)}${has.codex ? c.grn('✓ 找到日志') : c.dim('○ 未找到')}`);
  console.log(`    ${'DeepSeek Harness'.padEnd(15)}${has.deepseek ? c.grn('✓ 找到日志') : c.dim('○ 未找到')}`);
  console.log(`    ${'WorkBuddy'.padEnd(15)}${has.workbuddy ? c.grn('✓ 找到日志') : c.dim('○ 未找到')}`);
  console.log('');

  const options = [];
  options.push(`  ${c.b('1')}  Claude Code    ${c.dim('写入钩子，三态精确')}`);
  if (has.codex) options.push(`  ${c.b('2')}  Codex          ${c.dim('bao watch codex')}`);
  if (has.deepseek) options.push(`  ${c.b('3')}  DeepSeek       ${c.dim('bao watch deepseek')}`);
  if (has.workbuddy) options.push(`  ${c.b('4')}  WorkBuddy      ${c.dim('bao watch workbuddy')}`);
  if (has.codex || has.deepseek || has.workbuddy) options.push(`  ${c.b('A')}  全部日志观察器 ${c.dim('bao watch all，后台常驻')}`);
  options.push(`  ${c.b('S')}  跳过，直接启动机器人`);

  console.log('  想先接哪个？\n');
  console.log(options.join('\n'));
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  (async () => {
    const choice = await question(rl, '  选一个（回车 = 跳过）: ');
    rl.close();

    if (choice === '1' || (choice === '' && claudePresent && !claudeHooked)) {
      const r = install.installClaude({ scope: 'user' });
      console.log(`\n${c.grn('●')} Claude Code hooks installed (${r.events} events)`);
      console.log(c.dim(`  ${r.file}`));
      console.log(c.grn('✓') + ' 立即生效，不用重启——给 Claude Code 发条消息，机器人就变绿。');
    } else if (choice === '2' && has.codex) {
      console.log(`\n${c.grn('●')} 让 Codex 上报：`);
      console.log(`    ${c.b('bao watch codex')}`);
      console.log(c.dim('  （关掉终端就停；想一直开着用 `bao watch all` + `bao autostart on`）'));
    } else if (choice === '3' && has.deepseek) {
      console.log(`\n${c.grn('●')} 让 DeepSeek Harness 上报：`);
      console.log(`    ${c.b('bao watch deepseek')}`);
    } else if (choice === '4' && has.workbuddy) {
      console.log(`\n${c.grn('●')} 让 WorkBuddy 上报：`);
      console.log(`    ${c.b('bao watch workbuddy')}`);
      console.log(c.dim('  （粗粒度；要精确用 `bao hook --agent workbuddy`）'));
    } else if (choice === 'a' && (has.codex || has.deepseek || has.workbuddy)) {
      console.log(`\n${c.grn('●')} 一次盯住全部：`);
      console.log(`    ${c.b('bao watch all')}`);
      console.log(c.dim('  配合开机自启：  bao autostart on'));
    }

    console.log('');
    console.log(`${c.b('下一步：')}`);
    console.log(`    ${c.b('bao start')}       启动机器人（还没启动的话）`);
    console.log(`    ${c.b('bao status')}     看它现在说什么`);
    console.log(`    ${c.b('bao doctor')}     体检这台机器接线对不对`);
    console.log(`    ${c.b('bao agents')}     所有支持的代理`);
    console.log('');
  })().catch(() => process.exit(1));
}

// ---------------------------------------------------------------------- main

async function main() {
  enableUtf8Console();
  const { flags, positional, rest } = parse(process.argv.slice(2));
  const cmd = positional.shift();

  // `--port` 必须在进任何命令前校验：`bao start --port 70000` 或 `50o` 以前会
  // 一路漏到 server.listen()，要么抛一个裸 RangeError 堆栈，要么静默退回默认端口。
  // 0 表示「让系统挑一个」。
  if (flags.port !== undefined && flags.port !== '') {
    const p = Number(flags.port);
    if (!Number.isInteger(p) || p < 0 || p > 65535) {
      console.error(`${c.red('●')} invalid port: ${JSON.stringify(flags.port)} (must be an integer 0-65535)`);
      process.exit(2);
    }
    process.env.BAOANLIGHT_PORT = String(p);
  }

  switch (cmd) {
    case 'start':      return flags.foreground ? cmdStart(flags) : cmdStartDetached(flags);
    case 'server':     return cmdServer(flags).then(() => new Promise(() => {}));
    case 'overlay':    return cmdOverlay(flags);
    case 'stop':       return cmdStop();
    case 'autostart':  return cmdAutostart(positional);
    case 'set':        return cmdSet(positional, flags);
    case 'status':     return cmdStatus(flags);
    case 'log':        return cmdLog();
    case 'token':      return cmdToken();
    case 'clear':      return cmdClear(flags);
    case 'doctor':     return require('./doctor').run();
    case 'onboard':    return cmdOnboard();
    case 'setup':      return require('child_process')
                         .spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup.js')], { stdio: 'inherit' });
    case 'fuel':       return cmdFuel(positional, flags);
    case 'demo':       return cmdDemo();
    case 'agents':     return cmdAgents();
    // `connect` is the verb; `install` is kept working because people will
    // have it written down from the previous name.
    case 'connect':
    case 'install':    return cmdInstall(positional, flags);
    case 'disconnect':
    case 'uninstall':  return cmdUninstall(positional, flags);
    case 'watch':      return cmdWatch(positional, flags);
    case 'hook': {
      // 走 failSafe：1.5 秒硬超时 + 无论如何 exit 0。
      // 原来直接调 run()，既没有超时也没有 catch —— 而 `bao hook` 正是文档让
      // 用户接进自己代理的那条命令。调用方只要不关 stdin，这个进程就一直挂着。
      const event = require('./hooks/event');
      event.failSafe(() => event.run(positional, flags));
      return new Promise(() => {});
    }
    case 'mcp':
      // stdio MCP server: it connects and keeps the process alive on its own.
      require('./mcp-server');
      return new Promise(() => {});
    case 'wrap': {
      const argv = rest.length ? rest : positional;
      if (!argv.length) { console.error('usage: bao wrap -- <command> [args...]'); process.exit(1); }
      return require('./adapters/wrap').run(argv, flags);
    }
    case 'help':
    case undefined:    return usage();
    default:
      console.error(`unknown command "${cmd}"`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
