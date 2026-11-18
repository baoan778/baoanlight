'use strict';
// 桌面便签 / 今日待办。
//
// 它只做一件事：把「今天要做的事」写下来，并且一直放在机器人旁边，直到你勾掉。
// 和状态机完全无关 —— 待办不是「代理在等你」，不能借用红黄绿，也不参与主灯。
//
// 存储：~/.baoanlight/notes.json（原子写）。最近 30 天的已完成会自动清理，
// 未完成的会一直保留 —— 忘了的事正是这个功能存在的理由。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const FILE = path.join(config.DIR, 'notes.json');
const MAX_TEXT = 140;
const MAX_ITEMS = 200;
const KEEP_DONE_DAYS = 30;

function dayKey(now = Date.now()) {
  const d = new Date(now);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

function emptyState() {
  return { items: [] };
}

function read() {
  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw err;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // 坏文件不能静默清空：备份一份，下一次写入会重建。至少给排查留证据。
    try { fs.renameSync(FILE, `${FILE}.bad`); } catch { /* 备份失败也不影响使用 */ }
    return emptyState();
  }
  const items = Array.isArray(data && data.items) ? data.items : [];
  const cleaned = items
    .filter((i) => i && typeof i.id === 'string' && typeof i.text === 'string')
    .map((i) => ({
      id: i.id.slice(0, 40),
      text: cleanText(i.text),
      done: i.done === true,
      pinned: i.pinned === true,
      createdAt: Number(i.createdAt) || Date.now(),
      doneAt: Number(i.doneAt) || 0,
      day: typeof i.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(i.day) ? i.day : dayKey(),
    }))
    .filter((i) => i.text);
  // 读的时候也套用清理规则：完成超过 30 天的条目不该继续算进「今日完成/历史」，
  // 哪怕用户这一个月一次都没写新便签。磁盘上的清理会在下一次 apply 写入时完成。
  return { items: prune(cleaned) };
}

function write(state) {
  config.ensureDir();
  const body = JSON.stringify(state, null, 2);
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  try {
    fs.renameSync(tmp, FILE);
  } catch (err) {
    try { fs.writeFileSync(FILE, body); } catch { /* 真写不进去，交给调用方 */ }
    try { fs.unlinkSync(tmp); } catch { /* 已被 rename */ }
    if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') throw err;
  }
}

function prune(items, now = Date.now()) {
  const cutoff = now - KEEP_DONE_DAYS * 86400000;
  let next = items.filter((i) => !(i.done && (i.doneAt || i.createdAt) < cutoff));
  // 上限按「最不重要」的顺序丢：先丢最早的已完成，再丢最早的未完成。
  if (next.length > MAX_ITEMS) {
    // 从数组头部丢：先丢最早的已完成，再丢最早的未完成；置顶的放在最后，
    // 它们正是用户明确说过「别忘了」的那几条。
    const pinned = next.filter((i) => !i.done && i.pinned);
    const done = next.filter((i) => i.done).sort((a, b) => a.createdAt - b.createdAt);
    const open = next.filter((i) => !i.done && !i.pinned).sort((a, b) => a.createdAt - b.createdAt);
    const keep = new Set([...done, ...open, ...pinned].slice(-MAX_ITEMS).map((i) => i.id));
    next = next.filter((i) => keep.has(i.id));
  }
  return next;
}

function snapshot(state = read()) {
  const day = dayKey();
  const open = state.items.filter((i) => !i.done)
    // 置顶的永远在最上面；同一组内仍按记下的先后排。
    .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (a.createdAt - b.createdAt));
  const done = state.items.filter((i) => i.done)
    .sort((a, b) => (b.doneAt || b.createdAt) - (a.doneAt || a.createdAt));
  return {
    day,
    items: [...open, ...done],
    open: open.length,
    done: done.length,
    // 昨天（更早）记下、到今天还没勾掉的：启动时先说一句，别让它们混在
    // 「今天新记的」里面，看上去像今天的任务。
    olderOpen: open.filter((i) => i.day && i.day < day).length,
    // 「今天完成」看的是完成的时刻，不是创建的那天：昨天记下、今天勾掉的
    // 事情同样是今天的成果。旧数据没有 doneAt（0）时无法判断，宁可不计。
    doneToday: done.filter((i) => i.doneAt && dayKey(i.doneAt) === day).length,
    historyDays: new Set(state.items.map((i) => i.day)).size,
  };
}

// 所有改动都走这里：读 → 改 → 清理 → 原子写 → 返回新快照。
function apply(action = {}) {
  const now = Date.now();
  const state = read();
  const kind = String(action.action || '').toLowerCase();

  if (kind === 'add') {
    const text = cleanText(action.text);
    if (!text) return { error: 'text required' };
    state.items.push({
      id: crypto.randomBytes(8).toString('hex'),
      text,
      done: false,
      pinned: false,
      createdAt: now,
      doneAt: 0,
      day: dayKey(now),
    });
  } else if (kind === 'pin') {
    const item = state.items.find((i) => i.id === String(action.id || ''));
    if (!item) return { error: 'no such item' };
    item.pinned = action.pinned === undefined ? !item.pinned : action.pinned === true;
  } else if (kind === 'restore') {
    // 撤销删除：把刚刚拿走的条目原样放回来（文字、完成状态、置顶、记下的日子）。
    // 只收有限数量的干净条目，不把调用方传进来的对象原样落盘。
    const list = Array.isArray(action.items) ? action.items.slice(0, 100) : [];
    for (const raw of list) {
      const text = cleanText(raw && raw.text);
      if (!text) continue;
      const day = raw && typeof raw.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.day)
        ? raw.day : dayKey(now);
      const done = raw && raw.done === true;
      state.items.push({
        id: crypto.randomBytes(8).toString('hex'),
        text,
        done,
        pinned: !done && raw.pinned === true,
        createdAt: now,
        doneAt: done ? now : 0,
        day,
      });
    }
    if (!list.some((raw) => cleanText(raw && raw.text))) return { error: 'text required' };
  } else if (kind === 'edit') {
    const item = state.items.find((i) => i.id === String(action.id || ''));
    if (!item) return { error: 'no such item' };
    const text = cleanText(action.text);
    if (!text) return { error: 'text required' };
    item.text = text;
  } else if (kind === 'toggle') {
    const item = state.items.find((i) => i.id === String(action.id || ''));
    if (!item) return { error: 'no such item' };
    item.done = action.done === undefined ? !item.done : action.done === true;
    item.doneAt = item.done ? now : 0;
  } else if (kind === 'remove') {
    const id = String(action.id || '');
    const before = state.items.length;
    state.items = state.items.filter((i) => i.id !== id);
    if (state.items.length === before) return { error: 'no such item' };
  } else if (kind === 'cleardone') {
    state.items = state.items.filter((i) => !i.done);
  } else {
    return { error: 'unknown action' };
  }

  state.items = prune(state.items, now);
  write(state);
  return snapshot(state);
}

module.exports = { FILE, MAX_TEXT, read, apply, snapshot, dayKey, cleanText };
