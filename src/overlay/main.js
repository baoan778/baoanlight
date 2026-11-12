'use strict';
const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage, globalShortcut, Notification } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const config = require('../config');

const PORT = Number(process.env.BAOANLIGHT_PORT || process.env.SIGNALHEAD_PORT) || config.port();
const URL_BASE = `http://127.0.0.1:${PORT}`;

// Windows 原生通知（toast）需要绑一个 AppUserModelId，否则会显示成「Electron」。
app.setAppUserModelId('com.baoanlight.robot');

// The alert tone is generated in the renderer and is not triggered by a click,
// so Chrome's autoplay gate would otherwise swallow every sound.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
let tray = null;
let saveTimer = null;
let cursorTimer = null;
let clickThroughEnabled = true;
// 最近一次「我们自己」改窗口大小/位置的时间。`moved` 在程序化 setBounds 时也会
// 触发，不区分的话每开一次菜单都会把 clamp 后的位置当成用户拖拽保存下来。
let boundsAppliedAt = 0;

function waitForServer(tries = 40) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const req = http.get(`${URL_BASE}/health`, (res) => { res.resume(); resolve(); });
      req.on('error', () => {
        if (n <= 0) return reject(new Error(`no baoanlight server on ${URL_BASE}`));
        setTimeout(() => attempt(n - 1), 250);
      });
      req.setTimeout(1000, () => req.destroy());
    };
    attempt(tries);
  });
}

function defaultPosition(w, h) {
  const { workArea } = screen.getPrimaryDisplay();
  // Bottom-right by default: a desk robot sits in the corner, out of the way
  // of the editor but still in peripheral vision.
  return {
    x: workArea.x + workArea.width - w - 24,
    y: workArea.y + workArea.height - h - 24,
  };
}

// 拔掉外接显示器之后，存下来的坐标可能落在任何一块屏幕之外。窗口会照常创建、
// 照设置置顶，但用户看不见它 —— 只能靠托盘「显示/隐藏」碰运气捞回来。
function isOnAnyDisplay(x, y, w, h) {
  return screen.getAllDisplays().some(({ workArea: a }) => (
    x + w > a.x && x < a.x + a.width && y + h > a.y && y < a.y + a.height
  ));
}

function createWindow() {
  const cfg = config.load();
  const width = 340;
  const height = 520;
  const saved = cfg.window || {};
  const remembered = Number.isFinite(saved.x) && Number.isFinite(saved.y)
    && isOnAnyDisplay(saved.x, saved.y, width, height);
  const pos = remembered ? { x: saved.x, y: saved.y } : defaultPosition(width, height);

  win = new BrowserWindow({
    title: 'baoanlight',
    width,
    height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 页面通过 http://127.0.0.1 加载，CSP 里也没有 eval —— 没有理由让渲染进程
      // 拿到 Node。端口走启动参数，preload 因此不需要 require 任何本地文件。
      sandbox: true,
      additionalArguments: [`--bao-port=${PORT}`],
    },
  });

  // Float above fullscreen apps and every desktop/space.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  clickThroughEnabled = cfg.clickThrough !== false;
  if (clickThroughEnabled) win.setIgnoreMouseEvents(true, { forward: true });

  win.loadURL(URL_BASE + '/');
  win.once('ready-to-show', () => win.showInactive());

  // 这个窗口只该显示机器人自己的页面。挡住跳转，页面里任何意外链接都不会把
  // 渲染进程带走 —— 而 preload 暴露的那组能力（通知、开终端、退出）是跟着
  // 渲染进程走的，所以「它停在哪里」也是一条安全边界。
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(URL_BASE)) e.preventDefault();
  });
  // 机器人没有需要网页权限的功能（声音由 WebAudio 合成，通知走主进程）。
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));

  // Keep the window where the user dragged it.
  const remember = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      // 程序化改尺寸（菜单打开、机器人变大）同样会发出 moved。用户没碰窗口，
      // 只是点了一下齿轮，不该把被屏幕边界 clamp 过的位置记成「他喜欢的位置」——
      // 否则在屏幕边缘每开一次菜单，机器人就往里挪一点，关掉也不回来。
      if (Date.now() - boundsAppliedAt < 500) return;
      const [x, y] = win.getPosition();
      config.save({ window: { x, y } });
    }, 400);
  };
  win.on('moved', remember);
  win.on('blur', () => { clearInterval(dragTimer); dragTimer = null; dragOrigin = null; });
  win.on('closed', () => {
    clearInterval(cursorTimer);
    clearInterval(dragTimer);
    dragTimer = null; dragOrigin = null; win = null;
  });

  cursorTimer = setInterval(pollCursor, 80);

  // Anything the page tries to open goes to the real browser, not this window.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// ---------- system tray ----------
// 一个常驻托盘图标：机器人没有任务栏按钮、也没有标题栏，托盘是唯一「藏起来
// 还能找回来」的地方。点一下切换显示/隐藏，右键退出。图标颜色跟着状态走。
const TRAY_ICONS = {
  busy: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAM0lEQVR4nGNgGJTA5Hjkf2yYIs1EGUJIM15DiNWM05BRA6hgAMXRSKwheDUTMoQozXQHADeGFviVW+EpAAAAAElFTkSuQmCC',
  waiting: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAM0lEQVR4nGNgGJTg/xmG/9gwRZqJMoSQZryGEKsZpyGjBlDBAIqjkVhD8GomZAhRmukOADE4TsD+rEiEAAAAAElFTkSuQmCC',
  error: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAM0lEQVR4nGNgGJTgv7XBf2yYIs1EGUJIM15DiNWM05BRA6hgAMXRSKwheDUTMoQozXQHAKLJIUjTb6gUAAAAAElFTkSuQmCC',
  done: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAM0lEQVR4nGNgGJRgQ/b//9gwRZqJMoSQZryGEKsZpyGjBlDBAIqjkVhD8GomZAhRmukOAOPCc8hNattkAAAAAElFTkSuQmCC',
  idle: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANElEQVR4nGNgGJTg/tM3/7FhijQTZQghzXgNIVYzTkNGDaCCARRHI7GG4NVMyBCiNNMdAAAAyroYYaWJHwAAAABJRU5ErkJggg==',
  unknown: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANElEQVR4nGNgGJTgzOU7/7FhijQTZQghzXgNIVYzTkNGDaCCARRHI7GG4NVMyBCiNNMdAAB5OaFAPhxoSQAAAABJRU5ErkJggg==',
  offline: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAM0lEQVR4nGNgGJTAKyDiPzZMkWaiDCGkGa8hxGrGacioAVQwgOJoJNYQvJoJGUKUZroDANZU6PkBDgjZAAAAAElFTkSuQmCC',
};
for (const k of Object.keys(TRAY_ICONS)) TRAY_ICONS[k] = 'data:image/png;base64,' + TRAY_ICONS[k];

function toggleWin() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) win.hide();
  else { win.show(); win.setAlwaysOnTop(true, 'screen-saver'); }
}

function createTray() {
  try {
    const icon = nativeImage.createFromDataURL(TRAY_ICONS.offline);
    tray = new Tray(icon);
    tray.setToolTip('baoanlight');
    const menu = Menu.buildFromTemplate([
      { label: '显示 / 隐藏机器人', click: toggleWin },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
    tray.on('click', toggleWin);
  } catch {
    tray = null;   // 创建失败就退回纯窗口模式，不影响使用
  }
}

const TRAY_STATE_LABEL = { busy: '运行中', waiting: '需要你', error: '出错', done: '完成', idle: '空闲', unknown: '未知', offline: '未连接' };
let trayState = 'offline';
ipcMain.on('tray:status', (_e, s) => {
  const st = (s && s.overall) || 'offline';
  if (!tray) return;
  const label = TRAY_STATE_LABEL[st] || '未连接';
  const extra = s && s.count ? ` · ${s.count} 个会话` : '';
  tray.setToolTip(`baoanlight — ${label}${extra}`);
  if (st !== trayState && TRAY_ICONS[st]) {
    trayState = st;
    try { tray.setImage(nativeImage.createFromDataURL(TRAY_ICONS[st])); } catch { /* 忽略 */ }
  }
});

// ---------- renderer bridge ----------
ipcMain.handle('config:get', () => config.load());
ipcMain.handle('config:save', (_e, patch) => {
  const next = config.save(patch || {});
  clickThroughEnabled = next.clickThrough !== false;
  return next;
});

// Clicks pass through the window except over the light itself.
//
// Deciding this from forwarded mouse events is unreliable: leave the window fast
// enough and the final event never arrives, so the overlay stays click-swallowing
// over a region the user cannot see. Polling the cursor against the interactive
// rect has no such edge case.
let hotRect = null;      // interactive region, CSS px relative to the page
let cursorInside = null;

ipcMain.on('window:hotrect', (_e, rect) => { hotRect = rect; });

function pollCursor() {
  if (!win || win.isDestroyed()) return;
  // 托盘把窗口藏起来之后，没人看得见那只眼睛 —— 就别再以每秒 12 次的频率往
  // 一个不可见的渲染进程推坐标了。
  if (!win.isVisible()) return;

  const pt = screen.getCursorScreenPoint();
  const b = win.getBounds();

  // The robot watches the cursor wherever it is on the desktop, not just when
  // it is over the 340px window — so the position is pushed every tick, and
  // "look at me" works from anywhere on the screen.
  try {
    win.webContents.send('cursor', { x: pt.x - b.x, y: pt.y - b.y, w: b.width, h: b.height });
  } catch { /* the page is still loading; the next tick will land */ }

  // While the window is being dragged the cursor can briefly leave the hotspot;
  // toggling click-through mid-drag would drop the button-up.
  if (dragOrigin) return;

  if (clickThroughEnabled === false) {
    if (cursorInside !== true) { cursorInside = true; win.setIgnoreMouseEvents(false); }
    return;
  }
  if (!hotRect) return;

  const inside =
    pt.x >= b.x + hotRect.x && pt.x <= b.x + hotRect.x + hotRect.w &&
    pt.y >= b.y + hotRect.y && pt.y <= b.y + hotRect.y + hotRect.h;

  if (inside === cursorInside) return;
  cursorInside = inside;
  win.setIgnoreMouseEvents(!inside, { forward: true });
}

let lastScale = null;

ipcMain.on('window:size', (_e, { w, h, scale: s, anchor } = {}) => {
  if (!win || win.isDestroyed() || !w || !h) return;
  const width = Math.max(80, Math.ceil(w));
  const height = Math.max(80, Math.ceil(h));
  const [cw, ch] = win.getSize();
  const scaleChanged = s != null && lastScale != null && s !== lastScale;
  if (s != null) lastScale = s;
  if (cw === width && ch === height) return;

  // A resize caused by an agent appearing grows downward and keeps the robot
  // where it is. A resize caused by the size slider grows around the robot's
  // bottom centre instead, so dragging the slider does not walk it off the desk.
  const [x, y] = win.getPosition();
  const keepBottom = anchor === 'bottom' || scaleChanged;
  const nx = keepBottom ? Math.round(x - (width - cw) / 2) : x;
  const ny = keepBottom ? Math.round(y - (height - ch)) : y;

  // Keep the window inside the screen it sits on — otherwise a light parked
  // near an edge drifts off it.
  const { workArea } = screen.getDisplayNearestPoint({ x, y });
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

  win.setBounds({
    x: clamp(nx, workArea.x, workArea.x + workArea.width - width),
    y: clamp(ny, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  });
  // 记下来：这次移动是我们自己做的，别让 moved 处理器当成用户拖拽。
  boundsAppliedAt = Date.now();
});

// Dragging is driven from the main process rather than a CSS drag region: a
// -webkit-app-region drag area swallows the right-click that opens the size
// menu, and this window is click-through everywhere except the robot.
let dragTimer = null;
let dragOrigin = null;

ipcMain.on('window:drag-start', () => {
  if (!win || win.isDestroyed()) return;
  clearInterval(dragTimer);
  const p = screen.getCursorScreenPoint();
  const [x, y] = win.getPosition();
  dragOrigin = { cx: p.x, cy: p.y, x, y };
  dragTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !dragOrigin) return;
    const q = screen.getCursorScreenPoint();
    win.setPosition(dragOrigin.x + q.x - dragOrigin.cx, dragOrigin.y + q.y - dragOrigin.cy);
  }, 16);
});

ipcMain.on('window:drag-end', () => {
  clearInterval(dragTimer);
  dragTimer = null;
  dragOrigin = null;
});

ipcMain.on('app:quit', () => app.quit());

// 3D 拆解台：从设置菜单打开一个**独立的普通窗口**（不是浏览器标签，也不是那个
// 340px 的透明小窗 —— 拆解要整屏看零件和标注）。窗口是常规可缩放窗口，关掉就
// 释放，下次再开新的。
let teardownWin = null;
ipcMain.on('teardown:open', () => {
  if (teardownWin && !teardownWin.isDestroyed()) {
    teardownWin.focus();
    return;
  }
  teardownWin = new BrowserWindow({
    width: 1440, height: 920,
    minWidth: 900, minHeight: 620,
    title: 'baoanlight · 拆解台',
    backgroundColor: '#f4f1ea',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--bao-port=${PORT}`],
    },
  });
  teardownWin.loadURL(URL_BASE + '/teardown/');
  teardownWin.on('closed', () => { teardownWin = null; });
  teardownWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
});

// 原生系统通知：某个软件需要你 / 出错 / 额度见底时弹一次。
ipcMain.on('notify:show', (_e, { title, body } = {}) => {
  if (!title) return;
  try {
    if (Notification.isSupported()) new Notification({ title: String(title).slice(0, 60), body: String(body || '').slice(0, 120) }).show();
  } catch { /* 通知失败不影响运行 */ }
});

// 一键打开终端：在某个会话的工作目录里起一个终端，回到「事故现场」。
//
// cwd 来自服务端（hooks 上报）。「本机」不等于「一定是个安全路径」：
// 原来只是把引号和反斜杠删掉就拼进 `cmd /k "cd /d ..."`，而 cmd.exe 在引号
// 内部仍然会展开 %VAR%。现在只接受一个**真实存在的目录**，含展开字符的一律
// 拒绝 —— 打不开终端是小事，执行到别处是大事。
ipcMain.on('shell:open', (_e, { cwd } = {}) => {
  if (!cwd || typeof cwd !== 'string') return;
  if (/[%$`"\r\n]/.test(cwd)) return;
  let dir;
  try { dir = path.resolve(cwd); } catch { return; }
  try { if (!fs.statSync(dir).isDirectory()) return; } catch { return; }
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', 'cmd', '/k', `cd /d "${dir}"`], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Terminal', dir], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('x-terminal-emulator', ['--working-directory', dir], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* 打不开终端就算了 */ }
});

app.on('window-all-closed', () => app.quit());
if (process.platform === 'darwin' && app.dock) app.dock.hide();

// Two robots on one desktop is not a second opinion: they overlap, they fight
// over the saved window position, and neither of them can be told apart from a
// rendering bug. The second copy says what is happening and leaves; the first
// one comes forward so it is obvious which robot is the real one.
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  console.error(`baoanlight: another instance is already running on port ${PORT}.`);
  console.error('  One robot per desktop — use the existing window, or `bao stop` first.');
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) win.showInactive();
  });

  app.whenReady().then(async () => {
    try {
      await waitForServer();
    } catch (err) {
      console.error(err.message);
      console.error('Start it first with:  bao start');
      return app.quit();
    }
    createWindow();
    createTray();
    // 全局快捷键：Ctrl/⌘+Shift+B 一键显示/隐藏机器人。
    try { globalShortcut.register('CommandOrControl+Shift+B', toggleWin); } catch { /* 占用就放弃 */ }
    app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch { /* 忽略 */ } });
  });
}
