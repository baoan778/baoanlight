'use strict';
// 启动自检的两个易错点：
//   1. 同一个故障只报一次，而且报对（坏 JSON ≠ 未安装）；
//   2. 它覆盖的代理清单必须来自 agents 表，不能是手写的副本 —— 副本不会跟着
//      新代理长大，而且不会报错，只是那个代理永远不出现在自检里。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const install = require('../src/adapters/install');
const agents = require('../src/adapters/agents');
const selfcheck = require('../src/selfcheck');

const withSettings = (content, fn) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bao-sc-')), 'settings.json');
  fs.writeFileSync(file, content);
  const original = install.claudeSettingsPath;
  install.claudeSettingsPath = () => file;
  try {
    return fn(file);
  } finally {
    install.claudeSettingsPath = original;
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
};

const claudeChecks = (result) => result.checks.filter((c) => c.name.includes('Claude'));

test('a settings file we cannot parse is reported once, as a failure', () => {
  withSettings('{ "hooks": { ,,, }', () => {
    const related = claudeChecks(selfcheck.run());
    assert.equal(related.filter((c) => c.status === 'fail').length, 1,
      'the broken file is exactly one failure');
    assert.equal(related.filter((c) => c.status === 'warn').length, 0,
      'and it must not also be reported as "not installed" — two contradictory lines');
  });
});

test('missing hooks are a warning, not a failure', () => {
  withSettings('{"permissions":{"allow":[]}}', () => {
    const related = claudeChecks(selfcheck.run());
    assert.deepEqual(related.map((c) => c.status), ['warn'],
      'an uninstalled hook is optional, and must not look broken');
  });
});

test('hooks whose paths no longer exist are a failure', () => {
  const settings = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: '"/no/such/node" "/no/such/hooks/claude.js"' }] }],
    },
  };
  withSettings(JSON.stringify(settings), () => {
    const related = claudeChecks(selfcheck.run());
    assert.equal(related.filter((c) => c.status === 'fail').length, 1,
      'a moved checkout is the single most common cross-machine failure');
  });
});

// 记事本保存的 settings.json 会带 BOM。`bao connect` 和 `bao doctor` 都能正常读，
// 自检若自己 parse 一份，就会把一份能用的配置报成「不是合法 JSON」的 fail。
test('a hook settings file saved with a BOM is not called broken', () => {
  const hook = path.join(__dirname, '..', 'src', 'hooks', 'claude.js');
  const command = `"${process.execPath}" "${hook}"`;
  const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } };
  withSettings('\uFEFF' + JSON.stringify(settings), () => {
    const related = claudeChecks(selfcheck.run());
    assert.equal(related.filter((c) => c.status === 'fail').length, 0,
      'a BOM is an encoding marker, not a broken hook file');
    assert.ok(related.some((c) => c.status === 'pass'), 'the live hook is recognised');
  });
});

// 新增一个「有日志」的代理时，只改 agents.js 就该够了。这条断言盯的是
// selfcheck 有没有偷偷维护第二份名单。
test('the self-check looks at every agent that reports through a log', () => {
  const result = selfcheck.run();
  const names = result.checks.map((c) => c.name);
  const logged = agents.names().filter((n) => (agents.AGENTS[n] || {}).tier === 'log');
  assert.ok(logged.length >= 3, 'precondition: there are log-backed agents');
  for (const name of logged) {
    const { label } = agents.AGENTS[name];
    assert.ok(names.some((n) => n.startsWith(label)),
      `selfcheck never looks at "${name}" (${label}) — the list is hardcoded somewhere`);
  }
});
