#!/usr/bin/env node
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const config = require('./config');
const client = require('./client');
const install = require('./adapters/install');
const agents = require('./adapters/agents');
const { supervise } = require('./supervisor');

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
      // 只按第一个 `=` 切：`--detail=exit=1` 是一个值里带等号的常见写法，
      // `split('=')` 会把它截成 "exit"，按钮文案就少了一半。
      const eq = a.indexOf('=');
      const k = a.slice(2, eq < 0 ? undefined : eq);
      const v = eq < 0 ? undefined : a.slice(eq + 1);
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
      red: (s) => `\x1b[31m${s}\x1b[0m`, yel: (s) => `\x1b[33m${s}\x1b[0m`,
      grn: (s) => `\x1b[32m${s}\x1b[0m`, mag: (s) => `\x1b[35m${s}\x1b[0m` }
  : { dim: (s) => s, b: (s) => s, red: (s) => s, yel: (s) => s, grn: (s) => s, mag: (s) => s };

// Same colours as the robot, in the same order of alarm. `idle` is white
// (rendered dim in a terminal) — a different thing from running. `done` is the
// transient purple the robot shows for a finished turn.
const DOT = {
  error: () => c.red('●'),
  waiting: () => c.yel('●'),
  busy: () => c.grn('●'),
  done: () => c.mag('◉'),
  idle: () => c.dim('●'),
  unknown: () => c.dim('◐'),
  offline: () => c.dim('○'),
};

// Windows consoles default to a legacy code page (936 on Chinese systems), so
// the UTF-8 bytes this CLI writes render as "鈼?" instead of the dots above.
// Switching the console to 65001 fixes it for every run that follows. Only do
// it for an interactive terminal: piped output must stay raw bytes.
function enableUtf8Console() {
  if (!process.stdout.isTTY) return;
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

  ${c.grn('●')} green   an agent is working
  ${c.yel('●')} yellow  an agent stopped and needs you (permission, question, choice)
  ${c.red('●')} red     a run failed or is blocked
  ${c.mag('◉')} purple  a turn just finished (brief)
  ${c.dim('●')} dim     an agent is open but not working
  ${c.dim('○')} dark    nothing running / not installed

${c.b('USAGE')}
  bao start                    start it in the background and hand the prompt back
                               ${c.dim('(also starts and supervises the log watchers)')}
  bao start --foreground       keep it attached to this terminal (Ctrl+C to stop)
  bao server                   state server only (no robot window)
  bao overlay                  robot window only (server must already run)
  bao stop                     shut everything down

  bao connect claude           wire into Claude Code hooks   ${c.dim('(exact)')}
  bao connect codex            wire into Codex notify        ${c.dim('(red + green)')}
  bao connect codebuddy        wire into CodeBuddy hooks     ${c.dim('(restart the IDE once)')}
  bao connect generic          print snippets for any other tool
  bao disconnect claude|codex|codebuddy  remove those again

  bao wrap -- <command>        run any agent in a watched terminal
                               ${c.dim('e.g. bao wrap -- gemini')}

  bao watch codex              read Codex's own session logs      ${c.dim('(all 3 states)')}
  bao watch deepseek           read DeepSeek Harness projections  ${c.dim('(all 3 states)')}
  bao watch workbuddy          read WorkBuddy's task board
  bao watch codebuddy          read CodeBuddy's session transcripts
  bao watch all                run every log-based watcher at once
                               ${c.dim('codex + deepseek + workbuddy + codebuddy')}
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
  bao status --watch           redraw every second (like top; Ctrl+C to stop)
  bao status --json            same, as JSON, for scripts and overlays
  bao token                    print the local write token (for curl / scripts)
  bao clear [--session id]     forget sessions left behind by a crashed agent
  bao setup                    download the Electron runtime for the window
  bao autostart on|off|status  start the robot at Windows login
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
  --no-watch       for \`start\`: do not run the log watchers (they run by default)
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

// `require('electron')` 只读 path.txt，**不检查 exe 是否还在**：杀毒软件隔离、
// 升级中途失败都会留下一个指向空气的路径。只 require 就当成「运行时可用」，
// 结果是窗口根本不出现，而命令仍然打印「robot up」。
function electronBinary() {
  try {
    const p = require('electron');
    return typeof p === 'string' && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

// 同步安装窗口运行时，并把输出留给用户看（stdio: 'inherit'）。只在脱离终端之前
// 调用：`bao start` 不应该先宣布成功、再在后台悄悄下载几分钟。
function runSetup() {
  try {
    const r = require('child_process').spawnSync(
      process.execPath, [path.join(ROOT, 'scripts', 'setup.js')], { stdio: 'inherit' });
    return r.status === 0 && !!electronBinary();
  } catch {
    return false;
  }
}

function spawnOverlay(port) {
  const electron = electronBinary();
  if (!electron) return null;
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
    // Windows：父进程（server）是带 CREATE_NO_WINDOW 起来的、没有控制台，子进程
    // 若不带这个标志，系统会给它**新分配一个控制台窗口** —— 每 `bao start` 一次
    // 就有一个黑框弹出来。ELECTRON_NO_ATTACH_CONSOLE 只阻止「附着」，不阻止「新建」。
    windowsHide: true,
  });
  child.on('error', () => {});
  return child;
}

// 日志观察器作为独立子进程跑：某个适配器里的意外异常只会带走它自己，不会
// 把 server 和机器人窗口一起拖下水；`cmdStart` 负责在它退出后重启。
function spawnWatchChild(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'cli.js'), 'watch', 'all', '--supervised'], {
    cwd: os.tmpdir(),
    env: { ...process.env, BAOANLIGHT_PORT: String(port) },
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  return child;
}

// 整机子进程：server + 窗口 + 观察器都由它带起来（见 cmdStart）。
// 守护者只负责在它非零退出后重开，不关心它内部怎么分工。
//
// 用户的选择必须全部传下去：`--no-watch` 漏传时，前台子进程会把「没写」当成
// 「默认开」，于是 `bao start --no-watch` 照样拉起一整套观察器 —— 参数被静默
// 吞掉，比不支持还糟。
function startChildArgs(port, flags = {}) {
  const args = [path.join(ROOT, 'src', 'cli.js'), 'start', '--foreground', '--port', String(port)];
  if (flags['no-watch']) args.push('--no-watch');
  else args.push('--watch');
  if (flags['no-overlay']) args.push('--no-overlay');
  if (flags.browser) args.push('--browser');
  return args;
}

function spawnStartChild(port, flags = {}) {
  const args = startChildArgs(port, flags);
  const child = spawn(process.execPath, args, {
    cwd: os.tmpdir(),
    env: { ...process.env, BAOANLIGHT_PORT: String(port) },
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  return child;
}

// `bao start` 的脱离进程实际跑的是这个：它一遍遍地拉起 `start --foreground`，
// 直到那个进程正常退出（用户主动退出 / `bao stop`）。
function cmdSupervise(flags = {}) {
  const port = Number(flags.port) || config.port();
  const sup = supervise(() => spawnStartChild(port, flags), {
    log: ({ code, wait }) => console.error(
      `${c.yel('!')} the robot exited (${code}) — restarting in ${Math.round(wait / 1000)}s`
    ),
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { sup.stop(); process.exit(0); });
  return new Promise(() => {});
}

// `bao start` 是否要开桌面窗口。`--no-overlay`（只跑 server）和 `--browser`
// （在浏览器标签里看同一个机器人）都不需要 Electron。
function needsWindow(flags = {}) {
  return !flags['no-overlay'] && !flags.browser;
}

// 首次运行：窗口运行时不在时，先在这个进程里同步装好，再脱离终端。
// 以前把下载留给脱离后的子进程 —— 它的 stdio 是 ignore，用户看不到任何进度，
// 而父进程 180 秒后就 taskkill 整棵树：慢网络上必然得到一次「启动失败」。
function ensureWindowRuntime(flags, {
  probe = electronBinary,
  install = runSetup,
  log = (m) => console.log(c.dim(m)),
} = {}) {
  if (!needsWindow(flags) || probe()) return true;
  log('  fetching the window runtime, once — this can take a few minutes…');
  return !!install() && !!probe();
}

// `bao start` detaches by default: a desk robot should not hold a shell
// hostage, and closing that terminal should not take the robot down.
async function cmdStartDetached(flags) {
  const port = Number(flags.port) || config.port();

  // 一个桌面只该有一个机器人。端口文件里可能记着另一个端口上的旧实例（默认
  // 4747，这次用户写了 `--port 5000`）—— 那个实例还活着的话，再起一个会得到
  // 两个 server，并把端口文件改写成 5000：之后 `bao status` / `bao stop` 全部
  // 指向新的那个，桌面上真正在跑的旧机器人变成谁也管不到的孤儿。
  const filePort = config.portFromFile();
  if (filePort && filePort !== port) {
    const other = await client.healthAt(filePort);
    if (other) {
      console.error(`${c.red('●')} another robot is already running on http://127.0.0.1:${filePort} (pid ${other.pid}).`);
      console.error(c.dim('  one robot per desktop — `bao stop` it first, or start on that port.'));
      process.exitCode = 1;
      return;
    }
  }

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

  // 窗口运行时在这里、带着用户的终端装好，**然后**才脱离终端。需要的下载
  // （~140 MB）如果留给脱离后的子进程，用户看不到任何进度，而本进程的等待
  // 窗口会先到点；同一份 node_modules 被两个进程同时解包也不是好事。
  const hasRuntime = ensureWindowRuntime(flags);
  if (needsWindow(flags) && !hasRuntime) {
    console.error(`${c.red('●')} the robot window runtime could not be installed.`);
    console.error(c.dim('  see the messages above, fix the download, then:  bao setup'));
    console.error(c.dim('  or run without the window:  bao start --browser'));
    process.exitCode = 1;
    return;
  }

  // 脱离出去的是守护进程，不是机器人本体：本体崩溃时由它按退避重开。
  // 一条 `bao start` 就够 —— server、窗口、观察器都在被守护的这一层里面。
  const args = [path.join(ROOT, 'src', 'cli.js'), 'supervise', '--port', String(port)];
  if (flags['no-overlay']) args.push('--no-overlay');
  if (flags.browser) args.push('--browser');
  if (flags['no-watch']) args.push('--no-watch');

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    cwd: os.tmpdir(),
    windowsHide: true,
  });
  child.unref();

  // Do not claim success before it is listening — a premature "it's up" would
  // be a lie.
  const budgetMs = 20_000;
  const deadline = Date.now() + budgetMs;
  let up = null;
  while (Date.now() < deadline) {
    up = await client.health();
    if (up) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  if (!up) {
    // 别把脱离出去的守护进程留在后台：它会每隔 5–60 秒重开一个注定失败的
    // 子进程（端口被别的程序占着时永远起不来），而 `bao stop` 找不到 server，
    // 也不会去停它 —— 用户只会看到一个没人管的 node 进程一直重试。
    try {
      require('child_process').execFileSync(
        'taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      try { child.kill(); } catch { /* 已经退了 */ }
    }
    console.error(`${c.red('●')} it did not come up within ${Math.round(budgetMs / 1000)}s.`);
    console.error(c.dim('  run it attached to see the error:  bao start --foreground'));
    process.exitCode = 1;
    return;
  }

  console.log(`${c.grn('●')} baoanlight is running in the background.`);
  if (!needsWindow(flags)) {
    console.log(c.dim(flags.browser
      ? `  robot in the browser: http://127.0.0.1:${port}`
      : '  server only — no robot window (--no-overlay)'));
  } else {
    console.log(c.dim('  drag the robot anywhere; hover it for controls'));
  }
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

  // ---- 自动化：守护日志观察器 -------------------------------------------
  // `bao start` 也负责 watcher，并在它意外退出后按 5s → 10s → 30s → 60s 退避
  // 重启；稳定跑满一分钟后重置退避。退出码 3 表示「另一个 watcher 已经在看」，
  // 那是正常状态，不能再重启 —— 否则会变成一个 5 秒一次的失败循环。
  let watchChild = null;
  let watchTimer = null;
  let watchBackoff = 5000;
  let watchStartedAt = 0;
  let watchConflicts = 0;
  let shuttingDown = false;
  const stopWatching = () => {
    clearTimeout(watchTimer);
    watchTimer = null;
    if (watchChild) { try { watchChild.kill(); } catch { /* 已经退了 */ } watchChild = null; }
  };
  const startWatching = () => {
    if (shuttingDown || flags['no-watch']) return;
    watchStartedAt = Date.now();
    watchChild = spawnWatchChild(port);
    watchChild.on('exit', (code) => {
      watchChild = null;
      if (shuttingDown) return;
      if (Date.now() - watchStartedAt > 60_000) {
        watchBackoff = 5000;
        watchConflicts = 0;
      }
      if (code === 3) {
        // 另一个 watcher 已经在看（常见于整机重启后旧进程还没退干净）：等一分钟
        // 再看一次，最多三次。之后认定那是用户自己的选择，安静退场 —— 不能为了
        // 接管而每 5 秒重启一个注定失败的子进程。
        watchConflicts += 1;
        if (watchConflicts > 3) return;
        watchTimer = setTimeout(startWatching, 60_000);
        return;
      }
      watchTimer = setTimeout(startWatching, watchBackoff);
      watchBackoff = Math.min(watchBackoff * 2, 60_000);
    });
  };
  // 默认就带观察器（`--no-watch` 关闭）：前台调试窗口时也一样，否则用户
  // 用 `bao start --foreground` 会得到一个「灯永远不亮」的机器人。
  if (!flags['no-watch']) startWatching();
  // 所有分支（含 --no-overlay / --browser）退出时都要带走 watcher，否则它
  // 会变成一个替已关闭机器人的指示灯继续工作的孤儿进程。
  process.on('exit', () => { shuttingDown = true; stopWatching(); });

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
    // Windows 的 `start` 是 cmd 内建命令，没有可执行文件可查，必须交给 cmd。
    // 不走 shell: true —— Node 24 起它会在 stderr 打一条 DEP0190 弃用警告，
    // 而用户看到的应当是「打开了浏览器」，不是一段无关的警告。
    // 第一个参数空字符串是 start 的窗口标题占位（`start "标题" 目标`）。
    spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '', url], {
      stdio: 'ignore',
      windowsHide: true,
    }).on('error', () => {});
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
  let overlay = child;
  let overlayRestarts = 0;
  const shutdown = () => { shuttingDown = true; stopWatching(); try { overlay.kill(); } catch {} };
  process.on('exit', shutdown);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { shutdown(); process.exit(0); });

  // 窗口正常退出 = 用户点了退出（工具栏 ✕ / 托盘退出）：跟着收摊。非零退出
  // 通常是渲染进程崩了 —— 自动重开，最多 3 次，别让桌面上少一只机器人。
  const wireOverlay = (proc) => {
    const spawnedAt = Date.now();
    proc.on('exit', (code) => {
      if (shuttingDown) return;
      // 刚拉起就正常退出：几乎一定是「另一个窗口已经占了单实例锁」（整机崩溃
      // 重启后旧窗口还活着）。server 要留着 —— 旧窗口会自己重连到新 server。
      if (code === 0 && Date.now() - spawnedAt < 4000) {
        console.log(c.dim('  another robot window is already open — keeping the server'));
        return;
      }
      if (code !== 0 && overlayRestarts < 3) {
        overlayRestarts += 1;
        const next = spawnOverlay(port);
        if (next) {
          overlay = next;
          console.log(`${c.yel('!')} the robot window exited (${code}) — reopened it`);
          wireOverlay(next);
          return;
        }
      }
      process.exit(0);
    });
  };
  wireOverlay(overlay);

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
    console.error('Electron is not installed or its binary is missing. Run `bao setup`, or `bao start --browser`.');
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
  // 等监听真的消失再报 stopped：`bao stop && bao start` 是常见连招，旧进程还
  // 在退出的那 150ms 里时，新 start 会误以为「已经在运行」，然后两边一起消失。
  let down = false;
  for (let i = 0; i < 40; i++) {
    if (!(await client.health())) { down = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!down) {
    console.error(`${c.red('●')} stop was acknowledged, but the server is still answering.`);
    console.error(c.dim('  it may be an older instance that ignored the request — end it manually'));
    process.exitCode = 1;
    return;
  }
  console.log('stopped');
}

function cmdAutostart(positional) {
  const autostart = require('./autostart');
  const action = String(positional[0] || 'status').toLowerCase();

  if (action === 'on' || action === 'install' || action === 'enable') {
    let file;
    try {
      file = autostart.install();
    } catch (err) {
      // 启动文件夹被安全软件锁定 / PowerShell 没写成功：说清楚，别打「已开启」。
      console.error(`${c.red('●')} could not enable autostart: ${err.message}`);
      console.error(c.dim('  try again, or add a shortcut to `bao start` to the Startup folder yourself.'));
      process.exitCode = 1;
      return;
    }
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
  if (s.enabled) {
    console.log(`${c.grn('●')} 开机自启：已开启`);
  } else if (s.broken) {
    // 启动项还在、脚本没了：登录时什么都不会发生。说清楚，并给出一步修复。
    console.log(`${c.yel('!')} 开机自启：已失效（启动脚本不见了）`);
    console.log(c.dim(`  ${s.launcher}`));
    console.log(c.dim('  修复：bao autostart on'));
    process.exitCode = 1;
    return;
  } else {
    console.log(`${c.dim('○')} 开机自启：已关闭`);
  }
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
    const res = await client.setState({ session: flags.session, state: 'offline' });
    // 服务没起来 / token 不匹配时不能照打「cleared」：那是一句假话，用户会以为
    // 残影已经清掉，实际上灯还挂着。和 `bao set` 用同一套失败处理。
    if (!res) {
      console.error(c.dim('(no server listening — start it with `bao start`)'));
      process.exitCode = 1;
      return;
    }
    if (res.error) {
      console.error(`${c.red('●')} ${res.error}`);
      process.exitCode = 1;
      return;
    }
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

function printStatus(snap, flags = {}) {
  // Scripts (a stream deck, OBS, a shell prompt) want the numbers, not the
  // dots. Machine shape, no colours, one object.
  if (flags.json) {
    console.log(JSON.stringify(snap ? { running: true, ...snap } : { running: false }, null, 2));
    return;
  }
  if (!snap) { console.log(`${c.dim('○')} server not running`); return; }
  // 端口上回 JSON 的不一定是 baoanlight：别的本地服务也可能占着 4747。缺字段的
  // 响应不能让 `bao status` 带着堆栈崩掉 —— 诊断入口自己崩溃是最糟的结果。
  const dot = (state) => DOT[state] || DOT.unknown;
  const sessions = Array.isArray(snap.sessions) ? snap.sessions : [];
  console.log(`${dot(snap.overall)()} ${c.b(snap.overall)}`);
  if (!sessions.length) { console.log(c.dim('  no active agents')); return; }
  for (const s of sessions) {
    const age = Math.round((Date.now() - s.since) / 1000);
    // 「silent」只对还在忙、却不再上报的会话才有意义（那才是卡住的信号）。一个
    // 正常 idle/done 的会话本来就该安静，标成「失联 N 分钟」和界面里 idle=就绪 矛盾。
    const quietStuck = s.quiet && (s.state === 'busy' || s.state === 'unknown');
    const note = quietStuck
      ? `${s.detail || ''} (silent ${Math.round(s.quietFor / 60000)}m)`.trim()
      : s.detail || '';
    console.log(`  ${dot(s.state)()} ${String(s.agent).padEnd(12)} ${String(s.state).padEnd(8)} ${c.dim(`${age}s  ${note}`)}`);
  }
}

function fmtDur(ms) {
  const m = Math.round((Number(ms) || 0) / 60000);
  if (m < 1) return '不到 1 分钟';
  return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}

// `bao status --watch`：像 top 一样每秒重绘。不开窗口、不依赖 Electron 也能盯着，
// 这是命令行里唯一能「看着它变」的入口。
async function statusWatch() {
  const out = process.stdout;
  const stop = () => {
    out.write('\x1b[?25h\n');   // 把光标还回去，别让用户刷完一条命令后找不到它
    process.exit(0);
  };
  out.write('\x1b[?25l');       // 隐藏光标，免得它在原地闪
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  for (;;) {
    out.write('\x1b[2J\x1b[H');
    const clock = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    out.write(`${c.dim(clock)}${c.dim('   bao status --watch · Ctrl+C 退出')}\n\n`);
    const snap = await client.snapshot();
    printStatus(snap);
    if (snap) {
      const todayMs = Object.values(snap.stats?.byAgent || {}).reduce((a, b) => a + (b || 0), 0);
      if (todayMs > 0) out.write(`\n${c.dim(`今日累计 ${fmtDur(todayMs)}`)}\n`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function cmdStatus(flags = {}) {
  // `--json` 是一次性快照（脚本要的），不该被 --watch 变成刷屏。
  if (flags.watch && !flags.json) return statusWatch();
  // 先按名字确认端口上真的是我们：别的本地服务回 200 + JSON 时，
  // `running: true` 和一份没有 sessions 的对象都是一句假话。
  const healthy = await client.health();
  printStatus(healthy ? await client.snapshot() : null, flags);
}

async function cmdDemo() {
  // 没起服务就演，等于对着空气说台词：终端照打 demo done，机器人一动不动。
  if (!(await client.health())) {
    console.error(`${c.red('●')} no server listening — run: bao start`);
    process.exit(1);
  }
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
    const res = await client.setState({ state, detail, agent: 'demo', session: 'demo:1' });
    // 端口被别的程序占用、token 不匹配时 setState 返回 null / {error}：这时
    // 「demo done」是句谎话。立刻停，别让用户盯着一个没动的机器人等 15 秒。
    if (!res || res.error) {
      console.error(`${c.red('●')} the robot did not accept the write — is it the right server? (bao doctor)`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${DOT[state]()} ${state}${detail ? ' — ' + detail : ''}\n`);
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
    // pty 代理不能用 `bao wrap -- ${r.n}` 拼命令：cursor 的真实二进制是
    // cursor-agent，copilot/cline/windsurf 要 `--agent X -- X` 才能指对。agents.js
    // 的 detail 里已经存了正确命令（`bao wrap --agent cursor -- cursor-agent`），
    // 列表必须和详情一致，照抄才跑得起来。
    const setup = r.tier === 'pty' ? String(r.detail || '').replace(/`/g, '').trim()
      : r.tier === 'log' ? `bao watch ${r.n}`
        : `bao connect ${r.n}`;
    console.log(`  ${r.n.padEnd(12)} ${String(r.how).padEnd(30)} ${setup}`);
  }
  console.log('');
  console.log(c.dim('  Anything else: bao hook --agent <name>  (one JSON event on stdin)'));
  console.log(c.dim('  Or over HTTP (writes need the local token):'));
  console.log(c.dim("    $h = @{ 'x-bao-token' = (bao token) }"));
  console.log(c.dim('    Invoke-RestMethod -Headers $h "http://127.0.0.1:4747/set/busy?agent=my-bot"\n'));
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
  // CodeBuddy / WorkBuddy 的一轮轮对话写在 projects/<项目>/<session>.jsonl 里，
  // 记录是带类型的（reasoning / function_call / message），通用 JSONL reader 认不出。
  const useTranscripts = target === 'codebuddy' && !flags.jsonl;
  const watcher = useDsh ? require('./adapters/dsh-watch')
    : useTranscripts ? require('./adapters/wbt-watch')
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
// 两个 `watch all` 会把同一份日志盯两遍：CPU 翻倍，两棵树各自上报同一批会话，
// 界面上的「忙碌时长」也会被重复计。用一个 pid 锁挡住第二次启动。锁里的进程已经
// 不在了（崩溃留下的陈锁）就当作没有锁。
function watchAllLockFile() {
  return path.join(config.DIR, 'watch-all.pid');
}

function acquireWatchAllLock() {
  const file = watchAllLockFile();
  try {
    const pid = Number(String(fs.readFileSync(file, 'utf8')).trim());
    if (pid && pid !== process.pid) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { /* 已经不在了 */ }
      if (alive) {
        console.error(`${c.yel('!')} another \`bao watch all\` is already running (pid ${pid}) — nothing to do.`);
        console.error(c.dim('  two of them would watch the same logs twice. Stop that one first if you want a fresh start.'));
        return false;
      }
    }
  } catch { /* 没有锁 = 直接拿 */ }
  try { config.ensureDir(); fs.writeFileSync(file, String(process.pid)); } catch { /* 写不进也别挡住功能 */ }
  return true;
}

function releaseWatchAllLock() {
  const file = watchAllLockFile();
  try {
    if (Number(String(fs.readFileSync(file, 'utf8')).trim()) === process.pid) fs.unlinkSync(file);
  } catch { /* 不是我们的，或已经被清掉 */ }
}

function cmdWatchAll(flags = {}) {
  // `--supervised` 表示这个 watcher 是被 `bao start` 拉起并守护的。它只需要
  // 区分一种情况：锁被另一个 watcher 占着（别人已经在干活）——这时用退出码 3
  // 告诉守护者「别再重启我」，否则会每 5 秒重启一个注定失败的子进程。
  const supervised = !!flags.supervised;
  if (!acquireWatchAllLock()) {
    if (supervised) process.exitCode = 3;
    return undefined;
  }
  const SOURCES = [
    ['codex', 'log-watch'],
    ['deepseek', 'dsh-watch'],
    ['workbuddy', 'task-watch'],
    ['codebuddy', 'wbt-watch'],
  ];
  // 每 30 秒重试一次没起来的来源：软件可能是开机之后才装的、日志目录可能被
  // 挪走又挪回来。以前启动时找不到就直接退出，那个 source 从此永远缺席，
  // 直到用户手动重启一次 —— 而这正是「需要人工干预」的来源。
  const RETRY_MS = Number(flags.retry) > 0 ? Number(flags.retry) : 30_000;

  const handles = new Map();
  const pending = new Map(SOURCES);
  const started = new Set();
  const warned = new Set();
  let retryTimer = null;

  const startSource = (name, mod) => {
    if (handles.has(name)) return true;
    try {
      const w = require(`./adapters/${mod}`);
      // throwOnMissing: a missing log directory must not call process.exit()
      // here — that would kill every other watcher in this process.
      const h = w.run({
        agent: name, quiet: flags.quiet, interval: flags.interval, throwOnMissing: true,
      });
      handles.set(name, h);
      pending.delete(name);
      if (!started.has(name)) {
        started.add(name);
        console.log(`${c.grn('●')} watching ${name}`);
      }
      return true;
    } catch (err) {
      // 每个来源只解释一次；之后每 30 秒的静默重试不该刷屏。
      if (!warned.has(name)) {
        warned.add(name);
        console.error(`${c.yel('!')} ${name} watcher not ready: ${err.message}`);
      }
      return false;
    }
  };

  for (const [name, mod] of [...pending]) startSource(name, mod);

  if (started.size) {
    console.log(`${c.grn('●')} watching ${[...started].join(' · ')} — Ctrl+C to stop`);
  } else {
    console.error(`${c.dim('  no watchable log source yet — checking again every 30s')}`);
  }
  if (pending.size) {
    retryTimer = setInterval(() => {
      for (const [name, mod] of [...pending]) startSource(name, mod);
      if (!pending.size) {
        clearInterval(retryTimer);
        retryTimer = null;
        console.log(`${c.grn('●')} watching ${[...started].join(' · ')} — Ctrl+C to stop`);
      }
    }, RETRY_MS);
  }

  const stop = () => {
    clearInterval(retryTimer);
    retryTimer = null;
    for (const h of handles.values()) {
      try {
        // 各 run() 都返回 { stop }；这个 else 分支留给以后某个返回定时器的实现。
        if (h && typeof h.stop === 'function') h.stop();
        else if (h && typeof h === 'object') clearInterval(h);
      } catch { /* 已经在停 */ }
    }
    releaseWatchAllLock();
  };
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
      console.log(c.dim('    npm install -g https://github.com/baoan778/baoanlight/releases/latest/download/baoanlight.tgz'));
      console.log(c.dim('    bao connect claude'));
    }
    return;
  }
  if (target === 'codebuddy' || target === 'workbuddy') {
    // CodeBuddy 的 hook 表只在它启动时读一次，所以要重启 IDE 才生效；
    // transcript 观察器（bao watch codebuddy）不需要重启，两套可以同时用。
    let r;
    try {
      r = install.installCodebuddy();
    } catch (err) {
      console.error(`${c.red('✗')} ${err.message}`);
      console.error(c.dim('  Nothing was written. Fix or move that file, then run it again.'));
      process.exitCode = 1;
      return;
    }
    console.log(`${c.grn('●')} CodeBuddy hooks installed (${r.events} events)`);
    console.log(c.dim(`  ${r.file}`));
    if (r.backup) console.log(c.dim(`  backup: ${r.backup}`));
    console.log(c.yel('  Restart CodeBuddy once — it reads the hook table at startup.'));
    console.log('');
    console.log(`${c.grn('✓')} Then every prompt and tool call updates the robot in real time.`);
    console.log(c.dim('  Without the restart, `bao watch codebuddy` still works from the transcript.'));
    return;
  }
  if (target === 'codex') {
    let r;
    try {
      r = install.installCodex();
    } catch (err) {
      // 读不到 / 写不进用户的 config.toml（权限、被 Codex 占用、杀软）：和上面
      // 两个入口一样，说清楚原因，而不是甩一段堆栈。
      console.error(`${c.red('✗')} ${err.message}`);
      console.error(c.dim('  Nothing was changed. Fix or move that file, then run it again.'));
      process.exitCode = 1;
      return;
    }
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
    let r;
    try {
      r = install.uninstallCodex();
    } catch (err) {
      console.error(`${c.red('✗')} ${err.message}`);
      console.error(c.dim('  Nothing was changed.'));
      process.exitCode = 1;
      return;
    }
    console.log(r.removed ? `removed baoanlight notify from ${r.file}` : `no baoanlight notify in ${r.file} — nothing to do`);
    return;
  }
  if (target === 'codebuddy' || target === 'workbuddy') {
    let r;
    try {
      r = install.uninstallCodebuddy();
    } catch (err) {
      console.error(`${c.red('✗')} ${err.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(r.removed
      ? `removed baoanlight hooks from ${r.file} (restart CodeBuddy to apply)`
      : `no baoanlight hooks in ${r.file} — nothing to do`);
    return;
  }
  console.error('usage: bao disconnect <claude|codex|codebuddy>');
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
  // WorkBuddy 没有任务板时，仍可能被 CodeBuddy 观察器按逐轮 transcript 实时跟踪。
  const wbTranscript = agents.transcriptCoverage('workbuddy', { config: cfg });
  const has = {
    codex: detect('codex'),
    deepseek: detect('deepseek'),
    workbuddy: detect('workbuddy'),
    codebuddy: detect('codebuddy'),
  };

  console.log(`\n${c.b('baoanlight onboarding')}\n`);
  console.log('  在这台机器上发现：');
  console.log(`    ${'Claude Code'.padEnd(15)}${claudeHooked ? c.grn('✓ 已装钩子') : (claudePresent ? c.yel('○ 已安装，未接') : c.dim('○ 未找到'))}`);
  console.log(`    ${'Codex'.padEnd(15)}${has.codex ? c.grn('✓ 找到日志') : c.dim('○ 未找到')}`);
  console.log(`    ${'DeepSeek Harness'.padEnd(15)}${has.deepseek ? c.grn('✓ 找到日志') : c.dim('○ 未找到')}`);
  console.log(`    ${'WorkBuddy'.padEnd(15)}${
    has.workbuddy ? c.grn('✓ 找到任务板')
      : (wbTranscript ? c.grn('✓ 逐轮日志（CodeBuddy 观察器读取）') : c.dim('○ 未找到'))}`);
  console.log(`    ${'CodeBuddy'.padEnd(15)}${has.codebuddy ? c.grn('✓ 找到日志') : c.dim('○ 未找到')}`);
  console.log('');

  const options = [];
  options.push(`  ${c.b('1')}  Claude Code    ${c.dim('写入钩子，三态精确')}`);
  if (has.codex) options.push(`  ${c.b('2')}  Codex          ${c.dim('bao watch codex')}`);
  if (has.deepseek) options.push(`  ${c.b('3')}  DeepSeek       ${c.dim('bao watch deepseek')}`);
  if (has.workbuddy) options.push(`  ${c.b('4')}  WorkBuddy      ${c.dim('bao watch workbuddy')}`);
  if (has.codebuddy) options.push(`  ${c.b('5')}  CodeBuddy      ${c.dim('bao watch codebuddy')}`);
  if (has.codex || has.deepseek || has.workbuddy || has.codebuddy) {
    options.push(`  ${c.b('A')}  全部日志观察器 ${c.dim('bao watch all，后台常驻')}`);
  }
  options.push(`  ${c.b('S')}  跳过，直接启动机器人`);

  console.log('  想先接哪个？\n');
  console.log(options.join('\n'));
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  (async () => {
    const choice = await question(rl, '  选一个（回车 = 跳过）: ');
    rl.close();

    if (choice === '1' || (choice === '' && claudePresent && !claudeHooked)) {
      let r;
      try {
        r = install.installClaude({ scope: 'user' });
      } catch (err) {
        // settings.json 读不出来 / 不是合法 JSON：不写任何东西，说清楚为什么。
        // 和 cmdInstall 同一套错误处理 —— onboarding 更不能让人「选了 1」就
        // 静默退出，连错在哪一步都不知道。
        console.error(`\n${c.red('✗')} ${err.message}`);
        console.error(c.dim('  Nothing was written. Fix or move that file, then run: bao connect claude'));
        process.exitCode = 1;
        return;
      }
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
    } else if (choice === '5' && has.codebuddy) {
      console.log(`\n${c.grn('●')} 让 CodeBuddy 上报：`);
      console.log(`    ${c.b('bao watch codebuddy')}`);
      console.log(c.dim('  （每轮结束才更新；要实时用 `bao connect codebuddy`，需重启 IDE）'));
    } else if (choice === 'a' && (has.codex || has.deepseek || has.workbuddy || has.codebuddy)) {
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
  })().catch((err) => {
    // 别裸 exit：哪怕是上面 try 漏掉的路径，也得让人知道为什么没装成。
    console.error(`${c.red('✗')} ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
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
    case 'supervise':  return cmdSupervise(flags);
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
    case 'setup': {
      // 把子进程的退出码带回来：下载失败时 setup.js 退出 1，而这里以前直接
      // return 它的结果值，进程本身仍然是 0 —— 脚本/CI 会以为装好了。
      const r = require('child_process')
        .spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup.js')], { stdio: 'inherit' });
      if (r.status) process.exitCode = r.status;
      return;
    }
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

// 只在作为命令运行时执行：测试要 require 这里的纯函数（例如 startChildArgs），
// 不能因为 import 一次就把整个 CLI 跑起来。
if (require.main === module) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}

module.exports = { parse, printStatus, startChildArgs, needsWindow, ensureWindowRuntime };
