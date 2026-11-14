'use strict';
// 三条日志观察器共用的一条规矩：机器人退出之后，watcher 不该变成孤儿进程。
//
// 20 秒 × 3 次的宽限足够覆盖一次「stop 之后马上 start」的重启，又不会永远赖着
// 不走。三个 watcher 原来只有 log-watch 实现了它，deepseek 与 workbuddy 的
// 观察器在 `bao stop` 之后会一直轮询下去 —— 同一件事写在两个地方，就总有一处
// 会被忘掉。
const client = require('../client');

function keepAliveWith(stop, { everyMs = 20_000, missesAllowed = 3, onRecover } = {}) {
  let misses = 0;
  let wasDown = false;
  let lastPid = null;
  const timer = setInterval(async () => {
    const health = await client.get('/health');
    if (health && health.ok) {
      // server 回来了，**或者换了一个新 server**。后者覆盖「stop 之后马上 start」
      // 的快速重启：watchdog 每 20 秒才探一次，根本抓不到那 <1 秒的 down 空窗，
      // 只认 wasDown 的话 onRecover 永远不触发 —— 重启后 store 是空的，灯就一直
      // 灭到下一次状态变化。pid 变了就是新进程，一样要重报。
      const newServer = !!health.pid && lastPid != null && health.pid !== lastPid;
      if ((wasDown || newServer) && onRecover) { try { onRecover(); } catch { /* 上报失败别拖垮守护 */ } }
      if (health.pid) lastPid = health.pid;
      misses = 0;
      wasDown = false;
    } else {
      misses += 1;
      wasDown = true;
      if (misses >= missesAllowed) stop();
    }
  }, everyMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { keepAliveWith };
