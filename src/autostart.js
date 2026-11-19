'use strict';
// 开机自启管理（Windows）：把机器人放进当前用户的登录启动项，或移除。
//
// 只改当前用户的「启动」文件夹，不碰系统服务或注册表全局项，所以 `off` 永远
// 是一次干净的撤销。启动项实际执行的是一条 `bao start`：server、窗口和日志
// 观察器都由它带起来并守护。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('./config');

const ROOT = path.resolve(__dirname, '..');
const NAME = 'baoanlight';

function startupDir() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function targetPath() {
  return path.join(startupDir(), `${NAME}.lnk`);
}

// 启动项只是入口，真正执行的是这个 VBS（里面写死了 node 与 cli 的绝对路径）。
function launcherPath() {
  return path.join(config.DIR, 'autostart.vbs');
}

// Windows Script Host 和 Windows PowerShell 5.1 都按「系统 ANSI 代码页」解码**没有
// BOM** 的脚本文件。系统是中文时，`C:\Users\张三\...` 会被读成乱码，登录时 node
// 根本不在那个路径上——机器人永远不出现，而 `bao autostart status` 仍然显示「已开启」
// （两个文件都在），用户没有任何线索。WSH 只认 UTF-16 的 BOM，PowerShell 5.1 认
// UTF-8 的 BOM，所以两种格式分开写。
const BOM = { utf16: Buffer.from([0xff, 0xfe]), utf8: Buffer.from([0xef, 0xbb, 0xbf]) };

function writeScript(file, text, encoding) {
  const body = Buffer.from(String(text), encoding === 'utf16' ? 'utf16le' : 'utf8');
  fs.writeFileSync(file, Buffer.concat([BOM[encoding], body]));
}

// Run a PowerShell script from a temp file: passing a multi-line script through
// -Command means fighting two layers of quoting, and this is not worth it.
function psRun(script) {
  const tmp = path.join(os.tmpdir(), `bao-autostart-${process.pid}-${Date.now()}.ps1`);
  writeScript(tmp, script, 'utf8');
  try {
    return execFileSync('powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], { encoding: 'utf8' });
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

const q = (s) => String(s).replace(/'/g, "''");

function install() {
  const lnk = targetPath();
  // Write a VBS with the node binary's absolute path baked in. At login the
  // shell's PATH may not include node (nvm, a custom install, a stripped
  // environment), and a `node …` launch that cannot find node fails silently —
  // the robot just never appears. The absolute path cannot miss.
  const vbs = launcherPath();
  fs.mkdirSync(path.dirname(vbs), { recursive: true });
  writeScript(vbs, [
    'Set sh = CreateObject("WScript.Shell")',
    `nodeExe = "${process.execPath}"`,
    `cli = "${path.join(ROOT, 'src', 'cli.js')}"`,
    // 一条 start 就够了：它会把 server、窗口和日志观察器一起带起来。
    'sh.Run """" & nodeExe & """ """ & cli & """ start", 0, False',
  ].join('\r\n') + '\r\n', 'utf16');

  fs.mkdirSync(startupDir(), { recursive: true });
  psRun([
    '$w = New-Object -ComObject WScript.Shell',
    `$l = $w.CreateShortcut('${q(lnk)}')`,
    "$l.TargetPath = Join-Path $env:WINDIR 'System32\\wscript.exe'",
    `$l.Arguments = '"${q(vbs)}"'`,
    `$l.WorkingDirectory = '${q(ROOT)}'`,
    '$l.Save()',
  ].join('\n'));
  // PowerShell 退出码是 0 不代表快捷方式真的落盘了（路径写错、启动文件夹被
  // 安全软件挡住都可能静默失败）。不验证的话，命令会打印「已开启」，而登录时
  // 什么都不会发生 —— 这正是这个项目最不能做的事。
  if (!fs.existsSync(lnk)) throw new Error(`the startup shortcut was not created at ${lnk}`);
  return lnk;
}

function uninstall() {
  const file = targetPath();
  let removed = false;
  try { fs.unlinkSync(file); removed = true; } catch { /* 本来就没开 */ }
  // 启动项只是入口，真正干活的是 VBS。留着它会让「已关闭」变成一句只对启动
  // 文件夹成立的话。
  try { fs.unlinkSync(launcherPath()); } catch { /* 不存在或正被占用 */ }
  return { removed, file };
}

// 只看 .lnk 会说谎：脚本被杀软隔离或手工清理后，登录时 wscript 什么也起不来，
// 而界面仍然显示「已开启」。两个文件都在才算真的开了。
function status() {
  const file = targetPath();
  const launcher = launcherPath();
  const hasShortcut = fs.existsSync(file);
  const hasLauncher = fs.existsSync(launcher);
  return {
    enabled: hasShortcut && hasLauncher,
    broken: hasShortcut && !hasLauncher,
    file,
    launcher,
    platform: 'win32',
  };
}

module.exports = { install, uninstall, status, targetPath, launcherPath, writeScript };
