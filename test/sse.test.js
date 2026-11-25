'use strict';
// 传输层：状态变化通过 SSE 推给窗口。一条广播 = 一次完整快照的序列化 + 每个
// 窗口一次写入；钩子和观察器忙起来时，几条状态常常在同一个瞬间变化，窗口没必要
// 为每条中间态各收一帧 —— 它只画最新那一帧。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// 和别的测试一样隔离 HOME：临时端口不能写进用户真实的端口文件。
process.env.BAOANLIGHT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-sse-'));

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

after(() => server && server.close());

const api = (body) =>
  fetch(`http://127.0.0.1:${port}/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bao-token': token },
    body: JSON.stringify(body),
  });

test('a burst of state changes arrives as one coalesced SSE frame', async () => {
  const frames = [];
  const req = http.get(`http://127.0.0.1:${port}/events`, (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try { frames.push(JSON.parse(line.slice(6))); } catch { /* ping / quit 事件 */ }
      }
    });
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    // 等连接建立后的第一帧，别把「握手」算进下面的突发里。
    for (let i = 0; i < 50 && !frames.length; i++) await sleep(20);
    assert.ok(frames.length >= 1, 'the connection gets an initial frame');

    // 8 条状态几乎同时到达（多个会话/多个钩子）。
    const seq = ['busy', 'idle', 'busy', 'idle', 'busy', 'waiting', 'busy', 'error'];
    await Promise.all(seq.map((state, i) => api({ session: `burst-${i % 2}`, agent: 'claude', state })));
    // 再落一个确定的终态，验证合并后的最后一帧就是最新状态。
    await api({ session: 'burst-final', agent: 'claude', state: 'error' });
    await sleep(400);

    const mine = frames.filter((f) => (f.sessions || [])
      .some((s) => String(s.session).startsWith('burst-')));
    assert.ok(mine.length >= 1, 'the changes reach the window');
    // 9 次写入若逐条广播就是 9 帧；合并后每个 50ms 窗口最多一帧。上限留出
    // 「慢机器上这批请求跨了几个窗口」的余量，但仍能抓住「退回逐条广播」。
    assert.ok(mine.length <= 6,
      `a burst is coalesced instead of one frame per write (got ${mine.length})`);
    assert.equal(mine[mine.length - 1].overall, 'error', 'the final frame carries the latest state');
    assert.ok(mine[mine.length - 1].sessions.some((s) => s.session === 'burst-final'));
  } finally {
    req.destroy();
  }
});
