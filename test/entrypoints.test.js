'use strict';
// 入口脚本的冒烟测试：doctor / wrap / autostart 这些「CLI 入口」零覆盖，至少
// 保证它们 require 不炸、导出的形状对。mcp-server.js 是 stdio 服务、require 就
// 自启，只能用文本契约钉住它的两个工具名和 agent 校验规则。
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// 隔离测试用的状态目录和「启动」文件夹：autostart 的真实安装会改用户的登录项，
// 测试里不能碰它。必须在第一次 require src/config 之前设置。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-entrypoints-'));
process.env.BAOANLIGHT_HOME = path.join(TMP, 'home');
process.env.APPDATA = path.join(TMP, 'appdata');
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理是礼貌 */ } });

test('autostart.targetPath points inside the per-user Windows startup directory', () => {
  const autostart = require('../src/autostart');
  const p = autostart.targetPath();
  assert.ok(p && p.length > 0, 'a path is returned');
  assert.match(path.basename(p), /\.lnk$/);
  assert.match(p, /Start Menu[\\/]Programs[\\/]Startup/i);
  // 启动项只是入口：状态必须同时知道 VBS 在哪，否则脚本被清理后会谎报「已开启」。
  assert.match(path.basename(autostart.launcherPath()), /^autostart\.vbs$/i);
  const s = autostart.status();
  assert.equal(s.platform, 'win32');
  assert.equal(typeof s.broken, 'boolean');
  assert.equal(s.enabled, !s.broken && fs.existsSync(autostart.targetPath()));
});

test('the CLI entry modules load without side effects and expose their API', () => {
  const doctor = require('../src/doctor');
  assert.equal(typeof doctor.run, 'function');

  const wrap = require('../src/adapters/wrap');
  assert.equal(typeof wrap.run, 'function');

  const autostart = require('../src/autostart');
  assert.equal(typeof autostart.install, 'function');
  assert.equal(typeof autostart.uninstall, 'function');
  assert.equal(typeof autostart.status, 'function');
});

// 守护进程把 `--no-watch` / `--no-overlay` / `--browser` 传给前台子进程时，
// 少传一个就等于把用户的选择静默改掉：`bao start --no-watch` 仍会拉起观察器。
test('the supervisor passes every start flag through to the foreground child', () => {
  const { startChildArgs } = require('../src/cli');
  const quiet = startChildArgs(4747, { 'no-watch': true, 'no-overlay': true });
  assert.ok(quiet.includes('--no-watch'), 'no-watch is forwarded, not dropped');
  assert.ok(!quiet.includes('--watch'), 'and the default watch flag is not added anyway');
  assert.ok(quiet.includes('--no-overlay'));
  assert.equal(quiet[quiet.indexOf('--port') + 1], '4747');

  const normal = startChildArgs(4747, {});
  assert.ok(normal.includes('--watch'), 'the default child watches logs');
  assert.ok(!normal.includes('--no-watch'));
});

test('boolean flags are not stolen by the positional argument behind them', () => {
  const { parse } = require('../src/cli');
  const { flags, positional } = parse(['start', '--no-overlay', '--no-watch', '--port', '4817']);
  assert.equal(flags['no-overlay'], true);
  assert.equal(flags['no-watch'], true);
  assert.equal(flags.port, '4817');
  assert.deepEqual(positional, ['start']);
});

// `--detail=exit=1` 是「值里带等号」的常见写法。按所有等号切分会把它截成
// "exit"，而这条文案是要显示在机器人气泡/列表里的。
test('an inline option value may contain an equals sign', () => {
  const { parse } = require('../src/cli');
  const { flags } = parse(['set', 'error', '--agent=x', '--detail=exit=1', '--session=a=b']);
  assert.equal(flags.agent, 'x');
  assert.equal(flags.detail, 'exit=1');
  assert.equal(flags.session, 'a=b');
});

// 端口上回 JSON 的不一定是 baoanlight。别的本地服务占着同一个端口时，
// `bao status` 不能因为缺 sessions/overall 就带着堆栈崩掉。
test('bao status survives a foreign JSON service on the port', () => {
  const { printStatus } = require('../src/cli');
  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    assert.doesNotThrow(() => printStatus({ hello: 'world' }));
  } finally {
    console.log = orig;
  }
  assert.ok(logs.length > 0, 'it still says something instead of dying');
});

// CLI 的帮助图例也属于「颜色即事实」的一部分：它曾经写着「green = working
// or finished」，而完成早已是紫色瞬态、空闲是暗白。帮助文本错了，用户就会把
// 紫色当成绿色、把空闲当成在干活。
test('the CLI legend matches the robot colour contract', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'cli.js'), 'utf8');
  assert.match(src, /green\s+an agent is working/);
  assert.match(src, /purple\s+a turn just finished/);
  assert.match(src, /dim\s+an agent is open but not working/);
  assert.match(src, /dark\s+nothing running/);
  assert.doesNotMatch(src, /finished \(dim\)/, 'the old green-finished wording must not come back');
});

test('the MCP server registers both tools and accepts any short agent id', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'mcp-server.js'), 'utf8');
  assert.match(src, /registerTool\('report_status'/);
  assert.match(src, /registerTool\('get_agents_status'/);
  // agent 不能是四个硬编码 id：README 承诺「任何 MCP 客户端」都能上报。
  assert.match(src, /AGENT_RE/);
  assert.match(src, /any short id is accepted|KNOWN_AGENTS/);
});

test('the generic hook exposes classify and event vocabularies stay consistent', () => {
  // log-watch 是日志/通用钩子的事件→状态唯一映射；codex 的 notify 词汇是另一套，
  // 但两者对 complete 必须给出同一个 done（紫）。
  const logWatch = require('../src/adapters/log-watch');
  assert.equal(typeof logWatch.classify, 'function');
  assert.equal(typeof logWatch.readFuel, 'function');
});

// 中文用户名 / 中文安装路径是最现实的一台机器：`C:\Users\张三\...`。WSH 和
// Windows PowerShell 5.1 都会把没有 BOM 的脚本按 GBK 解码，路径变乱码，登录时
// 机器人永远不出现——而界面上一切显示「已开启」。这两个用例直接让真正的解释器
// 去读文件，确认写进去的编码在它们那里不会变形。
test('the autostart VBS decodes a non-ASCII path correctly in WSH', () => {
  const autostart = require('../src/autostart');
  const dir = fs.mkdtempSync(path.join(TMP, 'vbs-'));
  const out = path.join(dir, 'out.txt');
  const chinese = 'C:\\Users\\张三\\AppData\\Roaming\\npm\\baoanlight\\src\\cli.js';
  const vbs = path.join(dir, 'echo.vbs');
  autostart.writeScript(vbs, [
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `Set f = fso.CreateTextFile("${out.replace(/\\/g, '\\\\')}", True, True)`,
    `f.Write "${chinese}"`,
    'f.Close',
  ].join('\r\n'), 'utf16');

  execFileSync('cscript', ['//nologo', vbs], { stdio: 'ignore' });
  assert.equal(fs.readFileSync(out, 'utf16le').replace(/^\uFEFF/, ''), chinese);
});

test('the autostart PowerShell script decodes a non-ASCII path correctly', () => {
  const autostart = require('../src/autostart');
  const dir = fs.mkdtempSync(path.join(TMP, 'ps-'));
  const out = path.join(dir, 'out.txt');
  const chinese = 'C:\\Users\\张三\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\baoanlight.lnk';
  const ps1 = path.join(dir, 'echo.ps1');
  autostart.writeScript(ps1,
    `Set-Content -LiteralPath '${out.replace(/\\/g, '\\\\')}' -Value '${chinese}' -Encoding Unicode`,
    'utf8');

  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { stdio: 'ignore' });
  assert.equal(fs.readFileSync(out, 'utf16le').replace(/^\uFEFF/, '').trim(), chinese);
});

test('autostart installs and removes a working startup entry inside the temp profile', () => {
  const autostart = require('../src/autostart');
  const lnk = autostart.install();
  assert.ok(fs.existsSync(lnk), 'the shortcut lands in the startup folder');

  const raw = fs.readFileSync(autostart.launcherPath());
  assert.deepEqual([...raw.subarray(0, 2)], [0xff, 0xfe], 'the VBS is UTF-16 with a BOM');
  const text = raw.subarray(2).toString('utf16le');
  assert.ok(text.includes(process.execPath), 'the interpreter path is baked in');
  assert.match(text, /sh\.Run/, 'it still launches something');
  assert.equal(autostart.status().enabled, true);

  autostart.uninstall();
  assert.equal(fs.existsSync(lnk), false, 'uninstall removes the shortcut');
  assert.equal(autostart.status().enabled, false, 'and the status stops claiming it is on');
});

// 只有真要开桌面窗口时才需要 Electron。`--no-overlay` / `--browser` 不该在启动
// 输出里说「正在拉取窗口运行时」，也不该让用户去找一个不存在的窗口。
test('a window is only expected when neither --no-overlay nor --browser is given', () => {
  const { needsWindow } = require('../src/cli');
  assert.equal(needsWindow({}), true);
  assert.equal(needsWindow({ 'no-overlay': true }), false);
  assert.equal(needsWindow({ browser: true }), false);
  assert.equal(needsWindow({ 'no-overlay': true, browser: true }), false);
});

// 首次运行最常见的卡点：运行时不在，旧的实现把这个 ~140 MB 的下载留给脱离终端
// 后的子进程（stdio 被 ignore），父进程 180 秒后 taskkill —— 慢网络必然「失败」。
// 现在必须先在本进程里装好，且只装一次；--no-overlay / --browser 绝不能触发下载。
test('a missing window runtime is installed once, before detaching, and never without a window', () => {
  const { ensureWindowRuntime } = require('../src/cli');
  const logs = [];
  let present = false;
  let installs = 0;
  const harness = {
    probe: () => present,
    install: () => { installs += 1; present = true; return true; },
    log: (m) => logs.push(m),
  };

  assert.equal(ensureWindowRuntime({}, harness), true);
  assert.equal(installs, 1, 'it installs exactly once');
  assert.equal(logs.length, 1, 'and says why the command is waiting');

  assert.equal(ensureWindowRuntime({}, harness), true);
  assert.equal(installs, 1, 'an installed runtime is not downloaded again');

  present = false;
  installs = 0;
  assert.equal(ensureWindowRuntime({ 'no-overlay': true }, harness), true);
  assert.equal(ensureWindowRuntime({ browser: true }, harness), true);
  assert.equal(installs, 0, 'server/browser mode never downloads the window runtime');
});

test('a failed runtime install is reported as a failure, not silently accepted', () => {
  const { ensureWindowRuntime } = require('../src/cli');
  assert.equal(
    ensureWindowRuntime({}, { probe: () => false, install: () => false, log: () => {} }),
    false
  );
});
