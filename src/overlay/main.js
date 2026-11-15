'use strict';
const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage, globalShortcut, Notification } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const config = require('../config');
const auth = require('../auth');

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
      const retry = (msg) => {
        if (n <= 0) return reject(new Error(msg));
        setTimeout(() => attempt(n - 1), 250);
      };
      const req = http.get(`${URL_BASE}/health`, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (body.length < 4096) body += c; });
        res.on('end', () => {
          // 端口上应答的不一定是 baoanlight：别的本地服务、上一个残留实例都可能
          // 占着它。必须认名字 —— 否则会把陌生页面装进这个带 quit/开终端权限的壳。
          let name = '';
          try { name = JSON.parse(body).name || ''; } catch { name = ''; }
          if (name === 'baoanlight') return resolve();
          retry(`${URL_BASE} is occupied by something that is not baoanlight (health.name=${JSON.stringify(name)})`);
        });
        res.on('error', () => retry(`no baoanlight server on ${URL_BASE}`));
      });
      req.on('error', () => retry(`no baoanlight server on ${URL_BASE}`));
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

// 窗口至少要有这么多像素落在某块屏幕的工作区里，才算「能被看见/抓住」。
// 1px 相交也算「在屏内」的话，拔屏后窗口会变成边缘一条看不见的细缝，连
// 托盘的显示/隐藏都不会把它搬回来。和拖拽用的是同一个阈值。
const KEEP_VISIBLE = 60;

function isReachable(x, y, w, h) {
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const ox = Math.min(x + w, a.x + a.width) - Math.max(x, a.x);
    const oy = Math.min(y + h, a.y + a.height) - Math.max(y, a.y);
    return ox >= KEEP_VISIBLE && oy >= KEEP_VISIBLE;
  });
}

// 把跑到屏幕外的窗口搬回主屏右下角。
function ensureVisible() {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();
  if (isReachable(x, y, w, h)) return;
  const { workArea } = screen.getPrimaryDisplay();
  win.setPosition(
    Math.round(workArea.x + workArea.width - w - 24),
    Math.round(workArea.y + workArea.height - h - 24)
  );
  boundsAppliedAt = Date.now();
}

// 立即把当前位置落盘。拖拽用 400ms 防抖，但退出时不能再等：拖完立刻点「退出」，
// 防抖定时器还没到就被进程终止，下次启动就回到旧位置。
function savePositionNow() {
  if (!win || win.isDestroyed()) return;
  // 程序化改尺寸（菜单打开、机器人变大）同样会发出 moved。用户没碰窗口，只是点了
  // 一下齿轮，不该把被屏幕边界 clamp 过的位置记成「他喜欢的位置」—— 否则在屏幕
  // 边缘每开一次菜单，机器人就往里挪一点，关掉也不回来。
  if (Date.now() - boundsAppliedAt < 500) return;
  const [x, y] = win.getPosition();
  config.save({ window: { x, y } });
}

function createWindow() {
  const cfg = config.load();
  const width = 340;
  const height = 520;
  const saved = cfg.window || {};
  const remembered = Number.isFinite(saved.x) && Number.isFinite(saved.y)
    && isReachable(saved.x, saved.y, width, height);
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
    saveTimer = setTimeout(savePositionNow, 400);
  };
  win.on('moved', remember);
  // Linux 上 `moved` 不会发（Electron 只在 macOS / Windows 发它），而 `move`
  // 三平台都有。少了这条，Linux 用户的窗口位置永远记不住。
  if (process.platform === 'linux') win.on('move', remember);
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
  else {
    // 托盘/快捷键是唯一能把窗口找回来的入口：先确认它还在某块屏幕上。
    ensureVisible();
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
  }
}

// Ctrl/⌘+Alt+B。刻意避开 Ctrl+Shift+B —— 后者是 VS Code / IDEA 的「运行构建任务」，
// 全局热键会在系统层把它抢过来，用户在编辑器里按一下只会看到机器人动了一下。
const HOTKEY = 'CommandOrControl+Alt+B';

// register() 在组合被别的软件占用 / 系统拒绝时返回 false 而不抛异常；以前 catch
// 住什么都不做，用户按文档里的键毫无反应，也不知道为什么。至少留一条日志，并让
// 托盘菜单仍然可用（它不依赖热键）。
function registerHotkey(enabled = config.load().hotkeyOn !== false) {
  try {
    globalShortcut.unregisterAll();
    // 设置里可以关掉：全局热键是系统级的，有些人不希望任何程序常驻抢键。
    if (!enabled) return false;
    const ok = globalShortcut.register(HOTKEY, toggleWin);
    if (!ok) {
      console.warn(`baoanlight: global shortcut ${HOTKEY} is taken by another app — the tray menu still toggles the window.`);
    }
    return ok;
  } catch (err) {
    console.warn(`baoanlight: could not register ${HOTKEY}: ${err && err.message ? err.message : err}`);
    return false;
  }
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
  // 全局快捷键开关一改就立刻重新注册/注销，不用重启窗口。
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'hotkeyOn')) {
    registerHotkey(next.hotkeyOn !== false);
  }
  return next;
});

// ---------- 开机自启 ----------
// 安装动作交给 server（跑在 node 里）执行，主进程只发一条带 token 的本地请求：
// autostart.js 用 process.execPath 写启动项，在 Electron 进程里会写成 Electron
// 可执行文件，登录时根本起不来。
function apiJson(method, pathname, payload) {
  return new Promise((resolve) => {
    const body = payload ? JSON.stringify(payload) : '';
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      method,
      timeout: 5000,
      headers: {
        'x-bao-token': auth.token(),
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}
ipcMain.handle('autostart:get', () => apiJson('GET', '/autostart'));
ipcMain.handle('autostart:set', (_e, on) => apiJson('POST', '/autostart', { on: !!on }));

// Clicks pass through the window except over the light itself.
//
// Deciding this from forwarded mouse events is unreliable: leave the window fast
// enough and the final event never arrives, so the overlay stays click-swallowing
// over a region the user cannot see. Polling the cursor against the interactive
// rect has no such edge case.
let hotRect = null;      // interactive region, CSS px relative to the page
let cursorInside = null;

ipcMain.on('window:hotrect', (_e, rect) => {
  // 热区决定「哪些像素吃点击」，也是 setIgnoreMouseEvents 的唯一依据：脏值
  // （NaN / 字符串）会让每次比较都变成 false，整个窗口永久可点或永久穿透。
  if (!rect || ![rect.x, rect.y, rect.w, rect.h].every((v) => Number.isFinite(v))) return;
  if (rect.w < 0 || rect.h < 0) return;
  hotRect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
});

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
  // 渲染进程传什么都要当不可信输入：Infinity / NaN 会进 setBounds，主进程抛出
  // 的异常没人接，会把窗口、托盘、快捷键一起带走。上限也挡住一个撑满屏幕的误报。
  if (!Number.isFinite(w) || !Number.isFinite(h)) return;
  const width = Math.max(80, Math.min(4000, Math.ceil(w)));
  const height = Math.max(80, Math.min(4000, Math.ceil(h)));
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
    const [w, h] = win.getSize();
    // 拖拽也要留一条「够得着」的边：窗口 340×520，拖到屏幕外只剩几个像素时，
    // 既看不见也点不到，重启后还会照原样恢复。至少留 KEEP_VISIBLE 像素在屏内。
    const { workArea } = screen.getDisplayNearestPoint({ x: q.x, y: q.y });
    const nx = dragOrigin.x + q.x - dragOrigin.cx;
    const ny = dragOrigin.y + q.y - dragOrigin.cy;
    win.setPosition(
      Math.round(Math.max(workArea.x - w + KEEP_VISIBLE, Math.min(nx, workArea.x + workArea.width - KEEP_VISIBLE))),
      Math.round(Math.max(workArea.y - h + KEEP_VISIBLE, Math.min(ny, workArea.y + workArea.height - KEEP_VISIBLE)))
    );
  }, 16);
});

ipcMain.on('window:drag-end', () => {
  clearInterval(dragTimer);
  dragTimer = null;
  dragOrigin = null;
});

ipcMain.on('app:quit', () => app.quit());

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
    // 拔掉外接屏 / 改分辨率 / 缩放比例：窗口可能被留在不存在的坐标上。
    for (const ev of ['display-removed', 'display-added', 'display-metrics-changed']) {
      screen.on(ev, () => ensureVisible());
    }
    // 全局快捷键：Ctrl/⌘+Alt+B 一键显示/隐藏机器人。
    // 为什么不是 Ctrl+Shift+B：那是 VS Code / IDEA 的「运行构建任务」，机器人常驻时
    // 会在系统层把它吞掉，用户在编辑器里按一下，构建没跑、桌面角落的机器人却动了一下。
    registerHotkey();
    app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch { /* 忽略 */ } });
    // 退出前把位置防抖里还没落盘的那次写下去。
    app.on('before-quit', () => {
      clearTimeout(saveTimer);
      saveTimer = null;
      savePositionNow();
    });
  });
}
