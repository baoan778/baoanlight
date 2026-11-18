'use strict';
// 打开终端的纯逻辑：哪些路径允许、Windows 怎么起进程。不需要 Electron。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { safeDir, openTerminal } = require('../src/overlay/terminal');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-terminal-'));

function fakeSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return {
      on(evt) { if (evt === 'error') calls.at(-1).errorHandled = true; },
      unref() { calls.at(-1).unref = true; },
    };
  };
  fn.calls = calls;
  return fn;
}

test('a real existing directory is accepted', () => {
  assert.equal(safeDir(dir), path.resolve(dir));
  assert.equal(safeDir(''), null);
  assert.equal(safeDir(null), null);
  assert.equal(safeDir(path.join(dir, 'does-not-exist')), null);
});

test('paths that could be re-parsed by cmd are refused', () => {
  for (const bad of ['%TEMP%', '$HOME', '`whoami`', 'C:\\a"b', 'C:\\a\r\nb', 'C:\\a\0b']) {
    assert.equal(safeDir(bad), null, bad);
  }
});

test('Windows opens the terminal with cwd, never a cd string', () => {
  const spawn = fakeSpawn();
  assert.equal(openTerminal(dir, { spawnImpl: spawn }), true);
  assert.equal(spawn.calls.length, 1);
  const call = spawn.calls[0];
  assert.equal(call.cmd, 'cmd');
  assert.deepEqual(call.args, ['/c', 'start', 'cmd', '/k']);
  assert.equal(call.opts.cwd, path.resolve(dir), 'the directory arrives as cwd');
  assert.ok(!call.args.join(' ').includes('cd /d'), 'no shell string interpolation');
  assert.equal(call.unref, true);
  assert.equal(call.errorHandled, true, 'async spawn errors must not crash the main process');
});

test('an unsafe or missing path never spawns anything', () => {
  const spawn = fakeSpawn();
  assert.equal(openTerminal('C:\\a%TEMP%', { spawnImpl: spawn }), false);
  assert.equal(openTerminal(path.join(dir, 'nope'), { spawnImpl: spawn }), false);
  assert.equal(spawn.calls.length, 0);
});

test('a spawn that throws degrades to false', () => {
  assert.equal(openTerminal(dir, {
    spawnImpl: () => { throw new Error('no terminal'); },
  }), false);
});
