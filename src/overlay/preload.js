'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 沙箱化的 preload 只能 require('electron')，不能读 ~/.baoanlight/config.json。
// 端口因此由主进程用启动参数递进来（main.js 的 additionalArguments），这样
// 渲染进程拿不到 fs，也拿不到 node 的任何东西。
const PORT_ARG = '--bao-port=';
const found = (process.argv || []).find((a) => a.startsWith(PORT_ARG));
const port = Number(found ? found.slice(PORT_ARG.length) : 0) || 4747;
if (!found) {
  // 静默回落到 4747 会让「主进程实际在别的端口」变成一个查不出来的死循环：
  // 页面每 1.5 秒连一次不存在的地址，界面上只显示「未连接」，谁也不知道原因。
  console.warn('baoanlight: 启动参数里没有 --bao-port，端口回落到 4747');
}

// 光标订阅只保留一个：页面重新加载或二次调用 onCursor 时不能叠加监听，
// 否则同一个光标位置会推到每个回调里，每帧干几遍同样的事。
let cursorCb = null;
let cursorBound = false;

contextBridge.exposeInMainWorld('bao', {
  serverUrl: `http://127.0.0.1:${port}`,
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  hotRect: (rect) => ipcRenderer.send('window:hotrect', rect),
  contentSize: (size) => ipcRenderer.send('window:size', size),
  dragStart: () => ipcRenderer.send('window:drag-start'),
  dragEnd: () => ipcRenderer.send('window:drag-end'),
  // The scene needs the cursor even when the window is click-through, so main
  // pushes it rather than relying on forwarded mouse events.
  onCursor: (cb) => {
    cursorCb = cb;
    if (cursorBound) return;
    cursorBound = true;
    ipcRenderer.on('cursor', (_e, p) => { if (cursorCb) cursorCb(p); });
  },
  offCursor: () => { cursorCb = null; },
  trayStatus: (s) => ipcRenderer.send('tray:status', s),
  notify: (title, body) => ipcRenderer.send('notify:show', { title, body }),
  openTerminal: (cwd) => ipcRenderer.send('shell:open', { cwd }),
  openTeardown: () => ipcRenderer.send('teardown:open'),
  quit: () => ipcRenderer.send('app:quit'),
});
