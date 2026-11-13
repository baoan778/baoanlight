// 纯几何：把尺寸/参数变成 BufferGeometry，不碰场景、不碰灯光、不碰状态。
//
// 从 robot3d.js 里切出来的原因很实际：那个文件将近 3900 行，改一个建模细节
// 要先滚过一千多行纹理生成代码。这里都是「输入数字、输出几何」，可以单独读、
// 单独改，也不需要知道机器人此刻在干什么。

import * as THREE from '../vendor/three.module.js';

const V2 = THREE.Vector2;

// ------------------------------------------------------------------ helpers

export function roundedRectPoints(w, h, r, seg = 10) {
  const x = -w / 2;
  const y = -h / 2;
  const rr = Math.max(0.001, Math.min(r, w / 2, h / 2));
  const pts = [];
  const line = (x0, y0, x1, y1) => {
    for (let i = 0; i < seg; i++) pts.push(new V2(x0 + (x1 - x0) * (i / seg), y0 + (y1 - y0) * (i / seg)));
  };
  const quad = (x0, y0, cx, cy, x1, y1) => {
    for (let i = 0; i < seg; i++) {
      const t = i / seg;
      const u = 1 - t;
      pts.push(new V2(u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1));
    }
  };
  line(x + rr, y, x + w - rr, y);
  quad(x + w - rr, y, x + w, y, x + w, y + rr);
  line(x + w, y + rr, x + w, y + h - rr);
  quad(x + w, y + h - rr, x + w, y + h, x + w - rr, y + h);
  line(x + w - rr, y + h, x + rr, y + h);
  quad(x + rr, y + h, x, y + h, x, y + h - rr);
  line(x, y + h - rr, x, y + rr);
  quad(x, y + rr, x, y, x + rr, y);
  return pts;
}

// 任意凸多边形的圆角轮廓：直线段 + 每个顶点的圆角弧。用于三角形/梯形履带。
export function roundedPolygon(verts, r, seg = 8) {
  const pts = [];
  const n = verts.length;
  const line = (a, b) => { for (let i = 0; i < seg; i++) pts.push(new V2(a[0] + (b[0] - a[0]) * i / seg, a[1] + (b[1] - a[1]) * i / seg)); };
  const quad = (a, c, b) => { for (let i = 0; i < seg; i++) { const t = i / seg; const u = 1 - t; pts.push(new V2(u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1])); } };
  const T = [];
  for (let i = 0; i < n; i++) {
    const prev = verts[(i - 1 + n) % n], cur = verts[i], next = verts[(i + 1) % n];
    const dPrev = Math.hypot(prev[0] - cur[0], prev[1] - cur[1]) || 1;
    const dNext = Math.hypot(next[0] - cur[0], next[1] - cur[1]) || 1;
    const cutPrev = Math.min(r, dPrev / 2), cutNext = Math.min(r, dNext / 2);
    T.push({
      tin: [cur[0] + (prev[0] - cur[0]) / dPrev * cutPrev, cur[1] + (prev[1] - cur[1]) / dPrev * cutPrev],
      tout: [cur[0] + (next[0] - cur[0]) / dNext * cutNext, cur[1] + (next[1] - cur[1]) / dNext * cutNext],
      c: cur,
    });
  }
  for (let i = 0; i < n; i++) {
    const cur = T[i], next = T[(i + 1) % n];
    line(cur.tout, next.tin);
    quad(next.tin, next.c, next.tout);
  }
  return pts;
}

// A slab with rounded corners and a machined chamfer. The chamfer is what
// catches the key light along every edge — without it a yellow box reads as
// a sticker, which is exactly the flat look this replaces.
export function slab(w, h, d, { r = 0.08, bevel = 0.018, holes = [], seg = 8 } = {}) {
  const b = Math.min(bevel, w * 0.24, h * 0.24, d * 0.24);
  const shape = new THREE.Shape(roundedRectPoints(w - 2 * b, h - 2 * b, Math.max(0.002, r - b), seg));
  for (const hole of holes) {
    shape.holes.push(new THREE.Path(
      roundedRectPoints(hole.w, hole.h, hole.r ?? 0.03, seg)
        .map((p) => new V2(p.x + (hole.x || 0), p.y + (hole.y || 0)))
    ));
  }
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.004, d - 2 * b),
    bevelEnabled: b > 0.001,
    bevelSize: b,
    bevelThickness: b,
    bevelSegments: 2,
    curveSegments: seg,
  });
  geo.center();
  return geo;
}

export function mesh(geo, mat, { cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}
