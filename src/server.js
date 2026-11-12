'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store } = require('./store');
const config = require('./config');
const presence = require('./presence');
const ccSwitch = require('./adapters/ccswitch');
const selfcheck = require('./selfcheck');

const OVERLAY_DIR = path.join(__dirname, 'overlay');
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
};

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
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
  store.on('change', () => {
    if (statsTimer) return;
    statsTimer = setTimeout(() => {
      statsTimer = null;
      try {
        config.ensureDir();
        fs.writeFileSync(statsFile, JSON.stringify(store.stats));
      } catch { /* 写不进也不影响运行 */ }
    }, 2000);
    if (statsTimer.unref) statsTimer.unref();
  });

  const clients = new Set();

  // 启动自检：每次启动同步跑一遍，结果挂进快照（机器人窗口据此提示）+ 单独端点。
  const selfcheckResult = selfcheck.run();

  // `presence` is evidence, not state: true means "a Claude process exists",
  // false means "we could not prove one does" (see src/presence.js).
  const frame = () => ({ ...store.snapshot(), presence: presence.lastValue(), ccSwitch: ccSwitch.lastValue(), selfcheck: selfcheckResult });

  const send = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    // Local-only tool: allow the overlay page (and OBS/browser sources) to read it.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    try {
      // `clients` is how many overlays are listening. A running server with
      // nobody watching is not a running robot.
      if (p === '/health') return send(res, 200, { ok: true, name: 'baoanlight', pid: process.pid, port, clients: clients.size });

      if (p === '/state' && req.method === 'GET') return send(res, 200, frame());

      if (p === '/selfcheck') return send(res, 200, selfcheckResult);

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

      // Convenience for shell one-liners and hooks:  curl -s localhost:4747/set/busy?agent=claude
      if (p.startsWith('/set/')) {
        const state = p.slice('/set/'.length);
        return send(res, 200, store.set({
          state,
          agent: url.searchParams.get('agent') || 'agent',
          session: url.searchParams.get('session') || 'default',
          detail: url.searchParams.get('detail') || '',
          cwd: url.searchParams.get('cwd') || '',
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
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
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
        return setTimeout(() => process.exit(0), 50);
      }

      // Static: the same overlay UI Electron loads, so a plain browser tab works too.
      // 用 resolve + 严格前缀（含分隔符）校验，堵住 `../overlay-evil/x` 这种同前缀
      // 兄弟目录穿越（老的 startsWith(OVERLAY_DIR) 会被这种路径骗过）。
      const file = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
      const abs = path.resolve(OVERLAY_DIR, file);
      const insideOverlay = abs === OVERLAY_DIR || abs.startsWith(OVERLAY_DIR + path.sep);
      if (insideOverlay && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' });
        return fs.createReadStream(abs).pipe(res);
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, 400, { error: String(err.message || err) });
    }
  });

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
      try { fs.writeFileSync(config.PORT_FILE, String(port)); } catch {}
      presence.claudeRunning().catch(() => {});
      resolve({ server, store, port });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  start().then(({ port }) => console.log(`baoanlight server on http://127.0.0.1:${port}`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
