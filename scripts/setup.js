#!/usr/bin/env node
'use strict';
// Fetches the Electron runtime the overlay window needs.
//
// This is a separate step because npm 11 blocks package install scripts by
// default, and Electron's postinstall is what downloads its binary. It is also
// where a half-extracted download gets noticed and repaired, rather than showing
// up later as "Electron failed to install correctly".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON_DIR = path.join(ROOT, 'node_modules', 'electron');

function electronBinary() {
  try {
    const p = require(ELECTRON_DIR);
    return typeof p === 'string' && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

// Electron 的下载缓存里可能同时躺着多个版本/架构的 zip。随便拿第一个解出来，
// 在 arm64 机器上解到 x64 包、或把旧版本塞进新目录，表现都是「Electron 坏了」。
// 文件名形如 electron-v38.0.0-win32-x64.zip，优先选与当前 package.json 版本、
// 平台和架构都对得上的那个。
function pickCachedZip(files, {
  version = '', platform = 'win32', arch = process.arch,
} = {}) {
  const list = (Array.isArray(files) ? files : []).filter((f) => /\.zip$/i.test(f));
  if (!list.length) return null;
  const wantVersion = version ? `v${version}` : '';
  const wantPlatform = `${platform}-${arch}`;
  return list.find((f) => (!wantVersion || f.includes(wantVersion)) && f.includes(wantPlatform))
    || list.find((f) => f.includes(wantPlatform))
    || list.find((f) => wantVersion && f.includes(wantVersion))
    || list[0];
}

function cachedZip() {
  const base = path.join(process.env.LOCALAPPDATA || os.homedir(), 'electron', 'Cache');
  if (!fs.existsSync(base)) return null;
  const zips = [];
  let dirs;
  try { dirs = fs.readdirSync(base); } catch { return null; }
  for (const dir of dirs) {
    const sub = path.join(base, dir);
    let entries;
    try { entries = fs.readdirSync(sub); } catch { continue; }
    for (const f of entries) if (/\.zip$/i.test(f)) zips.push(path.join(sub, f));
  }
  let version = '';
  try { version = require(path.join(ELECTRON_DIR, 'package.json')).version; } catch { /* 不知道版本 */ }
  return pickCachedZip(zips, { version });
}

// The downloader reports success even when the unpack leaves an empty dist/, so
// unpack the cached archive ourselves as a fallback.
function extract(zip, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  // 不能把路径插进 -Command 字符串：路径里只要有一个引号或反引号，这条命令
  // 就被改写。走环境变量，PowerShell 自己取值。
  const r = spawnSync('powershell', [
    '-NoProfile', '-Command',
    'Expand-Archive -LiteralPath $env:BAO_ZIP -DestinationPath $env:BAO_DEST -Force',
  ], {
    stdio: 'inherit',
    env: { ...process.env, BAO_ZIP: zip, BAO_DEST: dest },
  });
  if (r.status !== 0) throw new Error(`could not unpack ${zip}`);

  const exe = 'electron.exe';
  if (!fs.existsSync(path.join(dest, exe))) throw new Error('archive unpacked but no Electron binary in it');
  fs.writeFileSync(path.join(ELECTRON_DIR, 'path.txt'), exe);
}

// Electron 的二进制托管在 GitHub Releases。国内网络经常拉不动，而 npm 安装
// optionalDependency 失败是静默跳过的，用户最后只会看到「窗口打不开」。所以
// 官方源失败后自动换 npmmirror 再试一次；用户自己设了 ELECTRON_MIRROR 就只尊重
// 用户的选择，不擅自覆盖。
const CN_MIRROR = 'https://npmmirror.com/mirrors/electron/';

function mirrorCandidates(env = process.env) {
  return env.ELECTRON_MIRROR ? [null] : [null, CN_MIRROR];
}

// 下载器是 electron 包自带的 install.js：它读 ELECTRON_MIRROR。注入 run/log
// 只是为了让「第一次失败、第二次换镜像」这条路径可以被测试钉住。
function runDownloader(mirror, {
  electronDir = ELECTRON_DIR,
  run = (script, opts) => execFileSync(process.execPath, [script], opts),
  log = console.log,
} = {}) {
  const env = mirror ? { ...process.env, ELECTRON_MIRROR: mirror } : process.env;
  if (mirror) log(`The official download failed; retrying from ${mirror}`);
  try {
    run('install.js', { cwd: electronDir, stdio: 'inherit', env });
  } catch { /* 是否真的成功由 electronBinary() 决定，不信任退出码 */ }
}

// 包本身不在 node_modules 里时，`bao setup` 没法「再拉一次」——它下载的是包内的
// install.js，而不是包本身。原来这里让用户「run bao setup」，等于让用户对着同一条
// 命令无限循环；而 `bao start` 又会先打印「正在拉取运行时」，把问题指得更错。
// 所以按当前是源码 checkout 还是全局安装，给出真正能修好的那条命令。
function installHint({ checkout = false } = {}) {
  return checkout
    ? 'npm install && npm run setup'
    : 'npm install -g baoanlight   (reinstalls its optional Electron dependency), then: bao setup';
}

function main() {
  if (!fs.existsSync(ELECTRON_DIR)) {
    console.error([
      'Electron is not installed — the robot window cannot open.',
      `  fix: ${installHint({ checkout: fs.existsSync(path.join(ROOT, '.git')) })}`,
      '  or run without the window:  bao start --browser',
    ].join('\n'));
    process.exit(1);
  }

  if (electronBinary()) {
    console.log('Electron is already installed.');
    return;
  }

  console.log('Downloading the Electron runtime (~140 MB, once)…');
  for (const mirror of mirrorCandidates()) {
    if (electronBinary()) break;
    runDownloader(mirror);
  }

  if (!electronBinary()) {
    const zip = cachedZip();
    if (zip) {
      console.log('The download failed; trying the cached archive.');
      console.log(`Unpacking ${path.basename(zip)}…`);
      try { extract(zip, path.join(ELECTRON_DIR, 'dist')); } catch (e) { console.error(e.message); }
    }
  }

  const bin = electronBinary();
  if (bin) {
    console.log(`Electron ready: ${bin}`);
    console.log('Now run:  bao start');
    return;
  }

  console.error(
    [
      '',
      'Could not install Electron.',
      '',
      'The network may block the official source. Retry with a mirror (PowerShell):',
      `  $env:ELECTRON_MIRROR = "${CN_MIRROR}"; bao setup`,
      '',
      'Or clear the download cache and run `bao setup` again:',
      '  PowerShell:  Remove-Item -Recurse -Force "$env:LOCALAPPDATA\\electron\\Cache"',
      '  cmd:         rmdir /s /q "%LOCALAPPDATA%\\electron\\Cache"',
      '',
      'Or skip the desktop window entirely — this works right now:',
      '  node src/cli.js start --browser',
    ].join('\n')
  );
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  pickCachedZip, cachedZip, electronBinary, installHint,
  mirrorCandidates, runDownloader, CN_MIRROR,
};
