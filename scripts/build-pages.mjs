// 把落地页 demo 需要的渲染代码镜像到 docs/demo/。
//
// 为什么是「复制」而不是「引用」：GitHub Pages 只发布 docs/ 目录，浏览器拿不到
// ../src/ 下的模块。反过来，如果落地页自己再写一份 3D 机器人，它就会慢慢和
// 产品长得不一样 —— 那正是这次要修的问题（页面用 2D SVG 冒充 3D 产品）。
//
// 所以：源码只有一份（src/overlay/），这里是它的**构建产物**。
//   * 每次改完 src/overlay/ 里的渲染代码都要跑一次 `npm run build:pages`；
//   * test/contracts.test.js 会逐字节比对，忘了跑就会红。
//
// 用法：node scripts/build-pages.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'overlay');
const OUT = path.join(ROOT, 'docs', 'demo');

// robot3d.js 的 import 是相对路径，所以目录结构必须原样保留。
const FILES = [
  'robot3d.js',
  'vendor/three.module.js',
  'vendor/three.core.js',
  'scene/geometry.js',
  'scene/surfaces.js',
  'shared/palette.mjs',
];

let total = 0;
for (const rel of FILES) {
  const from = path.join(SRC, rel);
  const to = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  const size = fs.statSync(to).size;
  total += size;
  console.log(`  ${rel.padEnd(28)} ${(size / 1024).toFixed(0)} KB`);
}
console.log(`docs/demo written: ${FILES.length} files, ${(total / 1024 / 1024).toFixed(2)} MB`);
