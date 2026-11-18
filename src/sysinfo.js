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
const { execFile } = require('child_process');

let prev = null;
let prevAt = 0;      // 上次采样的时刻：差值只在这两帧之间的窗口里有意义
let cached = null;
let cachedAt = 0;

// GPU：只有存在 NVIDIA 驱动时才报。Windows 上 nvidia-smi 随驱动装在 System32，
// AMD/Intel 没有同样简单可靠的单值接口 —— 宁可不显示这一行，也不猜一个数字
// 冒充「GPU 占用」。查询是异步的，`sample()` 只读缓存，绝不会卡住 HTTP 请求。
let gpu = null;
let gpuAt = 0;
let gpuChecking = false;
const GPU_EVERY_MS = 3000;
const GPU_RETRY_MS = 5 * 60 * 1000;

function parseNvidiaSmi(out) {
  const line = String(out || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  const parts = line.split(',').map((p) => p.trim());
  // name, utilization.gpu, memory.used(MiB), memory.total(MiB)
  if (parts.length < 4) return null;
  const [percent, usedMb, totalMb] = parts.slice(1, 4).map(Number);
  if (![percent, usedMb, totalMb].every(Number.isFinite)) return null;
  return {
    name: parts[0],
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    mem: {
      used: Math.max(0, usedMb) * 1048576,
      total: Math.max(0, totalMb) * 1048576,
    },
  };
}

function probeGpu() {
  if (gpuChecking) return;
  gpuChecking = true;
  execFile(
    'nvidia-smi',
    ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
    { timeout: 1500, windowsHide: true, encoding: 'utf8' },
    (err, stdout) => {
      gpuChecking = false;
      gpuAt = Date.now();
      if (err) { gpu = null; return; }
      const parsed = parseNvidiaSmi(stdout);
      if (parsed) gpu = parsed;
    }
  );
}

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

  // 到点就异步刷一次；不可用时 5 分钟才重试，别对着一台没有 NVIDIA 的机器
  // 每 3 秒 spawn 一次注定失败的进程。
  if (now - gpuAt > (gpu ? GPU_EVERY_MS : GPU_RETRY_MS)) probeGpu();

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
    // null 表示这台机器没有可用的 NVIDIA 读数，界面据此隐藏 GPU 那一行。
    gpu,
  };
  cachedAt = now;
  return cached;
}

module.exports = { sample, parseNvidiaSmi };
