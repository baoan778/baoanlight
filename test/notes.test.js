'use strict';
// 桌面便签的存储规则：能加、能勾、能删、能持久化，坏输入一律拒绝。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-notes-'));
process.env.BAOANLIGHT_HOME = HOME;

const notes = require('../src/notes');

const reset = () => { try { fs.unlinkSync(notes.FILE); } catch { /* 还没有文件 */ } };

test('a note can be added, completed, removed and read back from disk', () => {
  reset();

  let s = notes.apply({ action: 'add', text: '  写周报  ' });
  assert.equal(s.open, 1);
  assert.equal(s.items[0].text, '写周报', 'whitespace is collapsed');
  const id = s.items[0].id;

  // 落盘：下一次读到的就是这一条（重启不丢）。
  const onDisk = JSON.parse(fs.readFileSync(notes.FILE, 'utf8'));
  assert.equal(onDisk.items.length, 1);
  assert.equal(onDisk.items[0].id, id);

  s = notes.apply({ action: 'toggle', id, done: true });
  assert.equal(s.open, 0);
  assert.equal(s.done, 1);
  assert.equal(s.doneToday, 1);

  s = notes.apply({ action: 'toggle', id, done: false });
  assert.equal(s.open, 1, 'unchecking brings it back');

  s = notes.apply({ action: 'remove', id });
  assert.equal(s.items.length, 0);
});

test('empty text and unknown actions are rejected, not guessed', () => {
  reset();
  assert.match(notes.apply({ action: 'add', text: '   ' }).error, /text required/);
  assert.match(notes.apply({ action: 'nonsense' }).error, /unknown action/);
  assert.match(notes.apply({ action: 'toggle', id: 'nope' }).error, /no such item/);
  assert.match(notes.apply({ action: 'remove', id: 'nope' }).error, /no such item/);
  // 没有写进任何东西
  assert.equal(fs.existsSync(notes.FILE), false);
});

test('a note can be edited in place, and empty edits are rejected', () => {
  reset();
  let s = notes.apply({ action: 'add', text: '写周报' });
  const id = s.items[0].id;

  s = notes.apply({ action: 'edit', id, text: '  写 月报  ' });
  assert.equal(s.items[0].text, '写 月报', 'whitespace is collapsed');
  assert.equal(s.items[0].id, id, 'editing keeps the same item (and its day)');
  assert.match(notes.apply({ action: 'edit', id, text: '   ' }).error, /text required/);
  assert.match(notes.apply({ action: 'edit', id: 'nope', text: 'x' }).error, /no such item/);
});

test('the daily count uses when a task was completed, not when it was written', () => {
  reset();
  fs.mkdirSync(HOME, { recursive: true });
  // 昨天记下的一条：day 是昨天，doneAt 是 0（还没完成）。
  fs.writeFileSync(notes.FILE, JSON.stringify({
    items: [{
      id: 'a1', text: '昨天记的事', done: false, createdAt: Date.now() - 86400000,
      doneAt: 0, day: notes.dayKey(Date.now() - 86400000),
    }],
  }));
  let s = notes.apply({ action: 'toggle', id: 'a1', done: true });
  assert.equal(s.doneToday, 1, 'completed today counts today, even if written yesterday');
  assert.equal(s.historyDays, 1);
});

test('pinned notes sort first, and a deleted note can be restored', () => {
  reset();
  let s = notes.apply({ action: 'add', text: '普通任务' });
  s = notes.apply({ action: 'add', text: '重要任务' });
  const important = s.items.find((i) => i.text === '重要任务').id;

  s = notes.apply({ action: 'pin', id: important, pinned: true });
  assert.equal(s.items[0].text, '重要任务', 'pinned notes come first');
  assert.equal(s.items[0].pinned, true);

  s = notes.apply({ action: 'remove', id: important });
  assert.equal(s.open, 1);
  s = notes.apply({ action: 'restore', items: [{ text: '重要任务', pinned: true, day: s.day }] });
  assert.equal(s.open, 2);
  assert.equal(s.items[0].text, '重要任务');
  assert.equal(s.items[0].pinned, true, 'restoring keeps the pin');
});

test('unfinished notes from earlier days are counted separately', () => {
  reset();
  const today = notes.dayKey();
  const yesterday = notes.dayKey(Date.now() - 86400000);
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(notes.FILE, JSON.stringify({
    items: [
      { id: 'old', text: '昨天没做完', done: false, day: yesterday, createdAt: 1, doneAt: 0 },
      { id: 'new', text: '今天新记的', done: false, day: today, createdAt: 2, doneAt: 0 },
    ],
  }));
  const s = notes.snapshot();
  assert.equal(s.open, 2);
  assert.equal(s.olderOpen, 1);
});

test('a very long note is truncated, and clearDone keeps open items', () => {
  reset();
  const long = '长'.repeat(400);
  let s = notes.apply({ action: 'add', text: long });
  assert.equal(s.items[0].text.length, notes.MAX_TEXT);

  const openId = s.items[0].id;
  notes.apply({ action: 'add', text: '这件事还没做' });
  notes.apply({ action: 'toggle', id: openId, done: true });
  s = notes.apply({ action: 'clearDone' });
  assert.equal(s.done, 0);
  assert.equal(s.open, 1);
  assert.equal(s.items[0].text, '这件事还没做');
});

test('completed notes older than 30 days disappear even before the next write', () => {
  reset();
  const old = Date.now() - 31 * 86400000;
  fs.writeFileSync(notes.FILE, JSON.stringify({
    items: [
      { id: 'old', text: '上个月完成的', done: true, pinned: false, createdAt: old, doneAt: old, day: notes.dayKey(old) },
      { id: 'open', text: '还没做完', done: false, pinned: false, createdAt: old, doneAt: 0, day: notes.dayKey(old) },
    ],
  }), 'utf8');

  const s = notes.snapshot();
  assert.equal(s.done, 0, 'the expired completed item is not counted or shown');
  assert.equal(s.open, 1, 'an unfinished item never expires');

  notes.apply({ action: 'add', text: '新的一条' });
  const disk = JSON.parse(fs.readFileSync(notes.FILE, 'utf8'));
  assert.ok(!disk.items.some((i) => i.id === 'old'), 'the next write removes it from disk');
  assert.ok(disk.items.some((i) => i.id === 'open'), 'the unfinished item is kept');
});

test('a corrupted file is moved aside instead of crashing', () => {
  reset();
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(notes.FILE, '{ not json');
  const s = notes.snapshot();
  assert.equal(s.open, 0);
  assert.equal(fs.existsSync(`${notes.FILE}.bad`), true);
});
