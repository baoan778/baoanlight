'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { execFile, execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 隔离到临时目录：测试在 port 0 上起 server，会把临时端口写进 ~/.baoanlight/port，
// 覆盖用户真实机器人的端口。HOME 必须在 require server 之前设好（config.DIR 在
// 模块加载时就定死了）。
process.env.BAOANLIGHT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-e2e-'));

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

// `bao start --port X` 用 healthAt 确认端口文件里记着的旧实例是否还活着：它必须
// 能问一个「不是当前端口」的服务，否则那条防重复启动的守卫等于没写。
test('health can be asked about a specific port, and a dead one is not baoanlight', async () => {
  const client = require('../src/client');
  const h = await client.healthAt(PORT);
  assert.equal(h && h.name, 'baoanlight');
  assert.equal(await client.healthAt(1), null, 'a closed port is not an answer');
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

  // 提问工具一调用就停下来等你：这句必须变成黄灯，而不是继续绿着。
  await fire({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', cwd: '/tmp/x' });
  assert.equal(await stateOf(sid), 'waiting', 'a question tool waits for you');
  await fire({ session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', cwd: '/tmp/x' });
  assert.equal(await stateOf(sid), 'busy', 'answered -> working again');

  await fire({ session_id: sid, hook_event_name: 'Stop', cwd: '/tmp/x' });
  assert.equal(await stateOf(sid), 'idle', 'turn finished -> ready');

  const ev = (await api('/state')).sessions.find((x) => x.session === `claude:${sid}`);
  assert.equal(ev.events[0].source, 'hook');
  assert.equal(ev.events[0].event, 'UserPromptSubmit');
  assert.ok(ev.events.some((e) => e.event === 'Stop'), 'the stop event is visible evidence');
});

// Regression: "Claude is waiting for your input" is Claude telling you the turn
// is over — not a request for permission. Mapping it to waiting pinned the lamp
// yellow for six hours, because a waiting session never writes another event.
test('an idle notification does not pin the lamp on "needs you"', async () => {
  const sid = 'notice-idle';
  await fire({ session_id: sid, hook_event_name: 'UserPromptSubmit' });
  assert.equal(await stateOf(sid), 'busy');

  await fire({ session_id: sid, hook_event_name: 'Notification', message: 'Claude is waiting for your input' });
  assert.equal(await stateOf(sid), 'idle', 'idle reminder -> ready, not waiting');
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

// 清理会话时说「cleared」必须等价于「服务端真的收到了 offline」。服务没起、
// 或 token 不匹配时照打 cleared，用户会以为残影清掉了，而灯还挂在屏幕上。
test('clearing a session does not claim success when nobody is listening', async () => {
  const CLI = path.join(__dirname, '..', 'src', 'cli.js');
  const out = await new Promise((resolve) => {
    execFile(process.execPath, [CLI, 'clear', '--session', 'x'], {
      env: { ...process.env, BAOANLIGHT_PORT: '4999', BAOANLIGHT_LOG: '0' },
      timeout: 5000,
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
  assert.equal(out.code, 1, 'a failed clear must exit non-zero');
  assert.doesNotMatch(out.stdout, /cleared/, 'and must not pretend it worked');
  assert.match(out.stderr, /no server listening/);
});

// A dark light and a prompt is not a finished setup. `start` used to end with
// "stop it with: sig stop" — telling people how to quit something they had not
// finished wiring up, with no mention of the step that makes it do anything.
test('start tells you the next step, and which one depends on what is connected', async () => {
  const CLI = path.join(__dirname, '..', 'src', 'cli.js');
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-fresh-'));
  const run = (env) =>
    new Promise((resolve) => {
      const cp = execFile(process.execPath, [CLI, 'start', '--foreground', '--no-overlay', '--no-watch', '--port', '4797'],
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

// 连续的工具调用不会改变状态。如果日志里长时间没有 ambient 行（token_count 之类），
// 服务端会按「静默 30 分钟」把一个仍在干活的会话丢掉 —— 灯自己灭了，而代理还在跑。
// 通用日志观察器必须像 dsh / task / wbt 那三条一样，定期重报同一个 busy。
test('a continuously busy session is re-reported so it never looks abandoned', async () => {
  const logWatch = require('../src/adapters/log-watch');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-hb-'));
  const file = path.join(dir, 'rollout-hb.jsonl');
  const busyLine = JSON.stringify({ type: 'event_msg', payload: { type: 'function_call' } });
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'hb-1', cwd: '/tmp/x' } }),
    busyLine,
  ].join('\n') + '\n');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const previousPort = process.env.BAOANLIGHT_PORT;
  process.env.BAOANLIGHT_PORT = String(PORT);
  const handle = logWatch.run({
    agent: 'codex', dir, interval: 100, quiet: true, manual: true,
    lookback: 3_600_000, heartbeat: 100,
  });

  try {
    const find = async () => (await api('/state')).sessions.find((s) => s.session === 'codex:hb-1') || null;
    let first = null;
    for (let i = 0; i < 40 && !first; i++) {
      first = await find();
      if (!first) await sleep(100);
    }
    assert.ok(first, 'the busy session is on the lamp');

    // 再写一条同状态的事件：没有任何状态变化，只有心跳能刷新 updatedAt。
    await sleep(300);
    fs.appendFileSync(file, busyLine + '\n');

    let second = null;
    for (let i = 0; i < 40; i++) {
      second = await find();
      if (second && second.updatedAt > first.updatedAt) break;
      await sleep(100);
    }
    assert.ok(second && second.updatedAt > first.updatedAt,
      'a same-state busy event refreshed the session instead of leaving it to time out');
  } finally {
    handle.stop();
    await api('/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: 'codex:hb-1', state: 'offline' }),
    });
    if (previousPort === undefined) delete process.env.BAOANLIGHT_PORT;
    else process.env.BAOANLIGHT_PORT = previousPort;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 流式日志（stream / delta / tool 输出）每秒可能追加几十行，而它们只能表达
// 「还在干活」这一件事。以前每一条都上报一次：每行一条本地 HTTP、一次服务端
// 快照、一轮 SSE 广播，状态却始终是同一个 busy。现在按心跳窗口汇总 —— 状态与
// 「静默」判定不变，但常驻观察器不再被一行一行的增量拖成忙循环。
test('a busy log streaming ambient output reports at a heartbeat pace, not per line', async () => {
  const logWatch = require('../src/adapters/log-watch');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-ambient-'));
  const file = path.join(dir, 'rollout-ambient.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'ambient-1', cwd: '/tmp/x' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'turn_started' } }),
  ].join('\n') + '\n');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const previousPort = process.env.BAOANLIGHT_PORT;
  process.env.BAOANLIGHT_PORT = String(PORT);
  const handle = logWatch.run({
    agent: 'codex', dir, interval: 40, quiet: true, manual: true,
    lookback: 3_600_000, heartbeat: 2000,
  });

  try {
    const find = async () => (await api('/state')).sessions.find((s) => s.session === 'codex:ambient-1') || null;
    let first = null;
    for (let i = 0; i < 60 && !first; i++) {
      first = await find();
      if (!first) await sleep(50);
    }
    assert.ok(first && first.state === 'busy', 'the turn start reports busy');

    // 40 行环境噪音（只证明「还活着」）：都在心跳窗口内，不该逐行上报。
    fs.appendFileSync(file, Array.from({ length: 40 }, () =>
      JSON.stringify({ type: 'event_msg', payload: { type: 'output_delta' } })).join('\n') + '\n');
    await sleep(500);
    const mid = await find();
    assert.equal(mid && mid.updatedAt, first.updatedAt,
      'ambient lines inside the heartbeat window do not each force a report');

    // 心跳窗口过去之后，持续送达的增量必须把忙碌会话重新报一遍；否则一个
    // 长时间只写增量的会话会在 90 秒后变暗、最终被当作失联丢掉。
    let after = null;
    for (let i = 0; i < 60 && !after; i++) {
      fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'output_delta' } }) + '\n');
      await sleep(100);
      const s = await find();
      if (s && s.updatedAt > first.updatedAt) after = s;
    }
    assert.ok(after, 'the heartbeat still refreshes a busy session');
  } finally {
    handle.stop();
    await api('/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: 'codex:ambient-1', state: 'offline' }),
    });
    if (previousPort === undefined) delete process.env.BAOANLIGHT_PORT;
    else process.env.BAOANLIGHT_PORT = previousPort;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 用户手动 `bao watch codex` 起的观察器会活过 `bao stop && bao start`。server 换了
// 进程之后，它必须把**此刻仍然成立**的状态（等待 / 忙碌 / 出错 / 空闲）重报回
// 新 store，否则灯要等下一次变化才亮；但「完成」是过去时 —— 重放它会让一盏早已
// 回落成空闲的紫灯再亮 30 秒，并多弹一条完成通知。
test('a watcher that outlives the server resends live states but never replays a finished turn', async () => {
  const logWatch = require('../src/adapters/log-watch');
  const client = require('../src/client');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-resend-'));
  const live = path.join(dir, 'rollout-live.jsonl');
  const finished = path.join(dir, 'rollout-done.jsonl');
  fs.writeFileSync(live, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'live-1', cwd: '/tmp/x' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'needs_input' } }),
  ].join('\n') + '\n');
  fs.writeFileSync(finished, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'done-1', cwd: '/tmp/x' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n') + '\n');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const previousPort = process.env.BAOANLIGHT_PORT;
  process.env.BAOANLIGHT_PORT = String(PORT);
  // heartbeat 拉长：本用例只关心「server 换了进程」这一条重报路径。
  const handle = logWatch.run({
    agent: 'codex', dir, interval: 60, quiet: true, manual: true,
    lookback: 3_600_000, heartbeat: 60_000, recoverMs: 100,
  });
  const realGet = client.get;

  try {
    const both = async () => {
      const snap = await api('/state');
      return {
        live: snap.sessions.find((s) => s.session === 'codex:live-1') || null,
        done: snap.sessions.find((s) => s.session === 'codex:done-1') || null,
      };
    };
    let seen = null;
    for (let i = 0; i < 60; i++) {
      seen = await both();
      if (seen.live && seen.live.state === 'waiting' && seen.done && seen.done.state === 'done') break;
      await sleep(50);
    }
    assert.ok(seen.live && seen.live.state === 'waiting', 'the waiting session is live');
    assert.ok(seen.done && seen.done.state === 'done', 'the finished turn is done');
    const liveAt = seen.live.updatedAt;
    const doneAt = seen.done.updatedAt;

    // 让 watchdog 先探到当前 server 的 pid（同进程里的第二个 server 只是端口不同，
    // pid 一样，所以这里直接把 health 换成一个新 pid，模拟真正的进程重启）。
    await sleep(300);
    client.get = async (p, opts) => (p === '/health' ? { ok: true, pid: 987654 } : realGet(p, opts));

    let resent = null;
    for (let i = 0; i < 80 && !resent; i++) {
      const now = await both();
      if (now.live && now.live.updatedAt > liveAt) resent = now;
      else await sleep(50);
    }
    assert.ok(resent, 'a live waiting session is resent after the server changes process');
    assert.equal(resent.live.state, 'waiting');
    assert.equal(resent.done.updatedAt, doneAt, 'the finished turn is not replayed as a fresh completion');
  } finally {
    client.get = realGet;
    handle.stop();
    await api('/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: 'codex:live-1', state: 'offline' }),
    });
    await api('/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: 'codex:done-1', state: 'offline' }),
    });
    if (previousPort === undefined) delete process.env.BAOANLIGHT_PORT;
    else process.env.BAOANLIGHT_PORT = previousPort;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 有些写入方会持续追加，却把修改时间钉在创建时刻（实测 Codex 的 rollout：文件
// 每秒都在长，mtime 一直停在开头）。观察器若只凭 mtime 判断「还新鲜吗」，会在
// lookback 到期后把一个正在干活的会话踢出跟踪 —— 灯停在上一次 task_complete 上，
// 而代理后面写的每一行都没人看。ctime 随写入更新，必须一起看。
test('a log that grows while its mtime stays frozen is still followed', async () => {
  const logWatch = require('../src/adapters/log-watch');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-frozen-'));
  const file = path.join(dir, 'rollout-frozen.jsonl');
  const frozen = new Date(Date.now() - 60 * 60 * 1000);
  const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'frozen-1', cwd: '/tmp/x' } });
  const busy = JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } });
  const ambient = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } });
  const done = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } });
  fs.writeFileSync(file, [meta, busy].join('\n') + '\n');
  // 每次追加后把 mtime 钉回一小时前，模拟「只追加、不改 mtime」的写入方。
  const freeze = () => fs.utimesSync(file, frozen, frozen);
  freeze();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const previousPort = process.env.BAOANLIGHT_PORT;
  process.env.BAOANLIGHT_PORT = String(PORT);
  // lookback 只有 1.5 秒：旧实现会在第一轮之后就把它当成历史文件丢掉。
  const handle = logWatch.run({
    agent: 'codex', dir, interval: 100, quiet: true, manual: true, lookback: 1500,
  });

  try {
    const find = async () => (await api('/state')).sessions.find((s) => s.session === 'codex:frozen-1') || null;
    let first = null;
    for (let i = 0; i < 40 && !first; i++) {
      first = await find();
      if (!first) await sleep(100);
    }
    assert.ok(first && first.state === 'busy', 'the growing session is tracked');

    // 连续写 3 秒（远超 lookback），mtime 每轮都被钉住。
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      fs.appendFileSync(file, ambient + '\n');
      freeze();
    }
    assert.ok(await find(), 'the session survived the lookback window instead of going stale');

    fs.appendFileSync(file, done + '\n');
    freeze();
    let finished = null;
    for (let i = 0; i < 40; i++) {
      finished = await find();
      if (finished && finished.state === 'done') break;
      await sleep(100);
    }
    assert.ok(finished && finished.state === 'done', 'lines written after the window are still read');
  } finally {
    handle.stop();
    await api('/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: 'codex:frozen-1', state: 'offline' }),
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
    contextPressure: { val: { pressureTokens: 64000, contextWindow: 256000 } },
  });

  // In-process, so unlike a spawned hook it has no per-process env of its own:
  // point the client at this test server's random port.
  const previousPort = process.env.BAOANLIGHT_PORT;
  process.env.BAOANLIGHT_PORT = String(PORT);
  const handle = dsh.run({ dir, interval: 100, quiet: true, manual: true, lookback: 3_600_000, heartbeat: 50 });

  try {
    const busy = await waitFor('busy');
    assert.ok(busy, 'an open turn reports busy');
    assert.equal(busy.agent, 'deepseek');
    assert.equal(Math.round(busy.fuel.remaining), 75, '75% of the context window is left');
    assert.equal(busy.fuel.label, 'context');

    // 文件继续更新、状态没变 = 它还在干活。时间戳必须被推新，否则 90 秒后
    // 会被标成「静默」，30 分钟后直接当成失联从灯上丢掉。
    const before = busy.updatedAt;
    await sleep(80);
    write({
      turnBoundary: { val: { openTurnStartSeq: 1 } },
      contextPressure: { val: { pressureTokens: 65000, contextWindow: 256000 } },
    });
    let refreshed = null;
    for (let i = 0; i < 30 && !refreshed; i++) {
      const snap = await api('/state');
      const s = snap.sessions.find((x) => x.session === 'deepseek:proj-1');
      if (s && s.updatedAt > before) refreshed = s;
      else await sleep(100);
    }
    assert.ok(refreshed, 'an active turn refreshes its timestamp');

    await sleep(30);
    write({ userQuestions: { val: { questions: { active: [{ id: 'q1' }] } } } });
    assert.ok(await waitFor('waiting'), 'a pending question reports waiting');

    await sleep(30);
    write({ turnBoundary: { val: { lastTurn: 1, openTurnStartSeq: null } } });
    assert.ok(await waitFor('idle'), 'a closed turn reports idle');

    // 投影文件被删掉（会话清理 / 换工作区）= 证据没了。这盏灯必须熄，
    // 而不是替一个已经不存在的会话挂到 6 小时 TTL。
    fs.unlinkSync(file);
    let gone = false;
    for (let i = 0; i < 40; i++) {
      const snap = await api('/state');
      if (!snap.sessions.some((x) => x.session === 'deepseek:proj-1')) { gone = true; break; }
      await sleep(100);
    }
    assert.equal(gone, true, 'a deleted projection turns the session off');
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

// dsh 的投影每次请求都会重写，其中 contextPressure 的变化走 fuel-only 上报，
// 而服务端对 fuel-only 明确不刷新 updatedAt（额度上报不是「活动」）。观察器
// 如果把它也算成心跳基准，那么「状态没变、额度一直在变」的忙碌会话就永远发不出
// 真正的 busy 心跳：90 秒后变暗、10 分钟后降级成「状态未确认」、30 分钟后被当成
// 失联从灯上丢掉 —— 而它其实一直在干活。
test('a dsh turn that only updates its fuel still keeps its busy session fresh', async () => {
  const dsh = require('../src/adapters/dsh-watch');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-dsh-fuel-'));
  const file = path.join(dir, 'session-fuel.json');
  // 只改 pressureTokens：状态始终是「回合未结束」，即 busy。
  const write = (tokens) => fs.writeFileSync(file, JSON.stringify({
    rows: {
      turnBoundary: { val: { openTurnStartSeq: 1 } },
      contextPressure: { val: { pressureTokens: tokens, contextWindow: 256000 } },
    },
  }));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const previousPort = process.env.BAOANLIGHT_PORT;
  process.env.BAOANLIGHT_PORT = String(PORT);
  write(64000);
  const handle = dsh.run({
    dir, interval: 30, quiet: true, manual: true, lookback: 3_600_000, heartbeat: 400,
  });

  try {
    const find = async () => (await api('/state')).sessions.find((s) => s.session === 'deepseek:fuel') || null;
    let busy = null;
    for (let i = 0; i < 60 && !busy; i++) {
      const s = await find();
      if (s && s.state === 'busy') busy = s;
      else await sleep(50);
    }
    assert.ok(busy, 'an open turn reports busy');
    const before = busy.updatedAt;

    // 每 100ms 改写一次额度（比 400ms 的心跳窗口更密），状态不变。
    for (let i = 1; i <= 12; i++) {
      write(64000 + i * 10000);
      await sleep(100);
    }
    await sleep(700);

    const after = await find();
    assert.ok(after && after.state === 'busy', 'the turn is still busy');
    assert.ok(after.updatedAt > before,
      'fuel-only updates must not starve the busy heartbeat (the lamp would go grey)');
  } finally {
    handle.stop();
    await api('/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: 'deepseek:fuel', state: 'offline' }),
    });
    if (previousPort === undefined) delete process.env.BAOANLIGHT_PORT;
    else process.env.BAOANLIGHT_PORT = previousPort;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 任务板的新鲜度必须看**板内文件**的 mtime，而不是目录的 mtime：文件是原地
// 改写的，目录时间停在你建任务那天。按目录时间算，一块用了半天的板子会在
// lookback 之后被当成过期，灯从此再也不亮。
test('a long-lived WorkBuddy task board keeps reporting, and an empty one goes dark', async () => {
  const taskWatch = require('../src/adapters/task-watch');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-task-'));
  const folder = path.join(dir, 'task-1');
  fs.mkdirSync(folder);
  const item = path.join(folder, '1.json');
  fs.writeFileSync(item, JSON.stringify({ status: 'in_progress' }));
  // 把目录的 mtime 推到两天前，模拟一块一直在用、但目录本身很久没变过的板子。
  const old = new Date(Date.now() - 2 * 86400 * 1000);
  fs.utimesSync(folder, old, old);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stateOf = async (sid) => {
    const snap = await api('/state');
    return snap.sessions.find((x) => x.session === sid) || null;
  };

  const previousPort = process.env.BAOANLIGHT_PORT;
  process.env.BAOANLIGHT_PORT = String(PORT);
  const handle = taskWatch.run({ dir, interval: 100, quiet: true, manual: true, lookback: 60_000 });

  try {
    let busy = null;
    for (let i = 0; i < 40 && !busy; i++) {
      const s = await stateOf('workbuddy:task-1');
      if (s && s.state === 'busy') busy = s;
      else await sleep(100);
    }
    assert.ok(busy, 'a fresh item in an old folder still reports busy');

    // 板子被清空 = 没有证据，灯要熄，而不是把 busy 留成残影。
    fs.unlinkSync(item);
    let gone = false;
    for (let i = 0; i < 40; i++) {
      if (!(await stateOf('workbuddy:task-1'))) { gone = true; break; }
      await sleep(100);
    }
    assert.equal(gone, true, 'an emptied task board turns the session off');
  } finally {
    handle.stop();
    if (previousPort === undefined) delete process.env.BAOANLIGHT_PORT;
    else process.env.BAOANLIGHT_PORT = previousPort;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 观察器重启时，一块早已全部完成的任务板不能被重放成「刚刚完成」：否则每
// 重启一次就多闪一次紫灯、多弹一条完成通知，并把今日完成数重复相加。闲置板
// 同样不该冒出一行；但真正的 in_progress 必须立刻恢复成忙碌。
test('a restarted task-board watcher does not replay an old completion', async () => {
  const taskWatch = require('../src/adapters/task-watch');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-task-replay-'));
  const doneFolder = path.join(dir, 'task-old-done');
  const idleFolder = path.join(dir, 'task-old-idle');
  fs.mkdirSync(doneFolder);
  fs.mkdirSync(idleFolder);
  const doneItem = path.join(doneFolder, '1.json');
  const idleItem = path.join(idleFolder, '1.json');
  fs.writeFileSync(doneItem, JSON.stringify({ status: 'completed' }));
  fs.writeFileSync(idleItem, JSON.stringify({ status: 'cancelled' }));
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(doneItem, old, old);
  fs.utimesSync(idleItem, old, old);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stateOf = async (sid) => {
    const snap = await api('/state');
    return snap.sessions.find((x) => x.session === sid) || null;
  };

  const previousPort = process.env.BAOANLIGHT_PORT;
  process.env.BAOANLIGHT_PORT = String(PORT);
  const handle = taskWatch.run({ dir, interval: 100, quiet: true, manual: true, lookback: 3_600_000 });

  try {
    await sleep(500);
    assert.equal(await stateOf('workbuddy:task-old-done'), null,
      'a completion older than the replay window is not announced again');
    assert.equal(await stateOf('workbuddy:task-old-idle'), null,
      'an old idle board does not create a row');

    // 同一块板重新开始工作：首次静默不能把后续真实变化一起吞掉。
    fs.writeFileSync(doneItem, JSON.stringify({ status: 'in_progress' }));
    let busy = null;
    for (let i = 0; i < 40 && !busy; i++) {
      const s = await stateOf('workbuddy:task-old-done');
      if (s && s.state === 'busy') busy = s;
      else await sleep(100);
    }
    assert.ok(busy, 'a real in-progress item still lights up after the restart');
  } finally {
    handle.stop();
    for (const sid of ['workbuddy:task-old-done', 'workbuddy:task-old-idle']) {
      await api('/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: sid, state: 'offline' }),
      });
    }
    if (previousPort === undefined) delete process.env.BAOANLIGHT_PORT;
    else process.env.BAOANLIGHT_PORT = previousPort;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// DeepSeek 观察器重启时也不该把几十分钟前就结束的会话重新点亮：那会让列表
// 越来越长，`bao status` 里出现一堆并不是「刚刚完成」的 idle 行。真正刚结束
// 的会话仍要补发，后续的 open turn 也必须立刻恢复 busy。
test('a restarted dsh watcher does not replay an old idle session', async () => {
  const dsh = require('../src/adapters/dsh-watch');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-dsh-idle-'));
  const oldFile = path.join(dir, 'session-old.json');
  const recentFile = path.join(dir, 'session-recent.json');
  const closed = {
    record: {
      rows: {
        turnBoundary: { val: { lastTurn: 1 } },
        turnOutline: { val: { turns: [{}] } },
        sessionStats: { val: {} },
      },
    },
  };
  const open = {
    record: {
      rows: {
        turnBoundary: { val: { openTurnStartSeq: 1 } },
        sessionStats: { val: {} },
      },
    },
  };
  fs.writeFileSync(oldFile, JSON.stringify(closed));
  fs.writeFileSync(recentFile, JSON.stringify(closed));
  const tenMin = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(oldFile, tenMin, tenMin);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stateOf = async (sid) => {
    const snap = await api('/state');
    return snap.sessions.find((x) => x.session === sid) || null;
  };

  const previousPort = process.env.BAOANLIGHT_PORT;
  process.env.BAOANLIGHT_PORT = String(PORT);
  const handle = dsh.run({ dir, interval: 100, quiet: true, manual: true, lookback: 3_600_000 });

  try {
    await sleep(500);
    assert.equal(await stateOf('deepseek:old'), null,
      'an idle projection from ten minutes ago is not announced again');
    const recent = await stateOf('deepseek:recent');
    assert.ok(recent && recent.state === 'idle',
      'a session that really just finished is still announced');

    // 旧会话重新开一轮：busy 必须立刻出现，不能被首次静默吞掉。
    fs.writeFileSync(oldFile, JSON.stringify(open));
    let busy = null;
    for (let i = 0; i < 40 && !busy; i++) {
      const s = await stateOf('deepseek:old');
      if (s && s.state === 'busy') busy = s;
      else await sleep(100);
    }
    assert.ok(busy, 'an open turn after the restart lights up as busy');
  } finally {
    handle.stop();
    for (const sid of ['deepseek:old', 'deepseek:recent']) {
      await api('/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: sid, state: 'offline' }),
      });
    }
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

// 开机自启只跑一条 `bao start`：server、窗口和日志观察器由它一起带起来。
// 以前是「start + watch all」两条命令，两条会抢同一把 pid 锁，白起一个进程；
// 而且第二条进程崩了没人重启。项目现在只支持 Windows，Linux/macOS 启动器
// 不应该再出现在代码里。
test('autostart starts the robot and its watchers with one command', () => {
  const src = srcFile('autostart.js');
  const cli = srcFile('cli.js');
  assert.doesNotMatch(src, /installLinux|installDarwin|LaunchAgents|systemd|\.desktop/,
    'Windows-only autostart has no other platform branches');
  assert.match(src, /start", 0, False/, 'Windows runs one detached start');
  assert.doesNotMatch(src, /sh\.Run[^\n]*watch all/, 'no second process racing for the watcher lock');
  // watcher 由 start 通过 --watch 带起来，并作为子进程被守护。
  assert.match(cli, /'--watch'/, 'start asks for the watchers');
  assert.match(cli, /watch', 'all', '--supervised'/, 'and supervises one watcher child');
  assert.match(cli, /case 'supervise'/, 'the detached process is the whole-stack supervisor');
});

// 无人值守的关键：启动时一个来源都没有，不能退出。软件可能是开机之后才装的，
// 日志目录也可能被挪走又挪回来 —— 观察器要自己等、自己接上。
test('the watcher daemon waits for sources instead of exiting', async () => {
  const CLI = path.join(__dirname, '..', 'src', 'cli.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-watchd-'));
  const home = path.join(tmp, 'home');
  const env = {
    ...process.env,
    BAOANLIGHT_HOME: path.join(tmp, 'state'),
    USERPROFILE: home,
    HOME: home,
    APPDATA: path.join(tmp, 'appdata'),
    CODEX_HOME: path.join(tmp, 'codex'),
    DSH_HOME: path.join(tmp, 'dsh'),
    WORKBUDDY_HOME: path.join(tmp, 'wb'),
    BAOANLIGHT_PORT: '4998',     // 没有服务：watcher 的上报会静默失败，不影响启动
    BAOANLIGHT_LOG: '0',
  };
  const cp = spawn(process.execPath,
    [CLI, 'watch', 'all', '--supervised', '--retry', '150', '--quiet'], { env });
  let out = '';
  cp.stdout.on('data', (c) => { out += c; });
  cp.stderr.on('data', (c) => { out += c; });

  try {
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(cp.exitCode, null, 'it must not exit just because nothing is installed yet');

    // 装上一份 Codex 日志目录：重试循环要自己把它接进来，不需要人工重启。
    fs.mkdirSync(path.join(tmp, 'codex', 'sessions'), { recursive: true });
    await new Promise((r) => setTimeout(r, 1500));
    assert.match(out, /watching codex/, 'a source that appears later gets picked up');
  } finally {
    cp.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// 被子进程守护时，「锁被另一个 watcher 占着」不是失败：退出码 3 让父进程
// 别再重启它，否则会变成一个每 5 秒重启一次的失败循环。
test('a supervised watcher steps aside when another one holds the lock', async () => {
  const CLI = path.join(__dirname, '..', 'src', 'cli.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-watchl-'));
  fs.writeFileSync(path.join(tmp, 'watch-all.pid'), String(process.pid));

  const r = await new Promise((resolve) => {
    execFile(process.execPath, [CLI, 'watch', 'all', '--supervised'], {
      env: { ...process.env, BAOANLIGHT_HOME: tmp, BAOANLIGHT_LOG: '0' },
      timeout: 5000,
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
  try {
    assert.equal(r.code, 3, 'the supervisor must not restart a watcher that lost the lock');
    assert.match(r.stderr, /already running/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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

// 「已经只剩 3%」和「刚刚掉到 3%」不是一回事。启动后先到的几帧 fuel 是 null，
// 把它当成「上次还够用」会让首批 4% 一开机就弹一次通知，而用户什么也没做。
// 另外状态必须按软件分开记：两个订阅先后见底，第二次也得响。
test('a gauge that is already low at startup does not fire a notification', () => {
  const js = overlayFile('ui.js');
  assert.match(js, /const lastFuelLow = new Map\(\)/, 'one flag per software, not one global');
  assert.match(js, /typeof f\.remaining !== 'number'\) return;/,
    'a missing reading must not be recorded as "was fine"');
  assert.match(js, /lastFuelLow\.get\(key\) === false/, 'only a real drop notifies');
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

// Windows 上，从一个没有控制台的父进程里 spawn node.exe 时，子进程默认会被分配
// 一个新的控制台窗口 —— 用户看到的就是「动不动弹出一个黑框」。凡是从后台拉起的
// 子进程都必须带 windowsHide，否则从后台拉起的 node.exe 会各弹一个黑框。
test('children spawned in the background never pop a console window', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
  const sites = [
    'const child = spawn(process.execPath, args,',   // server（detached）
    'const child = spawn(String(electron)',          // 窗口
    "spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '', url],",   // 浏览器
  ];
  for (const anchor of sites) {
    const at = js.indexOf(anchor);
    assert.ok(at > 0, `spawn site missing: ${anchor}`);
    assert.match(js.slice(at, at + 900), /windowsHide: true/,
      `${anchor} must pass windowsHide: true`);
  }
  // watch all 曾经为每个软件 spawn 一个子进程（那是最常见的黑框来源）；现在它在
  // 同一进程里直接跑各 watcher，所以这条再也找不到那个 spawn —— 反而证明省掉了。
  assert.doesNotMatch(js, /stdio: \['ignore', 'pipe', 'pipe'\]/,
    'watch-all no longer spawns a child per agent');
});
