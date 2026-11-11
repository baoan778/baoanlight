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

function taskDirs() {
  const out = [];
  const root = process.env.WORKBUDDY_HOME || path.join(os.homedir(), '.workbuddy');
  out.push(path.join(root, 'tasks'));
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    out.push(path.join(appData, 'WorkBuddy', 'tasks'));
  } else if (process.platform === 'darwin') {
    out.push(path.join(os.homedir(), 'Library', 'Application Support', 'WorkBuddy', 'tasks'));
  } else {
    out.push(path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'WorkBuddy', 'tasks'));
  }
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
  if (states.length > 0 && states.every((s) => s === 'completed' || s === 'done' || s === 'cancelled')) {
    return 'idle';
  }
  return null;   // pending only: planned, not started — claim nothing
}

function readItems(dir) {
  const items = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return items; }
  for (const e of entries) {
    if (!e.isFile() || !/\.json$/i.test(e.name)) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8'));
      if (rec && typeof rec === 'object') items.push(rec);
    } catch { /* half-written file: try again next tick */ }
  }
  return items;
}

function run(opts = {}) {
  const dir = opts.dir || taskDirs().find((d) => {
    try { return fs.existsSync(d); } catch { return false; }
  });

  if (!dir || !fs.existsSync(dir)) {
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
  const quiet = !!opts.quiet;
  const tracked = new Map();   // task folder -> { state, mtimeMs }

  if (!quiet) console.log(`watching ${dir}`);

  const scan = () => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const folder = path.join(dir, e.name);

      let st;
      try { st = fs.statSync(folder); } catch { continue; }
      if (st.mtimeMs < Date.now() - lookbackMs) continue;

      const t = tracked.get(folder) || { state: null, mtimeMs: 0 };
      tracked.set(folder, t);

      const items = readItems(folder);
      if (!items.length) continue;

      const next = deriveTaskState(items);
      if (!next || next === t.state) continue;
      t.state = next;

      setState({
        session: `workbuddy:${e.name}`,
        agent: 'workbuddy',
        state: next,
        detail: next === 'busy' ? 'working through tasks' : '',
      });
      if (!quiet) console.log(`  ${new Date().toISOString().slice(11, 19)}  ${e.name.slice(0, 8)} -> ${next}`);
    }
  };

  scan();
  const timer = setInterval(scan, pollMs);

  const stop = () => {
    clearInterval(timer);
    for (const [folder, t] of tracked) {
      if (t.state === 'busy') {
        setState({ session: `workbuddy:${path.basename(folder)}`, agent: 'workbuddy', state: 'offline' });
      }
    }
    if (!opts.manual) process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stop);

  return { stop, tracked, dir };
}

module.exports = { run, deriveTaskState, taskDirs };
