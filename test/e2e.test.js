'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { start } = require('../src/server');
const install = require('../src/adapters/install');

const HOOK = path.join(__dirname, '..', 'src', 'hooks', 'claude.js');

// Port 0 lets the OS pick a free one. A fixed port collides with the user's own
// running traffic light, which is exactly the kind of failure that only shows up
// on someone else's machine.
let server;
let PORT;
let TOKEN;
before(async () => {
  const r = await start({ port: 0 });
  server = r.server;
  TOKEN = r.token;
  PORT = server.address().port;
});
after(() => server && server.close());

// Writes are token-gated; reads are not. The hooks go through `src/client.js`,
// which reads the same token file, so this helper only matters for direct calls.
const api = async (p, init) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    ...(init || {}),
    headers: { 'x-bao-token': TOKEN, ...((init && init.headers) || {}) },
  });
  return r.json();
};

// Deliberately async. execFileSync blocks this process's event loop, so the
// server running in it cannot answer the hook's request — every hook then times
// out and the lamp never moves. The real agent does not block our server, so a
// synchronous helper tests a situation that never happens.
const fire = (event) =>
  new Promise((resolve, reject) => {
    const cp = execFile(
      process.execPath,
      [HOOK],
      { env: { ...process.env, BAOANLIGHT_PORT: String(PORT), BAOANLIGHT_LOG: '0' }, timeout: 5000 },
      (err) => (err ? reject(err) : resolve())
    );
    cp.stdin.end(JSON.stringify(event));
  });

const stateOf = async (sid) =>
  (await api('/state')).sessions.find((s) => s.session === `claude:${sid}`)?.state ?? null;

test('server reports health and starts empty', async () => {
  assert.equal((await api('/health')).ok, true);
  assert.equal((await api('/state')).overall, 'offline');
});

// A running server with nobody watching is not a running traffic light. `sig
// start` used to see the server, say "already running", and leave you staring
// at a desktop with no window on it.
test('health says how many overlays are actually watching', async () => {
  const h = await api('/health');
  assert.equal(typeof h.clients, 'number', 'health must report watcher count');
  assert.equal(h.clients, 0, 'no overlay is attached in tests');
});

test('a full Claude turn drives the lamp end to end', async () => {
  const sid = 'turn-1';
  await fire({ session_id: sid, hook_event_name: 'UserPromptSubmit', cwd: '/tmp/x' });
  assert.equal(await stateOf(sid), 'busy', 'prompt submitted -> working');

  await fire({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: '/tmp/x' });
  assert.equal(await stateOf(sid), 'busy');

  await fire({ session_id: sid, hook_event_name: 'Notification', message: 'needs permission', cwd: '/tmp/x' });
  assert.equal(await stateOf(sid), 'waiting', 'permission prompt -> needs you');

  await fire({ session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: '/tmp/x' });
  assert.equal(await stateOf(sid), 'busy', 'answered -> working again');

  await fire({ session_id: sid, hook_event_name: 'Stop', cwd: '/tmp/x' });
  assert.equal(await stateOf(sid), 'idle', 'turn finished -> ready');
});

// Regression: SubagentStop lands a few seconds AFTER Stop at the end of a turn.
// Mapping it to busy turned the lamp green then immediately back to yellow, where
// it stuck. This is the single worst bug this project has had.
test('SubagentStop after Stop must not revive a finished session', async () => {
  const sid = 'turn-2';
  await fire({ session_id: sid, hook_event_name: 'Stop' });
  assert.equal(await stateOf(sid), 'idle');

  await fire({ session_id: sid, hook_event_name: 'SubagentStop' });
  assert.equal(await stateOf(sid), 'idle', 'still green three seconds later');
});

// Regression: unknown events used to fall back to busy, so one unexpected payload
// pinned the lamp yellow with no way to tell why.
test('an unrecognised event leaves the last good state alone', async () => {
  const sid = 'turn-3';
  await fire({ session_id: sid, hook_event_name: 'Stop' });
  assert.equal(await stateOf(sid), 'idle');

  await fire({ session_id: sid, hook_event_name: 'SomeFutureHook' });
  assert.equal(await stateOf(sid), 'idle');
});

// The only failure signal Claude Code gives us is an explicit one on the tool
// result. It has to become red, not stay green: a failed tool is the one moment
// the user can actually fix something.
test('a tool that came back with an error turns the lamp red', async () => {
  const sid = 'turn-err';
  await fire({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Bash' });
  assert.equal(await stateOf(sid), 'busy');

  await fire({
    session_id: sid,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_response: { is_error: true },
  });
  assert.equal(await stateOf(sid), 'error');
});

// A red lamp must have a cause. An ordinary successful result is not one.
test('a normal tool result does not turn the lamp red', async () => {
  const sid = 'turn-ok';
  await fire({
    session_id: sid,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_response: { stdout: 'ok', stderr: '' },
  });
  assert.equal(await stateOf(sid), 'busy');
});

// Absence of proof is not proof of absence: on Windows an npm-installed Claude
// runs as node.exe, so a tasklist miss is normal and must never be presented
// as "nothing is running".
test('the process probe defaults to "not proven"', () => {
  // Fresh process: a running server may already have resolved a probe, and the
  // answer depends on whether this machine happens to have Claude installed.
  const mod = JSON.stringify(path.join(__dirname, '..', 'src', 'presence.js'));
  const out = execFileSync(process.execPath, ['-e', `process.stdout.write(String(require(${mod}).lastValue()))`], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(out, 'false');
});

test('SessionEnd clears the session', async () => {
  const sid = 'turn-4';
  await fire({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'Read' });
  assert.equal(await stateOf(sid), 'busy');
  await fire({ session_id: sid, hook_event_name: 'SessionEnd' });
  assert.equal(await stateOf(sid), null);
});

test('the shell one-liner API works for any tool', async () => {
  await api('/set/busy?agent=ci&session=pipeline&detail=building');
  const s = (await api('/state')).sessions.find((x) => x.session === 'pipeline');
  assert.equal(s.state, 'busy');
  assert.equal(s.agent, 'ci');
  assert.equal(s.detail, 'building');

  await api('/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'pipeline', state: 'offline' }),
  });
  assert.equal((await api('/state')).sessions.find((x) => x.session === 'pipeline'), undefined);
});

// The escape hatch for agents nobody has written an adapter for: one command,
// a JSON event on stdin, and the robot moves.
test('the generic hook works for an agent with no adapter', async () => {
  const CLI = path.join(__dirname, '..', 'src', 'cli.js');
  const hook = (args, payload) =>
    new Promise((resolve, reject) => {
      const cp = execFile(
        process.execPath,
        [CLI, 'hook', ...args],
        { env: { ...process.env, BAOANLIGHT_PORT: String(PORT), BAOANLIGHT_LOG: '0' }, timeout: 5000 },
        (err) => (err ? reject(err) : resolve())
      );
      cp.stdin.end(payload || '');
    });

  await hook(['--agent', 'workbuddy'], JSON.stringify({ event: 'task_started', session_id: 'wb-1' }));
  let s = (await api('/state')).sessions.find((x) => x.session === 'workbuddy:wb-1');
  assert.equal(s.state, 'busy');
  assert.equal(s.agent, 'workbuddy');

  await hook(['--agent', 'workbuddy', '--state', 'waiting', '--session', 'wb-1', '--detail', 'approve plan?']);
  s = (await api('/state')).sessions.find((x) => x.session === 'workbuddy:wb-1');
  assert.equal(s.state, 'waiting');
  assert.equal(s.detail, 'approve plan?');

  await hook(['--agent', 'workbuddy'], JSON.stringify({ type: 'task_complete', session_id: 'wb-1' }));
  s = (await api('/state')).sessions.find((x) => x.session === 'workbuddy:wb-1');
  assert.equal(s.state, 'done');
});

test('a bad state is rejected, not silently accepted', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bao-token': TOKEN },
    body: JSON.stringify({ session: 'z', state: 'chartreuse' }),
  });
  assert.equal(r.status, 400, 'authorised, and still nonsense');
});

test('the overlay page is served for browser mode', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<title>baoanlight<\/title>/);
  assert.match(html, /id="bot"/, 'the robot, not the old traffic light');
  assert.doesNotMatch(html, /signalhead/i, 'the old project name is gone');
});

// The CLI is a scripting surface: people wire it into their own tooling. A
// rejected value that prints nothing and exits 0 is the worst possible
// behaviour there — the script "works" and the lamp never moves.
test('the CLI reports a rejected state instead of failing silently', async () => {
  const CLI = path.join(__dirname, '..', 'src', 'cli.js');
  const run = (args) =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args],
        { env: { ...process.env, BAOANLIGHT_PORT: String(PORT) } },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    });

  const bad = await run(['set', 'chartreuse', '--agent', 'x']);
  assert.equal(bad.code, 1, 'a rejected state must exit non-zero');
  assert.match(bad.stderr, /unknown state/, 'and must say why');

  const good = await run(['set', 'busy', '--agent', 'x']);
  assert.equal(good.code, 0);
  assert.equal(good.stderr.trim(), '');
});

// A dark light and a prompt is not a finished setup. `start` used to end with
// "stop it with: sig stop" — telling people how to quit something they had not
// finished wiring up, with no mention of the step that makes it do anything.
test('start tells you the next step, and which one depends on what is connected', async () => {
  const CLI = path.join(__dirname, '..', 'src', 'cli.js');
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-fresh-'));
  const run = (env) =>
    new Promise((resolve) => {
      const cp = execFile(process.execPath, [CLI, 'start', '--foreground', '--no-overlay', '--port', '4797'],
        { env: { ...process.env, ...env } }, () => {});
      let out = '';
      cp.stdout.on('data', (d) => (out += d));
      setTimeout(() => { cp.kill(); resolve(out); }, 2500);
    });

  try {
    const fresh = await run({ HOME: fake, USERPROFILE: fake });
    assert.match(fresh, /Nothing is connected yet/, 'a fresh machine is told the light will stay dark');
    assert.match(fresh, /bao connect claude/, 'and given the command that fixes it');
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- installer

// Hook commands carry an absolute path into this install. When that install is
// a git checkout, every hook invocation executes a file inside it — which holds
// the folder open on Windows and breaks the day the checkout moves. The
// installer has to say so rather than let people find out.
test('installing from a checkout reports that it did', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-checkout-'));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    fs.mkdirSync('.claude');
    fs.writeFileSync(path.join('.claude', 'settings.json'), '{}');
    const r = install.installClaude({ scope: 'project' });
    // This repo is itself a checkout, so the flag must be set and must name the
    // directory the user would need to stop using.
    assert.equal(r.fromCheckout, install.isCheckout(), 'flag reflects reality');
    assert.ok(r.root, 'and says which directory it means');
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// `connect` is the verb, but `install` shipped first and people will have it
// written down. Both must keep working, or an upgrade breaks their notes.
test('connect and install are the same command', async () => {
  const CLI = path.join(__dirname, '..', 'src', 'cli.js');
  const run = (args) =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], {}, (err, stdout, stderr) =>
        resolve((stdout || '') + (stderr || '')));
    });
  const a = await run(['connect']);
  const b = await run(['install']);
  assert.equal(a, b, 'the alias must behave identically');
  assert.match(a, /usage: bao connect/, 'and the usage line teaches the new name');
});

test('installing hooks preserves existing config and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-inst-'));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    fs.mkdirSync('.claude');
    fs.writeFileSync(
      path.join('.claude', 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(ls:*)'] },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
      })
    );

    install.installClaude({ scope: 'project' });
    install.installClaude({ scope: 'project' });
    install.installClaude({ scope: 'project' });

    const after = JSON.parse(fs.readFileSync(path.join('.claude', 'settings.json'), 'utf8'));
    const ours = Object.values(after.hooks).flat().flatMap((g) => g.hooks)
      .filter((h) => /hooks[\\/]claude\.js/.test(h.command));
    assert.equal(ours.length, 8, 'eight events, no duplicates after three installs');
    assert.deepEqual(after.permissions, { allow: ['Bash(ls:*)'] }, 'unrelated settings untouched');
    assert.ok(
      Object.values(after.hooks).flat().flatMap((g) => g.hooks).some((h) => h.command === 'echo mine'),
      'the user\'s own hook survived'
    );

    install.uninstallClaude({ scope: 'project' });
    const restored = JSON.parse(fs.readFileSync(path.join('.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(restored.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] });
    assert.deepEqual(restored.permissions, { allow: ['Bash(ls:*)'] });
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// watcher 重启后要能恢复「还在等你」：一个 waiting 的会话不会再写任何一行，
// 而旧实现启动时直接跳到文件末尾 —— 最该被看见的那盏黄灯自己熄了。
test('a restarted watcher recovers a waiting session instead of going dark', async () => {
  const logWatch = require('../src/adapters/log-watch');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-restart-'));
  const file = path.join(dir, 'rollout-restart.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'restart-1', cwd: '/tmp/x' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'approval_request' } }),
  ].join('\n') + '\n');
  // 把它变成「不是刚写的」：watcher 启动时会走回读尾部的分支。
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const previousPort = process.env.BAOANLIGHT_PORT;
  process.env.BAOANLIGHT_PORT = String(PORT);
  const handle = logWatch.run({
    agent: 'codex', dir, interval: 100, quiet: true, manual: true, lookback: 3_600_000,
  });

  try {
    let found = null;
    for (let i = 0; i < 40 && !found; i++) {
      const snap = await api('/state');
      found = snap.sessions.find((s) => s.session === 'codex:restart-1') || null;
      if (!found) await sleep(100);
    }
    assert.ok(found, 'the waiting session came back');
    assert.equal(found.state, 'waiting', 'and it says what it was last doing');
  } finally {
    handle.stop();
    await api('/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: 'codex:restart-1', state: 'offline' }),
    });
    if (previousPort === undefined) delete process.env.BAOANLIGHT_PORT;
    else process.env.BAOANLIGHT_PORT = previousPort;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// End-to-end for the agent that has no hooks to install: a dsh session
// projection on disk, and the real HTTP store on the other side.
test('the dsh watcher follows a session projection through a whole turn', async () => {
  const dsh = require('../src/adapters/dsh-watch');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-dsh-'));
  const file = path.join(dir, 'session-proj-1.json');
  const write = (rows) => fs.writeFileSync(file, JSON.stringify({ rows }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const waitFor = async (want) => {
    for (let i = 0; i < 40; i++) {
      const snap = await api('/state');
      const s = snap.sessions.find((x) => x.session === 'deepseek:proj-1');
      if (s && s.state === want) return s;
      await sleep(100);
    }
    return null;
  };

  write({
    turnBoundary: { val: { openTurnStartSeq: 1 } },
    contextPressure: { val: { surfaceTokens: 64000, contextWindow: 256000 } },
  });

  // In-process, so unlike a spawned hook it has no per-process env of its own:
  // point the client at this test server's random port.
  const previousPort = process.env.BAOANLIGHT_PORT;
  process.env.BAOANLIGHT_PORT = String(PORT);
  const handle = dsh.run({ dir, interval: 100, quiet: true, manual: true, lookback: 3_600_000 });

  try {
    const busy = await waitFor('busy');
    assert.ok(busy, 'an open turn reports busy');
    assert.equal(busy.agent, 'deepseek');
    assert.equal(Math.round(busy.fuel.remaining), 75, '75% of the context window is left');
    assert.equal(busy.fuel.label, 'context');

    await sleep(30);
    write({ userQuestions: { val: { questions: { active: [{ id: 'q1' }] } } } });
    assert.ok(await waitFor('waiting'), 'a pending question reports waiting');

    await sleep(30);
    write({ turnBoundary: { val: { lastTurn: 1, openTurnStartSeq: null } } });
    assert.ok(await waitFor('idle'), 'a closed turn reports idle');
  } finally {
    handle.stop();
    await api('/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: 'deepseek:proj-1', state: 'offline' }),
    });
    if (previousPort === undefined) delete process.env.BAOANLIGHT_PORT;
    else process.env.BAOANLIGHT_PORT = previousPort;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// `bao mcp` reports over POST /set/<state> with a JSON body. The handler used to
// read only the query string, so every MCP report landed as agent="agent" with
// no detail and no cwd — the whole route silently lied about who was busy.
test('a write may carry its fields in the body, not only in the query string', async () => {
  await api('/set/busy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agent: 'codex', session: 'mcp:codex', detail: 'from the body', cwd: '/tmp/body',
    }),
  });
  const snap = await api('/state');
  const s = snap.sessions.find((x) => x.session === 'mcp:codex');
  assert.ok(s, 'the session named in the body exists');
  assert.equal(s.agent, 'codex');
  assert.equal(s.state, 'busy');
  assert.equal(s.detail, 'from the body');
  assert.equal(s.cwd, '/tmp/body');

  await api('/set/offline', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'mcp:codex' }),
  });
});

// ---------------------------------------------------------- overlay wiring
// Electron 里的路径（preload 光标订阅、IPC）没法用 Playwright 跑到，只能
// 用源码契约钉住。这几条都对应过真实故障，不是「风格检查」。

const srcFile = (...parts) => fs.readFileSync(path.join(__dirname, '..', 'src', ...parts), 'utf8');

// 光标订阅曾经只有一个回调槽：robot3d.js 后注册、覆盖掉 ui.js 的回调，
// 于是 `body.hovering` 永远是 false，工具栏在点击穿透下完全点不到。
test('the cursor reaches every consumer, not just the last one to subscribe', () => {
  const preload = srcFile('overlay', 'preload.js');
  const ui = srcFile('overlay', 'ui.js');
  const scene = srcFile('overlay', 'robot3d.js');

  assert.match(preload, /const cursorSubs = new Set\(\)/, 'subscribers live in a set');
  assert.match(preload, /cursorSubs\.add\(/, 'and each consumer adds itself');
  assert.doesNotMatch(preload, /let cursorCb = null/, 'a single callback slot is the bug');
  assert.match(ui, /bridge\.onCursor\(/, 'the toolbar listens');
  assert.match(scene, /bao\.onCursor\(/, 'and so does the 3D scene');
});

// 静默状态（idle/offline）不能被当作一次「提示」占用限流窗口，否则紧接着
// 另一软件报 error 时就没有声音了。
test('a silent state never consumes the sound throttle', () => {
  const ui = srcFile('overlay', 'ui.js');
  const at = ui.indexOf('function cue(');
  assert.ok(at > 0);
  const body = ui.slice(at, at + 1200);
  const tone = body.indexOf('if (!TONES[kind]) return;');
  const stamp = body.indexOf('lastCue = now;');
  assert.ok(tone > 0, 'the tone lookup is still there');
  assert.ok(stamp > tone, 'and happens before the throttle is consumed');
});

// Codex 的 notify 只报「回合结束 / 等审批」。两个适配器对 complete 给出两种
// 颜色（codex→白、log-watch→紫）就是灯在自相矛盾。
test('codex notify reports a finished turn as done, like the log watcher does', () => {
  const codex = srcFile('hooks', 'codex.js');
  const at = codex.indexOf('function classify(');
  const body = codex.slice(at, at + 600);
  assert.match(body, /return 'done'/);
  assert.doesNotMatch(body, /return 'idle'/);
});

// 开机自启在 Windows 上跑「机器人 + watch all」，macOS/Linux 曾经只跑机器人：
// 日志型代理永远不报状态，机器人一直显示离线。
test('autostart starts the watchers on every platform', () => {
  const src = srcFile('autostart.js');
  const linux = src.slice(src.indexOf('function installLinux'), src.indexOf('function installDarwin'));
  const darwin = src.slice(src.indexOf('function installDarwin'), src.indexOf('function install()'));
  assert.match(linux, /launcher/, 'Linux goes through the launcher script');
  assert.match(darwin, /launcher/, 'and so does macOS');
  assert.match(src, /watch all/, 'the launcher runs the watchers');
});

// 演示命令要能看见出错闪烁和完成转圈 —— 它们是最容易被写坏的两段动效。
test('bao demo walks through every state, including error and done', () => {
  const cli = srcFile('cli.js');
  const at = cli.indexOf('async function cmdDemo');
  const body = cli.slice(at, at + 900);
  for (const state of ['busy', 'waiting', 'error', 'done', 'idle']) {
    assert.match(body, new RegExp(`\\['${state}'`), `${state} is part of the demo`);
  }
});

test('the path still decides the state, and the query string still works', async () => {
  await api('/set/busy?agent=deepseek&session=q:1&detail=from%20query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: 'error', agent: 'codex', detail: 'from the body' }),
  });
  const snap = await api('/state');
  const s = snap.sessions.find((x) => x.session === 'q:1');
  assert.ok(s, 'the query string still names the session');
  assert.equal(s.state, 'busy', 'the path wins over a state in the body');
  assert.equal(s.agent, 'deepseek', 'the query wins over the body');
  assert.equal(s.detail, 'from query');

  await api('/set/offline?session=q:1', { method: 'GET' });
});

// ---------------------------------------------------- overlay interaction traps

const overlayFile = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay', name), 'utf8');

// 尺寸条和状态速览都是 z-index 22、都贴在底部，而提示条是唯一会说出
// 「请执行 bao connect claude」的地方。它被盖住，用户就不知道该敲什么。
test('the hint line sits above the size bar and the preview panel', () => {
  const html = overlayFile('index.html');
  const blocks = [...html.matchAll(/#note\s*\{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(blocks.length >= 1, 'the note has a rule');
  const last = blocks[blocks.length - 1];
  const z = Number((last.match(/z-index:\s*(\d+)/) || [])[1]);
  assert.ok(z > 22, `the hint must sit above the panels at 22, got z-index ${z}`);
});

// 拖出窗口、切虚拟桌面、系统对话框抢焦点时不会有 pointerup。少了兜底，
// `dragging` 留在 true，主进程继续把窗口钉在光标上 —— 用户只能再点一下。
test('a dragged window cannot get stuck on the cursor', () => {
  const js = overlayFile('ui.js');
  assert.match(js, /setPointerCapture/, 'the pointer is captured so the release comes back');
  assert.match(js, /addEventListener\('pointercancel'/, 'and a cancelled pointer ends the drag');
  assert.match(js, /lostpointercapture/, 'so does a lost capture');
});

// 「已经只剩 3%」和「刚刚掉到 3%」不是一回事。初值写成 false 会让前者一开机
// 就弹一次通知，而用户什么也没做。
test('a gauge that is already low at startup does not fire a notification', () => {
  const js = overlayFile('ui.js');
  assert.match(js, /let lastFuelLow = null/, 'unknown is not the same as "was fine"');
  assert.match(js, /low && lastFuelLow === false/, 'only a real drop notifies');
});

// 成绩与最近动态只在设置菜单里可见，而 render() 每收到一条 SSE 帧都会调它们。
// 菜单关着还重建，等于往一个看不见的地方扔几十个节点。
test('closed menu panels are not rebuilt on every frame', () => {
  const js = overlayFile('ui.js');
  for (const fn of ['renderRecent', 'renderScore']) {
    const at = js.indexOf(`function ${fn}`);
    assert.ok(at > 0, `${fn} exists`);
    assert.match(js.slice(at, at + 400), /if \(menu\.hidden\) \{ panelDirty = true; return; \}/,
      `${fn} must bail out while the menu is closed`);
  }
  assert.match(js, /if \(open && panelDirty && lastSnap\)/, 'and be redrawn the moment it opens');
});

// 读屏是第二条输出通道，它必须和灯说的是同一件事。曾经想给它加 2 秒节流，
// 结果是「灯已经变绿、读屏还说需要你」—— 两条通道对同一个事实说法不同，
// 比偶尔多念一句糟得多。
test('the spoken text is never delayed behind the lamp', () => {
  const js = overlayFile('ui.js');
  assert.doesNotMatch(js, /spokenAt/, 'no throttle clock may gate the announcement');
});
