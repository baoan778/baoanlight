'use strict';
// 开机自启管理：把「机器人 + watch all」放进系统的登录启动项，或移除。
//
// This only edits the per-user login-startup entry. It never touches system
// services or registry-wide settings, so `off` is always a clean undo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NAME = 'baoanlight';

function startupDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'LaunchAgents');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart');
}

function targetPath() {
  if (process.platform === 'win32') return path.join(startupDir(), `${NAME}.lnk`);
  if (process.platform === 'darwin') return path.join(startupDir(), `com.${NAME}.plist`);
  return path.join(startupDir(), `${NAME}.desktop`);
}

// Run a PowerShell script from a temp file: passing a multi-line script through
// -Command means fighting two layers of quoting, and this is not worth it.
function psRun(script) {
  const tmp = path.join(os.tmpdir(), `bao-autostart-${process.pid}-${Date.now()}.ps1`);
  fs.writeFileSync(tmp, script, 'utf8');
  try {
    return execFileSync('powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], { encoding: 'utf8' });
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

const q = (s) => String(s).replace(/'/g, "''");

function installWindows() {
  const lnk = targetPath();
  // Write a VBS with the node binary's absolute path baked in. At login the
  // shell's PATH may not include node (nvm, a custom install, a stripped
  // environment), and a `node …` launch that cannot find node fails silently —
  // the robot just never appears. The absolute path cannot miss.
  const vbs = path.join(os.homedir(), '.baoanlight', 'autostart.vbs');
  fs.mkdirSync(path.dirname(vbs), { recursive: true });
  fs.writeFileSync(vbs, [
    'Set sh = CreateObject("WScript.Shell")',
    `nodeExe = "${process.execPath}"`,
    `cli = "${path.join(ROOT, 'src', 'cli.js')}"`,
    // 等 start 把 server 拉起来再启动 watcher：watcher 先于 server 启动时上报会
    // 静默失败，之后没有状态变化就不再上报，机器人会一直显示离线。
    'sh.Run """" & nodeExe & """ """ & cli & """ start", 0, True',
    'sh.Run """" & nodeExe & """ """ & cli & """ watch all", 0, False',
  ].join('\r\n') + '\r\n');

  fs.mkdirSync(startupDir(), { recursive: true });
  psRun([
    '$w = New-Object -ComObject WScript.Shell',
    `$l = $w.CreateShortcut('${q(lnk)}')`,
    "$l.TargetPath = Join-Path $env:WINDIR 'System32\\wscript.exe'",
    `$l.Arguments = '"${q(vbs)}"'`,
    `$l.WorkingDirectory = '${q(ROOT)}'`,
    '$l.Save()',
  ].join('\n'));
  return lnk;
}

function installLinux() {
  const file = targetPath();
  fs.mkdirSync(startupDir(), { recursive: true });
  fs.writeFileSync(file, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=baoanlight',
    `Exec="${process.execPath}" "${path.join(ROOT, 'src', 'cli.js')}" start`,
    'X-GNOME-Autostart-enabled=true',
  ].join('\n') + '\n');
  return file;
}

function installDarwin() {
  const file = targetPath();
  fs.mkdirSync(startupDir(), { recursive: true });
  fs.writeFileSync(file, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '  <key>Label</key><string>com.baoanlight</string>',
    '  <key>ProgramArguments</key><array>',
    `    <string>${process.execPath}</string>`,
    `    <string>${path.join(ROOT, 'src', 'cli.js')}</string>`,
    '    <string>start</string>',
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '</dict></plist>',
    '',
  ].join('\n'));
  return file;
}

function install() {
  if (process.platform === 'win32') return installWindows();
  if (process.platform === 'darwin') return installDarwin();
  return installLinux();
}

function uninstall() {
  const file = targetPath();
  try {
    fs.unlinkSync(file);
    return { removed: true, file };
  } catch {
    return { removed: false, file };
  }
}

function status() {
  const file = targetPath();
  return { enabled: fs.existsSync(file), file, platform: process.platform };
}

module.exports = { install, uninstall, status, targetPath };
