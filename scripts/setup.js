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

function main() {
  if (!fs.existsSync(ELECTRON_DIR)) {
    // 全局安装时 cwd 是任意目录，`npm install` 只会装当前目录的包 —— 提示必须给
    // 能真正修好它的命令（和 README 里的 `bao setup` 一致）。
    console.error('Electron is not installed — run `bao setup` (in a checkout: `npm install && npm run setup`).');
    process.exit(1);
  }

  if (electronBinary()) {
    console.log('Electron is already installed.');
    return;
  }

  console.log('Downloading the Electron runtime (~140 MB, once)…');
  try {
    execFileSync(process.execPath, ['install.js'], { cwd: ELECTRON_DIR, stdio: 'inherit' });
  } catch {
    console.log('The downloader failed; trying the cached archive.');
  }

  if (!electronBinary()) {
    const zip = cachedZip();
    if (zip) {
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
      'Try clearing its download cache and running `bao setup` again (in a checkout: `npm run setup`):',
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

module.exports = { pickCachedZip, cachedZip, electronBinary };
