#!/usr/bin/env node
// 逐帧导出拆解台：把「整机 → 全部零件」拍成一串 PNG + 时间线，可选 ffmpeg 出片。
//
// 这是 teardown 规范里「film」那一档的轻量实现：同一个 amount 输入既驱动页面，
// 也驱动这里的每一帧，所以影片和实时页永远不会漂移。
//
// 用法（先 `bao start --browser`，或本脚本自己起一个服务）：
//   node scripts/capture-teardown.mjs --fps 30 --seconds 18 --out teardown-out
// 有 ffmpeg 在 PATH 上时，最后会把 PNG 合成为 out/film.mp4。
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const fps = Number(opt('fps', 30));
const seconds = Number(opt('seconds', 18));
const outDir = path.resolve(opt('out', 'teardown-out'));
const port = Number(opt('port', process.env.BAOANLIGHT_PORT || 4747));

const { chromium } = await import('@playwright/test');

// 目标端口没起服务就自己起一个，用完自己关。
let server = null;
try {
  const r = await fetch(`http://127.0.0.1:${port}/health`);
  if (!r.ok) throw new Error('no server');
} catch {
  const { start } = await import('../src/server.js');
  const started = await start({ port });
  server = started.server;
}

const base = `http://127.0.0.1:${port}`;
const framesDir = path.join(outDir, 'film');
mkdirSync(framesDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(base + '/teardown/');
await page.waitForFunction(() => window.__teardown && document.getElementById('frame').dataset.fps, { timeout: 30000 });

const frames = Math.max(2, Math.round(fps * seconds));
const timeline = [];
console.log(`capturing ${frames} frames @ ${fps}fps → ${framesDir}`);

for (let i = 0; i < frames; i++) {
  const amount = i / (frames - 1);
  await page.evaluate((a) => {
    const scrub = document.getElementById('scrub');
    scrub.value = String(Math.round(a * 1000));
    scrub.dispatchEvent(new Event('input', { bubbles: true }));
  }, amount);
  // 给阻尼一点收敛时间，避免首尾两帧还带着上一帧的惯性。
  await page.waitForTimeout(40);

  const stage = await page.evaluate(() => window.__teardown.stage());
  const t = +(i / fps).toFixed(3);
  await page.screenshot({ path: path.join(framesDir, `${String(i).padStart(4, '0')}.png`) });
  timeline.push({ frame: i, t, amount: +amount.toFixed(4), stage });
  if (i % 10 === 0 || i === frames - 1) process.stdout.write(`\r${i + 1}/${frames}`);
}

writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2));
console.log('\ntimeline.json written');

const mp4 = path.join(outDir, 'film.mp4');
const ff = spawnSync('ffmpeg', [
  '-y', '-framerate', String(fps), '-i', path.join(framesDir, '%04d.png'),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', mp4,
], { stdio: 'inherit' });
if (ff.error) {
  console.log('ffmpeg not found — PNG frames and timeline.json are ready; install ffmpeg to get film.mp4.');
} else if (ff.status === 0) {
  console.log('wrote', mp4);
}

await browser.close();
if (server) server.close();
