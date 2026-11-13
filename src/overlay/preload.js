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

// 光标订阅可以有多个：界面（悬停工具栏）和 3D 场景（眼睛跟随）是两个独立的
// 消费者，它们都要读同一个坐标。曾经这里只留一个回调槽，后注册的 robot3d.js
// 直接把 ui.js 的回调覆盖掉 —— 工具栏从此拿不到光标，`body.hovering` 永远是
// false，折叠/切尺寸/退出按钮在点击穿透下完全点不到。
// IPC 监听仍然只挂一次，只是把每个坐标分发给集合里的所有回调。
const cursorSubs = new Set();
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
    if (typeof cb !== 'function') return () => {};
    cursorSubs.add(cb);
    if (!cursorBound) {
      cursorBound = true;
      ipcRenderer.on('cursor', (_e, p) => {
        for (const fn of cursorSubs) {
          try { fn(p); } catch { /* 一个消费者出错不能拖累另一个 */ }
        }
      });
    }
    // 返回退订函数：页面销毁/重建时可以只摘掉自己那一个。
    return () => cursorSubs.delete(cb);
  },
  trayStatus: (s) => ipcRenderer.send('tray:status', s),
  notify: (title, body) => ipcRenderer.send('notify:show', { title, body }),
  openTerminal: (cwd) => ipcRenderer.send('shell:open', { cwd }),
  quit: () => ipcRenderer.send('app:quit'),
});
