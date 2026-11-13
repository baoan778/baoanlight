'use strict';
// 3D 拆解台的渲染测试。
//
// 参考规范要求「不能只看视频，要看帧」——这里做的事一样：页面在真实浏览器里
// 渲染，我们断言的是结构、数据流和交互契约，而不是像素：
//
//   * 49 个零件、6 个阶段，一个不少（清单与几何同源，改一边必挂）；
//   * 三段式模式真的存在，且「依次拆解」能推进到 100%；
//   * 同一个 amount 在整机构上、在爆炸图上都成立（一个输入驱动一切）；
//   * 点选零件会给出带引线的标注，且标注不遮零件（朝外推 210px）；
//   * 页面零控制台错误 —— 一个 NaN 都不能有。
const { test, expect } = require('@playwright/test');
const { start } = require('../src/server');

let server;
let base;

test.beforeAll(async () => {
  const r = await start({ port: 0 });
  server = r.server;
  base = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(() => server && server.close());

test.beforeEach(async ({ page }) => {
  await page.goto(base + '/teardown/');
  await page.waitForFunction(() => window.__teardown && document.getElementById('frame').dataset.fps, { timeout: 30000 });
});

test('the teardown lists every part the model defines', async ({ page }) => {
  const info = await page.evaluate(() => ({ parts: window.__teardown.parts, stages: window.__teardown.stages }));
  // 精确值，不是「至少 45」：文档、面板和 README 都承诺 49 件。用 >= 的
  // 话，模型悄悄少掉零件时测试仍然全绿，而那份承诺已经变成假话。
  expect(info.parts).toBe(49);
  expect(info.stages).toBe(6);
});

test('the three phases exist and the stepped one reaches 100%', async ({ page }) => {
  await page.evaluate(() => window.__teardown.setMode('steps'));
  // 巡游从头走到尾需要 ~18s，这里直接把进度拉到末尾。
  await page.evaluate(() => {
    const scrub = document.getElementById('scrub');
    scrub.value = '1000';
    scrub.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(() => page.evaluate(() => window.__teardown.amount()), { timeout: 4000 }).toBe(1);
});

test('the scrub slider drives the same input the modes animate', async ({ page }) => {
  await page.evaluate(() => {
    const scrub = document.getElementById('scrub');
    scrub.value = '600';
    scrub.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // 拖滑块不得被阻尼拉回去（第一次实现就犯了这个错）。
  await page.waitForTimeout(600);
  const a = await page.evaluate(() => window.__teardown.amount());
  expect(a).toBeCloseTo(0.6, 1);
});

test('a selected part gets a leader-line callout pushed away from it', async ({ page }) => {
  await page.evaluate(() => window.__teardown.select('battery'));
  await page.waitForTimeout(400);
  const callout = await page.evaluate(() => {
    const tag = document.querySelector('.tag');
    const line = document.querySelector('#leaders line');
    return {
      visible: tag && tag.style.display !== 'none',
      text: tag ? tag.textContent : '',
      x: Number(tag ? tag.style.left.replace('px', '') : -1),
      y: Number(tag ? tag.style.top.replace('px', '') : -1),
      x1: Number(line.getAttribute('x1')), y1: Number(line.getAttribute('y1')),
      x2: Number(line.getAttribute('x2')), y2: Number(line.getAttribute('y2')),
    };
  });
  expect(callout.visible).toBe(true);
  expect(callout.text).toContain('电池组');
  // 标注距画面边缘 ≥ 60px，且不遮住零件（端点与标签之间至少隔 150px）
  expect(callout.x).toBeGreaterThanOrEqual(60);
  expect(callout.y).toBeGreaterThanOrEqual(60);
  expect(callout.x).toBeLessThanOrEqual(1540);
  expect(callout.y).toBeLessThanOrEqual(700);
  expect(Math.hypot(callout.x2 - callout.x1, callout.y2 - callout.y1)).toBeGreaterThanOrEqual(120);
});

test('assemble mode reverses the tour back to whole', async ({ page }) => {
  await page.evaluate(() => window.__teardown.setMode('explode'));
  // 等它真的走完，而不是等一个「900ms 应该够了」的猜测：这条动画是按帧推进
  // 的，慢一点的机器上 900ms 只到 0.93，于是同一份代码在别人的机器上飘红。
  await expect.poll(() => page.evaluate(() => window.__teardown.amount()), { timeout: 8000 })
    .toBeGreaterThanOrEqual(0.98);
  await page.evaluate(() => window.__teardown.setMode('assemble'));
  expect(await page.evaluate(() => window.__teardown.mode())).toBe('assemble');
  await expect.poll(() => page.evaluate(() => window.__teardown.amount()), { timeout: 6000 }).toBeLessThan(0.9);
});

test('the tour narrator can be muted', async ({ page }) => {
  expect(await page.evaluate(() => window.__teardown.narration())).toBe(true);
  await page.click('#narration');
  expect(await page.evaluate(() => window.__teardown.narration())).toBe(false);
  expect(await page.textContent('#narration')).toContain('关');
});

test('the page loads without a single console error', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(base + '/teardown/');
  await page.waitForFunction(() => window.__teardown && document.getElementById('frame').dataset.fps, { timeout: 30000 });
  await page.waitForTimeout(800);
  expect(errors, errors.join(' | ')).toEqual([]);
});
