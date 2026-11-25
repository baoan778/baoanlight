'use strict';
// DeepSeek Harness (`dsh`) adapter.
//
// dsh writes its session as a zstd-compressed JSONL, which is awkward to tail
// from Node without a decoder. It also keeps a plain-JSON *projection* of every
// session next to it, and that projection is rewritten whenever anything
// changes:
//
//   %APPDATA%/dsh-desktop/harness/storages/session_projcache/sessions/
//     session-<uuid>.json
//
// The projection is a set of reducer rows, and three of them describe exactly
// what a status light needs:
//
//   userQuestions.questions.active   non-empty -> it is asking you something
//   turnBoundary.openTurnStartSeq    set       -> a turn is open (working)
//   sessionStats.openStep            set       -> a step is running (working)
//
// Everything else in the file is history, not state, and is ignored on purpose.
//
//   bao watch deepseek
//   bao watch deepseek --dir "D:/somewhere/else"

const fs = require('fs');
const os = require('os');
const path = require('path');
const { setState } = require('../client');
const { keepAliveWith } = require('./watchdog');

// 首次看到一份投影时，只要「刚刚结束」的 idle 才值得补发。一个几十分钟前
// 就完成的会话，在观察器每次重启后都重新占一行，列表会越长越乱。
const IDLE_REPLAY_MS = 30_000;

function appDataDir() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

// Where the projection directory usually is, best guess first.
function projectionDirs() {
  const override = process.env.DSH_HOME || process.env.DSH_DESKTOP_HOME;
  const tails = [
    ['harness', 'storages', 'session_projcache', 'sessions'],
    ['storages', 'session_projcache', 'sessions'],
  ];
  const out = [];
  for (const root of [override, path.join(appDataDir(), 'dsh-desktop'), path.join(appDataDir(), 'dsh-tauri')]) {
    if (!root) continue;
    for (const tail of tails) out.push(path.join(root, ...tail));
  }
  return [...new Set(out)];
}

// Pure: given a projection file's JSON, what is the robot doing?
// Exported because this is the part worth testing without a running dsh.
function deriveDshState(record) {
  const rows = record?.rows || record?.record?.rows || record;
  if (!rows || typeof rows !== 'object') return null;

  // A question waiting for an answer is the strongest signal there is.
  const active = rows.userQuestions?.val?.questions?.active;
  if (Array.isArray(active) && active.length > 0) return 'waiting';

  // Approval may be modelled as a pending request rather than a question,
  // depending on the dsh version.
  const approval = rows.approvalState?.val;
  if (approval && (approval.pending || approval.request || approval.awaiting || approval.waiting)) {
    return 'waiting';
  }

  const turn = rows.turnBoundary?.val || {};
  const stats = rows.sessionStats?.val || {};
  const pendingCalls = stats.pendingCalls || {};
  if (turn.openTurnStartSeq != null || stats.openStep
    || (typeof pendingCalls === 'object' && Object.keys(pendingCalls).length > 0)) {
    return 'busy';
  }

  const turns = rows.turnOutline?.val?.turns;
  if ((typeof turn.lastTurn === 'number' && turn.lastTurn > 0)
    || (Array.isArray(turns) && turns.length > 0)) {
    return 'idle';
  }

  return null;   // brand-new session that has not done anything yet
}

// dsh already tracks how much of the model's context the session occupies, and
// that is the one number here that behaves like a fuel gauge: it only grows,
// and it is what will eventually stop the turn. Reported as "remaining", like
// every other fuel source, so the gauge has exactly one meaning.
//
// 只认 provider 锚定的数字：`contextPressure.pressureTokens` 是最近一次请求真实
// 上报的 prompt 大小，`projectedTokens` 再叠加那次采样之后表面的增减估计（见
// dsh-token-meter 的 projection.d.ts）。`contextBreakdown.surfaceTokens` 是启发式的
// 「组成」估算，文档明确说不要当总量 —— 它会超过窗口，拿它算剩余会得到 0%，
// 一个其实还剩 86% 的忙碌会话被报成「快用完了」，这是最糟的一种假警报。
function deriveDshFuel(record) {
  const rows = record?.rows || record?.record?.rows || record;
  const pressure = rows?.contextPressure?.val;
  const window = Number(pressure?.contextWindow);
  if (!Number.isFinite(window) || window <= 0) return null;
  const pick = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const used = pick(pressure?.projectedTokens) ?? pick(pressure?.pressureTokens);
  if (used === null) return null;
  return {
    remaining: Math.max(0, Math.min(100, (1 - used / window) * 100)),
    label: 'context',
  };
}

function identityOf(record) {
  const identity = record?.identity || record?.record?.identity || {};
  return {
    cwd: identity.cwd || record?.workingDirectory?.val || '',
    createdAt: identity.createdAt || 0,
  };
}

function sessionName(file) {
  return path.basename(file).replace(/\.json$/i, '').replace(/^session-/, '');
}

function run(opts = {}) {
  // An explicit --dir wins, then the user's configured override (the same
  // precedence every other watcher gets through agents.logDir), then the probe.
  const configured = require('../config').load().agents?.deepseek?.dir;
  const dir = opts.dir || configured || projectionDirs().find((d) => {
    try { return fs.existsSync(d); } catch { return false; }
  });

  if (!dir || !fs.existsSync(dir)) {
    // In `bao watch all` this watcher must fail alone, not kill the process.
    if (opts.throwOnMissing) throw new Error('no DeepSeek Harness session projections found');
    console.error('No DeepSeek Harness session projections found.');
    console.error('Looked in:');
    for (const d of projectionDirs()) console.error(`  ${d}`);
    console.error('');
    console.error('Point it at the folder instead:');
    console.error('  bao watch deepseek --dir <.../session_projcache/sessions>');
    console.error('');
    console.error('Or let the harness report directly:');
    console.error('  bao hook --agent deepseek    (reads one JSON event on stdin)');
    process.exit(1);
  }

  const pollMs = Number(opts.interval) || 1000;
  const lookbackMs = Number(opts.lookback) || 30 * 60 * 1000;
  // 文件在变、状态没变 = 它还在干活。每隔这么久重报一次，把服务端的「静默」
  // 计时推新；否则一个长时间跑工具的忙碌会话 90 秒后变暗、30 分钟后被丢掉。
  const heartbeatMs = Number(opts.heartbeat) > 0 ? Number(opts.heartbeat) : 20_000;
  const quiet = !!opts.quiet;
  const tracked = new Map();   // file -> { session, state, mtimeMs }

  if (!quiet) console.log(`watching ${dir}`);

  const scan = () => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const seen = new Set();

    for (const e of entries) {
      if (!e.isFile() || !/^session-.*\.json$/i.test(e.name)) continue;
      const file = path.join(dir, e.name);

      let st;
      try { st = fs.statSync(file); } catch { continue; }
      // 记下「文件还在」——即使它已经老到不在 lookback 里。老文件只是不再读，
      // 不代表会话被删了；把它当成消失会误熄一盏仍该亮着的黄灯。
      seen.add(file);
      // 切到别的目录、或会话被清理时，lookback 之外的文件不再回看。
      if (st.mtimeMs < Date.now() - lookbackMs) continue;

      const t = tracked.get(file) || { session: sessionName(file), state: null, mtimeMs: 0, reportedAt: 0 };
      tracked.set(file, t);
      if (st.mtimeMs === t.mtimeMs) continue;
      // 第一次看到这份投影时 mtimeMs 还是 0。下面的「历史 idle 不重放」只针对
      // 这一次，后续真实变化必须照常上报。
      const firstSight = !t.mtimeMs;
      t.mtimeMs = st.mtimeMs;

      let rec;
      try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }

      const next = deriveDshState(rec);
      const fuel = deriveDshFuel(rec);

      // "idle" is only ever derived from a closed turn, so a first sighting of
      // idle means real work just finished — announcing it is honest, and it is
      // also the only way the context gauge can appear for a session that was
      // already finished when the watcher started.
      const now = Date.now();
      // 但「刚刚」需要证据：重启时读到一份半小时前就结束的会话，不该重新点亮
      // 一行。busy / waiting 是「此刻仍成立」的状态，首次看到仍然立刻上报。
      if (firstSight && next === 'idle' && now - st.mtimeMs > IDLE_REPLAY_MS) {
        t.state = next;
        if (fuel) t.fuel = fuel;
        continue;
      }
      const stateChanged = !!next && next !== t.state;
      const fuelChanged = !!fuel
        && (!t.fuel || Math.round(fuel.remaining) !== Math.round(t.fuel.remaining));
      // 文件刚刚被重写过（能走到这里就说明 mtime 变了），而状态还是忙碌/等待：
      // 这是一条「还活着」的证据，要重报一次。
      const alive = !!next && (next === 'busy' || next === 'waiting')
        && next === t.state && now - (t.reportedAt || 0) > heartbeatMs;
      if (!stateChanged && !fuelChanged && !alive) continue;

      if (stateChanged) t.state = next;
      if (fuel) t.fuel = fuel;
      // 心跳只以带 state 的上报计时。fuel-only 更新在服务端**不**刷新 updatedAt
      // （见 store.set 的额度分支），把它当心跳基准，会让真正的 busy 心跳永远发
      // 不出去：一个持续改写额度、状态却没变的忙碌会话于是被判定为静默，10 分钟
      // 后降级、30 分钟后当成失联从灯上丢掉 —— 而它其实一直在干活。
      if (stateChanged || alive) t.reportedAt = now;

      const { cwd } = identityOf(rec);
      const payload = {
        session: `deepseek:${t.session}`,
        agent: 'deepseek',
        cwd: cwd || '',
        source: 'file',
        event: 'projection',
        pulse: alive,
      };
      if (stateChanged || alive) {
        payload.state = next;
        payload.detail = next === 'waiting' ? 'needs your answer'
          : next === 'busy' ? 'working'
            : '';
      }
      // Fuel-only updates need a session the store already knows about; when
      // this very message also carries the state, it creates it. Both paths
      // end up with a gauge as soon as anything is announced.
      if (fuel && t.state) payload.fuel = fuel;

      setState(payload);
      if (!quiet && stateChanged) {
        console.log(`  ${new Date().toISOString().slice(11, 19)}  ${t.session.slice(0, 8)} -> ${next}`);
      }
    }

    // 投影文件被删掉（会话清理、切换工作区）就是「证据没了」：不留一盏
    // 替已经不存在的会话说话的灯。原来 tracked 只增不减，这类会话会一直
    // 停在最后状态，直到服务端 6 小时 TTL。
    for (const [file, t] of [...tracked]) {
      if (seen.has(file)) continue;
      tracked.delete(file);
      if (t.state && t.state !== 'offline') {
        setState({ session: `deepseek:${t.session}`, agent: 'deepseek', state: 'offline' });
      }
    }
  };

  scan();
  const timer = setInterval(scan, pollMs);

  let watchServer = null;
  const stop = () => {
    clearInterval(timer);
    if (watchServer) clearInterval(watchServer);
    const jobs = [];
    for (const t of tracked.values()) {
      // 任何还亮着的状态都要熄掉：watcher 退出就是「证据没了」。只清
      // busy/waiting 会留下红灯或完成态，替一个已经关掉的程序继续说话。
      if (t.state && t.state !== 'idle' && t.state !== 'offline') {
        jobs.push(setState({ session: `deepseek:${t.session}`, agent: 'deepseek', state: 'offline' }));
      }
    }
    // The CLI exits on Ctrl+C; tests call stop() to clean up in-process.
    if (opts.manual) return undefined;
    return Promise.allSettled(jobs).finally(() => process.exit(0));
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stop);
  // server 重启回来之后把还活着的会话连同上下文电量重报：store 是新的，
  // 投影文件还在，但会话要等下一条变化才会重新出现。
  const resend = () => {
    for (const t of tracked.values()) {
      if (!t.state || t.state === 'offline') continue;
      const payload = { session: `deepseek:${t.session}`, agent: 'deepseek', state: t.state };
      if (t.fuel) payload.fuel = t.fuel;
      setState(payload);
    }
  };
  // 机器人退了就收摊：这个 watcher 原来没有这条守护，`bao stop` 之后会一直轮询。
  watchServer = keepAliveWith(stop, { onRecover: resend });

  return { stop, tracked, dir };
}

module.exports = { run, deriveDshState, deriveDshFuel, projectionDirs, sessionName };
