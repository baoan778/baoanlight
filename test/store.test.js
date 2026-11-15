'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { Store } = require('../src/store');

test('the most attention-hungry session wins the lamp', () => {
  const s = new Store();
  s.set({ session: 'a', state: 'idle' });
  assert.equal(s.snapshot().overall, 'idle');

  s.set({ session: 'b', state: 'busy' });
  assert.equal(s.snapshot().overall, 'busy', 'busy outranks idle');

  s.set({ session: 'c', state: 'waiting' });
  assert.equal(s.snapshot().overall, 'waiting', 'waiting outranks everything');

  s.set({ session: 'c', state: 'idle' });
  assert.equal(s.snapshot().overall, 'busy', 'drops back once nobody is waiting');
});

test('offline removes a session rather than storing a state', () => {
  const s = new Store();
  s.set({ session: 'a', state: 'busy' });
  s.set({ session: 'a', state: 'offline' });
  assert.equal(s.snapshot().sessions.length, 0);
  assert.equal(s.snapshot().overall, 'offline');
});

test('since only resets when the state actually changes', async () => {
  const s = new Store();
  s.set({ session: 'a', state: 'busy' });
  const first = s.snapshot().sessions[0].since;
  await new Promise((r) => setTimeout(r, 20));
  s.set({ session: 'a', state: 'busy', detail: 'still going' });
  assert.equal(s.snapshot().sessions[0].since, first, 'repeat of same state keeps since');
  s.set({ session: 'a', state: 'idle' });
  assert.notEqual(s.snapshot().sessions[0].since, first, 'a real change moves since');
});

test('rejects an unknown state instead of guessing', () => {
  const s = new Store();
  assert.throws(() => s.set({ session: 'a', state: 'purple' }), /unknown state/);
});

// The colour contract has an order, and it is not the order of arrival: a
// broken run must not be hidden behind a polite permission prompt.
test('a failure outranks a question, a question outranks work', () => {
  const s = new Store();
  s.set({ session: 'a', state: 'waiting' });
  s.set({ session: 'b', state: 'busy' });
  assert.equal(s.snapshot().overall, 'waiting', 'waiting outranks working');

  s.set({ session: 'c', state: 'error' });
  assert.equal(s.snapshot().overall, 'error', 'a failed run outranks everything');

  s.set({ session: 'c', state: 'offline' });
  assert.equal(s.snapshot().overall, 'waiting', 'and drops back when it clears');
});

// P0: one robot must show every software at once. Each agent owns a fixed
// slot, and the slot exists even when that software is not running — a cell
// that appears and disappears makes the strip unreadable at a glance.
test('every registered software keeps a fixed slot, running or not', () => {
  const s = new Store();
  const empty = s.snapshot();
  assert.deepEqual(empty.slots.map((x) => x.agent),
    ['deepseek', 'claude', 'codex', 'workbuddy', 'codebuddy']);
  assert.ok(empty.slots.every((x) => x.state === 'offline' && x.count === 0));

  s.set({ session: 'c1', agent: 'claude', state: 'busy' });
  s.set({ session: 'x1', agent: 'codex', state: 'waiting' });

  const snap = s.snapshot();
  assert.equal(snap.slots[1].state, 'busy', 'claude is slot 1 in the fixed order');
  assert.equal(snap.slots[2].state, 'waiting', 'codex is slot 2');
  assert.equal(snap.slots[3].state, 'offline', 'workbuddy is not running, and says so');
  assert.equal(snap.overall, 'waiting', 'the worst state wins the main lamp');
});

// Four Claude windows are one software, not four slots: the user needs to know
// that Claude wants them, not which window it was.
test('several sessions of one software collapse into one slot', () => {
  const s = new Store();
  s.set({ session: 'c1', agent: 'claude', state: 'busy' });
  s.set({ session: 'c2', agent: 'claude', state: 'waiting' });
  s.set({ session: 'c3', agent: 'claude', state: 'idle' });

  const slot = s.snapshot().slots.find((x) => x.agent === 'claude');
  assert.equal(slot.count, 3);
  assert.equal(slot.state, 'waiting', 'the worst of the three, not the latest');
});

// Two software on the same state must produce the same picture every time.
// Picking "whoever reported last" made the panel flicker between two equals.
test('a tie on priority is broken by slot order, never by arrival time', async () => {
  const s = new Store();
  s.set({ session: 'd1', agent: 'deepseek', state: 'waiting' });
  await new Promise((r) => setTimeout(r, 5));
  s.set({ session: 'c1', agent: 'claude', state: 'waiting' });

  const snap = s.snapshot();
  assert.equal(snap.overall, 'waiting');
  assert.equal(snap.slots.find((x) => x.state === 'waiting').agent, 'deepseek',
    'deepseek comes first in the fixed order, even though claude reported later');
});

// Anything outside the built-in list is appended alphabetically, so a new
// agent works without touching the robot.
test('an unregistered software is still shown, after the known ones', () => {
  const s = new Store();
  s.set({ session: 'z1', agent: 'zed', state: 'busy' });
  s.set({ session: 'a1', agent: 'acme', state: 'idle' });

  // 内置槽位在前（见 AGENT_ORDER），未登记的按字母序追加在后面。
  const builtIn = s.snapshot().slots.length - 2;
  assert.deepEqual(
    s.snapshot().slots.map((x) => x.agent).slice(builtIn),
    ['acme', 'zed']
  );
});

test('`running` is accepted as the same thing as `busy`', () => {
  const s = new Store();
  s.set({ session: 'a', state: 'running' });
  assert.equal(s.snapshot().overall, 'busy', 'the documented word for working must not be rejected');
});

// Red disappearing on its own was the original sin of the traffic light: the
// user looks away for a minute and the failure is gone.
test('an error never ages out, however long it is left', async () => {
  const s = new Store({ idleTtlMs: 60 });
  s.set({ session: 'a', state: 'error' });
  await new Promise((r) => setTimeout(r, 200));
  s.sweep();
  assert.equal(s.snapshot().overall, 'error');
});

// An event we cannot read must never move the lamp — that bug pinned the light
// yellow forever. But it must not be swallowed either, or the user has no way
// to learn that their agent is sending something this tool does not understand.
test('an unreadable event is recorded without touching the lamp', () => {
  const s = new Store();
  s.set({ session: 'a', state: 'idle' });

  s.noteUnknown('SomeFutureHook', 'ab12');

  const snap = s.snapshot();
  assert.equal(snap.overall, 'idle', 'the lamp stays where it was');
  assert.equal(snap.unknownEvent.event, 'SomeFutureHook', 'but the fact is reported');
  assert.equal(snap.unknownEvent.session, 'ab12');

  s.clearUnknown();
  assert.equal(s.snapshot().unknownEvent, null);
});

// This used to promote a silent busy session to idle, on the theory that a
// working agent reports constantly. It does not: an agent thinking hard with no
// tool calls reports nothing for minutes, and the lamp turned green while it was
// still working — telling the user "finished, come and look" on the strength of
// silence alone. Silence is now shown as silence.
test('a busy session that goes quiet stays busy, and is marked quiet', async () => {
  const s = new Store({ quietAfterMs: 100, idleTtlMs: 600_000 });
  s.set({ session: 'thinking', agent: 'claude', state: 'busy', detail: 'thinking' });

  await new Promise((r) => setTimeout(r, 220));
  s.sweep();

  const x = s.snapshot().sessions[0];
  assert.equal(x.state, 'busy', 'silence is not evidence that it finished');
  assert.equal(x.quiet, true, 'but it is shown as unconfirmed');
  assert.equal(s.snapshot().overall, 'busy');
});

test('a busy session silent past the idle window is dropped, not turned green', async () => {
  const s = new Store({ idleTtlMs: 120, quietAfterMs: 50 });
  s.set({ session: 'gone', agent: 'claude', state: 'busy' });

  await new Promise((r) => setTimeout(r, 240));
  s.sweep();

  assert.equal(s.snapshot().sessions.length, 0, 'the agent is gone, so the session goes');
  assert.equal(s.snapshot().overall, 'offline');
});

test('a waiting session never decays — red must not disappear on its own', async () => {
  const s = new Store({ idleTtlMs: 600_000 });
  s.set({ session: 'a', state: 'waiting' });
  await new Promise((r) => setTimeout(r, 150));
  s.sweep();
  assert.equal(s.snapshot().overall, 'waiting');
});

// An agent that crashes or is force-quit never sends SessionEnd, so its pill
// would sit there for hours claiming "ready" when nothing is running. This is
// the same failure as the stuck-yellow lamp: the light must not report a session
// that no longer exists.
test('a green session nobody touches is forgotten, not left claiming "ready"', async () => {
  const s = new Store({ idleTtlMs: 120 });
  s.set({ session: 'ghost', agent: 'claude', state: 'idle' });
  s.set({ session: 'live', agent: 'claude', state: 'idle' });

  const keepAlive = setInterval(() => s.set({ session: 'live', agent: 'claude', state: 'idle' }), 40);
  await new Promise((r) => setTimeout(r, 260));
  clearInterval(keepAlive);
  s.sweep();

  const ids = s.snapshot().sessions.map((x) => x.session);
  assert.ok(!ids.includes('ghost'), 'the abandoned session is gone');
  assert.ok(ids.includes('live'), 'one still reporting stays');
});

test('a waiting session is never forgotten, however long it waits', async () => {
  const s = new Store({ idleTtlMs: 60 });
  s.set({ session: 'a', state: 'waiting' });
  await new Promise((r) => setTimeout(r, 200));
  s.sweep();
  assert.equal(s.snapshot().overall, 'waiting', 'red must survive any amount of waiting');
});

// A window that reported once and then went silent looked identical to one that
// had just said "ready" — the light presented a stale claim with full
// confidence, and there was no way to tell the difference.
test('a session that has gone silent is marked quiet, not fresh', async () => {
  const s = new Store({ quietAfterMs: 100, idleTtlMs: 600_000 });
  s.set({ session: 'silent', agent: 'claude', state: 'idle' });
  s.set({ session: 'chatty', agent: 'claude', state: 'idle' });

  const keepAlive = setInterval(() => s.set({ session: 'chatty', agent: 'claude', state: 'idle' }), 30);
  await new Promise((r) => setTimeout(r, 220));
  clearInterval(keepAlive);

  const by = Object.fromEntries(s.snapshot().sessions.map((x) => [x.session, x]));
  assert.equal(by.silent.quiet, true, 'the silent one is flagged');
  assert.ok(by.silent.quietFor >= 100, 'and says how long it has been silent');
  assert.equal(by.chatty.quiet, undefined, 'one still reporting is not flagged');
  assert.equal(by.silent.state, 'idle', 'the state itself is unchanged — only our confidence in it');
});

// Observed in the wild: closing a Claude Code window ended one session and
// opened another in the same second, and that new one fired SessionStart and
// nothing else — ever. No prompt, no tool call, no end. It sat on screen as a
// "ready" agent that had never existed in any meaningful sense.
test('a session that announces itself and does nothing is forgotten quickly', async () => {
  const s = new Store({ unusedTtlMs: 100, idleTtlMs: 600_000 });

  s.set({ session: 'phantom', agent: 'claude', state: 'idle' });      // SessionStart only
  s.set({ session: 'real', agent: 'claude', state: 'busy' });          // did some work
  s.set({ session: 'real', agent: 'claude', state: 'idle' });          // then finished

  await new Promise((r) => setTimeout(r, 220));
  s.sweep();

  const ids = s.snapshot().sessions.map((x) => x.session);
  assert.ok(!ids.includes('phantom'), 'the session that never did anything is gone');
  assert.ok(ids.includes('real'), 'one that worked and finished is kept for the full idle window');
});

test('a session counts as used once it goes busy or waiting', () => {
  const s = new Store();
  s.set({ session: 'a', agent: 'claude', state: 'idle' });
  assert.ok(!s.snapshot().sessions[0].everBusy, 'idle alone does not count as use');

  s.set({ session: 'a', agent: 'claude', state: 'busy' });
  s.set({ session: 'a', agent: 'claude', state: 'idle' });
  assert.ok(s.snapshot().sessions[0].everBusy, 'and it stays used after finishing');
});

test('sessions expire after the TTL', async () => {
  const s = new Store({ ttlMs: 80 });
  s.set({ session: 'a', state: 'idle' });
  await new Promise((r) => setTimeout(r, 140));
  s.sweep();
  assert.equal(s.snapshot().sessions.length, 0);
});

// 今日统计：忙碌时长按 agent 累计，跨天清零，重启可 merge 回来。
test('daily busy time is accumulated per agent', async () => {
  const s = new Store();
  s.set({ session: 'a', agent: 'claude', state: 'busy' });
  await new Promise((r) => setTimeout(r, 50));
  s.set({ session: 'a', agent: 'claude', state: 'idle' });

  const snap = s.snapshot();
  assert.ok(snap.stats.day, 'stats carry a day key');
  assert.ok((snap.stats.byAgent.claude || 0) >= 40, 'the busy stretch is counted');
});

test('a stale stats file from another day is reset on merge', () => {
  const s = new Store();
  s.mergeStats({ day: '2000-01-01', byAgent: { claude: 999999 } });
  assert.deepEqual(s.snapshot().stats.byAgent, {}, 'yesterday never leaks into today');
});

// 跨夜重启：存档文件是昨天的，但历史必须保留（昨天还要归档进 history）。
test('a stale stats file keeps its history and archives the stale day', () => {
  const s = new Store();
  s.mergeStats({
    day: '2000-01-01',
    byAgent: { claude: 999999 },
    events: { claude: { done: 5, error: 1 } },
    history: { '1999-12-31': { byAgent: { codex: 1000 }, events: { codex: { done: 1 } } } },
  });
  const st = s.snapshot().stats;
  assert.deepEqual(st.byAgent, {}, 'stale day never leaks into today');
  assert.ok(st.history['1999-12-31'], 'older history survives the restart');
  assert.ok(st.history['2000-01-01'], 'the stale day itself is archived, not lost');
  assert.equal(st.history['2000-01-01'].events.claude.done, 5);
});

// 今日战绩：进入完成/出错各记一次，同一状态连续上报不重复。
test('done and error transitions are counted per agent', () => {
  const s = new Store();
  s.set({ session: 'a', agent: 'claude', state: 'busy' });
  s.set({ session: 'a', agent: 'claude', state: 'done' });
  s.set({ session: 'a', agent: 'claude', state: 'done' });   // 重复上报不算
  s.set({ session: 'b', agent: 'codex', state: 'busy' });
  s.set({ session: 'b', agent: 'codex', state: 'error' });

  const ev = s.snapshot().stats.events;
  assert.equal(ev.claude.done, 1, 'claude 完成记 1 次');
  assert.equal(ev.codex.error, 1, 'codex 出错记 1 次');
});

// 「完成」是瞬态：刚完成亮紫，过了 doneTtl 就退回空闲（就绪），不能一直钉紫。
test('done is transient and decays back to idle', async () => {
  const s = new Store({ doneTtlMs: 30 });
  s.set({ session: 'a', agent: 'claude', state: 'busy' });
  s.set({ session: 'a', agent: 'claude', state: 'done' });
  assert.equal(s.snapshot().sessions[0].state, 'done');

  await new Promise((r) => setTimeout(r, 50));
  s.sweep();
  assert.equal(s.snapshot().sessions[0].state, 'idle', 'done 过了 doneTtl 就退回空闲');
});
