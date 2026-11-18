'use strict';
// 常驻窗口的性能预算。
//
// 这个机器人一整天都待在别人桌面上，所以它的性能目标不是「跑得快」，而是
// 「不干活的时候几乎不花东西」。这件事以前只写在文档里，靠肉眼和任务管理器
// 判断；这里把它变成可断言的数字：
//
//   * 空闲/离线档位必须真的降下来（15fps），不能被当成 60fps 在跑；
//   * 「减少动态效果」必须把整场降到个位数帧率；
//   * 低档位不能被误判成「机器带不动」而永久降分辨率；
//   * 状态不变时，界面不许重写 DOM。
//
// `#bot[data-fps]` 是渲染循环自己测出来的真实帧率（不是目标值），`data-quality`
// 只在降级后出现 —— 两者都是给这里读的埋点。
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 与 overlay.spec 同一件事：port 0 起 server 必须把 HOME 指走，否则临时端口会写进
// 用户真实的 ~/.baoanlight/port，覆盖真实机器人的端口。require server 之前设好。
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-perf-'));
process.env.BAOANLIGHT_HOME = testHome;

const { start } = require('../src/server');

// 这台机器上很可能正开着 Claude Code。presence 探测到它就会把「离线」升级成
// 「未知」—— 于是空闲档、静止档、DOM 静止这些纯渲染契约全被一条与本文件无关的
// 证据改掉，测试随开发者手头开没开 Claude 忽绿忽红。这里只测渲染，不测进程探测。
require('../src/presence').claudeRunning = async () => false;

let server;
let base;
let token;

test.beforeAll(async () => {
  const r = await start({ port: 0, idleTtlMs: 600_000 });
  server = r.server;
  token = r.token;
  base = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(() => {
  server && server.close();
  delete process.env.BAOANLIGHT_HOME;
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
});

const api = (path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bao-token': token },
    body: JSON.stringify(body),
  });

const clearAll = async () => {
  const snap = await (await fetch(base + '/state')).json();
  for (const s of snap.sessions) await api('/state', { session: s.session, state: 'offline' });
};

const reset = async () => {
  await clearAll();
  await api('/state', { session: 'perf', agent: 'claude', state: 'busy' });
  await api('/state', { session: 'perf', state: 'offline' });
};

const open = async (page, { reducedMotion = 'no-preference' } = {}) => {
  await page.emulateMedia({ reducedMotion });
  await page.goto(base + '/');
  await page.waitForFunction(() => document.body.dataset.state !== undefined);
  // data-fps 要满一秒才会第一次出现。
  await page.waitForFunction(() => document.getElementById('bot').dataset.fps !== undefined, { timeout: 10_000 });
};

// 跳过开场的降级判定：读两次，等它稳在同一条水平线上。
const steadyFps = async (page) => {
  let last = -1;
  for (let i = 0; i < 3; i++) {
    last = await page.evaluate(() => Number(document.getElementById('bot').dataset.fps));
    await page.waitForTimeout(1100);
  }
  return last;
};

test.beforeEach(async () => {
  await reset();
});

// 档位分两层断言：`data-target-fps` 是逻辑要求的节奏，`data-fps` 是这台机器
// 实际画出来的。速度只有在「慢档」上才是稳定的（15/8 的余量足够大）；忙碌档
// 在软件渲染或机器正忙时可能远低于 60，那是环境，不是产品缺陷 —— 拿它当断言
// 会让测试随负载忽绿忽红。
const targetFps = (page) =>
  page.evaluate(() => Number(document.getElementById('bot').dataset.targetFps));

test('an idle robot draws at a fraction of the working rate', async ({ page }) => {
  await open(page);
  const fps = await steadyFps(page);
  expect(await targetFps(page), 'nothing is running: the tier is 15fps').toBe(15);
  expect(fps, 'and it really is drawn slowly').toBeLessThanOrEqual(20);
  expect(fps, 'but it must still be alive').toBeGreaterThan(0);
});

test('"reduce motion" slows the whole scene down, not just one animation', async ({ page }) => {
  await open(page, { reducedMotion: 'reduce' });
  const fps = await steadyFps(page);
  expect(await targetFps(page), 'the accessibility tier is 8fps').toBe(8);
  expect(fps).toBeLessThanOrEqual(12);
});

test('a working robot still asks for every frame it can', async ({ page }) => {
  await api('/state', { session: 'perf', agent: 'claude', state: 'busy' });
  await open(page);
  await page.waitForFunction(() => document.body.dataset.state === 'busy');
  expect(await targetFps(page), 'busy keeps the 60fps tier').toBe(60);
  const fps = await steadyFps(page);
  expect(fps, 'and the loop is still drawing').toBeGreaterThan(0);
});

// 这条守的是一个真实存在过的缺陷：降级阈值写死 24fps，而空闲档位本来就只跑
// 15fps —— 于是每次启动都会把一台完全正常的机器永久降到 1.25 倍分辨率。
test('the idle tier is not mistaken for a machine that cannot cope', async ({ page }) => {
  await open(page);
  await page.waitForTimeout(2500);
  const quality = await page.evaluate(() => document.getElementById('bot').dataset.quality || 'full');
  const fps = await page.evaluate(() => Number(document.getElementById('bot').dataset.fps));
  expect(fps, 'precondition: we are in the slow tier').toBeLessThanOrEqual(20);
  expect(quality, 'idle fps is a cadence, not a verdict on the GPU').toBe('full');
});

// 离线静止时应当主动降画质（1x + 关阴影），而不是等它掉帧才反应；一旦有代理
// 报来状态，立刻回到完整画质。`data-tier` 是给这条观测用的档位标记。
test('the settled offline robot drops to a low-cost tier, and recovers', async ({ page }) => {
  await open(page);
  await page.waitForFunction(() => document.getElementById('bot').dataset.tier === 'settled');

  await api('/state', { session: 'tier', agent: 'claude', state: 'busy' });
  await page.waitForFunction(() => document.getElementById('bot').dataset.tier === 'full');

  await api('/state', { session: 'tier', state: 'offline' });
  await page.waitForFunction(() => document.getElementById('bot').dataset.tier === 'settled');
});

// 状态不变的时候，界面必须一个节点都不动。这条挡住的是「每个 SSE 帧都重建一遍
// pill 列表」那种写法 —— 它不会让画面出错，只会让一个一直开着的窗口持续耗电。
test('nothing rewrites the DOM while nothing changes', async ({ page }) => {
  await open(page);
  await page.waitForFunction(() => document.body.dataset.state === 'offline');

  const mutations = await page.evaluate(() => new Promise((resolve) => {
    let count = 0;
    const observer = new MutationObserver((records) => { count += records.length; });
    const labels = document.getElementById('labels');
    observer.observe(labels, { childList: true, subtree: true, attributes: true, characterData: true });
    setTimeout(() => { observer.disconnect(); resolve(count); }, 2500);
  }));

  expect(mutations, 'an idle window that keeps writing DOM is an idle window that burns a battery').toBe(0);
});
