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

function appDataDir() {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
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
function deriveDshFuel(record) {
  const rows = record?.rows || record?.record?.rows || record;
  const pressure = rows?.contextPressure?.val;
  const used = Number(pressure?.surfaceTokens);
  const window = Number(pressure?.contextWindow);
  if (!Number.isFinite(used) || !Number.isFinite(window) || window <= 0) return null;
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
  const dir = opts.dir || projectionDirs().find((d) => {
    try { return fs.existsSync(d); } catch { return false; }
  });

  if (!dir || !fs.existsSync(dir)) {
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
  const quiet = !!opts.quiet;
  const tracked = new Map();   // file -> { session, state, mtimeMs }

  if (!quiet) console.log(`watching ${dir}`);

  const scan = () => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const e of entries) {
      if (!e.isFile() || !/^session-.*\.json$/i.test(e.name)) continue;
      const file = path.join(dir, e.name);

      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < Date.now() - lookbackMs) continue;

      const t = tracked.get(file) || { session: sessionName(file), state: null, mtimeMs: 0 };
      tracked.set(file, t);
      if (st.mtimeMs === t.mtimeMs) continue;
      t.mtimeMs = st.mtimeMs;

      let rec;
      try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }

      const next = deriveDshState(rec);
      const fuel = deriveDshFuel(rec);

      // "idle" is only ever derived from a closed turn, so a first sighting of
      // idle means real work just finished — announcing it is honest, and it is
      // also the only way the context gauge can appear for a session that was
      // already finished when the watcher started.
      const stateChanged = !!next && next !== t.state;
      const fuelChanged = !!fuel
        && (!t.fuel || Math.round(fuel.remaining) !== Math.round(t.fuel.remaining));
      if (!stateChanged && !fuelChanged) continue;

      if (stateChanged) t.state = next;
      if (fuel) t.fuel = fuel;

      const { cwd } = identityOf(rec);
      const payload = {
        session: `deepseek:${t.session}`,
        agent: 'deepseek',
        cwd: cwd || '',
      };
      if (stateChanged) {
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
  };

  scan();
  const timer = setInterval(scan, pollMs);

  const stop = () => {
    clearInterval(timer);
    for (const t of tracked.values()) {
      if (t.state === 'busy' || t.state === 'waiting') {
        setState({ session: `deepseek:${t.session}`, agent: 'deepseek', state: 'offline' });
      }
    }
    // The CLI exits on Ctrl+C; tests call stop() to clean up in-process.
    if (!opts.manual) process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stop);

  return { stop, tracked, dir };
}

module.exports = { run, deriveDshState, deriveDshFuel, projectionDirs, sessionName };
