'use strict';
// Reads an agent's own session log and turns it into robot states.
//
//   bao watch codex
//   bao watch deepseek --dir "D:/deepseek/logs"
//   bao watch workbuddy
//
// Hooks are exact but not every agent has them. Most harnesses append a
// machine-readable session log (JSONL is the common shape), and that stream
// carries enough to drive all three states. This one watcher serves every
// agent whose log looks like that, with `agents.js` saying where it lives.
//
// The rule that matters: only lifecycle events decide state. Token counts,
// reasoning deltas and tool output are ambient — they keep a busy session
// alive, but they must never *change* state. An ambient event arriving after
// "complete" would otherwise flip a finished session back to working and pin
// it there.

const fs = require('fs');
const path = require('path');
const { keepAliveWith } = require('./watchdog');
const { setState } = require('../client');
const config = require('../config');
const agents = require('./agents');

const STATES = ['error', 'waiting', 'busy', 'done', 'idle', 'offline'];

// Ambient chatter: alive, but says nothing about what the agent is doing.
const AMBIENT = /token_?count|usage|quota|rate_limit|agent_message(?!_start)|assistant_message(?!_start)|agent_reasoning|reasoning_delta|output_delta|text_delta|stream|tool_(call|result)_(end|output)|web_search|heartbeat|ping/i;

const BUSY = new Set([
  'task_started', 'turn_started', 'run_started', 'agent_start', 'step_started',
  'tool_call_start', 'message_start', 'reasoning_started', 'generating',
  'thinking', 'working', 'in_progress', 'busy', 'started',
  // Codex 的 response_item 就是这些回合：真实的模型思考与工具调用。词表里没有
  // 它们，一条 function_call 就会落到「不认识」而只能靠后面的 turn 事件兜底。
  'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output',
  'local_shell_call', 'local_shell_call_output', 'reasoning', 'tool_call',
]);

// 成功收尾：一个 run/turn/task 正常结束，是「完成」（紫色）而不是「空闲」（白色）。
// 之前这些都归到 idle，完成态和闲置态分不开。
const DONE = new Set([
  'task_complete', 'task_completed', 'turn_complete', 'turn_completed',
  'run_complete', 'run_completed',
  'done', 'finished', 'complete', 'completed', 'success', 'succeeded',
]);

// 失败：run 没跑完就挂了。单独一套，绝不能落到 idle——那是把红灯当白灯。
const ERROR = new Set([
  'task_failed', 'turn_failed', 'run_failed', 'step_failed', 'agent_failed',
  'error', 'failed', 'failure', 'crashed', 'exception', 'fatal',
  // Codex 在模型流中断时发 stream_error；它同时含有 "stream"，绝不能被
  // AMBIENT 当成环境噪音吞掉。
  'stream_error', 'stream_failed',
]);

// 中性收尾 / 用户取消：既不是成功也不是失败，回到就绪。
const IDLE = new Set([
  'task_aborted', 'task_cancelled', 'turn_end', 'agent_end',
  'step_complete', 'step_completed',
  'aborted', 'cancelled', 'stop', 'stop_hook', 'idle', 'end',
]);

const OFFLINE = new Set(['session_end', 'session_closed', 'exit', 'quit', 'offline']);

// Anything that means "a human has to answer this".
const WAITING = /approval|permission|confirm|awaiting|needs?_input|request_input|user_input|question/i;

function normaliseType(type) {
  return String(type || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

// Map an event name onto a robot state, or null when it is ambient.
// Exported because it is the single most testable part of this file.
function classify(payloadType) {
  const t = normaliseType(payloadType);
  if (!t) return null;

  // 显式失败必须先于「环境噪音」判定：Codex 的 stream_error / upstream_error
  // 既含 stream 又是错误，被 AMBIENT 吞掉的话，模型流断了灯却还是绿的。
  // 除了已知的失败词表，任何以 _error / _failed / _crashed 结尾的类型都算失败。
  if (ERROR.has(t) || /(?:^|_)(?:error|failed|failure|crashed|exception|fatal)$/.test(t)) {
    return 'error';
  }
  if (AMBIENT.test(t)) return null;

  // "approval_request", "exec_approval_request", "needs_input" all land here.
  // The check is deliberately before busy/idle: a request that also contains
  // the word "complete" is still a request.
  if (WAITING.test(t) && /request|required|needed|awaiting|input|question|approval|permission/i.test(t)) {
    return 'waiting';
  }
  if (t === 'waiting' || t === 'needs_you' || t === 'blocked') return 'waiting';
  if (OFFLINE.has(t)) return 'offline';
  if (BUSY.has(t)) return 'busy';
  if (DONE.has(t)) return 'done';
  if (IDLE.has(t)) return 'idle';
  return null;
}

// Codex reports both how much of the plan's quota is gone and how full the
// context window is. Fuel is always "how much is left".
//
//   quota   the plan allowance, which is what actually stops you working
//   context how full this conversation's context window is
function readFuel(payload, mode = 'quota') {
  const used = payload?.rate_limits?.primary?.used_percent;
  if (mode !== 'context' && Number.isFinite(used)) {
    return {
      remaining: 100 - used,
      label: 'plan quota',
      ...(payload.rate_limits.primary.resets_at ? { resetsAt: payload.rate_limits.primary.resets_at } : {}),
    };
  }

  const total = payload?.info?.total_token_usage?.total_tokens;
  const window = payload?.info?.model_context_window;
  if (Number.isFinite(total) && Number.isFinite(window) && window > 0) {
    return { remaining: 100 - (total / window) * 100, label: 'context' };
  }

  // Other harnesses just say it plainly. Accept a few spellings rather than
  // requiring every agent to adopt Codex's schema.
  const direct = payload?.fuel?.remaining ?? payload?.remaining_percent
    ?? payload?.remaining ?? payload?.usage?.remaining ?? payload?.usage?.remaining_percent;
  if (Number.isFinite(Number(direct))) {
    return {
      remaining: Number(direct),
      label: payload?.fuel?.label || payload?.usage?.label || 'remaining',
    };
  }
  return null;
}

function newestFiles(dir, sinceMs) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.(jsonl|json|log)$/i.test(e.name)) {
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs >= sinceMs) out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* file vanished mid-scan */ }
      }
    }
  };
  walk(dir);
  return out;
}

// Logs differ in shape, so look in the places a session id and a cwd can hide.
function metaOf(rec) {
  const p = rec.payload || rec.data || {};
  return {
    sessionId: rec.session_id || rec.sessionId || rec.thread_id || rec['thread-id']
      || rec.conversation_id || rec.conversationId
      || p.session_id || p.sessionId || p.thread_id || p.conversation_id || p.id,
    cwd: rec.cwd || rec.workspace || p.cwd || p.workspace,
  };
}

function typeOf(rec) {
  const p = rec.payload || rec.data || {};
  // Codex 把真正的事件都嵌在 payload 里：event_msg 装生命周期事件，
  // response_item 装模型/工具的回合（message、function_call、reasoning…）。
  // 对后者直接返回 rec.type 只会得到字面量 "response_item" —— 任何状态表都
  // 不认识它，于是 Codex 期间的每次工具调用都是隐形的，灯只能等下一个生命周期
  // 事件才动。
  if (rec.type === 'event_msg' || rec.type === 'response_item') return p.type;
  return rec.event || rec.event_type || rec.eventType || rec.kind
    || p.event || p.event_type || rec.type
    || p.type || rec.status;
}

// A file whose name carries no identity (WorkBuddy numbers its task files
// 1.json, 2.json inside a per-task folder) borrows the folder's name instead
// of collapsing every task onto the same session.
function fallbackId(file) {
  const base = path.basename(file).replace(/\.(jsonl|json|log)$/i, '');
  if (/^\d+$/.test(base) || base.length < 3) {
    return path.basename(path.dirname(file)) || base;
  }
  return base;
}

function run(opts = {}) {
  const requested = opts.agent || 'codex';
  const entry = agents.find(requested);
  const name = entry ? entry.name : requested;

  const cfg = config.load();
  const dir = agents.logDir(name, { config: cfg, explicit: opts.dir });

  const pollMs = Number(opts.interval) || 1000;
  // Files older than this are history, not live sessions.
  const lookbackMs = Number(opts.lookback) || 10 * 60 * 1000;
  // 状态没变时的重报节奏：连续的工具调用都是同一种生命周期事件，没有状态切换，
  // 而日志里可能长时间没有 ambient 行来刷新服务端的静默计时 —— 一个真在干活
  // 的会话会在 30 分钟后被当成失联丢掉。dsh / task / wbt 三个 watcher 都有这条
  // 心跳，只有通用日志观察器漏了。
  const heartbeatMs = Number(opts.heartbeat) > 0 ? Number(opts.heartbeat) : 20_000;
  const quiet = !!opts.quiet;
  const label = entry ? entry.label : name;

  if (!dir || !fs.existsSync(dir)) {
    // `bao watch all` runs every watcher in one process: exiting here would
    // take the watchers that *did* find their logs down with this one.
    if (opts.throwOnMissing) throw new Error(`no ${label} session logs found${dir ? ` at ${dir}` : ''}`);
    console.error(`No ${label} session logs found${dir ? ` at ${dir}` : ''}.`);
    const candidates = agents.candidates(name);
    if (candidates.length) {
      console.error('Looked in:');
      for (const c of candidates) console.error(`  ${c}`);
    }
    console.error('');
    console.error('Point it at the right folder instead:');
    console.error(`  bao watch ${name} --dir <path-to-logs>`);
    console.error('');
    console.error(`Or let ${label} report to the robot itself:`);
    console.error(`  bao hook --agent ${name}    (reads one JSON event on stdin)`);
    process.exit(1);
  }

  const tracked = new Map(); // path -> { offset, sessionId, cwd, state, buffer }
  if (!quiet) console.log(`watching ${dir}`);

  const handleLine = (file, line) => {
    let rec;
    try { rec = JSON.parse(line); } catch { return; }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return;

    const t = tracked.get(file);
    if (!t) return;

    // A metadata line names the session and the folder it runs in.
    if (rec.type === 'session_meta' || rec.meta || rec.session || rec.thread) {
      const m = metaOf(rec);
      if (m.sessionId) t.sessionId = m.sessionId;
      if (m.cwd) t.cwd = m.cwd;
      return;
    }

    // Session id can also arrive on the first ordinary record.
    if (!t.sessionId) {
      const m = metaOf(rec);
      if (m.sessionId) t.sessionId = m.sessionId;
      if (m.cwd) t.cwd = m.cwd;
    }

    const type = typeOf(rec);
    const session = `${name}:${t.sessionId || fallbackId(file)}`;
    // 之前用文件名兜底报过状态、现在才学到真实 id：旧键必须收摊。否则同一个
    // 会话在列表里占两格，多出来的那格停在最后状态直到 TTL，忙碌时长也会重复计。
    if (!t.recovering && t.session && t.session !== session && t.state) {
      setState({ session: t.session, agent: name, state: 'offline' });
      t.state = null;
    }
    // 记住「这个文件到底用了哪个会话名」：收摊时要靠它发 offline。只存
    // t.sessionId 的话，靠文件名兜底的那些会话永远收不了摊，灯上留一个残影。
    t.session = session;

    if (type === 'token_count' || /fuel|usage|quota|rate_limit/i.test(normaliseType(type))) {
      const f = readFuel(rec.payload || rec.data || rec, opts.fuel);
      if (f) {
        // 记住这次读数：server 重启后 store 是空的，要靠 onRecover 把它重报
        // 回去，否则电量条要等下一条 fuel 日志才重新出现。
        t.fuel = f;
        if (!t.recovering) setState({ session, fuel: f });
      }
      return;
    }

    // Some stores say it as a field rather than an event (`status: "in_progress"`),
    // and the same vocabulary maps those onto the same three states.
    const declared = rec.state || rec.status;
    const next = STATES.includes(declared) ? declared
      : (classify(declared) || classify(type));

    if (next) {
      if (next === t.state) {
        // 同一个状态的生命周期事件（连续 function_call）也要定期重报，理由见
        // heartbeatMs 的注释。只在 busy 上做：waiting 的定义就是「不再写日志」，
        // 而 error/done/idle 没有衰减计时需要推新。
        if (!t.recovering && next === 'busy'
          && Date.now() - (t.reportedAt || 0) > heartbeatMs) {
          t.reportedAt = Date.now();
          setState({
            session, agent: name, state: 'busy', detail: 'working', cwd: t.cwd || '',
            source: 'log', event: type, pulse: true,
          });
        }
        return;
      }
      t.state = next;
      const payload = {
        session,
        agent: name,
        state: next,
        detail: next === 'waiting' ? 'needs approval'
          : next === 'busy' ? 'working'
            : '',
        cwd: t.cwd || '',
        source: 'log',
        event: type || next,
      };
      // 回读历史时只记「最后是什么状态」，不逐条上报：中间状态早已过期，
      // 而且会让今日统计/通知把几分钟前的事重放一遍。
      if (t.recovering) { t.pending = payload; return; }
      t.reportedAt = Date.now();
      setState(payload);
      if (!quiet) console.log(`  ${new Date().toISOString().slice(11, 19)}  ${type || next} -> ${next}`);
      return;
    }

    // Ambient event: keep a busy session from being swept as stale, nothing more.
    if (!t.recovering && t.state === 'busy') {
      t.reportedAt = Date.now();
      setState({
        session, agent: name, state: 'busy', detail: 'working',
        cwd: t.cwd || '',
      });
    }
  };

  // 目录树每 5 秒重扫一次就够了：新会话文件不可能一秒冒出两批。原来是每秒递归
  // readdir 并对历史里的每个文件 statSync 一次 —— 几个月的会话历史下就是每秒
  // 几千次系统调用，一个常驻后台的进程一直在磨磁盘。
  let dirCache = [];
  let dirCacheAt = 0;

  // 已经存在、但不是刚写的文件：回读尾部，恢复「它最后一次在做什么」并且只上报
  // 这一次。原来直接跳到文件末尾 —— 而一个 waiting 的会话不会再写任何一行，
  // watcher 一重启，最该被看见的那盏黄灯就自己熄了。
  // 只恢复 waiting / busy：error/idle/done 描述的是过去时，重启后重放只会让
  // 灯说一句迟到的话。
  const RECOVER_BYTES = 16 * 1024;
  const recoverFromTail = (f, t) => {
    const from = Math.max(0, f.size - RECOVER_BYTES);
    let chunk = '';
    try {
      const fd = fs.openSync(f.path, 'r');
      const buf = Buffer.alloc(f.size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);
      chunk = buf.toString('utf8');
    } catch { return; }
    let lines = chunk.split(/\r?\n/);
    if (from > 0) lines = lines.slice(1);   // 第一条可能从半行开始
    t.recovering = true;
    try {
      for (const line of lines) if (line.trim()) handleLine(f.path, line);
    } finally {
      t.recovering = false;
    }
    const p = t.pending;
    t.pending = null;
    if (p && (p.state === 'waiting' || p.state === 'busy')) {
      t.reportedAt = Date.now();
      setState(p);
    }
  };

  const tick = () => {
    const now = Date.now();
    if (now - dirCacheAt >= 5000) {
      dirCacheAt = now;
      dirCache = newestFiles(dir, now - lookbackMs);
    }
    const byPath = new Map(dirCache.map((f) => [f.path, f]));
    // 正在跟踪的文件每轮都重新 stat：它们正在被写，尺寸必须是最新的。
    //
    // 同时要把「已经老到不在 lookback 里」的条目丢掉。原来只增不减：一个
    // 常驻数周的 watcher 会一直对全部历史文件做 statSync，并且把早已该被
    // 忽略的老文件重新塞回读取队列 —— 注释里说的「下一轮目录扫描自会清掉」
    // 从来没有发生过，因为没有任何地方 delete。
    for (const p of [...tracked.keys()]) {
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        tracked.delete(p);   // 文件没了：连跟踪状态一起清掉
        continue;
      }
      if (st.mtimeMs < now - lookbackMs) {
        tracked.delete(p);
        continue;
      }
      const hit = byPath.get(p);
      if (hit) { hit.size = st.size; hit.mtimeMs = st.mtimeMs; }
      else byPath.set(p, { path: p, size: st.size, mtimeMs: st.mtimeMs });
    }
    for (const f of byPath.values()) {
      let t = tracked.get(f.path);
      if (!t) {
        // Start from the end of a file that already existed, so old sessions do
        // not replay on startup — but read a brand-new file from the beginning.
        const fresh = Date.now() - f.mtimeMs < pollMs * 3;
        t = { offset: fresh ? 0 : f.size, state: null, buffer: '', reportedAt: 0 };
        tracked.set(f.path, t);
        if (!fresh) {
          recoverFromTail(f, t);
          continue;
        }
      }
      // 文件被截断/轮转（日志轮转、Codex 重写 rollout）之后 offset 会比 size 还大。
      // 直接 continue 会让这个文件永久失明，而且不报任何错 —— 灯就停在最后一次
      // 听到的状态上，看起来一切正常。
      if (f.size < t.offset) { t.offset = 0; t.buffer = ''; }
      if (f.size === t.offset) continue;

      let chunk = '';
      try {
        const fd = fs.openSync(f.path, 'r');
        const buf = Buffer.alloc(f.size - t.offset);
        fs.readSync(fd, buf, 0, buf.length, t.offset);
        fs.closeSync(fd);
        chunk = buf.toString('utf8');
      } catch { continue; }

      t.offset = f.size;
      t.buffer += chunk;
      const lines = t.buffer.split(/\r?\n/);
      t.buffer = lines.pop() || '';           // keep any partial trailing line
      for (const line of lines) if (line.trim()) handleLine(f.path, line);
    }
  };

  tick();
  const timer = setInterval(tick, pollMs);

  // 机器人退出后这三条 watcher 不该变成孤儿进程：连续几次探不到 server 就自己收摊。
  // 20s × 3 的宽限，足够覆盖一次「stop 后马上 start」的重启，又不会永远赖着不走。
  let watchServer = null;

  const stop = () => {
    clearInterval(timer);
    if (watchServer) clearInterval(watchServer);
    const jobs = [];
    for (const t of tracked.values()) {
      if (t.session && t.state && t.state !== 'idle' && t.state !== 'offline') {
        jobs.push(setState({ session: t.session, agent: name, state: 'offline' }));
      }
    }
    // In-process callers (tests, `watch all`) stop the watcher without taking
    // the whole process down; only the CLI wants the exit.
    if (opts.manual) return undefined;
    // 先把 offline 真的发出去再退出。同步 process.exit 会掐断还没建立的
    // 连接，服务端从来看不到收摊，灯就停在一个已经不存在的会话上。
    return Promise.allSettled(jobs).finally(() => process.exit(0));
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stop);

  // server 重启回来之后，把还活着的会话连同它的电量一起重报：store 是新的，
  // 已经跟踪到的会话不会凭空自己长出来。
  const resend = () => {
    for (const t of tracked.values()) {
      if (!t.session || !t.state || t.state === 'offline') continue;
      const payload = {
        session: t.session, agent: name, state: t.state,
        detail: t.state === 'waiting' ? 'needs approval' : t.state === 'busy' ? 'working' : '',
        cwd: t.cwd || '',
      };
      if (t.fuel) payload.fuel = t.fuel;
      setState(payload);
    }
  };
  watchServer = keepAliveWith(stop, { onRecover: resend });

  return { stop, tracked, dir };
}

module.exports = { run, classify, readFuel, newestFiles, typeOf, metaOf, fallbackId };
