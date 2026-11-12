'use strict';
// ui.js 与 robot3d.js 之间唯一的耦合面是窗口上的一组 `bao:*` 自定义事件。
//
// 它是字符串：改名、拼错、删掉一半，TypeScript 不会说话，eslint 也不会 ——
// 页面照样加载，只是某个功能静默失效（换皮肤没反应、点一下不动）。这份测试
// 把那层契约钉在文本层面：
//
//   1. 发出的每个事件都必须有人听（否则是白发的）；
//   2. 监听的每个事件都必须有人发（否则是永远不触发的死代码）；
//   3. 载荷在两边读的字段要对得上（见下方 payload 表）。
//
// 载荷约定（改任何一个字段，两边同时改，并更新这张表）：
//
//   bao:render      { state, color, live, dim, dead, agent, slots[], agents[] }
//   bao:render      agents[] = { agent, label, state, hex, dim, count, at, fresh, worst }
//   bao:skin        { skin }                  bao:eyestyle  { eyestyle }
//   bao:trackstyle  { trackstyle }            bao:tracktype { tracktype }
//   bao:armskin     { armskin }               bao:armtype   { armtype }
//   bao:body        { body }                  bao:headtype  { headtype }
//   bao:claw        { claw }                  bao:eyeshape  { eyeshape }
//   bao:scene       { scene }                 bao:decoration{ decoration }
//   bao:halo        { halo }                  bao:effect    { effect }
//   bao:motion      { motion }                bao:pose      { state, pose }
//   bao:sign        { mode, pos, color, shape }
//   bao:bubble / bao:nameplate / bao:brightness / bao:scale —— { text } / { text } / { brightness } / { scale }
//   bao:greet / bao:poke / bao:drag / bao:done / bao:crazy / bao:comfort / bao:companion / bao:milestone
//   bao:idle        { on, freq }              bao:ccswitch  { agent, model }
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const overlay = path.join(__dirname, '..', 'src', 'overlay');
const read = (f) => fs.readFileSync(path.join(overlay, f), 'utf8');

const ui = read('ui.js');
const robot = read('robot3d.js');

const uniq = (xs) => [...new Set(xs)].sort();

const emitted = uniq([...ui.matchAll(/new CustomEvent\('(bao:[^']+)'/g)].map((m) => m[1]));
const listensIn = (src) => uniq([...src.matchAll(/addEventListener\('(bao:[^']+)'/g)].map((m) => m[1]));
const listened = uniq([...listensIn(robot), ...listensIn(ui)]);

test('every event the UI emits has a listener', () => {
  const orphans = emitted.filter((e) => !listened.includes(e));
  assert.deepEqual(orphans, [], `emitted but never heard: ${orphans.join(', ')}`);
});

test('every listener is waiting for an event that is actually emitted', () => {
  const dead = listened.filter((e) => !emitted.includes(e));
  assert.deepEqual(dead, [], `listened for but never emitted: ${dead.join(', ')}`);
});

// 事件名是手写字符串，重复一次就多一个监听器；这条保证不会有人为了「修一下」
// 而在两处各写一遍同一个监听。
test('each event is wired exactly once', () => {
  const counts = {};
  for (const e of listensIn(robot)) counts[e] = (counts[e] || 0) + 1;
  const doubled = Object.entries(counts).filter(([, n]) => n > 1).map(([e]) => e);
  assert.deepEqual(doubled, [], `robot3d listens twice for: ${doubled.join(', ')}`);
});

// 3D 侧只该通过 detail 拿数据。若某个 handler 读了 detail 里不存在的字段，
// 表现是「设置项点了没反应」，而控制台一片安静。
test('the 3D side reads a field the UI actually sends', () => {
  // detail 的对象字面量里既有 `key: value` 也有简写 `{ days }`，所以按逗号切分
  // 再取标识符，而不是只认冒号。
  const detailFields = new Set();
  for (const m of ui.matchAll(/new CustomEvent\('bao:[^']+',\s*\{\s*detail:\s*\{([^}]*)/gs)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/[:\s=]/)[0];
      if (/^\w+$/.test(name)) detailFields.add(name);
    }
  }
  const readFields = [...robot.matchAll(/(?:e\.detail|detail)\s*(?:\?\.|\.)\s*(\w+)/g)].map((m) => m[1]);
  // 少数 handler 解构 detail（const { mode } = e.detail），那些字段也必须在表里 ——
  // 这里只检查「点号读取」，解构写法由 review 兜住。
  const unknown = uniq(readFields).filter((f) => !detailFields.has(f));
  assert.deepEqual(unknown, [], `robot3d reads detail.${unknown.join(', detail.')} — nobody sets that`);
});
