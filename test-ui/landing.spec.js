'use strict';
// Rendered tests for the GitHub Pages landing page.
//
// The thing most likely to break here is the second theme: a colour defined only
// inside a media query renders one theme's text on the other theme's ground, and
// nothing but a real browser catches it.

const { test, expect } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Served over HTTP, not opened as a file. GitHub Pages serves this page over
// HTTPS, and file:// differs where it matters: localStorage can be refused
// there, which is exactly what the theme-persistence test depends on. A test
// that loads the page differently from how it ships is testing something else.
const DOCS = path.resolve(__dirname, '..', 'docs');
// `.mjs` 必须声明成 JS：少了它，浏览器会把模块当二进制下载然后拒绝执行，
// 而失败发生在 import 里，页面上只是静静地没有机器人。
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png',
};

let server;
let PAGE;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(DOCS, rel === '/' ? 'index.html' : rel.replace(/^\/+/, ''));
    if (!file.startsWith(DOCS) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PAGE = `http://127.0.0.1:${server.address().port}/`;
});

test.afterAll(() => server && server.close());

// 落地页引用 Google Fonts。在离线/受限网络里这个请求常常被黑洞（一直挂着而
// 不是快速失败），`page.goto` 默认等 `load`，于是测试陪着它一起超时 —— 字体
// 不是被测对象，任何断言也不依赖它。这里用一份空样式表回掉它：既不走网络，
// 也不会在控制台留下一条「加载失败」，字号自动回落到系统字体（离线用户的
// 真实场景：页面必须照常可读）。
test.beforeEach(async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('https://fonts.gstatic.com/**', (r) =>
    r.fulfill({ status: 200, contentType: 'font/woff2', body: '' }));
});

// Relative luminance, so contrast can be asserted rather than eyeballed.
const rgb = (s) => s.match(/\d+/g).slice(0, 3).map(Number);
const lum = ([r, g, b]) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
  const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

for (const scheme of ['light', 'dark']) {
  test(`body text is legible in ${scheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(PAGE);

    const c = await page.evaluate(() => {
      const b = getComputedStyle(document.body);
      const lede = getComputedStyle(document.querySelector('.lede'));
      return { bg: b.backgroundColor, fg: b.color, muted: lede.color };
    });

    expect(c.bg, 'body must paint its own background, never transparent')
      .not.toMatch(/rgba\(0, 0, 0, 0\)/);
    expect(contrast(c.fg, c.bg), 'body text against the ground').toBeGreaterThan(7);
    expect(contrast(c.muted, c.bg), 'muted text against the ground').toBeGreaterThan(4.5);
  });
}

test('the theme toggle flips the page and survives a reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(PAGE);
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  const started = await bg();
  await page.click('#theme');
  const flipped = await bg();
  expect(flipped).not.toBe(started);

  // The explicit choice must beat the OS preference, and persist.
  await page.reload();
  expect(await bg()).toBe(flipped);
});

test('an explicit light choice beats a dark system preference', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(PAGE);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  const c = await page.evaluate(() => {
    const b = getComputedStyle(document.body);
    return { bg: b.backgroundColor, fg: b.color };
  });
  expect(lum(rgb(c.bg)), 'ground should be light').toBeGreaterThan(0.7);
  expect(contrast(c.fg, c.bg)).toBeGreaterThan(7);
});

test('the page never scrolls sideways, at any width', async ({ page }) => {
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(PAGE);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
  }
});

test('the page is readable at rest, with the demo already running', async ({ page }) => {
  await page.goto(PAGE);
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('.pill')).toBeVisible();
  await expect(page.getByText('npm install -g baoanlight')).toBeVisible();

  // The robot is awake from the first frame — a powered-down widget would look
  // broken in a screenshot or a link preview.
  // 卡片里必须是真的 WebGL 机器人（产品自己那份建模代码），不是一张画。
  // data-ready 由 robot3d.js 在首帧之后写，所以等它等于等「3D 真的起来了」。
  await expect(page.locator('#bot')).toHaveAttribute('data-ready', '1', { timeout: 20000 });
  const lit = await page.evaluate(() => ({
    state: document.body.dataset.state,
    canvases: document.querySelectorAll('#bot canvas').length,
    width: document.getElementById('bot').clientWidth,
    lamp: getComputedStyle(document.body).getPropertyValue('--state').trim(),
  }));
  expect(lit.canvases, 'the demo is the real robot, not a drawing').toBe(1);
  expect(lit.width, 'the canvas has been given room to draw in').toBeGreaterThan(100);
  expect(lit.state).toBe('busy');
  // Green while working — the page used to show amber here, which taught the
  // wrong contract before anyone had installed it.
  expect(lit.lamp.toLowerCase()).toBe('#34c759');
});

test('the served page loads clean — no console errors, no broken local requests', async ({ page }) => {
  const errors = [];
  const failed = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('requestfailed', (r) => {
    // Only our own assets matter; a blocked font CDN is the network's business.
    if (r.url().startsWith(PAGE)) failed.push(r.url() + ' ' + (r.failure()?.errorText || ''));
  });

  await page.goto(PAGE, { waitUntil: 'load' });
  expect(errors, 'console errors').toEqual([]);
  expect(failed, 'failed same-origin requests').toEqual([]);
});

// The page is a shop window for the product; if it shows a different widget
// from the one people install, it is lying about what they will get.
test('the gauge on the page matches the app: neutral, not a lamp colour', async ({ page }) => {
  await page.goto(PAGE);
  const fill = await page.evaluate(() => getComputedStyle(document.querySelector('.fuel i')).backgroundColor);
  expect(fill).not.toBe('rgb(52, 199, 89)');   // green lamp
  expect(fill).not.toBe('rgb(255, 204, 0)');   // amber lamp
  expect(fill).not.toBe('rgb(255, 59, 48)');   // red lamp
});

test('the status pill carries a dot, the agent and its status', async ({ page }) => {
  await page.goto(PAGE);
  // 正式产品名，与安装后的界面一致：列表和铭牌显示「Claude Code」而不是代号。
  await expect(page.locator('.pill .who')).toHaveText('Claude Code');
  await expect(page.locator('.pill .dot')).toBeVisible();
  await expect(page.locator('.pill .what')).not.toBeEmpty();
});

// 主色同时是链接文字和按钮底色。原来的检查只看 body 和 .lede，于是 67% 的靛蓝
// 在近白底上 3.9:1 也能全绿通过。
for (const scheme of ['light', 'dark']) {
  test(`the accent clears AA in ${scheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(PAGE);
    const c = await page.evaluate(() => {
      const btn = document.querySelector('.btn.primary');
      const code = document.querySelector('.agents .how code');
      return {
        bg: getComputedStyle(document.body).backgroundColor,
        btnBg: getComputedStyle(btn).backgroundColor,
        btnFg: getComputedStyle(btn).color,
        codeFg: getComputedStyle(code).color,
      };
    });
    expect(contrast(c.btnFg, c.btnBg), 'button label on the accent').toBeGreaterThan(4.5);
    expect(contrast(c.codeFg, c.bg), 'accent text on the page ground').toBeGreaterThan(4.5);
  });
}
