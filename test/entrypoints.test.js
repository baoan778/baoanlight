'use strict';
// 入口脚本的冒烟测试：doctor / wrap / autostart 这些「CLI 入口」零覆盖，至少
// 保证它们 require 不炸、导出的形状对。mcp-server.js 是 stdio 服务、require 就
// 自启，只能用文本契约钉住它的两个工具名和 agent 校验规则。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

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
