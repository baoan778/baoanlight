'use strict';
// 本地 HTTP 端口是整个方案最薄的一层防线，而「只绑 127.0.0.1」并不等于「只有本机
// 可信的人能访问」：
//
//   1. 任何网页都能往 127.0.0.1:4747 发请求。带 Origin 的 fetch 我们能看见，
//      但 <img src="http://127.0.0.1:4747/set/busy?agent=x"> 这种 GET 不带
//      Origin —— 只查 Origin 挡不住它，所以写入必须带一个秘密。
//   2. DNS rebinding：攻击者域名解析到 127.0.0.1 时，请求在网络上确实是本机发出
//      的，只有 Host 头还留着攻击者的域名。所以 Host 也必须是回环名。
//   3. token 泄露的后果要尽可能小：它只放在 ~/.baoanlight/token（POSIX 下 0600；
//      Windows 没有 chmod，权限继承用户目录 ACL），只用来
//      授权写入，读接口（/state、/events、/health）仍然免 token —— 否则 `bao
//      status` 和 overlay 页面都得先握手，而它们本来就在同一台机器上。
//
// 三层叠起来的效果：别的网页既看不见你的状态，也点不亮/关不掉你的机器人。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const TOKEN_FILE = path.join(config.DIR, 'token');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const MIN_TOKEN_LENGTH = 32;

let cached = null;

function splitHostPort(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return { name: '', port: '' };
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end < 0) return { name: raw, port: '' };
    return { name: raw.slice(0, end + 1), port: raw.slice(end + 1).replace(/^:/, '') };
  }
  const i = raw.lastIndexOf(':');
  if (i < 0) return { name: raw, port: '' };
  return { name: raw.slice(0, i), port: raw.slice(i + 1) };
}

// 读不到就生成一个。写入失败不算致命：这次运行内存里仍然有 token，只是重启后
// 会换一个（用户重跑 `bao connect claude` 即可，不需要为此起不来）。
//
// 但「读不到」有两种，处理必须不同：
//   ENOENT  -> 真的还没有 token，生成并写盘。
//   其它    -> Windows 上 EBUSY/EPERM 很常见（杀毒、索引、另一个进程正好在写）。
//             此时**绝不能**写盘：正在运行的 server 内存里是旧 token，覆盖掉
//             之后所有钩子都 401，而 client.js 把错误吞掉，灯就永久不动，
//             任何地方都不会报错。这种情况只在内存里给一个临时 token，并说一次。
let tokenWarned = false;

function readTokenFile() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return { raw: fs.readFileSync(TOKEN_FILE, 'utf8').trim(), error: null };
    } catch (err) {
      if (err.code === 'ENOENT') return { raw: null, error: null };
      if (attempt === 2) return { raw: null, error: err };
    }
  }
  return { raw: null, error: null };
}

function token({ refresh = false } = {}) {
  if (!refresh && cached) return cached;

  const { raw, error } = readTokenFile();
  if (raw && raw.length >= MIN_TOKEN_LENGTH) {
    cached = raw;
    return cached;
  }

  try { config.ensureDir(); } catch { /* 目录都建不了，下面照样能跑 */ }
  cached = crypto.randomBytes(32).toString('hex');
  if (error) {
    if (!tokenWarned) {
      tokenWarned = true;
      console.error(`baoanlight: cannot read ${TOKEN_FILE} (${error.code || error.message}).`
        + ' Using a temporary token for this process; the running server was not touched.'
        + ' Check file permissions or restart `bao start`.');
    }
    return cached;
  }
  try {
    fs.writeFileSync(TOKEN_FILE, cached + '\n', { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(TOKEN_FILE, 0o600);
  } catch { /* 见上 */ }
  return cached;
}

// 运行中的 server 每次校验前重新读一眼磁盘：token 文件被删掉、被另一个进程
// 重新生成（升级、手工清理、杀毒软件误删）之后，server 若一直用启动时缓存的
// 旧值，所有钩子都会 401，而 client.js 只警告一次 —— 灯从此不动、没有任何
// 地方报错。读到新的合法值就替换缓存；读不到就继续用内存里那份（绝不在校验
// 路径上生成并写盘，那会把「文件丢了」变成「静默换锁」）。
function currentToken() {
  const { raw } = readTokenFile();
  if (raw && raw.length >= MIN_TOKEN_LENGTH) cached = raw;
  return cached || token();
}

function isLoopbackHost(value, port) {
  const { name, port: given } = splitHostPort(value);
  if (!LOOPBACK.has(name)) return false;
  // 端口缺省只在「客户端省略了默认端口」时才可能发生，此时不再苛求相等。
  return !given || String(port) === given;
}

// 没有 Origin 的不是浏览器（CLI、钩子、curl、OBS 直连），按本机可信处理；
// 有 Origin 就必须和本服务同源。`Origin: null` 来自 file:// 页面，一律拒绝。
function originAllowed(origin, port) {
  if (!origin) return true;
  if (origin === 'null') return false;
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return isLoopbackHost(url.host, port);
}

function tokenMatches(req, url) {
  const header = String(req.headers['x-bao-token'] || '');
  const authz = String(req.headers.authorization || '');
  const bearer = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : '';
  const query = url.searchParams.get('token') || '';
  const given = header || bearer || query;
  if (!given) return false;

  const expected = Buffer.from(currentToken());
  const actual = Buffer.from(String(given));
  // timingSafeEqual 要求等长，先比长度（长度本身不是秘密）。
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// `/set/*` 是 GET 写接口（给 shell 一行命令用的），必须单独算作「写」。
// OPTIONS 是浏览器发出的预检，不带 token 也不可能带：把它算成写操作，会让
// 每个跨源预检都 401，而 server 里那套 CORS 头永远没机会发出去。
function isMutating(req, url) {
  if (req.method === 'OPTIONS') return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') return true;
  return url.pathname.startsWith('/set/');
}

function guard(req, url, port) {
  const host = req.headers.host;
  if (!isLoopbackHost(host, port)) {
    return { ok: false, code: 403, error: `host "${host || ''}" is not loopback` };
  }
  if (!originAllowed(req.headers.origin, port)) {
    return { ok: false, code: 403, error: 'cross-origin request refused' };
  }
  if (isMutating(req, url) && !tokenMatches(req, url)) {
    return { ok: false, code: 401, error: 'missing or wrong token (see ~/.baoanlight/token)' };
  }
  return { ok: true };
}

module.exports = {
  TOKEN_FILE,
  token,
  currentToken,
  guard,
  isLoopbackHost,
  originAllowed,
  isMutating,
  tokenMatches,
};
