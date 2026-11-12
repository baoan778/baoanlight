'use strict';
// 三条日志观察器共用的一条规矩：机器人退出之后，watcher 不该变成孤儿进程。
//
// 20 秒 × 3 次的宽限足够覆盖一次「stop 之后马上 start」的重启，又不会永远赖着
// 不走。三个 watcher 原来只有 log-watch 实现了它，deepseek 与 workbuddy 的
// 观察器在 `bao stop` 之后会一直轮询下去 —— 同一件事写在两个地方，就总有一处
// 会被忘掉。
const client = require('../client');

function keepAliveWith(stop, { everyMs = 20_000, missesAllowed = 3 } = {}) {
  let misses = 0;
  const timer = setInterval(async () => {
    const health = await client.get('/health');
    misses = health && health.ok ? 0 : misses + 1;
    if (misses >= missesAllowed) stop();
  }, everyMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { keepAliveWith };
