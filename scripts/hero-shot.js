'use strict';
// 重新生成 README / 落地页用的机器人展示图（docs/robot.png）。
//
// 为什么需要它：这张图是 3D 渲染器的截图，不是代码；渲染器改了以后它不会
// 自己更新，也不会被测试判红（二进制没有可比的“正确值”）。以前 README 里
// 一直挂着一张旧版机器人的图，就是漏了这一步。外观、光照、默认体型有可见
// 变化时，跑一次 `npm run shot:hero`。
//
// 依赖：npm install + `npx playwright install chromium`。

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-hero-'));
process.env.BAOANLIGHT_HOME = HOME;

(async () => {
  const { start } = require(path.join(ROOT, 'src', 'server'));
  const { chromium } = require('playwright');

  const { server, port, token } = await start({ port: 0 });
  const base = `http://127.0.0.1:${port}`;
  // 绿色 = 正在干活，是展示图里最有辨识度的状态。
  await fetch(`${base}/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bao-token': token },
    body: JSON.stringify({ session: 'hero', agent: 'claude', state: 'busy' }),
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(base + '/');
  // eslint-disable-next-line no-undef -- 这段在浏览器里执行
  await page.waitForFunction(() => document.querySelector('#bot')?.dataset.ready === '1', { timeout: 30000 });
  await page.waitForTimeout(1200);

  // 只留机器人：藏掉工具栏、列表、系统面板、信息牌、便签、提示条。
  await page.addStyleTag({
    content: `
      #stage > *:not(#robot) { display: none !important; }
      #robot > #fuel { display: none !important; }
      #note, #preview, #menu, #sizer, #disconnected, #memo, #memo-peek { display: none !important; }
      body.browser { background: #0b0d10 !important; }
      #stage, #robot { width: auto !important; }
      #bot { width: 780px !important; max-width: none !important; }
    `,
  });
  await page.evaluate(() => globalThis.dispatchEvent(
    new CustomEvent('bao:scale', { detail: { scale: 780 / 300 } })
  ));
  await page.waitForTimeout(900);

  const out = path.join(ROOT, 'docs', 'robot.png');
  await page.locator('#bot').screenshot({ path: out });
  console.log(`wrote ${out}`);

  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(HOME, { recursive: true, force: true });
})().catch((err) => {
  console.error(err);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(1);
});
