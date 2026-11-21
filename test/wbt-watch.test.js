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
  // 提问/请求批准不是「在干活」，而是「在等你」：灯必须是黄色。
  assert.equal(wbt.stateOf({ type: 'function_call', name: 'AskUserQuestion' }), 'waiting');
  assert.equal(wbt.stateOf({ type: 'function_call', name: 'request_approval' }), 'waiting');
  assert.equal(wbt.stateOf({ type: 'function_call_result', name: 'AskUserQuestion' }), 'busy');
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

test('an assistant message that is still calling tools is not a finished turn', () => {
  // 中途发言后面紧跟工具调用：灯不能先紫一下再变绿。
  assert.equal(
    wbt.stateOf({ type: 'message', role: 'assistant', content: [{ type: 'text', text: '我先查一下' }, { type: 'tool_use', name: 'Bash' }] }),
    'busy'
  );
  assert.equal(wbt.stateOf({ type: 'message', role: 'assistant', stop_reason: 'tool_use' }), 'busy');
  // 嵌套在 message 里的角色与内容也要认。
  assert.equal(
    wbt.stateOf({ type: 'message', message: { role: 'assistant', content: [{ type: 'function_call', name: 'Bash' }] } }),
    'busy'
  );
  assert.equal(wbt.stateOf({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '好了' }] } }), 'done');
});

test('the row gets the tool name, never the prompt text', () => {
  assert.equal(wbt.detailOf({ type: 'function_call', name: 'Bash' }), '运行 Bash');
  assert.equal(wbt.detailOf({ type: 'function_call', name: 'AskUserQuestion' }), '等你回答');
  assert.equal(wbt.detailOf({ type: 'reasoning' }), '思考中');
  assert.equal(wbt.detailOf({ type: 'message', role: 'user' }), '收到新指令');
  // 记录里带着完整对话，但 detail 只该来自类型与工具名。
  assert.equal(wbt.detailOf({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SECRET' }] })
    .includes('SECRET'), false);
});

test('the same transcript home is split into WorkBuddy and CodeBuddy', () => {
  // ~/.workbuddy 里跑的是 WorkBuddy；~/.codebuddy 才是 CodeBuddy CLI。
  // 以前一律记成 codebuddy，只开 WorkBuddy 的人会看到「CodeBuddy 在运行」。
  assert.equal(wbt.agentFor('C:/Users/x/.workbuddy/projects/p/a.jsonl', '', 'codebuddy'), 'workbuddy');
  assert.equal(wbt.agentFor('C:/Users/x/.codebuddy/projects/p/a.jsonl', '', 'codebuddy'), 'codebuddy');
  // 自定义目录时看会话自己的 cwd。
  assert.equal(wbt.agentFor('D:/logs/a.jsonl', 'c:\\Users\\x\\WorkBuddy\\2026-11-17-08-36-25', 'codebuddy'), 'workbuddy');
  assert.equal(wbt.agentFor('D:/logs/a.jsonl', 'D:/proj', 'codebuddy'), 'codebuddy');
  // 明确要求 workbuddy 时不改回别的名字。
  assert.equal(wbt.agentFor('D:/logs/a.jsonl', 'D:/proj', 'workbuddy'), 'workbuddy');
});

// 端到端：WorkBuddy 的 transcript 必须报成 workbuddy，而不是 codebuddy。
test('a WorkBuddy transcript is reported under the WorkBuddy name', async () => {
  const { start } = require('../src/server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbt-agent-'));
  const proj = path.join(dir, 'c-Users-x-WorkBuddy-2026-11-17');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, 'sess-wb.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session-meta', sessionId: 'sess-wb' }),
    JSON.stringify({ type: 'function_call', name: 'Bash', cwd: 'c:\\Users\\x\\WorkBuddy\\2026-11-17' }),
  ].join('\n') + '\n');

  let srv;
  let timer;
  try {
    ({ server: srv } = await start({ port: 0 }));
    const port = srv.address().port;
    timer = wbt.run({ dir, interval: 40, quiet: true, manual: true });
    let hit = null;
    const until = Date.now() + 4000;
    while (Date.now() < until && !hit) {
      const snap = await (await fetch(`http://127.0.0.1:${port}/state`)).json();
      hit = (snap.sessions || []).find((s) => s.session === 'workbuddy:sess-wb');
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.ok(hit, 'the session is filed under workbuddy');
    assert.equal(hit.state, 'busy');
    const wrong = (await (await fetch(`http://127.0.0.1:${port}/state`)).json())
      .sessions.some((s) => s.session === 'codebuddy:sess-wb');
    assert.equal(wrong, false, 'and never under codebuddy');
  } finally {
    if (timer && timer.stop) timer.stop(); else if (timer) clearInterval(timer);
    srv && srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 端到端：一轮对话早就结束了，watcher 现在才启动。不能把那次完成补发成
// 「刚刚完成」—— 那会多转一圈庆祝、多弹一条通知，也让今日完成数+1。
test('a transcript that finished long ago does not replay its completion on startup', async () => {
  const { start } = require('../src/server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbt-stale-'));
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const stale = path.join(proj, 'sess-stale.jsonl');
  fs.writeFileSync(stale, [
    JSON.stringify({ type: 'session-meta', sessionId: 'sess-stale' }),
    JSON.stringify({ type: 'function_call', name: 'Bash' }),
    JSON.stringify({ type: 'message', role: 'assistant' }),
  ].join('\n') + '\n');
  // 十分钟前结束：仍在 ACTIVE_MS（30 分钟）里，但早已不是「刚完成」。
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(stale, old, old);

  let srv;
  let timer;
  try {
    ({ server: srv } = await start({ port: 0 }));
    const port = srv.address().port;
    timer = wbt.run({ dir, interval: 40, quiet: true, manual: true });
    await new Promise((r) => setTimeout(r, 400));
    const snap = await (await fetch(`http://127.0.0.1:${port}/state`)).json();
    assert.equal(
      (snap.sessions || []).some((s) => s.session === 'codebuddy:sess-stale'),
      false,
      'an old finished turn must not come back as a fresh completion'
    );
  } finally {
    if (timer && timer.stop) timer.stop(); else if (timer) clearInterval(timer);
    srv && srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 一场会话里 assistant 的「中途说明」不是完成：它后面往往只隔几毫秒就跟着
// 工具调用。以前每条 assistant 文本都立刻报 done，灯在忙碌中反复闪紫、
// 「今日完成」被灌水（实测一场会话 117 条 assistant 文本里只有 33 条真的收尾）。
test('an assistant line followed by tool calls is not reported as a completion', async () => {
  const { start } = require('../src/server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbt-mid-'));
  const proj = path.join(dir, 'demo-project');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, 'sess-mid.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session-meta', sessionId: 'sess-mid' }),
    JSON.stringify({ type: 'function_call', name: 'Bash' }),
  ].join('\n') + '\n');

  let srv;
  let timer;
  try {
    ({ server: srv } = await start({ port: 0 }));
    const port = srv.address().port;
    const state = async () => (await fetch(`http://127.0.0.1:${port}/state`)).json();
    const session = (snap) => (snap.sessions || []).find((s) => s.session === 'codebuddy:sess-mid');
    const doneCount = (snap) => Number(snap && snap.stats && snap.stats.events
      && snap.stats.events.codebuddy && snap.stats.events.codebuddy.done) || 0;
    const waitFor = async (fn, label, ms = 5000) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const snap = await state();
        if (fn(snap)) return snap;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error(`timed out waiting for ${label}`);
    };

    timer = wbt.run({ dir, interval: 40, quiet: true, manual: true });
    await waitFor((snap) => session(snap) && session(snap).state === 'busy', 'busy');
    assert.equal(doneCount(await state()), 0);

    // 中途说明：先挂起，不能马上变成「已完成」。
    fs.appendFileSync(file, JSON.stringify({
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我先看看' }],
    }) + '\n');
    let sawDone = false;
    const watchUntil = Date.now() + 900;
    while (Date.now() < watchUntil) {
      const snap = await state();
      const s = session(snap);
      if (s && s.state === 'done') sawDone = true;
      await new Promise((r) => setTimeout(r, 30));
    }
    // 这轮还没完：紧跟着工具调用，灯必须留在运行中。
    fs.appendFileSync(file, JSON.stringify({ type: 'function_call', name: 'Bash' }) + '\n');
    await new Promise((r) => setTimeout(r, 1200));
    const midway = await state();
    assert.equal(sawDone, false, 'a mid-turn assistant line must not light the done lamp');
    assert.equal(session(midway).state, 'busy', 'the turn continues after the assistant line');
    assert.equal(doneCount(midway), 0, 'and it is not counted as a completed task');

    // 真正收尾（之后没有任何新记录）才该报完成，而且只报一次。
    fs.appendFileSync(file, JSON.stringify({ type: 'message', role: 'assistant' }) + '\n');
    const finished = await waitFor((snap) => session(snap) && session(snap).state === 'done', 'done');
    assert.equal(doneCount(finished), 1);
  } finally {
    if (timer && timer.stop) timer.stop(); else if (timer) clearInterval(timer);
    srv && srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

    timer = wbt.run({ dir, interval: 40, quiet: true, manual: true });
    // 首帧只有元数据：不该点亮任何东西。
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await state()).sessions.find((s) => s.agent === 'codebuddy'), undefined,
      'metadata alone must not light the lamp');

    fs.appendFileSync(file, JSON.stringify({ type: 'function_call', name: 'Bash', cwd: 'd:\\demo' }) + '\n');
    const busy = await waitFor((s) => s && s.state === 'busy', 'busy');
    assert.match(busy.detail, /Bash/);

    // 状态还是 busy，但那行小字必须跟着换 —— 否则它会一直停在「运行 Bash」。
    fs.appendFileSync(file, JSON.stringify({ type: 'reasoning' }) + '\n');
    await waitFor((s) => s && s.state === 'busy' && s.detail === '思考中', 'detail refresh');

    fs.appendFileSync(file, JSON.stringify({ type: 'message', role: 'assistant' }) + '\n');
    await waitFor((s) => s && s.state === 'done', 'done');
  } finally {
    if (timer && timer.stop) timer.stop(); else if (timer) clearInterval(timer);
    srv && srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
