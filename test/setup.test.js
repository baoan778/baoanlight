'use strict';
// Electron 缓存选择：多个版本/架构并存时，必须挑和当前安装匹配的那一个。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  pickCachedZip, installHint, mirrorCandidates, runDownloader, CN_MIRROR,
} = require('../scripts/setup');

// Electron 官方包在 GitHub，国内经常下载不动。官方源失败后必须自动换镜像；
// 但用户自己指定了 ELECTRON_MIRROR 时不能擅自改他的选择。
test('the official source is tried first, then the mirror — unless the user chose one', () => {
  assert.deepEqual(mirrorCandidates({}), [null, CN_MIRROR]);
  assert.deepEqual(mirrorCandidates({ ELECTRON_MIRROR: 'https://corp.example/e/' }), [null]);
});

test('the fallback attempt only rewrites the environment for the mirror', () => {
  const seen = [];
  const run = (script, opts) => seen.push({ script, env: opts.env });
  runDownloader(null, { electronDir: 'E:/fake/electron', run, log: () => {} });
  runDownloader(CN_MIRROR, { electronDir: 'E:/fake/electron', run, log: () => {} });

  assert.equal(seen.length, 2);
  assert.equal(seen[0].script, 'install.js');
  assert.equal(seen[0].env.ELECTRON_MIRROR, undefined, 'the first try uses the untouched environment');
  assert.equal(seen[1].env.ELECTRON_MIRROR, CN_MIRROR);
});

// 真实执行一个假的 install.js：官方源（没有 ELECTRON_MIRROR）失败，换镜像后成功。
// 这条用例证明「下载器失败不会拦住下一次尝试」，而不是只检查参数拼装。
test('a download that fails on the official source still succeeds on the mirror', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-mirror-'));
  fs.writeFileSync(path.join(dir, 'install.js'), [
    "'use strict';",
    "if (!process.env.ELECTRON_MIRROR) process.exit(1);",
    "require('fs').writeFileSync(require('path').join(__dirname, 'ok.txt'), process.env.ELECTRON_MIRROR);",
  ].join('\n'));

  runDownloader(null, { electronDir: dir, log: () => {} });
  assert.equal(fs.existsSync(path.join(dir, 'ok.txt')), false, 'the first attempt really failed');

  runDownloader(CN_MIRROR, { electronDir: dir, log: () => {} });
  assert.equal(fs.readFileSync(path.join(dir, 'ok.txt'), 'utf8'), CN_MIRROR);
});

// Electron 包整个缺失时（`--omit=optional`、代理把包丢掉、npm 跳过失败的 optional
// 依赖），`bao setup` 没法再下载自己——所以提示不能是「再跑一次 bao setup」。
test('the missing-Electron hint never sends the user back to the same command', () => {
  assert.doesNotMatch(installHint({ checkout: false }), /^\s*bao setup\s*$/);
  assert.match(installHint({ checkout: false }), /npm install -g baoanlight/);
  assert.match(installHint({ checkout: true }), /npm install/);
  assert.match(installHint({ checkout: true }), /npm run setup/);
});

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
