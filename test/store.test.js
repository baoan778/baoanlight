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

// The panel has room for eight, but the main lamp has to speak for all of
// them. A red ninth agent that only exists in `slotsOverflow` must not leave
// the robot looking calm.
test('an agent beyond the visible slots still drives the main lamp', () => {
  const s = new Store();
  for (const a of ['deepseek', 'claude', 'codex', 'workbuddy', 'codebuddy', 'alpha', 'bravo', 'charlie']) {
    s.set({ session: a, agent: a, state: 'idle' });
  }
  s.set({ session: 'zeta', agent: 'zeta', state: 'error' });

  const snap = s.snapshot();
  assert.equal(snap.slotsOverflow, 1, 'zeta does not fit in the panel');
  assert.equal(snap.slots.some((x) => x.agent === 'zeta'), false);
  assert.equal(snap.overall, 'error', 'the hidden failure still wins the main lamp');
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

// 静默超过 staleBusyMs 的「运行中」不再算运行中：会话本身还活着（卡住提醒要
// 看得到原始 busy），但灯和槽位必须降为「不确定」，否则一个卡死的会话能让机器人
// 一直绿到 TTL 结束 —— 这正是「只会显示一种绿色」的来源。
test('a busy session silent past staleBusyMs is demoted to unknown, not left green', async () => {
  const s = new Store({ quietAfterMs: 20, staleBusyMs: 100, idleTtlMs: 600_000 });
  s.set({ session: 'stuck', agent: 'claude', state: 'busy' });

  await new Promise((r) => setTimeout(r, 160));

  const snap = s.snapshot();
  const x = snap.sessions[0];
  assert.equal(x.state, 'busy', 'the raw state is kept for the stuck reminder');
  assert.equal(x.stale, true);
  assert.equal(snap.slots.find((y) => y.agent === 'claude').state, 'unknown');
  assert.equal(snap.slots.find((y) => y.agent === 'claude').stale, true);
  assert.equal(snap.overall, 'unknown');
});

test('a stale busy never outranks a real waiting session', async () => {
  const s = new Store({ quietAfterMs: 20, staleBusyMs: 100, idleTtlMs: 600_000 });
  s.set({ session: 'stuck', agent: 'claude', state: 'busy' });

  await new Promise((r) => setTimeout(r, 160));
  s.set({ session: 'ask', agent: 'codex', state: 'waiting' });

  const snap = s.snapshot();
  assert.equal(snap.slots.find((x) => x.agent === 'claude').state, 'unknown');
  assert.equal(snap.overall, 'waiting');
});

// 静默超时只说明「它不再汇报了」，不等于它又白干了半小时。今日时长要停在
// 最后一帧证据上，否则日目标/里程碑会被沉默虚报提前触发。
test('a dropped busy session is credited only up to its last report', () => {
  const s = new Store({ idleTtlMs: 100 });
  s.set({ session: 'gone', agent: 'claude', state: 'busy' });
  const rec = s.sessions.get('gone');
  const now = Date.now();
  rec.since = now - 10_000;
  rec.updatedAt = now - 2_000;

  s.sweep();

  const ms = s.snapshot().stats.byAgent.claude || 0;
  assert.ok(ms >= 7_000 && ms <= 8_500, `expected ~8s of evidence, counted ${ms}ms`);
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

// 「完成」是一条结论，只有真跑过才会出现。读 transcript 的适配器恢复出来的第一帧
// 往往就是 done；如果它不算「用过」，这个会话会在 2 分钟后被当成幻影清掉 ——
// 用户看到的就是「明明在用，灯却没了」。
test('a session that has only reported done still counts as used', () => {
  const s = new Store();
  s.set({ session: 'a', agent: 'codebuddy', state: 'done' });
  assert.ok(s.snapshot().sessions[0].everBusy, 'done means a turn really finished');
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

// 落盘不能只写「已经结束」的那些段：退出 / 重启时正在忙的整段也要留下，
// 但绝不能因此改写会话的 since（界面上的「已运行 N 分钟」不能归零）。
test('persisting stats includes the stretch that is still running', async () => {
  const s = new Store();
  s.set({ session: 'a', agent: 'claude', state: 'busy' });
  const since = s.sessions.get('a').since;
  await new Promise((r) => setTimeout(r, 60));

  const first = s.statsForPersistence();
  assert.ok(first.byAgent.claude >= 50, `expected the live stretch, got ${first.byAgent.claude || 0}`);
  assert.equal(s.sessions.get('a').since, since, 'persisting must not reset the visible duration');

  await new Promise((r) => setTimeout(r, 30));
  const second = s.statsForPersistence();
  assert.ok(second.byAgent.claude - first.byAgent.claude < 100,
    'a later snapshot replaces the live stretch instead of adding it again (no double count)');
  assert.ok(s.snapshot().stats.byAgent.claude >= 50, 'the display already counted it');

  s.set({ session: 'a', agent: 'claude', state: 'idle' });
  const settled = s.statsForPersistence();
  assert.ok(settled.byAgent.claude >= 70, 'the finished stretch is kept');
  assert.ok(settled.byAgent.claude < 300, `and not counted twice (${settled.byAgent.claude}ms)`);
});

// 跨午夜仍在忙的会话：昨天 23:00 开始、一直没停，昨天的历史里必须有那 1 小时。
// 以前 checkDay 只归档已经结算的 byAgent，这段会凭空消失。
test('a busy session that crosses midnight is credited to the archived day', () => {
  const s = new Store();
  s.set({ session: 'night', agent: 'claude', state: 'busy' });

  const now = Date.now();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(23, 0, 0, 0);
  const key = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

  s.stats.day = key;
  s.stats.byAgent = {};
  s.stats.events = {};
  s.sessions.get('night').since = yesterday.getTime();
  s.checkDay(now);

  const archived = s.stats.history[key];
  assert.ok(archived, 'the archived day exists');
  assert.ok(archived.byAgent.claude >= 60 * 60 * 1000 - 1000,
    `the final hour before midnight is kept (${archived.byAgent.claude}ms)`);
  assert.equal(s.stats.byAgent.claude, undefined, 'today starts at zero');
});

test('a stale stats file from another day is reset on merge', () => {
  const s = new Store();
  s.mergeStats({ day: '2000-01-01', byAgent: { claude: 999999 } });
  assert.deepEqual(s.snapshot().stats.byAgent, {}, 'yesterday never leaks into today');
});

// stats.json 可能被手改过，或来自字段类型不同的旧版本。字符串会被
// `byAgent[agent] + ms` 变成拼接（"abc100"），之后今日时长整列 NaN；
// 合并时只收有限的非负数。
test('a stats file with non-numeric values is sanitized instead of concatenated', () => {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const s = new Store();
  s.mergeStats({
    day: today,
    byAgent: { claude: 'abc', codex: -5, deepseek: 1000 },
    events: { claude: { done: '2', error: 1 } },
  });
  const st = s.snapshot().stats;
  assert.equal(st.byAgent.claude, 0, 'a string becomes zero, not a concatenation base');
  assert.equal(st.byAgent.codex, 0, 'negative time is not work');
  assert.equal(st.byAgent.deepseek, 1000);
  assert.equal(st.events.claude.done, 2, 'numeric strings are still numbers');
  assert.equal(st.events.claude.error, 1);

  s.set({ session: 'x', agent: 'claude', state: 'busy' });
  s.set({ session: 'x', agent: 'claude', state: 'idle' });
  assert.equal(typeof st.byAgent.claude, 'number');
  assert.equal(Number.isFinite(s.snapshot().stats.byAgent.claude), true, 'busy time stays numeric');
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

// 保留 30 天：足够做月报，又不会让 stats.json 无限膨胀。
test('history keeps the last 30 days and drops the rest', () => {
  const s = new Store();
  const history = {};
  for (let i = 40; i >= 1; i--) {
    const d = new Date(2020, 0, i);   // 2020-01-01 .. 02-09
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    history[key] = { byAgent: { claude: 1 }, events: {} };
  }
  s.mergeStats({ day: '2020-02-10', byAgent: { claude: 1 }, events: {}, history });
  const keys = Object.keys(s.snapshot().stats.history);
  assert.equal(keys.length, 30, 'capped at 30 days');
  assert.ok(keys.every((k) => k >= '2020-01-11'), 'only the newest 30 survive');
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
  s.set({ session: 'a', agent: 'claude', state: 'done', detail: '这一轮结束' });
  assert.equal(s.snapshot().sessions[0].state, 'done');

  await new Promise((r) => setTimeout(r, 50));
  s.sweep();
  const idle = s.snapshot().sessions[0];
  assert.equal(idle.state, 'idle', 'done 过了 doneTtl 就退回空闲');
  assert.equal(idle.detail, '', '退回空闲后不再挂着上一轮的动作说明');
});

test('a state change is recorded as one evidence event', () => {
  const st = new Store();
  st.set({ session: 'ev-1', agent: 'claude', state: 'busy', detail: 'running', source: 'hook', event: 'PreToolUse' });
  const s = st.snapshot().sessions.find((x) => x.session === 'ev-1');
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].source, 'hook');
  assert.equal(s.events[0].event, 'PreToolUse');
  assert.equal(s.events[0].state, 'busy');
  assert.ok(s.lastEventAt > 0, 'the activity clock starts with the first real event');
});

test('a repeated report does not add another event', () => {
  const st = new Store();
  st.set({ session: 'ev-2', agent: 'claude', state: 'busy', detail: 'running' });
  st.set({ session: 'ev-2', agent: 'claude', state: 'busy', detail: 'running' });
  assert.equal(st.snapshot().sessions[0].events.length, 1);
});

test('a heartbeat keeps the session alive but is not evidence', () => {
  const st = new Store();
  st.set({ session: 'ev-3', agent: 'codex', state: 'busy', detail: 'working' });
  const before = st.snapshot().sessions[0].lastEventAt;
  st.set({ session: 'ev-3', agent: 'codex', state: 'busy', detail: 'working', pulse: true });
  const s = st.snapshot().sessions[0];
  assert.equal(s.events.length, 1, 'heartbeats never enter the ring');
  assert.equal(s.lastEventAt, before, 'heartbeats never move the activity clock');
});

test('the ring keeps the newest eight events', () => {
  const st = new Store();
  for (let i = 0; i < 10; i += 1) {
    st.set({ session: 'ev-4', agent: 'claude', state: i % 2 ? 'busy' : 'waiting', detail: String(i) });
  }
  const s = st.snapshot().sessions[0];
  assert.equal(s.events.length, 8);
  assert.equal(s.events[7].detail, '9');
});

test('events older than two hours are dropped, and going offline clears the trail', () => {
  const st = new Store();
  st.set({ session: 'ev-5', agent: 'claude', state: 'busy', detail: 'old' });
  st.trails.get('ev-5')[0].at = Date.now() - 3 * 60 * 60 * 1000;
  st.set({ session: 'ev-5', agent: 'claude', state: 'waiting', detail: 'new' });
  assert.equal(st.snapshot().sessions[0].events.length, 1, 'the stale event is gone');
  st.set({ session: 'ev-5', agent: 'claude', state: 'offline' });
  assert.equal(st.trails.has('ev-5'), false, 'an ended session leaves nothing behind');
});
