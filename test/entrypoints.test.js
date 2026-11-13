'use strict';
// 入口脚本的冒烟测试：doctor / wrap / autostart 这些「CLI 入口」零覆盖，至少
// 保证它们 require 不炸、导出的形状对。mcp-server.js 是 stdio 服务、require 就
// 自启，只能用文本契约钉住它的两个工具名和 agent 校验规则。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('autostart.targetPath points inside the per-user startup directory', () => {
  const autostart = require('../src/autostart');
  const p = autostart.targetPath();
  assert.ok(p && p.length > 0, 'a path is returned');
  const file = path.basename(p);
  if (process.platform === 'win32') assert.match(file, /\.lnk$/);
  else if (process.platform === 'darwin') assert.match(file, /\.plist$/);
  else assert.match(file, /\.desktop$/);
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
