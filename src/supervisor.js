'use strict';
// 整机守护：把「server + 窗口 + 观察器」当成一个整体来看着。
//
// 之前只守护了其中两件（观察器子进程、窗口），但真正会让桌面上少一只机器人的
// 是 node 进程本身退出：未捕获异常、内存耗尽、升级替换文件。这时没有任何东西
// 会把它拉回来，直到下次登录。
//
// 这一层只做一件事：子进程非零退出就按退避重开；正常退出（0）就是用户真的
// 要它停（工具栏退出 / 托盘退出 / `bao stop`），不再复活。
//
// 逻辑做成纯函数是为了能测：传进来的 spawnChild 返回一个 EventEmitter 就够了。

const DEFAULT_BACKOFF = [5_000, 10_000, 30_000, 60_000];

function supervise(spawnChild, {
  backoff = DEFAULT_BACKOFF,
  // 连续崩溃时每次都从头退避会很吵；稳定跑过这段时间就认为它已经恢复正常，
  // 下一次崩溃重新从 5 秒开始。
  stableMs = 60_000,
  log = () => {},
  exit = (code) => process.exit(code),
} = {}) {
  let child = null;
  let timer = null;
  let stopped = false;
  let attempt = 0;
  let startedAt = 0;

  const start = () => {
    if (stopped) return null;
    startedAt = Date.now();
    child = spawnChild();
    child.on('exit', (code) => {
      child = null;
      if (stopped) return;
      if (code === 0) {
        // 正常退出 = 用户让它停。守护者跟着退，绝不把它「复活」。
        stopped = true;
        exit(0);
        return;
      }
      if (Date.now() - startedAt >= stableMs) attempt = 0;
      const wait = backoff[Math.min(attempt, backoff.length - 1)];
      attempt += 1;
      log({ code, wait, attempt });
      timer = setTimeout(start, wait);
    });
    return child;
  };

  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    timer = null;
    if (child) {
      try { child.kill(); } catch { /* 已经退了 */ }
      child = null;
    }
  };

  start();
  return { stop };
}

module.exports = { supervise, DEFAULT_BACKOFF };
