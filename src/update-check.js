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

function parseVersion(v) {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || ''));
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' };
}

// "Newer" means "the registry has something the user does not have", not
// "the strings differ". A local checkout, a rollback, or a stale cache can all
// put the installed version ahead of npm; offering that as an update would tell
// the user to downgrade.
// Semver prerelease comparison, not string comparison: alpha.10 is newer than
// alpha.2, and a numeric identifier ranks below an alphanumeric one. The old
// lexical compare told users on alpha.2 that alpha.10 was a downgrade.
function comparePre(a, b) {
  if (a === b) return 0;
  if (!a) return 1;   // a release outranks any prerelease
  if (!b) return -1;
  const as = String(a).split('.');
  const bs = String(b).split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i += 1) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;   // shorter prerelease has lower precedence
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const dx = Number(x);
      const dy = Number(y);
      if (dx !== dy) return dx > dy ? 1 : -1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;             // numeric identifiers sort below alphanumeric
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  }
  return comparePre(a.pre, b.pre) > 0;
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
    last = { current, latest: cached.latest, newer: isNewer(cached.latest, current) };
    return last;
  }
  const fresh = { current, latest: current, newer: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl('https://registry.npmjs.org/baoanlight/latest', { signal: ctrl.signal });
    if (!res.ok) return last = fresh;
    const data = await res.json();
    if (data && typeof data.version === 'string') {
      fresh.latest = data.version;
      fresh.newer = isNewer(data.version, current);
      writeCache(data.version);
    }
  } catch {
    // 离线/超时/被墙：不报错，也别写「未知」进缓存。
  } finally {
    clearTimeout(timer);
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

module.exports = { check, lastValue, currentVersion, isNewer, comparePre, reset };
