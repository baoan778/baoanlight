'use strict';
// WorkBuddy leaves no per-turn event stream on disk — its conversation logs are
// application logs, not state. What it does leave is a task board: one folder
// per task list, one numbered JSON file per item:
//
//   ~/.workbuddy/tasks/<task-id>/
//     1.json   { "description": "...", "status": "completed" }
//     2.json   { "description": "...", "status": "in_progress" }
//
// That is enough to answer "is it working right now?" at the granularity of a
// plan item: something in progress means the agent is working, everything
// completed means it is done. It is *coarse* — a turn with no active checklist
// item reports nothing rather than a guess — which is why the hook route
// (`bao hook --agent workbuddy`) is the exact one.
//
// Snapshot semantics matter here: WorkBuddy rewrites these files in place, so
// an append-only tailer would miss a file that shrank. This reads each file
// whole whenever its mtime changes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { setState } = require('../client');
const { keepAliveWith, registerStopSignals } = require('./watchdog');

// 「完成」是瞬态：首次看到一块任务板时，只有刚刚结束的 done 才值得重放。
// 一块几小时前就全部完成的板子，在观察器每次重启后都重放一次 done，会多闪
// 一次紫灯、多弹一条完成通知，并把「今日完成」重复相加。
const DONE_REPLAY_MS = 30_000;

function taskDirs() {
  const out = [];
  const root = process.env.WORKBUDDY_HOME || path.join(os.homedir(), '.workbuddy');
  out.push(path.join(root, 'tasks'));
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  out.push(path.join(appData, 'WorkBuddy', 'tasks'));
  return out;
}

// Pure, and the part worth testing without WorkBuddy installed.
function deriveTaskState(items) {
  const states = (items || [])
    .map((i) => String(i?.status || i?.state || '').toLowerCase())
    .filter(Boolean);

  // 失败 / 卡死最要紧：一条 failed 就该亮红灯，而不是被 in_progress 盖掉。
  if (states.some((s) => s === 'failed' || s === 'error' || s === 'errored' || s === 'stuck')) return 'error';
  // 等人：需要批准 / 被挡住 / 等输入。
  if (states.some((s) => s === 'waiting' || s === 'awaiting' || s === 'blocked'
    || s === 'needs_approval' || s === 'approval_required' || s === 'pending_approval' || s === 'needs_input')) {
    return 'waiting';
  }
  if (states.some((s) => s === 'in_progress' || s === 'running' || s === 'active')) return 'busy';
  // 全部完成 = done（紫），不是 idle：完成值得被看见一次，也才有「已完成」通知。
  // 「取消」是中性收尾，仍然只是 idle。
  if (states.length > 0 && states.every((s) => s === 'completed' || s === 'done')) return 'done';
  if (states.length > 0 && states.every((s) => s === 'completed' || s === 'done' || s === 'cancelled')) {
    return 'idle';
  }
  return null;   // pending only: planned, not started — claim nothing
}

// 读一个任务文件夹里的所有条目。`cache` 以文件为键保存「上次读到的
// mtime + 大小 + 解析结果」：任务文件是原地改写的，轮询每 1.5 秒跑一次，
// 无条件 readFileSync + JSON.parse 会让一块几十条的任务板变成持续不断的磁盘
// 读取和解析（文件没变时读到的还是同一个对象）。只有 mtime 或大小变了才重读；
// 大小兜住「同一毫秒内改写」这种情况。
function readItems(dir, cache = new Map()) {
  const items = [];
  let newest = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { items, newest }; }
  const seen = new Set();
  for (const e of entries) {
    if (!e.isFile() || !/\.json$/i.test(e.name)) continue;
    const file = path.join(dir, e.name);
    seen.add(file);
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
      const hit = cache.get(file);
      let rec;
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        rec = hit.rec;
      } else {
        rec = JSON.parse(fs.readFileSync(file, 'utf8'));
        cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, rec });
      }
      if (rec && typeof rec === 'object') items.push(rec);
    } catch { /* half-written file: try again next tick */ }
  }
  // 已经不在目录里的条目要清掉：任务被删/被清空后，缓存不该只增不减。
  for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
  return { items, newest };
}

function run(opts = {}) {
  // An explicit --dir wins, then the user's configured override, then the probe.
  const configured = require('../config').load().agents?.workbuddy?.dir;
  const dir = opts.dir || configured || taskDirs().find((d) => {
    try { return fs.existsSync(d); } catch { return false; }
  });

  if (!dir || !fs.existsSync(dir)) {
    // In `bao watch all` this watcher must fail alone, not kill the process.
    if (opts.throwOnMissing) throw new Error('no WorkBuddy task board found');
    console.error('No WorkBuddy task board found.');
    console.error('Looked in:');
    for (const d of taskDirs()) console.error(`  ${d}`);
    console.error('');
    console.error('Point it at the folder instead:');
    console.error('  bao watch workbuddy --dir <.../.workbuddy/tasks>');
    console.error('');
    console.error('For per-turn accuracy, let WorkBuddy report directly:');
    console.error('  bao hook --agent workbuddy    (reads one JSON event on stdin)');
    process.exit(1);
  }

  const pollMs = Number(opts.interval) || 1500;
  const lookbackMs = Number(opts.lookback) || 12 * 60 * 60 * 1000;
  // 板内文件还在写、状态没变 = 还在干活：定期重报一次，避免长时间同一个
  // 「进行中」被服务端判成静默、最后当成失联丢掉。
  const heartbeatMs = Number(opts.heartbeat) > 0 ? Number(opts.heartbeat) : 20_000;
  const quiet = !!opts.quiet;
  const tracked = new Map();   // task folder -> { state, mtimeMs }

  if (!quiet) console.log(`watching ${dir}`);

  const scan = () => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const seen = new Set();
    const now = Date.now();

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const folder = path.join(dir, e.name);

      let st;
      try { st = fs.statSync(folder); } catch { continue; }
      seen.add(folder);

      const t = tracked.get(folder) || {
        state: null, mtimeMs: 0, seenAt: 0, reportedAt: 0, files: new Map(),
      };
      tracked.set(folder, t);

      const { items, newest } = readItems(folder, t.files);
      // 新鲜度看**板内文件**的 mtime，而不是目录的 mtime：任务文件是原地改写的，
      // 目录时间停在你建任务那天。按目录时间算，一块用了半天的任务板会在 12 小时
      // 后被当成过期，从此再也不上报 —— 灯一直灭着，而任务还在跑。
      const freshAt = newest || st.mtimeMs;
      // 首次看到这块板（seenAt 还是 0）要单独记下来：下面的「历史状态不重放」
      // 只针对第一次上报，后续变化必须照常点亮。
      const firstSight = !t.seenAt;
      const fresh = newest > (t.seenAt || 0);
      t.seenAt = newest;
      t.mtimeMs = freshAt;
      if (freshAt < now - lookbackMs) continue;

      if (!items.length) {
        // 板子被清空：没有证据就熄灯，别把上一轮的状态留成残影。
        if (t.state) {
          t.state = null;
          setState({ session: `workbuddy:${e.name}`, agent: 'workbuddy', state: 'offline' });
        }
        continue;
      }

      const next = deriveTaskState(items);
      if (!next) continue;
      // done / idle 描述的是过去时。首次看到它们时只记账、不点灯：一块昨天就
      // 做完的板子不该在今天开机时再庆祝一次；一块闲置的板子也不该冒出一行。
      // busy / waiting / error 是「此刻仍成立」的证据，首次看到就应当点亮。
      if (firstSight && (next === 'idle' || (next === 'done' && now - newest > DONE_REPLAY_MS))) {
        t.state = next;
        t.reportedAt = 0;
        continue;
      }
      const alive = next === t.state && next === 'busy' && fresh
        && Date.now() - (t.reportedAt || 0) > heartbeatMs;
      if (next === t.state && !alive) continue;
      t.state = next;
      t.reportedAt = Date.now();

      setState({
        session: `workbuddy:${e.name}`,
        agent: 'workbuddy',
        state: next,
        detail: next === 'busy' ? 'working through tasks' : '',
        source: 'file',
        event: 'task_board',
        pulse: alive,
      });
      if (!quiet) console.log(`  ${new Date().toISOString().slice(11, 19)}  ${e.name.slice(0, 8)} -> ${next}`);
    }

    // 收摊：任务从板上消失、或已经老到 lookback 之外的，必须把之前点亮的那
    // 一行熄掉。原来只在进程退出时清 busy —— waiting/error 的残影会一直挂到
    // 服务端 TTL 才消失，而那时灯已经在说一件不存在的旧事。
    const cutoff = now - lookbackMs;
    for (const [folder, t] of [...tracked]) {
      const stale = !seen.has(folder) || (t.mtimeMs && t.mtimeMs < cutoff);
      if (!stale) continue;
      tracked.delete(folder);
      if (!t.state) continue;
      setState({ session: `workbuddy:${path.basename(folder)}`, agent: 'workbuddy', state: 'offline' });
    }
  };

  scan();
  const timer = setInterval(scan, pollMs);

  let watchServer = null;
  let offSignals = () => {};
  const stop = () => {
    offSignals();
    clearInterval(timer);
    if (watchServer) clearInterval(watchServer);
    // 任何还亮着的状态都要熄掉，不只是 busy：watcher 退出意味着「这个来源
    // 不再提供证据」，留着黄/红灯等于替一个已经关掉的程序继续说话。
    const jobs = [];
    for (const [folder, t] of tracked) {
      if (t.state) {
        jobs.push(setState({ session: `workbuddy:${path.basename(folder)}`, agent: 'workbuddy', state: 'offline' }));
      }
    }
    if (opts.manual) return undefined;
    // 等请求真的发出去再退出：同步 process.exit 会把还没建立的连接直接掐掉，
    // 服务端从来看不到 offline。
    return Promise.allSettled(jobs).finally(() => process.exit(0));
  };
  offSignals = registerStopSignals(stop, opts.manual);
  // server 重启回来之后把还亮着的会话重报：任务板上的状态没变，不会触发
  // 常规的「状态变化才上报」，于是重启后这些灯要等下一次状态切换才重新亮起。
  const resend = () => {
    for (const [folder, t] of tracked) {
      if (!t.state || t.state === 'offline') continue;
      // 「完成」是过去时：重放只会让旧任务板在 server 重启后再庆祝一次。
      if (t.state === 'done') continue;
      setState({ session: `workbuddy:${path.basename(folder)}`, agent: 'workbuddy', state: t.state, detail: t.state === 'busy' ? 'working through tasks' : '' });
    }
  };
  // 机器人退了就收摊，避免留下一个永远轮询的孤儿进程。
  watchServer = keepAliveWith(stop, { onRecover: resend });

  return { stop, tracked, dir };
}

module.exports = { run, deriveTaskState, taskDirs };
