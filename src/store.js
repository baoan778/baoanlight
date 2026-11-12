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
//   idle    -> GREEN   same hue as busy, half the light: alive, not working
//   offline -> DARK    session ended / nothing connected
const STATES = ['error', 'waiting', 'busy', 'done', 'idle', 'unknown', 'offline'];

// Reporters speak their own dialect. `running` is what everyone calls `busy`
// when they read the docs, so accept it rather than making them guess. `done`
// is the "succeeded / completed" state — distinct from idle, and higher than it.
const ALIASES = {
  running: 'busy',
  working: 'busy',
  blocked: 'error',
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
const AGENT_ORDER = ['deepseek', 'claude', 'codex', 'workbuddy'];
const MAX_SLOTS = 8;

// Local calendar day, the key for "today's stats". Rollover resets the counters.
function dayKey(now = Date.now()) {
  const d = new Date(now);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
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
    // 以及各 agent 完成/出错次数（今日战绩）。history 是最近 7 天的存档，供周报。
    this.stats = { day: dayKey(), byAgent: {}, events: {}, history: {} };
    // 每个 agent 最近几次任务的耗时（内存学习，重启重学），用于完成预估。
    this.taskTimes = {};
    this._sweeper = setInterval(() => this.sweep(), 5_000);
    if (this._sweeper.unref) this._sweeper.unref();
  }

  // Seed accumulated stats from disk. If the file is from an earlier day (the
  // app was closed overnight), archive that day into history first instead of
  // throwing the history away — otherwise the weekly report loses days.
  mergeStats(stats) {
    if (!stats || !stats.byAgent) return;
    const today = dayKey();
    const history = { ...(stats.history || {}) };
    if (stats.day !== today) {
      const hasData = Object.keys(stats.byAgent).length > 0
        || Object.keys(stats.events || {}).length > 0;
      if (stats.day && hasData) {
        history[stats.day] = { byAgent: stats.byAgent, events: stats.events || {} };
        const keys = Object.keys(history).sort();
        while (keys.length > 7) delete history[keys.shift()];
      }
      this.stats = { day: today, byAgent: {}, events: {}, history };
      return;
    }
    this.stats = {
      day: stats.day,
      byAgent: { ...stats.byAgent },
      events: { ...(stats.events || {}) },
      history,
    };
  }

  // 跨天归档：把昨天的战绩存进 history（保留最近 7 天），今日清零。
  // snapshot 每次都调用，所以跨天后的第一帧就会归档，不丢数据。
  checkDay() {
    const today = dayKey();
    if (this.stats.day === today) return;
    this.stats.history[this.stats.day] = {
      byAgent: this.stats.byAgent,
      events: this.stats.events,
    };
    const keys = Object.keys(this.stats.history).sort();
    while (keys.length > 7) delete this.stats.history[keys.shift()];
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

  set({ session = 'default', agent = 'agent', state, detail = '', cwd = '', fuel } = {}) {
    const prev = this.sessions.get(session);

    // A fuel-only update must not disturb the lamp: quota reports and state
    // changes arrive on completely different schedules.
    if (state === undefined && fuel !== undefined && prev) {
      this.sessions.set(session, { ...prev, fuel: normaliseFuel(fuel), updatedAt: Date.now() });
      this.emit('change', this.snapshot());
      return this.snapshot();
    }

    const next = normaliseState(state === undefined ? 'idle' : state);

    const now = Date.now();
    // A run leaving busy closes out its busy time. `since` is when it entered
    // busy, so the elapsed is the honest duration of that stretch of work.
    if (prev && prev.state === 'busy' && next !== 'busy') {
      this.accumulateBusy(prev.agent, now - prev.since);
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
        everBusy: prev?.everBusy || next === 'busy' || next === 'waiting' || next === 'error',
        since: prev && prev.state === next ? prev.since : now,
        updatedAt: now,
      });
    }
    this.emit('change', this.snapshot());
    return this.snapshot();
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
        // 静默超时被丢掉的忙碌会话，也算它的工作时长——它确实干过活。
        if (s.state === 'busy') this.accumulateBusy(s.agent, now - s.since);
        this.sessions.delete(id);
        changed = true;
      }

      // `error` is never aged out, for the same reason `waiting` is not: a red
      // light that disappears on its own is worse than no light at all. Only
      // the six-hour TTL above can clear it.
    }

    if (changed) this.emit('change', this.snapshot());
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
      .map((s) => (now - s.updatedAt > this.quietAfterMs ? { ...s, quiet: true, quietFor: now - s.updatedAt } : s))
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

    let overall = 'offline';
    for (const s of slots) if (PRIORITY[s.state] > PRIORITY[overall]) overall = s.state;

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
    // history 是最近 7 天的存档，供周报汇总。
    const stats = {
      day: this.stats.day,
      byAgent: { ...this.stats.byAgent },
      events: { ...this.stats.events },
      history: { ...this.stats.history },
    };
    for (const s of sessions) {
      if (s.state === 'busy') stats.byAgent[s.agent] = (stats.byAgent[s.agent] || 0) + (now - s.since);
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
