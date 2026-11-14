'use strict';
// 本机资源占用：给浮层上那块 CPU / 内存小面板提供数字。
//
// 只报**测得的东西**：CPU 用两次采样的 idle/total 差值，内存用
// totalmem/freemem。不做平滑、不猜趋势 —— 一个写着「12%」却其实在跑编译的
// 面板，比没有面板更糟。
//
// 1 秒缓存：面板每 2 秒取一次，多个窗口同时打开也不会把
// os.cpus() 变成忙循环。
const os = require('os');

let prev = null;
let prevAt = 0;      // 上次采样的时刻：差值只在这两帧之间的窗口里有意义
let cached = null;
let cachedAt = 0;

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const key of ['user', 'nice', 'sys', 'idle', 'irq']) total += cpu.times[key] || 0;
    idle += cpu.times.idle || 0;
  }
  return { idle, total };
}

function sample() {
  const now = Date.now();
  if (cached && now - cachedAt < 1000) return cached;

  const cur = cpuTimes();
  let cpu = 0;
  if (prev) {
    const dTotal = cur.total - prev.total;
    const dIdle = cur.idle - prev.idle;
    // 差值只在这两帧之间有意义：面板关了几小时再打开，prev 还是几小时前的值，
    // 用它算出来的是「过去几小时的平均」，冒充「此刻占用」——正是文件顶部
    // 承诺不报的数字。超过 5 秒就丢弃旧差值，只刷新基准、返回 0（下一帧 2 秒后
    // 才出真值）。第一次采样没有差值，同样返回 0。
    if (dTotal > 0 && now - prevAt <= 5000) {
      cpu = Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)));
    }
  }
  prev = cur;
  prevAt = now;

  const total = os.totalmem();
  const free = os.freemem();
  const used = Math.max(0, total - free);

  cached = {
    at: now,
    cpu,
    mem: {
      total,
      used,
      percent: total > 0 ? Math.max(0, Math.min(100, Math.round((used / total) * 100))) : 0,
    },
    cores: os.cpus().length,
    uptime: Math.round(os.uptime()),
  };
  cachedAt = now;
  return cached;
}

module.exports = { sample };
