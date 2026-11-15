'use strict';
// 静默的新版本检查：只在启动时 fire-and-forget 一次，24 小时内命中缓存就不再联网。
//
// 为什么值得做：`npm i -g baoanlight` 之后程序就一直停在那个版本，用户不知道有
// 新版（尤其是修了 bug 的版本）。这里只问 npm registry 一句「latest 是几」，任何
// 失败（离线、被墙、超时）都静默吞掉 —— 一个状态灯没有理由因为查不到版本而吵。
const fs = require('fs');
const path = require('path');
const config = require('./config');

const CACHE_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 4000;

let last = null;      // { current, latest, newer }

function currentVersion() {
  try {
    return require(path.join(__dirname, '..', 'package.json')).version;
  } catch {
    return '0.0.0';
  }
}

function cacheFile() {
  return path.join(config.DIR, '.update-check.json');
}

function readCache() {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    if (c && typeof c.latest === 'string' && Date.now() - Number(c.at || 0) < CACHE_MS) return c;
  } catch { /* 没缓存或坏了 */ }
  return null;
}

function writeCache(latest) {
  try {
    config.ensureDir();
    fs.writeFileSync(cacheFile(), JSON.stringify({ at: Date.now(), latest }));
  } catch { /* 写不进就算了，下次再查 */ }
}

async function check({ fetchImpl = globalThis.fetch } = {}) {
  const current = currentVersion();
  const cached = readCache();
  if (cached) {
    last = { current, latest: cached.latest, newer: cached.latest !== current };
    return last;
  }
  const fresh = { current, latest: current, newer: false };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetchImpl('https://registry.npmjs.org/baoanlight/latest', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return last = fresh;
    const data = await res.json();
    if (data && typeof data.version === 'string') {
      fresh.latest = data.version;
      fresh.newer = data.version !== current;
      writeCache(data.version);
    }
  } catch {
    // 离线/超时/被墙：不报错，也别写「未知」进缓存。
  }
  last = fresh;
  return last;
}

function lastValue() {
  return last;
}

function reset() {
  last = null;
  try { fs.unlinkSync(cacheFile()); } catch { /* 没有缓存 */ }
}

module.exports = { check, lastValue, currentVersion, reset };
