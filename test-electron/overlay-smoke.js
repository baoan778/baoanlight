'use strict';
// Electron 主进程烟测：真的启动一个 robot 窗口，用 Playwright 的 Electron 支持
// 检查 preload 桥、页面加载、SSE 状态和窗口可见性。
//
// 逻辑测试证明模块正确，浏览器里的 UI 测试证明页面正确；这一条证明「Electron
// 壳能把这些装起来」。没有 Electron 时直接 SKIP（UI 测试仍然覆盖页面本身）。
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TIMEOUT_MS = 60_000;

let failures = 0;
function check(name, cond, extra = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
}

async function main() {
  let electronPath = null;
  try { electronPath = require('electron'); } catch { /* 可选依赖 */ }
  if (!electronPath || !fs.existsSync(electronPath)) {
    console.log('SKIP  Electron is not installed (run `bao setup` to enable this test).');
    return;
  }

  const { _electron: electron } = require('playwright');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-electron-home-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-electron-ud-'));
  process.env.BAOANLIGHT_HOME = home;

  const { start } = require('../src/server');
  const { server, port, token } = await start({ port: 0 });
  let app = null;
  try {
    app = await electron.launch({
      args: [path.join(ROOT, 'src', 'overlay', 'main.js')],
      env: {
        ...process.env,
        BAOANLIGHT_PORT: String(port),
        BAOANLIGHT_HOME: home,
        BAOANLIGHT_USER_DATA: userData,
      },
    });

    const page = await app.firstWindow({ timeout: 20_000 });
    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));
    await page.waitForSelector('canvas', { timeout: 20_000 });
    await page.waitForFunction(() => document.body.dataset.state !== undefined, { timeout: 20_000 });

    const preload = await page.evaluate(() => ({
      hasBridge: typeof window.bao === 'object' && window.bao !== null,
      hasConfig: typeof window.bao?.getConfig === 'function',
      serverUrl: String(window.bao?.serverUrl || ''),
    }));
    check('preload bridge is exposed', preload.hasBridge && preload.hasConfig);
    check('the page points at the test server', preload.serverUrl.endsWith(':' + port), preload.serverUrl);

    const initial = await page.evaluate(() => ({
      state: document.body.dataset.state,
      title: document.title,
    }));
    check('the overlay loads the robot page', initial.title === 'baoanlight' || initial.title === '', initial.title);
    check('it starts without claiming an agent is working',
      initial.state === 'offline' || initial.state === 'unknown', initial.state);

    await fetch(`http://127.0.0.1:${port}/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bao-token': token },
      body: JSON.stringify({ session: 'electron:smoke', agent: 'claude', state: 'waiting', detail: 'electron smoke' }),
    });
    await page.waitForFunction(() => document.body.dataset.state === 'waiting', { timeout: 10_000 });
    const stateNow = await page.evaluate(() => document.body.dataset.state);
    const led = await page.evaluate(() => document.getElementById('status-led').dataset.color);
    check('SSE state reaches the real window', stateNow === 'waiting', stateNow);
    check('the lamp follows the state', led === 'amber', led);

    const visible = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return !!win && win.isVisible() && win.isAlwaysOnTop();
    });
    check('a visible always-on-top window exists', visible);

    await page.evaluate(() => window.bao.saveConfig({ nameplate: 'electron-smoke' }));
    const cfg = await page.evaluate(() => window.bao.getConfig());
    check('config round-trips through the preload bridge', cfg.nameplate === 'electron-smoke', cfg.nameplate);

    await page.evaluate(() => window.bao.contentSize({ w: 360, h: 560, scale: 1, anchor: 'bottom' }));
    await page.waitForTimeout(300);
    const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
    // fit() 用 Math.ceil 把亚像素高度收进整数窗口，Windows 上因此可能多出 1px；
    // 这里验证的是 IPC 真的改了窗口尺寸，不是像素级取整。
    check('the size IPC reaches the real window',
      Math.abs(size[0] - 360) <= 1 && Math.abs(size[1] - 560) <= 1, size.join('x'));

    check('page has no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  } finally {
    if (app) { try { await app.close(); } catch { /* already gone */ } }
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* temp */ }
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

const killer = setTimeout(() => {
  console.error('FAIL  Electron smoke test timed out');
  process.exit(1);
}, TIMEOUT_MS);
killer.unref?.();

main().then(() => {
  clearTimeout(killer);
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}).catch((err) => {
  clearTimeout(killer);
  console.error('HARNESS ERROR', err);
  process.exit(1);
});
