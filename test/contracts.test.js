'use strict';
// 跨进程契约的守卫。
//
// 这里测的三样东西都不会让界面报错，只会让事情安静地不对：
//   1. HTTP 路由怎么读请求体（`bao mcp` 的整条通道挂在上面）；
//   2. 配置文件怎么写下去（半截 JSON = 下次启动静默回到出厂设置）；
//   3. 安装器在「不该动手」的时候有没有动手（用户的 settings.json）。
//
// 每一条都对应一次真实故障：MCP 上报把 agent 压成 "agent"、配置写到一半、
// 一次权限抖动把 permissions 清空。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 隔离到临时目录：本文件在 port 0 上起 server，别把临时端口写进用户真实的端口文件。
process.env.BAOANLIGHT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-contracts-'));

const { start } = require('../src/server');
const install = require('../src/adapters/install');

const ROOT = path.join(__dirname, '..');

// 端口 0 让系统挑一个：固定端口会和用户自己正在跑的那只机器人撞上。
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

const api = async (p, init) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    ...(init || {}),
    headers: { 'x-bao-token': TOKEN, ...((init && init.headers) || {}) },
  });
  return r.json();
};

// ---------------------------------------------------------------- /set + body

// `bao mcp` 的 report_status 把 state 放在路径上、其余字段放在 JSON body 里。
// 路由曾经只读查询串，于是 body 被整段丢掉：每个软件都上报成同一个 "agent",
// detail 和 cwd 永远是空的 —— 而 MCP 是 README 主推的接入方式。
test('/set/<state> reads agent, detail and cwd from the JSON body', async () => {
  await api('/set/busy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agent: 'claude', detail: 'mcp-test', cwd: '/tmp/x', session: 'mcp:claude',
    }),
  });
  const snap = await api('/state');
  const s = snap.sessions.find((x) => x.session === 'mcp:claude');
  assert.ok(s, 'the session named in the body is the one that was written');
  assert.equal(s.agent, 'claude', 'not the generic "agent"');
  assert.equal(s.state, 'busy');
  assert.equal(s.detail, 'mcp-test');
  assert.equal(s.cwd, '/tmp/x');
});

// 一行 curl 的老用法不能因为上面那条而失效。
test('/set/<state> still works as a bare one-line curl', async () => {
  await api('/set/waiting?agent=codex&session=curl&detail=approve');
  const s = (await api('/state')).sessions.find((x) => x.session === 'curl');
  assert.equal(s.agent, 'codex');
  assert.equal(s.state, 'waiting');
  assert.equal(s.detail, 'approve');
});

// 路径里的 state 是权威：body 里再写一个也不能改掉它，否则
// `POST /set/waiting {"state":"error"}` 会变成一个没有鉴权的红灯。
test('the state in the path wins over a state in the body', async () => {
  await api('/set/idle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'codex', session: 'path-wins', state: 'error' }),
  });
  const s = (await api('/state')).sessions.find((x) => x.session === 'path-wins');
  assert.equal(s.state, 'idle');
});

// 坏 body 不该 500，也不该写进一个乱七八糟的会话。
test('a body that is not JSON falls back to the defaults instead of failing', async () => {
  const r = await api('/set/busy?session=bad-body', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ not json',
  });
  assert.equal(r.error, undefined, `no error surfaced, got ${JSON.stringify(r)}`);
  const s = (await api('/state')).sessions.find((x) => x.session === 'bad-body');
  assert.equal(s.agent, 'agent');
});

// 少了 state 的上报不是「idle」：以前会被 normalise 成就绪，凭空在面板上点亮
// 一个槽位（直到 unusedTtl 才消失），而调用方以为自己报的是 busy。
test('/state without a state is refused instead of becoming idle', async () => {
  const r = await api('/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'no-state', agent: 'ghost' }),
  });
  assert.equal(r.error, 'state or fuel required');
  const snap = await api('/state');
  assert.equal(
    snap.sessions.some((s) => s.session === 'no-state'),
    false,
    'no session may be created from a body without a state'
  );
});

// ---------------------------------------------------------------- config write

test('a config write lands atomically and leaves no temp file behind', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-cfg-'));
  try {
    const script = [
      `process.env.BAOANLIGHT_HOME = ${JSON.stringify(home)};`,
      `require(${JSON.stringify(path.join(ROOT, 'src', 'config.js'))}).save({ scale: 1.4, skin: '军绿' });`,
    ].join('\n');
    execFileSync(process.execPath, ['-e', script], { stdio: 'pipe' });

    const file = path.join(home, 'config.json');
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotThrow(() => JSON.parse(text), 'the file on disk is valid JSON');
    assert.equal(JSON.parse(text).scale, 1.4, 'and carries the write');
    const leftovers = fs.readdirSync(home).filter((n) => n.includes('.tmp'));
    assert.deepEqual(leftovers, [], `no half-written temp file left: ${leftovers.join(', ')}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// 配置文件被别的进程写坏时，下一次 save 必须能把它救回来（并且不抛）。
test('a corrupted config is repaired by the next save, not crashed on', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-cfg2-'));
  try {
    fs.writeFileSync(path.join(home, 'config.json'), '{ "scale": 1.4, ');
    const script = [
      `process.env.BAOANLIGHT_HOME = ${JSON.stringify(home)};`,
      `const c = require(${JSON.stringify(path.join(ROOT, 'src', 'config.js'))});`,
      'c.save({ theme: "mini" });',
    ].join('\n');
    execFileSync(process.execPath, ['-e', script], { stdio: 'pipe' });
    const parsed = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(parsed.theme, 'mini');
    assert.equal(parsed.scale, 1, 'falls back to the factory scale rather than guessing');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Windows 记事本保存 UTF-8 会加 BOM。用户手改 config.json 之后，整份配置不该
// 因为一个看不见的字符就静默回到出厂值。
test('a config file saved with a BOM is read, not reset to factory defaults', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-cfg3-'));
  try {
    fs.writeFileSync(path.join(home, 'config.json'),
      '\uFEFF' + JSON.stringify({ scale: 1.4, skin: '军绿' }));
    const script = [
      `process.env.BAOANLIGHT_HOME = ${JSON.stringify(home)};`,
      `const c = require(${JSON.stringify(path.join(ROOT, 'src', 'config.js'))});`,
      'const cfg = c.load();',
      'process.stdout.write(JSON.stringify({ scale: cfg.scale, skin: cfg.skin }));',
    ].join('\n');
    const out = execFileSync(process.execPath, ['-e', script], { stdio: 'pipe', encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), { scale: 1.4, skin: '军绿' },
      'a BOM is an encoding marker, not a corrupt file');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- installer safety

const withScopeProject = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-inst-'));
  const claudeDir = path.join(dir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const file = path.join(claudeDir, 'settings.json');
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return fn({ dir, claudeDir, file });
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

// 什么都没卸掉的时候，一个字节都不许动 —— 连备份都不该多做一份。
test('uninstalling hooks that are not there leaves the file byte-identical', () => {
  withScopeProject(({ claudeDir, file }) => {
    const original = '{\n  "permissions": { "allow": ["Bash(ls:*)"] }\n}\n';
    fs.writeFileSync(file, original);

    const r = install.uninstallClaude({ scope: 'project' });
    assert.equal(r.removed, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'not reformatted, not rewritten');
    assert.deepEqual(fs.readdirSync(claudeDir), ['settings.json'], 'and no backup was made');
  });
});

// 读不出这个文件时，唯一正确的动作是停下来。把它当成 `{}` 再写回去，
// 用户丢的是 permissions / env / model，拿到的只是一句「备份在 xxx」。
test('a settings file we cannot parse is never overwritten', () => {
  withScopeProject(({ file }) => {
    const broken = '{ "permissions": { "allow": [ ] },, }';
    fs.writeFileSync(file, broken);

    assert.throws(() => install.installClaude({ scope: 'project' }), /refusing to overwrite/i);
    assert.equal(fs.readFileSync(file, 'utf8'), broken, 'the user file survived untouched');
  });
});

// 反过来：一个能读的文件，必须原样保住我们不认识的键。
// 记事本等 Windows 编辑器会把 UTF-8 存成带 BOM 的形态：文件头一个不可见的
// U+FEFF，JSON.parse 会直接报错。这种文件其实是好的，不能因此拒绝写入。
test('a UTF-8 BOM does not make a good settings file unreadable', () => {
  withScopeProject(({ file }) => {
    fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls:*)'] } }));

    install.installClaude({ scope: 'project' });
    const s = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(s.model, 'opus', 'unrelated keys survived');
    assert.deepEqual(s.permissions, { allow: ['Bash(ls:*)'] });
    const hooks = Object.values(s.hooks).flat().flatMap((g) => g.hooks).length;
    assert.equal(hooks, 8, 'all eight lifecycle hooks are wired');
  });
});

test('installing hooks keeps every key it does not own', () => {
  withScopeProject(({ file }) => {
    fs.writeFileSync(file, JSON.stringify({
      model: 'opus', env: { FOO: '1' }, permissions: { allow: ['Bash(ls:*)'] },
    }, null, 2));

    install.installClaude({ scope: 'project' });
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(s.model, 'opus');
    assert.deepEqual(s.env, { FOO: '1' });
    assert.deepEqual(s.permissions, { allow: ['Bash(ls:*)'] });
    const hooks = Object.values(s.hooks).flat().flatMap((g) => g.hooks).length;
    assert.equal(hooks, 8, 'all eight lifecycle hooks are wired');
  });
});

// ------------------------------------------------------------ config export

// 设置里每多一个自定义项，就必须同时出现在「导出配置」里 —— 否则换台机器
// 导入回来会静默少一项，而界面上一切正常，用户直到发现「我的外观/通知设置
// 又变回默认」才知道。这一条把「新增配置项」和「导出清单」钉在一起。
test('every user-facing config key is in the export list', () => {
  const js = fs.readFileSync(path.join(ROOT, 'src', 'overlay', 'ui.js'), 'utf8');
  const m = js.match(/const EXPORT_KEYS = \[([\s\S]*?)\];/);
  assert.ok(m, 'ui.js still declares the export list in one place');
  const exported = new Set((m[1].match(/'[^']+'/g) || []).map((s) => s.slice(1, -1)));

  // 这几项属于「这台机器此刻的状态」，不是用户想带走的自定义：
  //   port/window   本机端口与窗口坐标，换台机器没有意义；
  //   collapsed     窗口是不是收起了，属于瞬时界面状态；
  //   mutedUntil    「静音到几点」，是一次性计时器；
  //   firstRun      首次安装日期，属于这台机器上的陪伴天数；
  //   *TtlMs        服务端的会话老化参数，不是外观/行为设置。
  const MACHINE_STATE = new Set([
    'port', 'window', 'collapsed', 'mutedUntil', 'firstRun',
    'sessionTtlMs', 'idleTtlMs', 'quietAfterMs', 'unusedTtlMs',
  ]);

  const { DEFAULTS } = require('../src/config');
  const missing = Object.keys(DEFAULTS).filter((k) => !MACHINE_STATE.has(k) && !exported.has(k));
  assert.deepEqual(missing, [], `these settings are not exported: ${missing.join(', ')}`);

  // 反过来：清单里写错一个键（拼写/改名残留），导入时会被静默丢掉。
  const unknown = [...exported].filter((k) => !(k in DEFAULTS));
  assert.deepEqual(unknown, [], `the export list names keys that do not exist: ${unknown.join(', ')}`);
});

// 出厂外观有两处真源：config.js 的 DEFAULTS 和 palette/界面选项。任何一边改了
// 默认值而另一边没跟，表现都是「新装用户看到的下拉值与机器人身上的颜色/形状
// 对不上」—— 没有报错，也没有截图会失败。
test('the factory appearance in config matches what the renderer starts with', async () => {
  const { DEFAULTS } = require('../src/config');
  const palette = await import('../src/overlay/shared/palette.mjs');

  assert.equal(DEFAULTS.skin, palette.SKIN_TONES[0].name, 'palette index 0 is the factory skin');
  assert.equal(DEFAULTS.eyestyle, palette.EYE_TONES[0].name);
  assert.equal(DEFAULTS.trackstyle, palette.TRACK_TONES[0].name);
  assert.equal(DEFAULTS.armskin, palette.ARM_TONES[0].name);

  // 这三项没有调色板顺序，但必须是界面真的提供的选项（ui.js 的列表）。
  assert.ok(['双筒', '单眼', '三眼'].includes(DEFAULTS.headtype), `bad headtype: ${DEFAULTS.headtype}`);
  assert.ok(['铲形', '三指', '钳形', '四指', '五指'].includes(DEFAULTS.claw), `bad claw: ${DEFAULTS.claw}`);
  assert.ok(['圆角矩形', '三角形', '梯形'].includes(DEFAULTS.tracktype), `bad tracktype: ${DEFAULTS.tracktype}`);
});

// ------------------------------------------------------------ stylesheet traps

// `#menu button { width: 100% }` 是给整宽按钮（导出/退出）用的，但它的特异性
// 和 `#m-order button` 相同、定义却在后面：排序行两个箭头会被撑满一行、
// 「保存 / 应用 / 删除」会把旁边的输入框和下拉压成 0 宽 —— 方案名根本输不进去。
// 这类覆盖不会报错，只会让一个功能整块失效，所以用一条断言钉住前缀。
test('the generic menu button width cannot override the inline controls', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'overlay', 'index.html'), 'utf8');
  assert.match(html, /#menu #m-order button\s*\{/, 'the order arrows keep their own specificity');
  assert.match(html, /#menu #m-preset-save/, 'and so do the preset buttons');
});

// ------------------------------------------------------------ pages build

// 落地页的 3D 是从 src/overlay/ 复制过去的构建产物：GitHub Pages 只发布 docs/，
// 浏览器拿不到 ../src/。忘了跑 `npm run build:pages` 时，页面会安静地继续显示
// 上一版机器人 —— 这条断言把「产物过期」变成一次失败，而不是一个慢慢跑偏的
// 商品橱窗。
test('the landing-page demo is a byte-for-byte copy of the product renderer', () => {
  const files = [
    'robot3d.js',
    'vendor/three.module.js',
    'vendor/three.core.js',
    'scene/geometry.js',
    'scene/surfaces.js',
    'shared/palette.mjs',
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'overlay', rel));
    const out = fs.readFileSync(path.join(ROOT, 'docs', 'demo', rel));
    assert.ok(src.equals(out), `docs/demo/${rel} is stale — run: npm run build:pages`);
  }
});

// ------------------------------------------------------------ docs drift

// 文档里的清单最容易和代码走散：加一个场景、改一次皮肤，README 不会跟着变。
test('every scene in the picker is named in the README', () => {
  const js = fs.readFileSync(path.join(ROOT, 'src', 'overlay', 'ui.js'), 'utf8');
  const list = js.match(/const SCENE_NAMES = \[([^\]]+)\]/);
  assert.ok(list, 'the scene picker still declares its names in one place');
  const names = list[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for (const name of names) {
    assert.ok(readme.includes(name), `README never mentions the "${name}" scene`);
  }
});
