'use strict';
// Electron 缓存选择：多个版本/架构并存时，必须挑和当前安装匹配的那一个。
const { test } = require('node:test');
const assert = require('node:assert');
const { pickCachedZip } = require('../scripts/setup');

test('the exact version and architecture wins over an older cache entry', () => {
  const files = [
    'C:/cache/a/electron-v37.0.0-win32-x64.zip',
    'C:/cache/b/electron-v38.0.0-win32-arm64.zip',
    'C:/cache/c/electron-v38.0.0-win32-x64.zip',
  ];
  assert.equal(
    pickCachedZip(files, { version: '38.0.0', platform: 'win32', arch: 'x64' }),
    'C:/cache/c/electron-v38.0.0-win32-x64.zip',
  );
});

test('it prefers the right version when the architecture is not in the name', () => {
  const files = ['electron-v37.0.0-win32-x64.zip', 'electron-v38.0.0-win32-x64.zip'];
  assert.equal(
    pickCachedZip(files, { version: '38.0.0', platform: 'win32', arch: 'x64' }),
    'electron-v38.0.0-win32-x64.zip',
  );
});

test('it prefers the right architecture over a newer wrong-arch zip', () => {
  const files = ['electron-v36.0.0-win32-x64.zip', 'electron-v38.0.0-win32-arm64.zip'];
  assert.equal(
    pickCachedZip(files, { version: '38.0.0', platform: 'win32', arch: 'x64' }),
    'electron-v36.0.0-win32-x64.zip',
  );
});

test('it falls back to the requested version, then to the first zip', () => {
  const files = ['electron-v38.0.0-win32-arm64.zip', 'unrelated.zip'];
  assert.equal(
    pickCachedZip(files, { version: '38.0.0', platform: 'win32', arch: 'x64' }),
    'electron-v38.0.0-win32-arm64.zip',
  );
  assert.equal(pickCachedZip(['a.zip', 'b.zip'], { version: '38.0.0' }), 'a.zip');
});

test('no zip means no answer, not a guess', () => {
  assert.equal(pickCachedZip([], { version: '38.0.0' }), null);
  assert.equal(pickCachedZip(['readme.txt'], { version: '38.0.0' }), null);
});
