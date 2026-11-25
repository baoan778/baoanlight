'use strict';
// `bao connect codebuddy` 会改写用户的 IDE 配置 —— 它必须只动自己那一行。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 隔离 HOME：install.js 在模块加载时就把 HOME 定死了，所以必须先改环境再 require。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-cb-'));
process.env.USERPROFILE = tmpHome;   // Windows: os.homedir()
process.env.HOME = tmpHome;          // POSIX
process.env.BAOANLIGHT_HOME = path.join(tmpHome, '.baoanlight');

const install = require('../src/adapters/install');

const settingsFile = () => path.join(tmpHome, '.codebuddy', 'settings.json');
const read = () => JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));

test('installing codebuddy hooks keeps the hooks that were already there', () => {
  fs.mkdirSync(path.join(tmpHome, '.codebuddy'), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ command: "bash '/c/Users/x/.wb-switch/hook.sh'", type: 'command' }], matcher: '' }],
    },
    enabledPlugins: { 'pptx@codebuddy-plugins-official': true },
    permissions: { allow: ['Bash'] },
  }, null, 2));

  const r = install.installCodebuddy();
  assert.ok(r.backup, 'a backup is written before touching the file');
  assert.equal(r.needsRestart, true, 'hooks are read at IDE startup, so say so');

  const after = read();
  // 别人的 hook 必须原样还在
  const stopCmds = (after.hooks.Stop || []).flatMap((g) => (g.hooks || []).map((h) => h.command));
  assert.ok(stopCmds.some((c) => c.includes('.wb-switch')), 'the foreign Stop hook survives');
  assert.ok(stopCmds.some((c) => c.includes('hooks/claude.js') || c.includes('hooks\\claude.js')),
    'ours is added alongside it');
  // 配置的其它部分一个字节都不该动
  assert.deepEqual(after.enabledPlugins, { 'pptx@codebuddy-plugins-official': true });
  assert.deepEqual(after.permissions, { allow: ['Bash'] });
  // 结构化事件都装上了
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'FinalStop', 'SessionEnd']) {
    assert.ok(Array.isArray(after.hooks[ev]) && after.hooks[ev].length, `${ev} is wired`);
  }
  assert.ok(install.codebuddyHookCount() >= 7, 'and the doctor can count them');
});

test('disconnecting removes only our hooks', () => {
  const r = install.uninstallCodebuddy();
  assert.ok(r.removed > 0);

  const after = read();
  const all = Object.values(after.hooks || {})
    .flat()
    .flatMap((g) => (g.hooks || []).map((h) => h.command));
  assert.equal(all.every((c) => !/hooks[\\/]claude\.js/.test(c)), true, 'none of ours is left');
  assert.ok(all.some((c) => c.includes('.wb-switch')), 'the foreign hook is still there');
  assert.deepEqual(after.enabledPlugins, { 'pptx@codebuddy-plugins-official': true });
  assert.equal(install.codebuddyHookCount(), 0);
});

test('a broken settings file is never overwritten', () => {
  fs.writeFileSync(settingsFile(), '{ not json');
  assert.throws(() => install.installCodebuddy(), /not valid JSON/);
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), '{ not json', 'the file is left exactly as it was');
});

// 形状错误的 hooks 表同样不能「装成功」：往数组里写字符串键会被 JSON 序列化
// 丢掉，界面打印已安装，实际一条也没有。
test('a hooks value that is not an object is refused instead of silently dropped', () => {
  fs.mkdirSync(path.join(tmpHome, '.codebuddy'), { recursive: true });
  const broken = JSON.stringify({ hooks: 'nope' }, null, 2);
  fs.writeFileSync(settingsFile(), broken);
  assert.throws(() => install.installCodebuddy(), /refusing to overwrite/i);
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), broken, 'the user file survived untouched');
  assert.equal(install.uninstallCodebuddy().removed, 0, 'uninstall leaves a malformed file alone too');
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), broken);
});
