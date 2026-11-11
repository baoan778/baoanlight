'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const config = require('../config');

contextBridge.exposeInMainWorld('bao', {
  serverUrl: `http://127.0.0.1:${config.port()}`,
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  hotRect: (rect) => ipcRenderer.send('window:hotrect', rect),
  contentSize: (size) => ipcRenderer.send('window:size', size),
  dragStart: () => ipcRenderer.send('window:drag-start'),
  dragEnd: () => ipcRenderer.send('window:drag-end'),
  // The scene needs the cursor even when the window is click-through, so main
  // pushes it rather than relying on forwarded mouse events.
  onCursor: (cb) => ipcRenderer.on('cursor', (_e, p) => cb(p)),
  onRoam: (cb) => ipcRenderer.on('roam', (_e, p) => cb(p)),
  setRoamAllowed: (on) => ipcRenderer.send('roam:set', on),
  trayStatus: (s) => ipcRenderer.send('tray:status', s),
  notify: (title, body) => ipcRenderer.send('notify:show', { title, body }),
  openTerminal: (cwd) => ipcRenderer.send('shell:open', { cwd }),
  quit: () => ipcRenderer.send('app:quit'),
});
