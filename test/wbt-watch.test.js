'use strict';
// CodeBuddy / WorkBuddy 的 transcript 适配器：记录类型 -> 状态。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 隔离：本文件在 port 0 上起 server，别把临时端口写进用户真实的端口文件。
process.env.BAOANLIGHT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-wbt-'));

const wbt = require('../src/adapters/wbt-watch');

test('a transcript record maps onto the lamp the way the tool actually behaves', () => {
  // 模型思考、调工具 = 在干活。
  assert.equal(wbt.stateOf({ type: 'reasoning' }), 'busy');
  assert.equal(wbt.stateOf({ type: 'function_call', name: 'Bash' }), 'busy');
  assert.equal(wbt.stateOf({ type: 'function_call_result', name: 'Bash' }), 'busy');
  // 用户发话 = 新一轮开始；助手说完 = 这一轮结束（紫灯闪一下再回空闲）。
  assert.equal(wbt.stateOf({ type: 'message', role: 'user' }), 'busy');
  assert.equal(wbt.stateOf({ type: 'message', role: 'assistant' }), 'done');
  // 纯元数据不该点亮任何东西 —— 否则一开 IDE 就「忙碌」。
  assert.equal(wbt.stateOf({ type: 'session-meta' }), null);
  assert.equal(wbt.stateOf({ type: 'file-history-snapshot' }), null);
  assert.equal(wbt.stateOf({ type: 'ai-title' }), null);
  assert.equal(wbt.stateOf(null), null);
});

test('the row gets the tool name, never the prompt text', () => {
  assert.equal(wbt.detailOf({ type: 'function_call', name: 'Bash' }), '运行 Bash');
  assert.equal(wbt.detailOf({ type: 'reasoning' }), '思考中');
  assert.equal(wbt.detailOf({ type: 'message', role: 'user' }), '收到新指令');
  // 记录里带着完整对话，但 detail 只该来自类型与工具名。
  assert.equal(wbt.detailOf({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SECRET' }] })
    .includes('SECRET'), false);
});

// 端到端：写一条记录，灯就该亮；助手回完，灯就该收。
test('watching a transcript turns into live state on the server', async () => {
  const { start } = require('../src/server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbt-proj-'));
  const proj = path.join(dir, 'demo-project');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, 'sess-1.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session-meta', sessionId: 'sess-1' }) + '\n');

  let srv;
  let timer;
  try {
    ({ server: srv } = await start({ port: 0 }));
    const port = srv.address().port;
    const state = async () => (await fetch(`http://127.0.0.1:${port}/state`)).json();
    const waitFor = async (fn, label) => {
      const until = Date.now() + 4000;
      while (Date.now() < until) {
        const snap = await state();
        const hit = (snap.sessions || []).find((s) => s.agent === 'codebuddy');
        if (fn(hit, snap)) return hit;
        await new Promise((r) => setTimeout(r, 60));
      }
      throw new Error(`timed out waiting for ${label}`);
    };

    timer = wbt.run({ dir, interval: 40, quiet: true });
    // 首帧只有元数据：不该点亮任何东西。
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await state()).sessions.find((s) => s.agent === 'codebuddy'), undefined,
      'metadata alone must not light the lamp');

    fs.appendFileSync(file, JSON.stringify({ type: 'function_call', name: 'Bash', cwd: 'd:\\demo' }) + '\n');
    const busy = await waitFor((s) => s && s.state === 'busy', 'busy');
    assert.match(busy.detail, /Bash/);

    fs.appendFileSync(file, JSON.stringify({ type: 'message', role: 'assistant' }) + '\n');
    await waitFor((s) => s && s.state === 'done', 'done');
  } finally {
    if (timer) clearInterval(timer);
    srv && srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
