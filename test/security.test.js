'use strict';
// 本地 HTTP 端口的安全边界。这些用例保护的不是「代码写得漂不漂亮」，而是这个
// 产品唯一的承诺：灯不能说谎。任何网页都能往 127.0.0.1 发请求，所以「能点灯」
// 必须等同于「这台机器上的用户」。
//
// 每个断言对应一个真实的攻击路径：
//   <img src="…/set/busy">            不带 Origin 的 GET，Origin 检查救不了
//   fetch(…, {method:'POST'})          同一个浏览器，带 Origin
//   evil.com -> 127.0.0.1 (rebinding)  Host 头还是 evil.com
//   /state 被读到                       cwd 里有你的项目路径
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');

// 隔离到临时目录：既不动用户真实的 token，也让「生成 token」这条路径被真正跑到。
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-auth-'));
process.env.BAOANLIGHT_HOME = HOME;

const { start } = require('../src/server');

let server;
let port;
let token;

before(async () => {
  const r = await start({ port: 0 });
  server = r.server;
  port = r.port;
  token = r.token;
});

after(() => {
  if (server) server.close();
  fs.rmSync(HOME, { recursive: true, force: true });
});

// 裸 http 请求：fetch 不允许伪造 Host 头，而 Host 正是 DNS rebinding 的唯一线索。
function raw({ method = 'GET', path: p = '/state', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const snapshot = async () => JSON.parse((await raw()).body);

test('a token is generated on first run and kept to the owner', () => {
  assert.match(token, /^[0-9a-f]{64}$/, '32 random bytes, hex');
  const onDisk = fs.readFileSync(path.join(HOME, 'token'), 'utf8').trim();
  assert.equal(onDisk, token, 'the file is what hooks and the CLI read');
  if (process.platform !== 'win32') {
    const mode = fs.statSync(path.join(HOME, 'token')).mode & 0o777;
    assert.equal(mode, 0o600, `token file must not be world-readable, got ${mode.toString(8)}`);
  }
});

test('a write without the token is refused and changes nothing', async () => {
  const res = await raw({
    method: 'POST',
    path: '/state',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'attacker', agent: 'claude', state: 'waiting' }),
  });
  assert.equal(res.status, 401);
  const snap = await snapshot();
  assert.equal(snap.sessions.some((s) => s.session === 'attacker'), false);
});

// 这就是 <img src="…/set/busy"> 的形状：GET、没有 Origin、没有 body。
test('a tokenless GET /set/* is refused, so an <img> tag cannot light the lamp', async () => {
  const res = await raw({ path: '/set/busy?agent=claude' });
  assert.equal(res.status, 401);
  assert.equal((await snapshot()).overall, 'offline', 'the lamp never moved');
});

test('the same write succeeds with the token', async () => {
  const res = await raw({ path: `/set/busy?agent=claude&token=${token}` });
  assert.equal(res.status, 200);
  assert.equal((await snapshot()).overall, 'busy');
});

test('reads stay open so `bao status` and the overlay need no handshake', async () => {
  const res = await raw();
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).overall, 'busy');
});

test('a foreign Origin is refused even when it somehow has the token', async () => {
  const write = await raw({
    method: 'POST',
    path: '/state',
    headers: {
      'content-type': 'application/json',
      origin: 'https://evil.example',
      'x-bao-token': token,
    },
    body: JSON.stringify({ session: 'evil', agent: 'claude', state: 'waiting' }),
  });
  assert.equal(write.status, 403);
  assert.equal((await snapshot()).sessions.some((s) => s.session === 'evil'), false);

  const read = await raw({ headers: { origin: 'https://evil.example' } });
  assert.equal(read.status, 403, 'a foreign page may not read your cwd either');
  assert.equal(read.headers['access-control-allow-origin'], undefined, 'and gets no CORS pass');
});

// DNS rebinding：请求真的来自本机，只有 Host 还留着攻击者的域名。
test('a Host that is not loopback is refused (DNS rebinding)', async () => {
  const res = await raw({ path: `/set/busy?agent=claude&token=${token}`, headers: { host: 'evil.example' } });
  assert.equal(res.status, 403);
});

test('a file:// page (Origin: null) is refused', async () => {
  const res = await raw({ path: `/set/busy?agent=claude&token=${token}`, headers: { origin: 'null' } });
  assert.equal(res.status, 403);
});

test('/quit cannot be triggered by another page', async () => {
  const res = await raw({
    method: 'POST',
    path: '/quit',
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(res.status, 403);
  assert.equal((await snapshot()).overall, 'busy', 'the server is still here');
});

test('the CLI writes with the token it reads from disk', async () => {
  // Deliberately async: execFileSync blocks this process's event loop, so the
  // in-process server could not answer the child and every write would time out.
  await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(__dirname, '..', 'src', 'cli.js'), 'set', 'waiting', '--agent', 'cli'],
      { env: { ...process.env, BAOANLIGHT_HOME: HOME, BAOANLIGHT_PORT: String(port) }, timeout: 10_000 },
      (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stdout}${stderr}`)) : resolve())
    );
  });
  const snap = await snapshot();
  assert.equal(snap.sessions.find((s) => s.agent === 'cli')?.state, 'waiting',
    'a hook and the CLI must keep working without any extra setup');
});

// CSP 的前提：页面里不能有内联脚本，否则 `script-src 'self'` 立刻失效。
test('the overlay page has no inline script left to bypass the CSP', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay', 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/, 'the page carries its own policy');
  assert.match(html, /script-src 'self'/, 'scripts may only come from this origin');
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
  assert.equal(inline.length, 0, `inline <script> found: ${inline.map((m) => m[0]).join(', ')}`);
});
