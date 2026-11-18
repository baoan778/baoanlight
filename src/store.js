'use strict';
const { EventEmitter } = require('events');

// The states every adapter maps onto, in the order a human should care about
// them. Colour is the contract, and it is deliberately not the vocabulary the
// first version used: a lamp's job is to say "you can look away" or "you
// cannot", and green has to mean the agent is alive and working.
//   error   -> RED     the run failed, or is blocked and will not recover alone
//   waiting -> YELLOW  the agent has stopped and needs a human
//   busy    -> GREEN   the agent is thinking or running tools ("running")
//   unknown -> GREY    something reported, but we cannot say what it means
//   idle    -> WHITE   dimmed: alive, not working; never borrows the running green
//   offline -> DARK    session ended / nothing connected
const STATES = ['error', 'waiting', 'busy', 'done', 'idle', 'unknown', 'offline'];

// Reporters speak their own dialect. `running` is what everyone calls `busy`
// when they read the docs, so accept it rather than making them guess. `done`
// is the "succeeded / completed" state — distinct from idle, and higher than it.
const ALIASES = {
  running: 'busy',
  working: 'busy',
  // 「被挡住」是等你，不是坏了：日志观察器和文档都把它归在 waiting。
  blocked: 'waiting',
  failed: 'error',
  failure: 'error',
  success: 'done',
  succeeded: 'done',
  completed: 'done',
  complete: 'done',
  finished: 'done',
};

// error > waiting > busy > done > unknown > idle > offline — the "done" state
// (a run succeeded) outranks an idle machine but never outranks a running one,
// because "it just finished" is a fact worth seeing, "it is still working" is
// more urgent.
const PRIORITY = { error: 6, waiting: 5, busy: 4, done: 3, unknown: 2, idle: 1, offline: 0 };

// The robot shows every software at once: one fixed slot per agent, in this
// order, left to right. Position is part of the contract — a light that moves
// around is a light the user has to re-learn every time a session starts. The
// order is also the tie-break for the main lamp: on equal severity, the first
// name here wins, so DeepSeek Harness is the canonical "main" agent on a tie.
// Anything not listed here is appended alphabetically.
const AGENT_ORDER = ['deepseek', 'claude', 'codex', 'workbuddy', 'codebuddy'];
const MAX_SLOTS = 8;

// Local calendar day, the key for "today's stats". Rollover resets the counters.
function dayKey(now = Date.now()) {
  const d = new Date(now);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// 今天 0 点的本地时间戳。「今日时长」只能算今天这一段：一个 23:50 进入 busy、
// 跨过午夜的会话，`since` 还是昨天的时刻，直接拿 `now - since` 会把昨夜整段记到
// 今天头上（午夜一过今日时长直接跳到几小时，还可能误触日目标庆祝）。
function startOfDay(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function normaliseState(state) {
  const name = ALIASES[state] || state;
  if (!STATES.includes(name)) {
    throw new Error(`unknown state "${state}" (use: ${STATES.join(', ')}; running = busy)`);
  }
  return name;
}

// Fuel is always "how much is left", 0–100. Reporters that think in "used"
// convert before sending, so the gauge only ever has one meaning.
function normaliseFuel(fuel) {
  if (fuel === null) return null;
  const remaining = Number(typeof fuel === 'object' ? fuel.remaining : fuel);
  if (!Number.isFinite(remaining)) return null;
  return {
    remaining: Math.max(0, Math.min(100, remaining)),
    label: (typeof fuel === 'object' && fuel.label) || 'remaining',
    ...(typeof fuel === 'object' && fuel.resetsAt ? { resetsAt: fuel.resetsAt } : {}),
  };
}

class Store extends EventEmitter {
  constructor({
    ttlMs = 6 * 60 * 60 * 1000,
    idleTtlMs = 30 * 60 * 1000,
    quietAfterMs = 90_000,
    unusedTtlMs = 2 * 60 * 1000,
    doneTtlMs = 30_000,
  } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.idleTtlMs = idleTtlMs;
    this.quietAfterMs = quietAfterMs;
    this.unusedTtlMs = unusedTtlMs;
    // 「完成」是瞬态：刚完成值得一眼看到，过了这个时长就退回「空闲」（就绪）。
    this.doneTtlMs = doneTtlMs;
    this.sessions = new Map();
    // The last event a hook could not map to a state. It deliberately does not
    // touch the lamp — an unrecognised payload must never be able to move it —
    // but silence about it is worse: the user sees a robot that "does nothing"
    // and has no way to learn that it is being sent something it cannot read.
    this.lastUnknown = null;
    // 今日各 agent 忙碌时长（累计完成的部分，实时部分在 snapshot 里现算），
    // 以及各 agent 完成/出错次数（今日战绩）。history 是最近 30 天的存档，供周报与月报。
    this.stats = { day: dayKey(), byAgent: {}, events: {}, history: {} };
    // 每个 agent 最近几次任务的耗时（内存学习，重启重学），用于完成预估。
    this.taskTimes = {};
    // 每个会话最近的状态证据（只有元数据，进程内，重启即清）。
    this.trails = new Map();
    this._sweeper = setInterval(() => this.sweep(), 5_000);
    if (this._sweeper.unref) this._sweeper.unref();
  }

  // Seed accumulated stats from disk. If the file is from an earlier day (the
  // app was closed overnight), archive that day into history first instead of
  // throwing the history away — otherwise the weekly report loses days.
  mergeStats(stats) {
    if (!stats || typeof stats !== 'object' || !stats.byAgent
      || typeof stats.byAgent !== 'object' || Array.isArray(stats.byAgent)) return;
    const today = dayKey();
    const history = { ...(stats.history && typeof stats.history === 'object' ? stats.history : {}) };
    // stats.json 可能被手改过，或来自字段类型不同的旧版本：一个字符串会被
    // `this.stats.byAgent[agent] + ms` 变成字符串拼接（"abc100"），之后今日
    // 时长整列 NaN。只收有限的非负数。
    const count = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    const byAgent = {};
    for (const [agent, ms] of Object.entries(stats.byAgent)) byAgent[agent] = count(ms);
    const events = {};
    const rawEvents = stats.events && typeof stats.events === 'object' ? stats.events : {};
    for (const [agent, ev] of Object.entries(rawEvents)) {
      if (ev && typeof ev === 'object' && !Array.isArray(ev)) {
        events[agent] = { done: count(ev.done), error: count(ev.error) };
      }
    }
    if (stats.day !== today) {
      const hasData = Object.keys(byAgent).length > 0
        || Object.keys(events).length > 0;
      if (stats.day && hasData) {
        history[stats.day] = { byAgent, events };
        const keys = Object.keys(history).sort();
        while (keys.length > 30) delete history[keys.shift()];
      }
      this.stats = { day: today, byAgent: {}, events: {}, history };
      return;
    }
    this.stats = {
      day: stats.day,
      byAgent,
      events,
      history,
    };
  }

  // 跨天归档：把昨天的战绩存进 history（保留最近 30 天），今日清零。
  // snapshot 每次都调用，所以跨天后的第一帧就会归档，不丢数据。
  checkDay(now = Date.now()) {
    const today = dayKey(now);
    if (this.stats.day === today) return;
    // 归档的是 `stats.day` 那一天，不一定是昨天：机器休眠/进程被挂起后，
    // checkDay 可能隔了几小时才第一次运行。按那个日历日的 0 点裁剪，
    // 才能把跨午夜仍在忙的会话算到正确的一天。
    const archivedStart = (() => {
      const [y, m, d] = String(this.stats.day || '').split('-').map(Number);
      if (!y || !m || !d) return startOfDay(now) - 86400000;
      return new Date(y, m - 1, d).getTime();
    })();
    const archivedEnd = archivedStart + 86400000;
    const byAgent = { ...this.stats.byAgent };
    // 会话跨午夜时，`since` 可能还在昨天。以前只归档已经结算的 byAgent，
    // 于是 23:00 开始、一直没停过的任务在昨天历史里完全消失。这里把仍在忙的
    // 那一小段补进归档副本；session.since 不动，今天的实时部分仍然从 0 点算。
    for (const s of this.sessions.values()) {
      if (s.state !== 'busy') continue;
      const from = Math.max(s.since, archivedStart);
      const until = Math.min(now, archivedEnd);
      if (until > from) byAgent[s.agent] = (byAgent[s.agent] || 0) + (until - from);
    }
    const hasData = Object.keys(byAgent).length > 0
      || Object.keys(this.stats.events).length > 0;
    if (this.stats.day && hasData) {
      this.stats.history[this.stats.day] = {
        byAgent,
        events: this.stats.events,
      };
      const keys = Object.keys(this.stats.history).sort();
      while (keys.length > 30) delete this.stats.history[keys.shift()];
    }
    this.stats.day = today;
    this.stats.byAgent = {};
    this.stats.events = {};
  }

  accumulateBusy(agent, ms) {
    this.checkDay();
    if (!(ms > 0)) return;
    this.stats.byAgent[agent] = (this.stats.byAgent[agent] || 0) + ms;
  }

  accumulateEvent(agent, kind) {
    this.checkDay();
    const e = this.stats.events[agent] || (this.stats.events[agent] = { done: 0, error: 0 });
    e[kind] = (e[kind] || 0) + 1;
  }

  noteUnknown(event, session = '') {
    this.lastUnknown = { event: String(event || 'unknown').slice(0, 80), session, at: Date.now() };
    this.emit('change', this.snapshot());
  }

  clearUnknown() {
    if (!this.lastUnknown) return;
    this.lastUnknown = null;
    this.emit('change', this.snapshot());
  }

  recordEvent(session, prev, state, detail, now, source, event) {
    const cut = now - 2 * 60 * 60 * 1000;
    const list = (this.trails.get(session) || []).filter((e) => e.at >= cut);
    list.push({
      at: now,
      source: String(source || 'api').slice(0, 12),
      event: String(event || '').slice(0, 40),
      state,
      detail: String(detail || '').slice(0, 120),
      tookMs: prev ? Math.max(0, now - prev.since) : 0,
    });
    while (list.length > 8) list.shift();
    this.trails.set(session, list);
  }

  set({
    session = 'default', agent = 'agent', state, detail = '', cwd = '', fuel, create = false,
    source = 'api', event = '', pulse = false,
  } = {}) {
    const prev = this.sessions.get(session);

    // A fuel-only update must not disturb the lamp: quota reports and state
    // changes arrive on completely different schedules.
    //
    // 但它也**不能凭空造出一个会话**：`token_count` / 额度上报属于某个已经在
    // 报状态的会话。store 里没有它，说明这条上报是旧的、或者来自已经结束的
    // 运行 —— 这时候按下面那条路走会 normalise 成 idle，在灯上点亮一格
    // 「就绪」的绿灯，而实际上什么也没在跑。
    // 唯一的例外是 `bao fuel --agent x`：那是人明确说「x 存在，额度是这个数」，
    // 所以 CLI 会带 create: true。
    if (state === undefined && fuel !== undefined) {
      if (!prev && !create) return this.snapshot();
      // create 的时候要有一条完整的记录（state/agent/session 一个都不能缺），
      // 否则 `{...undefined}` 会写进一个只有 fuel 的对象，界面拿不到 agent。
      const base = prev || {
        session,
        agent: agent || 'agent',
        state: 'idle',
        detail: '',
        cwd: cwd || '',
        fuel: null,
        everBusy: false,
        since: Date.now(),
        updatedAt: Date.now(),
      };
      // 额度上报不是「活动」：不能刷新 updatedAt。它被三处超时判定依赖
      // （unused 回收 / busy 静默丢弃 / quiet 变暗），刷新它会让一个只报额度的
      // 幻影「就绪」槽位永不回收，也会让一个真在跑的 busy 会话永不判静默。
      this.sessions.set(session, { ...base, fuel: normaliseFuel(fuel) });
      // 只算一次快照：每次上报都 snapshot 两遍（一遍广播、一遍返回）是纯重复的
      // 排序/复制工作，而钩子和 watcher 每秒可能上报好几次。
      const snap = this.snapshot();
      this.emit('change', snap);
      return snap;
    }

    const next = normaliseState(state === undefined ? 'idle' : state);

    const now = Date.now();
    const changed = !prev || prev.state !== next || prev.detail !== detail;
    const meaningful = !pulse && (changed || !!event);
    if (meaningful) this.recordEvent(session, prev, next, detail, now, source, event);
    // A run leaving busy closes out its busy time. `since` is when it entered
    // busy, so the elapsed is the honest duration of that stretch of work.
    if (prev && prev.state === 'busy' && next !== 'busy') {
      // 只结算「今天」那一段：跨午夜的忙碌在昨天已经过不去了（昨天的账早已归档），
      // 全算给今天会让今日时长凭空多出几小时。
      this.accumulateBusy(prev.agent, now - Math.max(prev.since, startOfDay(now)));
    }
    // 今日战绩：进入完成/出错各记一次（同一状态连续上报不重复计）。
    if (prev && prev.state !== next) {
      if (next === 'done') this.accumulateEvent(prev.agent, 'done');
      else if (next === 'error') this.accumulateEvent(prev.agent, 'error');
    }
    // 完成预估：记下每个 agent 最近几次任务的耗时（正常收尾才算，异常中断不算）。
    if (prev && prev.state === 'busy' && (next === 'done' || next === 'idle')) {
      const dur = now - prev.since;
      if (dur > 5000 && dur < 4 * 3600 * 1000) {
        const arr = this.taskTimes[prev.agent] || (this.taskTimes[prev.agent] = []);
        arr.push(dur);
        if (arr.length > 5) arr.shift();
      }
    }
    if (next === 'offline') {
      this.sessions.delete(session);
      this.trails.delete(session);
    } else {
      this.sessions.set(session, {
        session,
        agent: agent || prev?.agent || 'agent',
        state: next,
        detail,
        cwd: cwd || prev?.cwd || '',
        fuel: fuel !== undefined ? normaliseFuel(fuel) : (prev?.fuel ?? null),
        // A session that has only ever announced itself is not the same as one
        // that has done work. Agents sometimes open a session and abandon it
        // without ever reporting an end, and those must not linger as if real.
        // `done` 也算「干过活」：那是一条「这一轮结束了」的结论，只有真的跑过才会
        // 出现。不算进去的话，一个只报「完成 / 空闲」的会话（例如读 transcript 的
        // 适配器，它恢复出来的第一帧往往就是 done）会被当成「只报到、没干活」，
        // 2 分钟后从灯上消失，用户看到的就是「明明在用，灯却不见了」。
        everBusy: prev?.everBusy || next === 'busy' || next === 'waiting'
          || next === 'error' || next === 'done',
        since: prev && prev.state === next ? prev.since : now,
        updatedAt: now,
        lastEventAt: meaningful ? now : (prev?.lastEventAt ?? now),
      });
    }
    const snap = this.snapshot();
    this.emit('change', snap);
    return snap;
  }

  sweep() {
    const now = Date.now();
    const cutoff = now - this.ttlMs;
    let changed = false;

    for (const [id, s] of this.sessions) {
      if (s.updatedAt < cutoff) { this.sessions.delete(id); changed = true; continue; }

      // Announced itself and then did nothing at all. An agent that opens a
      // session and abandons it never sends SessionEnd, so without this the
      // phantom sits on screen claiming to be a ready agent until the much
      // longer idle timeout. A real session that has done work is untouched.
      if (!s.everBusy && s.state === 'idle' && now - s.updatedAt > this.unusedTtlMs) {
        this.sessions.delete(id);
        changed = true;
        continue;
      }

      // 「完成」是瞬态：刚完成亮紫，过了 doneTtl 就退回「空闲」。否则一个
      // 完成的任务会把紫灯钉在那里直到半小时后 TTL 清掉，像是一直在「刚完成」。
      if (s.state === 'done' && now - s.since > this.doneTtlMs) {
        s.state = 'idle';
        s.since = now;
        changed = true;
      }

      // An agent that crashed or was force-quit never sends SessionEnd, so its
      // pill would sit there for hours claiming to be "ready" when nothing is
      // running. A green session nobody has touched in half an hour is almost
      // certainly gone; if it is not, its next event brings it straight back.
      if ((s.state === 'idle' || s.state === 'done') && now - s.updatedAt > this.idleTtlMs) {
        this.sessions.delete(id);
        changed = true;
        continue;
      }

      // A busy session that has gone quiet is NOT promoted to idle.
      //
      // It used to be: the theory was that a working agent reports constantly,
      // so silence meant it had finished without saying so. That is often true
      // and occasionally very wrong — an agent thinking hard with no tool calls
      // reports nothing for minutes, and flipping it to green told the user
      // "finished, come and look" while it was still working. Silence is not
      // evidence of completion, and green is a claim, not a shrug.
      //
      // Silence is now shown as silence: the session stays busy and the quiet
      // flag dims it, which says "last I heard it was working, a while ago".
      // A busy session that has been silent past the idle window is dropped
      // outright, because by then the agent is gone rather than thinking.
      // `unknown` decays the same way: it is the weakest claim on the screen,
      // and an agent that sent one unreadable event an hour ago is gone.
      if ((s.state === 'busy' || s.state === 'unknown') && now - s.updatedAt > this.idleTtlMs) {
        // 静默超时被丢掉的忙碌会话也算工作时长，但只算到**最后一帧证据**为止：
        // 之后的沉默既不是「还在干」，也不该被记成工时。跨午夜时再夹到今天 0 点，
        // 免得把昨天已归档的那一段重复记进今天。
        if (s.state === 'busy') {
          const until = Math.min(now, s.updatedAt);
          this.accumulateBusy(s.agent, Math.max(0, until - Math.max(s.since, startOfDay(until))));
        }
        this.sessions.delete(id);
        changed = true;
      }

      // `error` is never aged out, for the same reason `waiting` is not: a red
      // light that disappears on its own is worse than no light at all. Only
      // the six-hour TTL above can clear it.
    }

    for (const id of this.trails.keys()) {
      if (!this.sessions.has(id)) this.trails.delete(id);
    }

    if (changed) this.emit('change', this.snapshot());
  }

  // 落盘用的统计副本：把「此刻仍在忙」的那一段也计入，但不改动会话的 `since`。
  // 界面上的「已运行 N 分钟」是用 since 算的，一次落盘不能把它重置成 0。
  //
  // store.stats 本身只在会话离开 busy 时累计，因此这里加上实时段不会重复计：
  // 会话真正结束时 accumulateBusy 记的是完整一段，之后这个会话就不在 sessions 里了。
  // 以前只写 store.stats，退出/重启时正在忙的整段（可能几小时）会凭空消失，
  // 今日时长看起来像被清零了。
  statsForPersistence(now = Date.now()) {
    this.checkDay();
    const dayStart = startOfDay(now);
    const stats = {
      day: this.stats.day,
      byAgent: { ...this.stats.byAgent },
      events: { ...this.stats.events },
      history: { ...this.stats.history },
    };
    for (const s of this.sessions.values()) {
      if (s.state !== 'busy') continue;
      const from = Math.max(s.since, dayStart);
      if (now > from) stats.byAgent[s.agent] = (stats.byAgent[s.agent] || 0) + (now - from);
    }
    return stats;
  }

  // Overall light: the most attention-hungry software wins.
  //
  // The tie-break is by slot order, never by whoever reported last. Two agents
  // stuck on the same state must produce the same picture every single time —
  // a lamp that picks a different winner on each event is a lamp you cannot
  // trust, and the user would see it flicker between two identical priorities.
  snapshot() {
    const now = Date.now();
    this.checkDay();
    // An agent that reported once and then went quiet is not the same as one
    // that just told us it finished, but they look identical on a lamp. Mark
    // the difference so the display can show it, rather than presenting a
    // stale claim with full confidence.
    const sessions = [...this.sessions.values()]
      .map((s) => {
        const out = now - s.updatedAt > this.quietAfterMs
          ? { ...s, quiet: true, quietFor: now - s.updatedAt }
          : { ...s };
        const trail = this.trails.get(s.session);
        if (trail && trail.length) out.events = trail.filter((e) => now - e.at <= 2 * 60 * 60 * 1000);
        return out;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);

    // One slot per software. Several sessions of the same agent (four Claude
    // windows) collapse into one slot showing the worst of them, with a count —
    // the user cares that Claude needs them, not which window it was.
    const byAgent = new Map();
    for (const s of sessions) {
      const cur = byAgent.get(s.agent);
      if (!cur) {
        byAgent.set(s.agent, {
          agent: s.agent, state: s.state, detail: s.detail, count: 1,
          quiet: !!s.quiet, quietFor: s.quietFor,
        });
        continue;
      }
      cur.count += 1;
      cur.quiet = cur.quiet && !!s.quiet;
      if (!cur.quiet) cur.quietFor = undefined;
      if (PRIORITY[s.state] > PRIORITY[cur.state]) {
        cur.state = s.state;
        cur.detail = s.detail;
      }
    }

    const extras = [...byAgent.keys()].filter((a) => !AGENT_ORDER.includes(a)).sort();
    const order = [...AGENT_ORDER, ...extras];
    const slots = order.slice(0, MAX_SLOTS).map(
      (agent) => byAgent.get(agent) || { agent, state: 'offline', detail: '', count: 0, quiet: false }
    );

    // The main lamp summarises every session, not just the ones that fit in the
    // panel: with more than MAX_SLOTS agents, a failure in the overflow must
    // still be visible on the robot.
    let overall = 'offline';
    for (const s of byAgent.values()) if (PRIORITY[s.state] > PRIORITY[overall]) overall = s.state;

    let fuel = null;
    for (const s of sessions) {
      if (!s.fuel) continue;
      if (!fuel || s.fuel.remaining < fuel.remaining) fuel = { ...s.fuel, agent: s.agent };
    }

    // 完成预估：每个 agent 最近几次任务的平均耗时（学不到就不给，不硬猜）。
    const pace = {};
    for (const [agent, arr] of Object.entries(this.taskTimes)) {
      if (arr.length) pace[agent] = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    }

    // 今日各 agent 忙碌时长：已累计 + 仍在忙的实时部分（不重复计）。
    // history 是最近 30 天的存档，供周报/月报汇总。
    const stats = {
      day: this.stats.day,
      byAgent: { ...this.stats.byAgent },
      events: { ...this.stats.events },
      history: { ...this.stats.history },
    };
    const dayStart = startOfDay(now);
    for (const s of sessions) {
      if (s.state !== 'busy') continue;
      // 同上：只把今天这一段算进今日时长，跨午夜的 `since` 不能整段计入。
      const from = Math.max(s.since, dayStart);
      if (now > from) stats.byAgent[s.agent] = (stats.byAgent[s.agent] || 0) + (now - from);
    }

    return {
      overall,
      fuel,
      pace,
      sessions,
      slots,
      stats,
      // More agents than the robot has room for. Reported rather than silently
      // dropped, so the display can say so instead of quietly hiding one.
      slotsOverflow: Math.max(0, order.length - MAX_SLOTS),
      // Reported, never inferred: the display may only mention an unreadable
      // event if one actually arrived.
      unknownEvent: this.lastUnknown,
      at: now,
    };
  }
}

module.exports = { Store, STATES, PRIORITY, AGENT_ORDER, MAX_SLOTS, normaliseFuel, normaliseState };
