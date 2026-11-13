'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store } = require('./store');
const config = require('./config');
const presence = require('./presence');
const ccSwitch = require('./adapters/ccswitch');
const selfcheck = require('./selfcheck');
const sysinfo = require('./sysinfo');
const auth = require('./auth');

const OVERLAY_DIR = path.join(__dirname, 'overlay');
// `.mjs` 必须声明成 JS，否则浏览器把模块当二进制下载，import 直接失败。
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
};

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    // 按字节收，不按字符串拼：`data += chunk` 会对每个 TCP 分片单独做一次
    // UTF-8 解码，一个中文字符正好跨在两个分片之间时，两边都会变成 U+FFFD
    // （详情文案里出现的「�」就是这么来的）。而且 limit 必须按字节算，
    // 否则 16KB 的请求体在中文下实际能到 ~48KB。
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;   // 继续把连接读完，否则 400 还没发出去就被 reset 了
      size += c.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function start({ port = config.port(), ttlMs, idleTtlMs, quietAfterMs, unusedTtlMs } = {}) {
  const cfg = config.load();
  const store = new Store({
    ttlMs: ttlMs ?? cfg.sessionTtlMs,
    idleTtlMs: idleTtlMs ?? cfg.idleTtlMs,
    quietAfterMs: quietAfterMs ?? cfg.quietAfterMs,
    unusedTtlMs: unusedTtlMs ?? cfg.unusedTtlMs,
  });
  // 今日统计持久化：重启不丢，跨天自动清零。
  const statsFile = path.join(config.DIR, 'stats.json');
  try {
    store.mergeStats(JSON.parse(fs.readFileSync(statsFile, 'utf8')));
  } catch { /* 首次运行或文件损坏 */ }
  let statsTimer = null;
  // 落盘抽成一个函数：防抖定时器会用它，`/quit` 和 server 关闭时也要用它。
  // 否则 `bao stop` 永远丢掉最后 2 秒的今日统计。
  const flushStats = () => {
    clearTimeout(statsTimer);
    statsTimer = null;
    try {
      config.ensureDir();
      fs.writeFileSync(statsFile, JSON.stringify(store.stats));
    } catch { /* 写不进也不影响运行 */ }
  };
  store.on('change', () => {
    if (statsTimer) return;
    statsTimer = setTimeout(flushStats, 2000);
    if (statsTimer.unref) statsTimer.unref();
  });

  const clients = new Set();

  // 启动自检：结果挂进快照（机器人窗口据此提示）+ 单独端点。
  //
  // 但不能只算一次：用户完全可能先启动、再 `bao connect claude` 把钩子修好，
  // 而一次性的结果会让窗口和 CLI 一直念「未安装」，直到重启 server。
  // 30 秒的 TTL 足够让修复被看见，又不会每次 SSE 帧都去摸磁盘。
  let selfcheckResult = selfcheck.run();
  const currentSelfcheck = () => {
    if (Date.now() - (selfcheckResult.at || 0) > 30_000) selfcheckResult = selfcheck.run();
    return selfcheckResult;
  };

  // `presence` is evidence, not state: true means "a Claude process exists",
  // false means "we could not prove one does" (see src/presence.js).
  const frame = () => ({ ...store.snapshot(), presence: presence.lastValue(), ccSwitch: ccSwitch.lastValue(), selfcheck: currentSelfcheck() });

  const send = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    // Port 0 means the OS picked one, so the real port only exists here.
    const boundPort = (server.address() || {}).port || port;

    // 请求行可以是 absolute-form（`GET http://127.0.0.1:99999/`）。端口越界、
    // 控制字符都会让 URL 构造抛错 —— 它必须在 try 里：async handler 的拒绝
    // 会变成 unhandledRejection，Node 20 默认直接结束整个进程，一行畸形请求
    // 就能把机器人从桌面上打掉。
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      return send(res, 400, { error: 'bad request target' });
    }
    const p = url.pathname;

    try {
      // 绑定 127.0.0.1 挡不住「别人网页里的 <img>」和 DNS rebinding —— 所以每个
      // 请求先过 Host/Origin，写入再过 token。CORS 也不再是 `*`：只有同源的
      // 浏览器页面才拿到回显的 Origin，别的源连读都读不到。
      const verdict = auth.guard(req, url, boundPort);
      if (!verdict.ok) return send(res, verdict.code, { error: verdict.error });

      if (req.headers.origin) {
        res.setHeader('access-control-allow-origin', req.headers.origin);
        res.setHeader('vary', 'origin');
      }
      res.setHeader('access-control-allow-headers', 'content-type, x-bao-token');
      if (req.method === 'OPTIONS') return res.writeHead(204).end();

      // `clients` is how many overlays are listening. A running server with
      // nobody watching is not a running robot.
      // 回真实绑定的端口：`--port 0` 时请求里的 0 毫无意义，而 README 的
      // 排障流程就是 `curl /health` 看它到底在哪儿。
      if (p === '/health') return send(res, 200, { ok: true, name: 'baoanlight', pid: process.pid, port: boundPort, clients: clients.size });

      if (p === '/state' && req.method === 'GET') return send(res, 200, frame());

      if (p === '/selfcheck') return send(res, 200, currentSelfcheck());

      // 本机 CPU / 内存。面板每 2 秒取一次，所以它是一条独立通道 —— 混进
      // SSE 快照会让「资源占用」变成「代理状态变化」的副产品，忙碌时每秒
      // 推好几帧，闲置时又完全不更新。
      if (p === '/sys') return send(res, 200, sysinfo.sample());

      if (p === '/state' && req.method === 'POST') {
        const raw = await readBody(req);
        const payload = raw ? JSON.parse(raw) : {};
        return send(res, 200, store.set(payload));
      }

      // An event a hook could not map. It never moves the lamp; it only lets
      // the display admit that something is arriving that we cannot read.
      if (p === '/unknown' && req.method === 'POST') {
        const raw = await readBody(req);
        const payload = raw ? JSON.parse(raw) : {};
        store.noteUnknown(payload.event, payload.session);
        return send(res, 200, { ok: true });
      }

      if (p === '/unknown/clear' && req.method === 'POST') {
        store.clearUnknown();
        return send(res, 200, { ok: true });
      }

      // Convenience for shell one-liners and hooks:
      //   curl -s localhost:4747/set/busy?agent=claude
      // 也接受 JSON 请求体（`bao mcp` 走的就是这条）：路径里的 state 永远优先，
      // 查询串与 body 都能补 agent/session/detail/cwd，缺省才回落。
      // 只读查询串曾经让整条 MCP 通道静默失效——报上来的每个软件都叫 "agent"。
      if (p.startsWith('/set/')) {
        const state = p.slice('/set/'.length);
        let body = {};
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const raw = await readBody(req, 16 * 1024);
          if (raw) { try { body = JSON.parse(raw); } catch { body = {}; } }
          if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
        }
        const pick = (key, fallback) => {
          const fromQuery = url.searchParams.get(key);
          if (fromQuery) return fromQuery;
          const fromBody = body[key];
          return typeof fromBody === 'string' && fromBody ? fromBody : fallback;
        };
        return send(res, 200, store.set({
          state,
          agent: pick('agent', 'agent'),
          session: pick('session', 'default'),
          detail: pick('detail', ''),
          cwd: pick('cwd', ''),
        }));
      }

      if (p === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify(frame())}\n\n`);
        clients.add(res);
        // 客户端半关连接后，`res.write` 的失败是异步 emit 的：没有 error
        // 监听器就是未捕获异常，一次断线能把整个 server 带走。
        let ping = null;
        const drop = () => {
          if (ping) clearInterval(ping);
          clients.delete(res);
        };
        res.on('error', drop);
        ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { drop(); } }, 25_000);
        req.on('close', drop);
        return;
      }

      // Wipe every session. Useful after testing, or when a crashed agent has
      // left a pill behind and you do not want to wait for it to age out.
      if (p === '/clear' && req.method === 'POST') {
        for (const id of [...store.sessions.keys()]) store.set({ session: id, state: 'offline' });
        return send(res, 200, store.snapshot());
      }

      if (p === '/quit' && req.method === 'POST') {
        send(res, 200, { ok: true });
        // 先把防抖里那 2 秒的今日统计写下去，再退出。
        flushStats();
        return setTimeout(() => process.exit(0), 50);
      }

      // Static: the same overlay UI Electron loads, so a plain browser tab works too.
      // 用 resolve + 严格前缀（含分隔符）校验，堵住 `../overlay-evil/x` 这种同前缀
      // 兄弟目录穿越（老的 startsWith(OVERLAY_DIR) 会被这种路径骗过）。
      const file = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
      let abs = path.resolve(OVERLAY_DIR, file);
      // 目录形式（/teardown/ 或 /teardown）落到它自己的 index.html：拆解台是
      // 一个独立页面，而不是要记住 `/teardown/index.html` 这种地址。
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) abs = path.join(abs, 'index.html');
      const insideOverlay = abs === OVERLAY_DIR || abs.startsWith(OVERLAY_DIR + path.sep);
      if (insideOverlay && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' });
        return fs.createReadStream(abs).pipe(res);
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      // 静态文件是流式写出的：响应已经开始之后再 writeHead 会再抛一次，
      // 那一次没人接，等于把「404」换成「进程崩溃」。
      if (res.headersSent) { try { res.end(); } catch { /* 已经关了 */ } return; }
      return send(res, 400, { error: String(err.message || err) });
    }
  });
  // 进程被 `server.close()`（测试、`bao stop` 之外的路由）收掉时也落盘一次。
  server.once('close', flushStats);

  store.on('change', () => {
    const line = `data: ${JSON.stringify(frame())}\n\n`;
    for (const c of clients) { try { c.write(line); } catch { clients.delete(c); } }
  });

  // Probing only matters when nothing is reporting — that is exactly when the
  // display is about to claim "nothing is running". With a live session the
  // answer cannot change what we show, so we do not spend a process spawn on it.
  const presenceTimer = setInterval(() => {
    if (store.sessions.size > 0) return;
    const before = presence.lastValue();
    presence.claudeRunning().then((v) => {
      if (v !== before) store.emit('change', store.snapshot());
    }).catch(() => {});
  }, 15_000);
  if (presenceTimer.unref) presenceTimer.unref();

  // cc-switch's files change only when the user flips a provider, so a short
  // poll is plenty. Refresh once at start so the first frame is already right,
  // then re-push whenever the picture actually changes (a provider switch never
  // goes through the store, so it has to drive its own broadcast).
  ccSwitch.refresh();
  const ccTimer = setInterval(() => {
    const before = ccSwitch.lastValue();
    const next = ccSwitch.refresh();
    if (JSON.stringify(next) !== JSON.stringify(before)) store.emit('change', store.snapshot());
  }, 10_000);
  if (ccTimer.unref) ccTimer.unref();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      config.ensureDir();
      // 端口文件写真实端口：`port: 0` 时请求的 0 毫无用处，而 CLI 与测试都用它。
      const bound = server.address().port;
      try { fs.writeFileSync(config.PORT_FILE, String(bound)); } catch {}
      presence.claudeRunning().catch(() => {});
      // 先采一次 CPU：第一次采样没有差值，早点垫上，面板打开时就有数字。
      sysinfo.sample();
      // token 在监听之后才保证存在，钩子和 CLI 都从这里读。
      resolve({ server, store, port: bound, token: auth.token() });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  start().then(({ port }) => console.log(`baoanlight server on http://127.0.0.1:${port}`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
