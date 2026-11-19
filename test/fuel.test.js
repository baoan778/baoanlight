'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { Store, normaliseFuel } = require('../src/store');
const { readFuel } = require('../src/adapters/log-watch');

// --------------------------------------------------------------- normalising

test('fuel always means "how much is left", clamped to 0-100', () => {
  assert.equal(normaliseFuel(42).remaining, 42);
  assert.equal(normaliseFuel({ remaining: 42 }).remaining, 42);
  assert.equal(normaliseFuel(150).remaining, 100, 'clamped high');
  assert.equal(normaliseFuel(-20).remaining, 0, 'clamped low');
  assert.equal(normaliseFuel('nonsense'), null, 'garbage is dropped, not shown as 0%');
  assert.equal(normaliseFuel(null), null);
  assert.equal(normaliseFuel(0).remaining, 0, 'empty is a real value, not falsy-dropped');
});

test('a label is carried through so the gauge can say what it measures', () => {
  assert.equal(normaliseFuel({ remaining: 10, label: 'plan quota' }).label, 'plan quota');
  assert.equal(normaliseFuel(10).label, 'remaining');
});

// ------------------------------------------------------------------- store

// The whole point of a separate channel: a quota report and a state change
// arrive on completely unrelated schedules, and a fuel update landing mid-turn
// must never touch the lamp.
test('a fuel-only update leaves the lamp exactly as it was', () => {
  const s = new Store();
  s.set({ session: 'a', agent: 'claude', state: 'waiting', detail: 'needs you' });
  const before = s.snapshot().sessions[0];

  s.set({ session: 'a', fuel: { remaining: 30, label: 'plan quota' } });
  const after = s.snapshot().sessions[0];

  assert.equal(after.state, 'waiting', 'state untouched');
  assert.equal(after.detail, 'needs you', 'detail untouched');
  assert.equal(after.since, before.since, 'and the clock did not restart');
  assert.equal(after.fuel.remaining, 30);
});

test('fuel survives subsequent state changes', () => {
  const s = new Store();
  s.set({ session: 'a', agent: 'claude', state: 'busy', fuel: 80 });
  s.set({ session: 'a', agent: 'claude', state: 'idle' });
  assert.equal(s.snapshot().sessions[0].fuel.remaining, 80, 'not wiped by a state update');
});

test('the emptiest tank is the one shown', () => {
  const s = new Store();
  s.set({ session: 'a', agent: 'claude', state: 'busy', fuel: 90 });
  s.set({ session: 'b', agent: 'codex', state: 'busy', fuel: 12 });
  s.set({ session: 'c', agent: 'gemini', state: 'busy' });   // no fuel reported

  const snap = s.snapshot();
  assert.equal(snap.fuel.remaining, 12);
  assert.equal(snap.fuel.agent, 'codex', 'and it says whose tank it is');
});

test('no fuel anywhere means no gauge, not an empty gauge', () => {
  const s = new Store();
  s.set({ session: 'a', agent: 'claude', state: 'busy' });
  assert.equal(s.snapshot().fuel, null);
});

// 一条迟到的 token_count / quota 上报属于某个已经在报状态的会话。store 里
// 没有它，说明那条上报是旧的、或者来自已经结束的运行 —— 这时候在灯上点亮一格
// 「就绪」的绿灯，就是在替什么都没发生的事作证。
test('a fuel update for an unknown session does not invent one', () => {
  const s = new Store();
  s.set({ session: 'ghost', fuel: 50 });
  const snap = s.snapshot();
  assert.deepEqual(snap.sessions, [], 'no session was created');
  assert.equal(snap.fuel, null, 'and no gauge appeared out of nowhere');
});

// 唯一的例外是人手敲的 `bao fuel 63 --agent x`：那是明确说「x 存在」，
// CLI 会带 create: true。它建出来的会话必须是完整的，不能只有一个 fuel 字段。
test('an explicit create from `bao fuel` makes a complete idle session', () => {
  const s = new Store();
  s.set({ session: 'ci:manual', agent: 'ci', fuel: { remaining: 63, label: 'plan quota' }, create: true });
  const [only] = s.snapshot().sessions;
  assert.ok(only, 'the session exists');
  assert.equal(only.state, 'idle');
  assert.equal(only.agent, 'ci');
  assert.equal(only.session, 'ci:manual');
  assert.equal(only.fuel.remaining, 63);
});

// 额度上报不是「活动」：它不能刷新 updatedAt。三处超时判定（未干活回收 / busy
// 静默丢弃 / quiet 变暗）都依赖这个时间，一刷新就全都失效。
test('a fuel-only update does not refresh the activity timestamp', () => {
  const s = new Store();
  s.set({ session: 'a', agent: 'claude', state: 'busy' });
  const before = s.sessions.get('a').updatedAt;

  const wait = Date.now() + 12;
  while (Date.now() < wait) { /* 让时间真的往前挪一点 */ }
  s.set({ session: 'a', fuel: 42 });
  const after = s.sessions.get('a').updatedAt;

  assert.equal(after, before, 'the fuel report must not count as activity');
  assert.equal(s.sessions.get('a').fuel.remaining, 42, 'but the reading is stored');
});

// 跨午夜：一个 23:50 进入 busy 的会话，今日时长只能算今天那一段。否则午夜一过
// 今日时长直接跳到几小时，还可能误触「今日目标达成」的庆祝与通知。
test('busy time that started yesterday is only counted from midnight', () => {
  const s = new Store();
  s.set({ session: 'a', agent: 'claude', state: 'busy' });
  const now = Date.now();
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  // 把「进入 busy」的时刻挪到昨天 23:50（比今天 0 点早 10 分钟）。
  s.sessions.get('a').since = midnight.getTime() - 10 * 60000;

  const counted = s.snapshot().stats.byAgent.claude || 0;
  // 只该算「今天 0 点到现在」这一段，不该把昨天那 10 分钟也算进来。
  const elapsedToday = now - midnight.getTime();
  assert.ok(Math.abs(counted - elapsedToday) < 5000,
    `counted ${counted}ms should equal today's ${elapsedToday}ms, not include yesterday's stretch`);
  assert.ok(counted < elapsedToday + 10 * 60000, 'yesterday\'s 10 minutes must not be added to today');
});

// ------------------------------------------------------------------- codex

// Shape taken from a real ~/.codex/sessions rollout file.
const TOKEN_COUNT = {
  type: 'token_count',
  info: {
    total_token_usage: { input_tokens: 21861, output_tokens: 196, total_tokens: 22057 },
    model_context_window: 258400,
  },
  rate_limits: {
    primary: { used_percent: 35, window_minutes: 43200, resets_at: 1790275478 },
    secondary: null,
  },
};

test('codex plan quota becomes fuel remaining', () => {
  const f = readFuel(TOKEN_COUNT, 'quota');
  assert.equal(f.remaining, 65, '35% used -> 65% left');
  assert.equal(f.label, 'plan quota');
  assert.equal(f.resetsAt, 1790275478, 'reset time carried through');
});

test('codex context window is available as an alternative gauge', () => {
  const f = readFuel(TOKEN_COUNT, 'context');
  assert.equal(f.label, 'context');
  assert.ok(f.remaining > 91 && f.remaining < 92, `expected ~91.5, got ${f.remaining}`);
});

test('quota is preferred, because that is what actually blocks the next turn', () => {
  assert.equal(readFuel(TOKEN_COUNT).label, 'plan quota');
});

test('falls back to context when no rate limit is reported', () => {
  const noLimits = { ...TOKEN_COUNT, rate_limits: {} };
  assert.equal(readFuel(noLimits).label, 'context');
});

test('reports nothing rather than guessing when the payload is unusable', () => {
  assert.equal(readFuel({}), null);
  assert.equal(readFuel({ info: {} }), null);
  assert.equal(readFuel({ info: { total_token_usage: { total_tokens: 5 }, model_context_window: 0 } }), null);
});

// ------------------------------------------------------------------ layout

// Guards the fix for a real complaint: the lamp slid sideways every time an
// agent's status text changed length, because the window was shrink-wrapped
// around content of varying width. A fixed stage width is what pins it.
test('the overlay pins its width so the lamp cannot drift', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay', 'index.html'), 'utf8');
  assert.match(html, /--stage-w:\s*\d+px/, 'stage width is a fixed pixel value');
  assert.match(html, /width:\s*var\(--stage-w\)/, 'and the stage actually uses it');
  assert.doesNotMatch(html, /#stage\s*\{[^}]*width:\s*max-content/, 'never shrink-wrapped again');
});

// Guards a second reported bug: collapsed to a single lamp there are no pills
// below the light, so an asymmetric bottom padding left less room than the bloom
// needs and sliced it into a visible box edge.
test('glow headroom is symmetric, so the bloom is never clipped in any mode', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay', 'index.html'), 'utf8');
  const stage = html.match(/#stage\s*\{[^}]*\}/)[0];
  const pad = stage.match(/padding:\s*([^;]+);/)[1].trim();
  assert.match(pad, /^var\(--glow-pad\)\s+0$/,
    `#stage padding must be vertically symmetric glow headroom, got "${pad}"`);

  const glow = Number(html.match(/--glow-pad:\s*(\d+)px/)[1]);
  assert.ok(glow >= 72, `glow headroom ${glow}px is smaller than the 72px bloom radius`);
});

// Guards a reported bug: the label vanished the moment the light went green,
// because the visibility rule required a non-empty `detail` and idle clears it.
test('a single session is labelled in every state, green included', () => {
  // The label logic lives in ui.js since the UI was split out for CSP; the
  // markup and CSS stayed in index.html.
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay', 'ui.js'), 'utf8');
  const rule = js.match(/const showPills\s*=[^;]+;/)[0];
  assert.doesNotMatch(rule, /\.detail/,
    `pill visibility must not depend on detail, got: ${rule}`);
  assert.match(js, /VERB\s*=\s*\{[^}]*idle:\s*'[^']+'/,
    'idle needs a fallback label to show instead of the empty detail');
});

// The lamp's red/amber/green mean "agent state". If the gauge fill defaults to
// one of them, the same three colours carry two meanings on one small widget.
test('the fuel gauge does not borrow the lamp colours at normal levels', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay', 'ui.js'), 'utf8');
  const fill = html.match(/#fuel b\s*\{[^}]*\}/)[0];
  assert.doesNotMatch(fill, /var\(--(green|red|amber)\)/,
    `the default fill must be neutral, got: ${fill}`);
  // Colour is reserved for warnings, and those bands stay narrow.
  const low = Number(js.match(/pct <= (\d+) \? 'low'/)[1]);
  const mid = Number(js.match(/pct <= (\d+) \? 'mid'/)[1]);
  assert.ok(low <= 15, `low band ${low}% should mean "act now"`);
  assert.ok(mid <= 30 && mid > low, `mid band ${mid}% should be a narrow warning, not most of the range`);
});

test('the fuel gauge is positioned out of flow so it cannot move the lamp', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay', 'index.html'), 'utf8');
  assert.match(html, /#fuel\s*\{[^}]*position:\s*absolute/, 'gauge is absolutely positioned');
});
