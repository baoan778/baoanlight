// 外观调色板的单一真源守卫。
//
// 这些颜色原本在 ui.js（色块预览）和 robot3d.js（材质上色）各存一份，靠注释
// 「与 robot3d.js 保持一致」维系。只改一边不会让任何测试失败 —— 色块会变成
// 蓝的、机器人还是绿的，而两边各自「自洽」。所以这里直接盯住：
//   * 每个条目字段齐全、颜色合法；
//   * 名字不重复（重复会让下拉框出现两个「黑」）；
//   * 第一项就是出厂默认皮肤（robot3d 的初始材质取 index 0）；
//   * 十六进制值不许在渲染代码里再出现一次；
//   * 槽位顺序与服务端 store.js 完全一致。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SKIN_TONES, EYE_TONES, TRACK_TONES, ARM_TONES, AGENT_SLOTS,
  STATE_PRIORITY, DEFAULT_POSES,
} from '../src/overlay/shared/palette.mjs';
import { AGENT_ORDER, MAX_SLOTS, PRIORITY } from '../src/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const overlayDir = path.join(ROOT, 'src', 'overlay');

const TABLES = [
  { name: 'skins', list: SKIN_TONES, fields: ['hex', 'dark'], defaultName: '钛金白' },
  { name: 'eyes', list: EYE_TONES, fields: ['lens', 'iris'], defaultName: '默认黑' },
  { name: 'tracks', list: TRACK_TONES, fields: ['rubber', 'hi'], defaultName: '黑' },
  { name: 'arms', list: ARM_TONES, fields: ['arm', 'steel', 'dark', 'eye'], defaultName: '枪灰' },
];

for (const table of TABLES) {
  test(`every ${table.name} entry carries a colour the renderer can use`, () => {
    assert.ok(table.list.length > 0, `${table.name} is not empty`);
    for (const entry of table.list) {
      assert.equal(typeof entry.name, 'string');
      assert.ok(entry.name.length > 0, 'a nameless option cannot be picked');
      for (const field of table.fields) {
        assert.match(entry[field], /^#[0-9a-f]{6}$/i,
          `${table.name} "${entry.name}".${field} must be #rrggbb, got ${entry[field]}`);
      }
    }
  });

  test(`${table.name} has no duplicate name`, () => {
    const seen = new Set();
    for (const { name } of table.list) {
      assert.equal(seen.has(name), false, `"${name}" appears twice — the dropdown would lie`);
      seen.add(name);
    }
  });

  // robot3d.js 的初始材质读的是 index 0，等于把「默认外观」编码进了数组顺序。
  test(`${table.name} keeps the factory default first`, () => {
    assert.equal(table.list[0].name, table.defaultName,
      'reordering the palette silently changes what a fresh install looks like');
  });
}

// 服务端的槽位表与界面的默认顺序必须是同一份，否则主灯的同级优先级会跟
// 仪表板从左到右的顺序对不上。
test('the fixed slot order agrees with the server', () => {
  assert.deepEqual(AGENT_SLOTS, AGENT_ORDER,
    'shared/palette.mjs AGENT_SLOTS and store.js AGENT_ORDER must stay identical');
  assert.ok(AGENT_SLOTS.length <= MAX_SLOTS, 'the robot has only so many segments');
});

// 真正防回归的一条：颜色不许在渲染代码里再抄一遍。
test('no colour is hardcoded outside the palette', () => {
  const values = new Set(
    TABLES.flatMap((t) => t.list.flatMap((e) => t.fields.map((f) => e[f].toLowerCase())))
  );
  for (const file of ['ui.js', 'robot3d.js']) {
    const src = fs.readFileSync(path.join(overlayDir, file), 'utf8').toLowerCase();
    for (const hex of values) {
      const at = src.indexOf(hex);
      if (at < 0) continue;
      const line = src.slice(0, at).split('\n').length;
      assert.fail(`${file}:${line} hardcodes ${hex}; import it from shared/palette.mjs instead`);
    }
  }
});

// 优先级表也曾经是三份拷贝（store.js 一份、ui.js 两份）。两份表一旦分叉，
// 机器人会盯着一个不是主灯代表的软件看 —— 而这种错没有任何报错、没有任何
// screenshot 会失败。
test('the state priority table agrees with the server', () => {
  assert.deepEqual(STATE_PRIORITY, PRIORITY,
    'shared/palette.mjs STATE_PRIORITY and store.js PRIORITY must stay identical');
});

// 默认手势同理：设置里显示「垂放」而机器人正在「举手」，是最难查的一类不一致。
test('the default pose per state is the same one the renderer starts with', () => {
  const src = fs.readFileSync(path.join(overlayDir, 'robot3d.js'), 'utf8');
  assert.match(src, /let statePoses = \{ \.\.\.DEFAULT_POSES \}/,
    'robot3d.js must start from shared/palette.mjs DEFAULT_POSES, not its own table');
  assert.deepEqual(Object.keys(DEFAULT_POSES).sort(), ['busy', 'done', 'error', 'idle', 'waiting']);
});
