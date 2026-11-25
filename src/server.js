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
const updateCheck = require('./update-check');
const notes = require('./notes');
// 开机自启只能在 **node** 进程里装：autostart.js 用 process.execPath 写启动项，
// 在 Electron 主进程里会写成 Electron 可执行文件，登录时根本起不来。
const autostart = require('./autostart');

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
    store.mergeStats(JSON.parse(config.stripBom(fs.readFileSync(statsFile, 'utf8'))));
  } catch (err) {
    // 首次运行没有文件是正常的；文件坏了不能静默丢弃 —— 今日时长/周报少一天却
    // 没有任何提示，用户会以为是自己漏记了。备份 + 说一句。
    if (err.code !== 'ENOENT') {
      try {
        fs.renameSync(statsFile, statsFile + '.bad');
        console.error(`baoanlight: stats.json was unreadable (${err.message}); moved to stats.json.bad, starting fresh.`);
      } catch { /* 备份失败也不影响启动 */ }
    }
  }
  let statsTimer = null;
  // 落盘抽成一个函数：防抖定时器会用它，`/quit` 和 server 关闭时也要用它。
  // 否则 `bao stop` 永远丢掉最后 2 秒的今日统计。
  const flushStats = () => {
    clearTimeout(statsTimer);
    statsTimer = null;
    try {
      config.ensureDir();
      // 用「已累计 + 此刻正在忙」的副本：退出/重启时正在跑的那一段也必须留下，
      // 否则今日时长会像被清零了一样（见 Store.statsForPersistence）。
      const stats = store.statsForPersistence();
      // 原子写：先写临时文件再 rename。进程在 writeFileSync 中途被杀（kill -9 /
      // 断电）会留下半截 JSON，下次启动 parse 失败、统计清零。rename 是同目录内
      // 的原子替换，磁盘上要么是完整旧文件、要么是完整新文件。
      const tmp = statsFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(stats));
      fs.renameSync(tmp, statsFile);
    } catch { /* 写不进也不影响运行 */ }
  };
  store.on('change', () => {
    if (statsTimer) return;
    statsTimer = setTimeout(flushStats, 2000);
    if (statsTimer.unref) statsTimer.unref();
  });

  const clients = new Set();
  // 合并短时间内的多次状态变化（见下面 store.on('change') 的注释）。
  let broadcastTimer = null;

  // 轻量事件日志：环形缓冲，`bao log` 或 `/log` 读取。只记「有意义」的事 ——
  // 状态切换、被拒绝的写入、读不懂的事件 —— 不落盘，重启即清。常驻进程里
  // 有这一条「最近发生了什么」，排障就不用再靠猜。
  const eventLog = [];
  const LOG_MAX = 200;
  const logEvent = (what) => {
    eventLog.push({ at: Date.now(), what });
    if (eventLog.length > LOG_MAX) eventLog.shift();
  };

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
  // 后台查一次新版本（24h 内命中缓存、离线静默）。结果挂在 frame().update 上，
  // 窗口和设置菜单据此显示「有新版本」。
  updateCheck.check().catch(() => {});

  // `presence` is evidence, not state: true means "a Claude process exists",
  // false means "we could not prove one does" (see src/presence.js).
  // `cheap` 只给心跳用：心跳唯一目的是把 quietFor 推新，为它每 30 秒摸一次磁盘
  // 不值当，所以用缓存的 selfcheck 结果。
  const frame = (cheap = false) => ({
    ...store.snapshot(),
    presence: presence.lastValue(),
    ccSwitch: ccSwitch.lastValue(),
    selfcheck: cheap ? selfcheckResult : currentSelfcheck(),
    update: updateCheck.lastValue(),
    heartbeat: cheap,
  });

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
      if (!verdict.ok) {
        // 带上查询串：被拒的写请求里往往带着 agent/session，不记下来就永远
        // 不知道「是谁没带 token」，只能看到一堆没头没尾的 refused。
        // 但查询串里也可能带着 token（CLI 支持 `?token=`），而 `/log` 是免
        // token 的读接口 —— 秘密绝不能抄进一个任何人都能读的地方。
        const redacted = (() => {
          if (!url.search) return '';
          const q = new URLSearchParams(url.search);
          if (q.has('token')) q.set('token', '***');
          const s = q.toString();
          return s ? `?${s}` : '';
        })();
        logEvent(`refused ${req.method} ${p}${redacted} (${verdict.error})`);
        return send(res, verdict.code, { error: verdict.error });
      }

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

      // 开机自启：设置里那个开关。GET 只读（免 token），POST 走既有的写入校验。
      // 真正的安装必须在 server 这个 **node** 进程里做（见顶部 require 的注释）。
      if (p === '/autostart') {
        if (req.method === 'GET') return send(res, 200, autostart.status());
        if (req.method === 'POST') {
          const raw = await readBody(req);
          let payload = {};
          try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }
          try {
            // 只认真正的布尔 true：手写的 `{"on":"false"}` 是真值，按 truthy
            // 判断会把它当成「开启」，在用户明确写了 false 的时候装启动项。
            if (payload && payload.on === true) autostart.install(); else autostart.uninstall();
          } catch (err) {
            return send(res, 500, { error: String(err.message || err) });
          }
          return send(res, 200, autostart.status());
        }
      }

      // 本机 CPU / 内存。面板每 2 秒取一次，所以它是一条独立通道 —— 混进
      // SSE 快照会让「资源占用」变成「代理状态变化」的副产品，忙碌时每秒
      // 推好几帧，闲置时又完全不更新。
      if (p === '/sys') return send(res, 200, sysinfo.sample());

      if (p === '/log') return send(res, 200, { events: eventLog });

      // 桌面便签：读免 token，写走既有的写入校验。它和代理状态无关，
      // 不参与主灯，也不会被 TTL 清掉 —— 忘了的事要一直留着。
      if (p === '/notes') {
        if (req.method === 'GET') return send(res, 200, notes.snapshot());
        if (req.method === 'POST') {
          const raw = await readBody(req, 16 * 1024);
          let payload;
          try { payload = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'invalid json' }); }
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
          const result = notes.apply(payload);
          return send(res, result && result.error ? 400 : 200, result);
        }
      }

      if (p === '/state' && req.method === 'POST') {
        const raw = await readBody(req);
        const payload = raw ? JSON.parse(raw) : {};
        // 既没有 state 也没有 fuel 的 body 一定是拼错了：store 会把它 normalise 成
        // idle，凭空在面板上点亮一个「就绪」槽位，而调用方以为自己报的是 busy。
        if (payload.state === undefined && payload.fuel === undefined) {
          return send(res, 400, { error: 'state or fuel required' });
        }
        const session = payload.session || 'default';
        const prev = store.sessions.get(session);
        const result = store.set(payload);
        const next = store.sessions.get(session);
        if (next && (!prev || prev.state !== next.state)) {
          logEvent(`${next.agent || 'agent'} ${session} → ${next.state}`);
        }
        return send(res, 200, result);
      }

      // An event a hook could not map. It never moves the lamp; it only lets
      // the display admit that something is arriving that we cannot read.
      if (p === '/unknown' && req.method === 'POST') {
        const raw = await readBody(req);
        const payload = raw ? JSON.parse(raw) : {};
        store.noteUnknown(payload.event, payload.session);
        logEvent(`unknown event: ${String(payload.event || '').slice(0, 80)}`);
        return send(res, 200, { ok: true });
      }

      if (p === '/unknown/clear' && req.method === 'POST') {
        store.clearUnknown();
        return send(res, 200, { ok: true });
      }

      // Convenience for shell one-liners and hooks. 写入（含 GET）必须带 token：
      //   Invoke-RestMethod -Headers @{'x-bao-token'=(bao token)} localhost:4747/set/busy?agent=claude
      // 没带 token 的 GET 会被上面的 guard 拒绝（否则 <img> 就能替你点灯）。
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
        const session = pick('session', 'default');
        const prev = store.sessions.get(session);
        const result = store.set({
          state,
          agent: pick('agent', 'agent'),
          session,
          detail: pick('detail', ''),
          cwd: pick('cwd', ''),
        });
        const next = store.sessions.get(session);
        if (next && (!prev || prev.state !== next.state)) {
          logEvent(`${next.agent || 'agent'} ${session} → ${next.state}`);
        }
        return send(res, 200, result);
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
        // Stop accepting new connections *now*, not 150ms from now. `bao stop`
        // returns as soon as it sees this response, and `bao stop && bao start`
        // is a normal thing to type — if the old listener is still up, the new
        // start sees a live server, says "already running", and leaves the
        // desktop without a robot when the old one exits.
        try { server.close(); } catch { /* already closing */ }
        // 告诉所有客户端「这是计划内关闭」：窗口收到就自己退出。否则它会以一个
        // 「未连接」的孤儿进程留在桌面上，继续占着单实例锁和全局快捷键。
        for (const c of clients) { try { c.write('event: quit\ndata: {}\n\n'); } catch { clients.delete(c); } }
        // 先把防抖里那 2 秒的今日统计写下去，再退出。
        flushStats();
        return setTimeout(() => process.exit(0), 150);
      }

      // Static: the same overlay UI Electron loads, so a plain browser tab works too.
      // 用 resolve + 严格前缀（含分隔符）校验，堵住 `../overlay-evil/x` 这种同前缀
      // 兄弟目录穿越（老的 startsWith(OVERLAY_DIR) 会被这种路径骗过）。
      const file = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
      let abs = path.resolve(OVERLAY_DIR, file);
      // 目录形式（/foo/ 或 /foo）落到它自己的 index.html，避免要记住
      // `/foo/index.html` 这种地址。
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) abs = path.join(abs, 'index.html');
      const insideOverlay = abs === OVERLAY_DIR || abs.startsWith(OVERLAY_DIR + path.sep);
      if (insideOverlay && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' });
        // stat 与 open 之间文件可能被替换/删除（升级、编辑器保存、杀软隔离）。
        // 读流没有 error 监听器时，'error' 是未捕获异常 —— 一个落空的静态请求
        // 就能把常驻的 server 整个带走。断开响应即可，下次请求会重新解析。
        const stream = fs.createReadStream(abs);
        stream.on('error', () => { try { res.end(); } catch { /* 已经关了 */ } });
        return stream.pipe(res);
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
  // Ctrl+C（`start --foreground`）、工具栏 / 托盘退出最终都会走到 process.exit，
  // 这条路径不经过 server.close()。'exit' 里只能做同步操作，写盘正好是同步的 ——
  // 这是把「退出那一刻还在忙」的时长留下来的最后机会。
  process.once('exit', flushStats);

  store.on('change', () => {
    // 没有窗口在听就什么都不用做：新连接建立时会立刻收到一帧完整快照。
    if (!clients.size) return;
    if (broadcastTimer) return;
    // 一条广播 = 一次完整快照的序列化 + 每个窗口一次 socket 写入。钩子和观察器
    // 忙起来时会在几十毫秒内连报好几条（多个会话同时变化），把同一个窗口里的
    // 变化合并成一帧：客户端看到的仍是最新状态，中间帧本来也会被下一帧覆盖。
    // 50ms 远低于人眼可辨的延迟，也低于任何轮询粒度。
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      const line = `data: ${JSON.stringify(frame())}\n\n`;
      for (const c of clients) { try { c.write(line); } catch { clients.delete(c); } }
    }, 50);
    if (broadcastTimer.unref) broadcastTimer.unref();
  });

  // 心跳：snapshot 里的 quietFor 是「算的那一刻」的静止时长，而 change 只在
  // 真的变化时广播。一个不再上报的 busy 会话不会产生任何事件，客户端手里的
  // quietFor 就永远停在最后一帧 —— 「卡住 5 分钟」的提醒永远到不了点。
  // 只重发一帧（不 emit change，免得每 30 秒白写一次 stats），并标记 heartbeat。
  const aliveTimer = setInterval(() => {
    if (!clients.size) return;
    const line = `data: ${JSON.stringify(frame(true))}\n\n`;
    for (const c of clients) { try { c.write(line); } catch { clients.delete(c); } }
  }, 30_000);
  if (aliveTimer.unref) aliveTimer.unref();

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
