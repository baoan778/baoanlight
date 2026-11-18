'use strict';
// 在某个会话的工作目录里打开一个 Windows 终端。
//
// 独立成模块而不是写在 Electron 的 ipcMain 处理器里，是因为「哪些路径能打开、
// 命令怎么拼」是纯逻辑，值得在不启动 Electron 的情况下测试。cwd 来自服务端
// （钩子上报），不能直接当作可信路径拼进 shell。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// cmd.exe 的变量展开、引号与换行都能改变一条命令的含义。路径里出现这些字符
// 时拒绝打开，而不是尝试转义 —— 打不开终端是小事，执行到别处是大事。
const UNSAFE = /[%$`"\r\n\0]/;

function safeDir(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  if (UNSAFE.test(cwd)) return null;
  let dir;
  try { dir = path.resolve(cwd); } catch { return null; }
  try { if (!fs.statSync(dir).isDirectory()) return null; } catch { return null; }
  return dir;
}

function launch(spawnImpl, cmd, args, opts) {
  const child = spawnImpl(cmd, args, opts);
  // 终端程序缺失时，spawn 的失败是异步 'error' 事件；不接住它会把 Electron
  // 主进程一起带走。打不开终端只是小事。
  if (child && typeof child.on === 'function') child.on('error', () => {});
  child.unref();
}

// 返回 true 表示已经把打开终端的请求发出去了。`spawnImpl` 只给测试注入，
// 生产路径永远是 child_process.spawn。
function openTerminal(cwd, { spawnImpl = spawn } = {}) {
  const dir = safeDir(cwd);
  if (!dir) return false;
  try {
    // 不再拼 `cd /d "..."`：把目录作为 spawn 的 cwd 传下去，路径根本不进入
    // 命令行，`&`、`|`、`(` 这些字符也就没有机会被 cmd 重新解释。
    launch(spawnImpl, 'cmd', ['/c', 'start', 'cmd', '/k'], {
      cwd: dir, detached: true, stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = { safeDir, openTerminal };
