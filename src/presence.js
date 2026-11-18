'use strict';
const { execFile } = require('child_process');

// "Is Claude Code running?" — asked only to avoid a specific lie.
//
// The robot goes dark when no session is reporting, which is correct but
// ambiguous: "nothing is running" and "Claude is running and its hooks are not
// installed" look identical, and the second one is the user's actual problem.
//
// So this returns ONE-WAY evidence. `true` means we proved a Claude process
// exists, and the display may then say "running, but not reporting". `false`
// means only that we could not prove it — never that it is absent. Windows
// npm installs run as node.exe, so a tasklist miss is the normal case for a
// perfectly healthy agent; saying "offline" on the strength of that miss would
// be exactly the kind of confident wrong answer this project exists to avoid.

const CACHE_MS = 25_000;
let cache = { at: 0, probe: null, value: false };

function run(cmd, args, timeout = 1500) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

async function probeWindows() {
  const out = await run('tasklist.exe', ['/FI', 'IMAGENAME eq claude.exe', '/FO', 'CSV', '/NH']);
  return /"claude\.exe"/i.test(out);
}

// Cached, and in-flight work is shared: this is polled from a server that may
// have several overlays asking, and spawning tasklist per request would be a
// silly way to spend a user's battery.
function claudeRunning({ ttl = CACHE_MS } = {}) {
  const now = Date.now();
  if (cache.probe) return cache.probe;
  if (now - cache.at < ttl) return Promise.resolve(cache.value);

  const next = probeWindows()
    .catch(() => false)
    .then((value) => {
      cache = { at: Date.now(), probe: null, value };
      return value;
    });

  cache.probe = next;
  return next;
}

function reset() {
  cache = { at: 0, probe: null, value: false };
}

// Synchronous read for the snapshot path: the server never blocks a request on
// a probe, it only reports what the last one found.
const lastValue = () => cache.value;

module.exports = { claudeRunning, lastValue, reset, probeWindows };
