// The desktop robot is a real 3D model, not a drawing.
//
// Everything here is built from primitives at load time — no .glb to download,
// no binary to ship, and the silhouette can be re-proportioned by editing
// numbers. The rules the flat SVG used to encode are all still honoured:
// the body stays yellow in every state, the three state colours only ever mean
// agent state, and the lamp is the same colour as the DOM mirror so the 3D
// scene can never invent a state of its own.
//
// Cost: ~120 draw calls at 30–60fps in a 300×291 transparent window. That is
// affordable, but it is not free, so the loop slows down for states that do
// not move much and stops entirely when the window is hidden.

import * as THREE from './vendor/three.module.js';

const body = document.body;
const host = document.getElementById('bot');

const V2 = THREE.Vector2;

// ------------------------------------------------------------------ helpers

function roundedRectPoints(w, h, r, seg = 10) {
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
function roundedPolygon(verts, r, seg = 8) {
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
function slab(w, h, d, { r = 0.08, bevel = 0.018, holes = [], seg = 8 } = {}) {
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

function mesh(geo, mat, { cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}

// A canvas is the cheapest way to get crisp print on a machined panel: stripes,
// the dot-matrix wordmark, the engraved agent name, the "!" bubble.
function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// 场景地表纹理：程序化生成的噪声/颗粒/波纹，让地面读作真实地表而不是纯色。
function sceneTexture(type) {
  const seedMap = { 雪地: 11, 草原: 22, 沙漠: 33, 星空: 44, 岩浆: 55, 樱花: 66, 海洋: 77, 森林: 88, 雨夜: 99, 工厂: 111, 雪夜: 123 };
  return canvasTexture(512, 512, (g, w, h) => {
    const r = rng(seedMap[type] || 1);
    const blob = (x, y, rad, rgb, a) => {
      const grad = g.createRadialGradient(x, y, 0, x, y, rad);
      grad.addColorStop(0, `rgba(${rgb},${a})`);
      grad.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = grad; g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
    };
    const speck = (rgb, a, n, s = 2) => { for (let i = 0; i < n; i++) { g.fillStyle = `rgba(${rgb},${a()})`; g.fillRect(r() * w, r() * h, s * r() + 0.6, s * r() + 0.6); } };
    const blade = (rgb) => { g.strokeStyle = rgb; g.beginPath(); const x = r() * w, y = r() * h; g.moveTo(x, y); g.lineTo(x + 1, y - 4 - r() * 7); g.stroke(); };
    if (type === '雪地') {
      g.fillStyle = '#e6edf4'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 70; i++) blob(r() * w, r() * h, 10 + r() * 42, '185,208,230', 0.15 + r() * 0.25);
      speck('255,255,255', () => 0.2 + r() * 0.4, 320);
    } else if (type === '草原') {
      g.fillStyle = '#5c873b'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 90; i++) blob(r() * w, r() * h, 9 + r() * 32, '70,110,40', 0.2 + r() * 0.3);
      for (let i = 0; i < 460; i++) blade(`rgba(${40 + r() * 25},${82 + r() * 30},${28 + r() * 15},${0.3 + r() * 0.4})`);
      speck(`${180 + r() * 70},${200 + r() * 45},70`, () => 0.5 + r() * 0.4, 26, 2.5);
    } else if (type === '沙漠') {
      g.fillStyle = '#c9a562'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 90; i++) blob(r() * w, r() * h, 12 + r() * 42, '178,148,88', 0.2 + r() * 0.3);
      speck('150,120,70', () => 0.15 + r() * 0.2, 140);
    } else if (type === '星空') {
      g.fillStyle = '#14162a'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 60; i++) blob(r() * w, r() * h, 12 + r() * 42, '42,52,96', 0.3 + r() * 0.4);
      speck('255,255,255', () => 0.3 + r() * 0.7, 180);
    } else if (type === '岩浆') {
      g.fillStyle = '#1a0e0a'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 50; i++) { g.strokeStyle = `rgba(255,${80 + r() * 90},20,${0.5 + r() * 0.5})`; g.beginPath(); let x = r() * w, y = r() * h; g.moveTo(x, y); for (let j = 0; j < 4; j++) { x += r() * 22 - 11; y += r() * 22 - 11; g.lineTo(x, y); } g.stroke(); }
      for (let i = 0; i < 46; i++) blob(r() * w, r() * h, 8 + r() * 26, '255,120,30', 0.3 + r() * 0.4);
    } else if (type === '樱花') {
      g.fillStyle = '#f0dcd8'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 90; i++) blob(r() * w, r() * h, 8 + r() * 30, '240,190,205', 0.3 + r() * 0.4);
      speck(`${228 + r() * 22},${170 + r() * 22},${192 + r() * 22}`, () => 0.4 + r() * 0.4, 140, 3);
    } else if (type === '海洋') {
      g.fillStyle = '#1a4a6a'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 90; i++) blob(r() * w, r() * h, 10 + r() * 36, '30,90,140', 0.3 + r() * 0.4);
      speck('200,240,255', () => 0.2 + r() * 0.4, 110);
    } else if (type === '森林') {
      g.fillStyle = '#2c4a24'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 90; i++) blob(r() * w, r() * h, 10 + r() * 36, '40,70,30', 0.3 + r() * 0.4);
      for (let i = 0; i < 240; i++) { g.fillStyle = `rgba(${22 + r() * 16},${50 + r() * 22},${20 + r() * 10},${0.3 + r() * 0.4})`; g.fillRect(r() * w, r() * h, 2, 3 + r() * 5); }
    } else if (type === '雨夜') {
      // 湿漉漉的深色路面：蓝灰底 + 反光水渍，雨夜里地面会映出周围的亮光。
      g.fillStyle = '#1c2530'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 90; i++) blob(r() * w, r() * h, 10 + r() * 36, '30,44,60', 0.3 + r() * 0.4);
      speck('150,180,210', () => 0.15 + r() * 0.3, 120, 2.5);
    } else if (type === '雪夜') {
      // 雪夜：深蓝黑的地面 + 一层薄雪，月光下泛着冷白，和白天雪地不同。
      g.fillStyle = '#1a2230'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 70; i++) blob(r() * w, r() * h, 12 + r() * 40, '38,50,70', 0.3 + r() * 0.4);
      speck('225,235,248', () => 0.35 + r() * 0.5, 260, 2.4);
      for (let i = 0; i < 24; i++) blob(r() * w, r() * h, 8 + r() * 22, '210,225,245', 0.15 + r() * 0.2);
    } else if (type === '工厂') {
      // 车间钢板地面：深灰底 + 钢板拼缝 + 铆钉点，像真正的车间地坪。
      g.fillStyle = '#2e3238'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 70; i++) blob(r() * w, r() * h, 10 + r() * 34, '38,42,48', 0.3 + r() * 0.4);
      g.strokeStyle = 'rgba(20,22,26,.8)'; g.lineWidth = 3;
      for (let i = 0; i < 6; i++) { g.beginPath(); g.moveTo(0, (i / 6) * h); g.lineTo(w, (i / 6) * h); g.stroke(); }
      for (let i = 0; i < 8; i++) { g.beginPath(); g.moveTo((i / 8) * w, 0); g.lineTo((i / 8) * w, h); g.stroke(); }
      speck('90,96,104', () => 0.4 + r() * 0.4, 240, 2.2);
    }
  });
}

// 场景地面的边缘羽化：中心实、边缘虚，让圆盘地表融入桌面而不是硬边一块。
function edgeFadeTexture(size = 256) {
  return canvasTexture(size, size, (g, w, h) => {
    const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.72, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  });
}

function hazardTexture() {
  return canvasTexture(256, 56, (g, w, h) => {
    g.fillStyle = '#eef1f5';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#191c20';
    for (let x = -h; x < w + h; x += 44) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x + 22, 0);
      g.lineTo(x + 22 + h, h);
      g.lineTo(x + h, h);
      g.closePath();
      g.fill();
    }
  });
}

function softTexture(size = 128, stops = [[0, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]) {
  return canvasTexture(size, size, (g) => {
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [at, colour] of stops) grad.addColorStop(at, colour);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  });
}

// 5×7 dot matrix, drawn not imported — the wordmark is ours, and a bitmap
// font is the one typeface that survives being 8mm wide on a toy robot.
const DOT = {
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  N: ['10001', '11001', '11001', '10101', '10011', '10011', '10001'],
};

function wordmarkTexture() {
  return canvasTexture(512, 128, (g, w, h) => {
    const cell = 13;
    const gap = 13;
    const word = 'BAOAN';
    let x = 14;
    g.fillStyle = '#15181c';
    for (const ch of word) {
      const rows = DOT[ch];
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 5; c++) {
          if (rows[r][c] === '1') g.fillRect(x + c * cell, 22 + r * cell, cell - 2, cell - 2);
        }
      }
      x += 5 * cell + gap;
    }
    // the badge: a hexagon bolt, our mark, not anybody else's character
    const cx = x + 44;
    const cy = 64;
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 6;
      const px = cx + Math.cos(a) * 30;
      const py = cy + Math.sin(a) * 30;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath();
    g.fillStyle = '#f0c11a';
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = '#15181c';
    g.stroke();
    g.fillStyle = '#15181c';
    g.font = 'bold 30px monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('B', cx, cy + 1);
  });
}

function bubbleTexture() {
  return canvasTexture(128, 128, (g) => {
    g.beginPath();
    g.arc(64, 64, 52, 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();
    g.lineWidth = 10;
    g.strokeStyle = 'rgba(12,15,19,.85)';
    g.stroke();
    g.fillStyle = '#12151a';
    g.font = 'bold 76px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('!', 64, 62);
  });
}

// ------------------------------------------------------------------ materials

// A seeded PRNG, so the weathering lands in the same place on every launch:
// rust that rearranges itself between frames is a rendering bug, not a paint
// job.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Seven hundred years of sun, dust and rain, painted into one 256px canvas:
// a dusty base, dirt blotches, rust blooming up out of the seams, streaks
// running down, and a few chips of bare metal. Flat, saturated yellow is what
// made the old robot read as a toy; the shape was never the whole problem.
function weatherTexture(base, { seed = 1, amount = 1 } = {}) {
  return canvasTexture(256, 256, (g, w, h) => {
    const r = rng(seed);
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);

    const blob = (x, y, rad, rgb, a) => {
      const grad = g.createRadialGradient(x, y, 0, x, y, rad);
      grad.addColorStop(0, `rgba(${rgb},${a})`);
      grad.addColorStop(0.55, `rgba(${rgb},${a * 0.5})`);
      grad.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, rad, 0, Math.PI * 2);
      g.fill();
    };

    // grime
    for (let i = 0; i < 26; i++) {
      blob(r() * w, r() * h, 10 + r() * 46, '58,42,22', (0.05 + r() * 0.12) * amount);
    }
    // rust, biased low: that is where water sits
    for (let i = 0; i < 16; i++) {
      blob(r() * w, h * (0.4 + r() * 0.58), 4 + r() * 12, '124,62,30', (0.22 + r() * 0.32) * amount);
    }
    // streaks
    for (let i = 0; i < 12; i++) {
      const x = r() * w;
      const y = r() * h * 0.55;
      const len = 24 + r() * 70;
      const grad = g.createLinearGradient(0, y, 0, y + len);
      grad.addColorStop(0, `rgba(86,56,26,${0.14 * amount})`);
      grad.addColorStop(1, 'rgba(86,56,26,0)');
      g.fillStyle = grad;
      g.fillRect(x, y, 1.5 + r() * 2.5, len);
    }
    // chips of bare metal
    for (let i = 0; i < 20; i++) {
      g.fillStyle = `rgba(204,194,174,${(0.08 + r() * 0.14) * amount})`;
      g.fillRect(r() * w, r() * h, 1 + r() * 3, 1 + r() * 1.4);
    }
  });
}

function paint(base, { seed = 1, amount = 1, repeat = [1, 1] } = {}) {
  const tex = weatherTexture(base, { seed, amount });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  return tex;
}

// The palette is the character: dusty ochre paint over gunmetal, rust where the
// paint has worn through, and not one mirror-bright surface anywhere. Chrome
// reads as "new toy"; WALL·E is a machine that has been outside for 700 years.
const M = {
  yellow: new THREE.MeshStandardMaterial({ map: paint('#c9a238', { seed: 3, repeat: [0.55, 0.72] }), metalness: 0.14, roughness: 0.66 }),
  yellowDark: new THREE.MeshStandardMaterial({ map: paint('#9a7923', { seed: 5, amount: 1.2, repeat: [0.8, 0.8] }), metalness: 0.16, roughness: 0.7 }),
  metal: new THREE.MeshStandardMaterial({ map: paint('#77736a', { seed: 7, amount: 0.7, repeat: [0.9, 0.9] }), metalness: 0.6, roughness: 0.56 }),
  metalDark: new THREE.MeshStandardMaterial({ color: 0x4b4842, metalness: 0.65, roughness: 0.58 }),
  steel: new THREE.MeshStandardMaterial({ map: paint('#8b8779', { seed: 11, amount: 0.55, repeat: [1.6, 1.6] }), metalness: 0.74, roughness: 0.44 }),
  // the arms have to read against black rubber at 300px, so they are the one
  // bright surface left on the machine — worn aluminium, not chrome
  arm: new THREE.MeshStandardMaterial({ map: paint('#97958a', { seed: 23, amount: 0.6, repeat: [1.4, 1.4] }), metalness: 0.5, roughness: 0.46 }),
  rust: new THREE.MeshStandardMaterial({ map: paint('#8a4a28', { seed: 13, amount: 0.8, repeat: [2, 2] }), metalness: 0.32, roughness: 0.8 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x2b2b28, metalness: 0.5, roughness: 0.62 }),
  black: new THREE.MeshStandardMaterial({ color: 0x141412, metalness: 0.4, roughness: 0.58 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x1a1a18, metalness: 0.05, roughness: 0.95 }),
  rubberIn: new THREE.MeshStandardMaterial({ color: 0x121211, metalness: 0.02, roughness: 1.0 }),
  rubberHi: new THREE.MeshStandardMaterial({ color: 0x3a3833, metalness: 0.22, roughness: 0.86 }),
  wheel: new THREE.MeshStandardMaterial({ map: paint('#7a4530', { seed: 17, amount: 0.9, repeat: [2, 2] }), metalness: 0.45, roughness: 0.62 }),
  wheelDark: new THREE.MeshStandardMaterial({ color: 0x45271b, metalness: 0.5, roughness: 0.66 }),
  // binocular glass, not ping-pong balls: near-black, glossy, with a catchlight
  lens: new THREE.MeshPhysicalMaterial({ color: 0x131c23, metalness: 0.1, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.03 }),
  eyeBody: new THREE.MeshStandardMaterial({ map: paint('#5c594f', { seed: 19, amount: 0.5, repeat: [1.6, 1.6] }), metalness: 0.7, roughness: 0.45 }),
  // 只有 irisInner 真的被装到镜片里（M.iris 曾经是个没有挂到任何几何上的死材质）。
  irisInner: new THREE.MeshStandardMaterial({ color: 0x1b242c, metalness: 0.45, roughness: 0.32 }),
  panel: new THREE.MeshStandardMaterial({ color: 0x17171a, metalness: 0.6, roughness: 0.6 }),
  glow: new THREE.MeshStandardMaterial({ color: 0x0c0e11, emissive: 0x34c759, emissiveIntensity: 1.6, roughness: 0.4 }),
};

// ---- 皮肤系统：身体主色 + 暗色（门板/下板）可换，做旧纹理保留 --------------
const SKINS = {
  '做旧黄': { main: '#c9a238', dark: '#9a7923' },
  '军绿': { main: '#7d8a4a', dark: '#5a6635' },
  '铁锈橙': { main: '#c2773e', dark: '#8f5628' },
  '深海蓝': { main: '#5a7d9a', dark: '#3f5c72' },
  '岩灰': { main: '#9a968c', dark: '#6e6a60' },
  '暗红': { main: '#a05048', dark: '#743a34' },
  '金属银': { main: '#b9c2cd', dark: '#8a929c' },
  '碳纤黑': { main: '#3a3d42', dark: '#24262a' },
  '森林绿': { main: '#4a6a3a', dark: '#334a28' },
  '日落橙': { main: '#d8823a', dark: '#a85a20' },
  '樱花粉': { main: '#d98aa8', dark: '#a85e7a' },
};
function applySkin(name) {
  const s = SKINS[name] || SKINS['做旧黄'];
  // 旧贴图要显式释放：换皮肤会重新生成两张纹理，不释放的话来回切换会一直吃显存。
  const oldMain = M.yellow.map;
  const oldDark = M.yellowDark.map;
  M.yellow.map = paint(s.main, { seed: 3, repeat: [0.55, 0.72] });
  M.yellow.needsUpdate = true;
  M.yellowDark.map = paint(s.dark, { seed: 5, amount: 1.2, repeat: [0.8, 0.8] });
  M.yellowDark.needsUpdate = true;
  if (oldMain && oldMain !== M.yellow.map) oldMain.dispose();
  if (oldDark && oldDark !== M.yellowDark.map) oldDark.dispose();
}

// ---- 眼睛配色：镜片 + 虹膜换色（表情的核心颜色） --------------------------
const EYE_STYLES = {
  '默认黑': { lens: 0x131c23, iris: 0x1b242c },
  '蓝瞳': { lens: 0x0c1a2e, iris: 0x1e3a5f },
  '绿瞳': { lens: 0x0c1e14, iris: 0x1e4a30 },
  '金瞳': { lens: 0x1e1408, iris: 0x4a3a10 },
  '紫瞳': { lens: 0x1a0c2e, iris: 0x3a1a5f },
  '红瞳': { lens: 0x2e0c0c, iris: 0x5f1a1a },
  '橙瞳': { lens: 0x2e1a0c, iris: 0x5f3a1a },
  '青瞳': { lens: 0x0c2a2a, iris: 0x1a5a5a },
};
function applyEyeStyle(name) {
  const s = EYE_STYLES[name] || EYE_STYLES['默认黑'];
  // 镜片本身接近黑玻璃，换色几乎看不出来；真正被看见的是镜片里那圈虹膜，
  // 所以两者一起改，瞳色才真的「换色」而不是只换了一层反光。
  M.lens.color.set(s.lens);
  M.irisInner.color.set(s.iris);
}

// ---- 履带配色：橡胶 + 履带齿高光换色 --------------------------------------
const TRACK_SKINS = {
  '黑': { rubber: 0x1a1a18, hi: 0x3a3833 },
  '深棕': { rubber: 0x2a1c14, hi: 0x4a3428 },
  '岩灰': { rubber: 0x2a2a28, hi: 0x4a4a46 },
  '军绿': { rubber: 0x1c2418, hi: 0x38442e },
  '深蓝': { rubber: 0x141a24, hi: 0x283848 },
  '暗红': { rubber: 0x240c0c, hi: 0x48201a },
  '墨绿': { rubber: 0x141c14, hi: 0x2a3a26 },
};
function applyTrackSkin(name) {
  const s = TRACK_SKINS[name] || TRACK_SKINS['黑'];
  M.rubber.color.set(s.rubber);
  M.rubberHi.color.set(s.hi);
}

// ---- 配件配色：手臂金属 / 手爪 / 头镜筒一起换色 ----------------------------
const ARM_SKINS = {
  '枪灰': { arm: '#97958a', steel: '#8b8779', dark: '#2b2b28', eye: '#5c594f' },
  '银白': { arm: '#c4c1b6', steel: '#d6d2c6', dark: '#4a4a46', eye: '#9a9a94' },
  '金色': { arm: '#b89a55', steel: '#c9ad6e', dark: '#5a4526', eye: '#8a7438' },
  '暗黑': { arm: '#4a4a46', steel: '#5f5f5a', dark: '#1f1f1c', eye: '#3a3a36' },
  '铜色': { arm: '#b0764a', steel: '#c0895e', dark: '#4a3526', eye: '#7a5a3a' },
  '青铜': { arm: '#8a6a3a', steel: '#a07e48', dark: '#3a2a18', eye: '#6a5030' },
  '枪铁': { arm: '#5a5f66', steel: '#6e737a', dark: '#22252a', eye: '#454a52' },
  '香槟金': { arm: '#c9b48a', steel: '#ddcba0', dark: '#6a5a3a', eye: '#a08a60' },
};
function applyArmSkin(name) {
  const s = ARM_SKINS[name] || ARM_SKINS['枪灰'];
  M.arm.color.set(s.arm);
  M.steel.color.set(s.steel);
  M.dark.color.set(s.dark);
  M.eyeBody.color.set(s.eye);
}

// ---- 手爪形状：手指数量/粗细可切换，切换时重建手臂 ------------------------
const CLAW_TYPES = {
  '铲形': { fingers: [[-0.050, -1], [0.050, 1]], w: 0.048 },
  '三指': { fingers: [[-0.060, -1], [0, 1], [0.060, 1]], w: 0.042 },
  '钳形': { fingers: [[-0.055, -1], [0.055, 1]], w: 0.062 },
  '四指': { fingers: [[-0.072, -1], [-0.024, 1], [0.024, -1], [0.072, 1]], w: 0.032 },
  '五指': { fingers: [[-0.080, -1], [-0.040, 1], [0, -1], [0.040, 1], [0.080, -1]], w: 0.026 },
};
let clawType = '铲形';

// ---- 胳膊形状：上臂造型可切换，切换时重建手臂 ------------------------------
const ARM_TYPES = { '双板': 'plate', '圆筒': 'cylinder', '桁架': 'truss' };
let armType = '双板';

// ---- 履带形状：轮廓可切换（圆角矩形 / 三角形 / 梯形），切换时重建履带 ------
const TRACK_TYPES = { '圆角矩形': 'rect', '三角形': 'tri', '梯形': 'trap' };
let trackType = '圆角矩形';

// ---- 场景：机器人脚下的「立足之地」与氛围粒子 ------------------------------
const SCENES = {
  '无': { texture: null, props: null, particle: null, fog: null },
  '雪地': { texture: '雪地', props: '松树', particle: 'snow', fog: 0xd8e2ec },
  '草原': { texture: '草原', props: '草丛花', particle: 'grass', fog: 0x6a8a4a },
  '沙漠': { texture: '沙漠', props: '仙人掌', particle: 'sand', fog: 0xc9a562 },
  '星空': { texture: '星空', props: '月亮', particle: 'star', fog: 0x14162a },
  '岩浆': { texture: '岩浆', props: '火山岩', particle: 'ember', fog: 0x1a0e0a },
  '樱花': { texture: '樱花', props: '樱花树', particle: 'petal', fog: 0xf0dcd8 },
  '海洋': { texture: '海洋', props: '珊瑚', particle: 'bubble', fog: 0x1a4a6a },
  '森林': { texture: '森林', props: '树', particle: 'firefly', fog: 0x2c4a24 },
  '雨夜': { texture: '雨夜', props: '水洼', particle: 'rain', fog: 0x1c2530 },
  '工厂': { texture: '工厂', props: '货箱', particle: 'ember', fog: 0x2a2e34 },
  '雪夜': { texture: '雪夜', props: '松树', particle: 'snow', fog: 0x1c2434 },
};
let sceneType = '无';

// ---- 头形状：双筒（默认）/ 单眼（中央大眼）/ 三眼（双目 + 额前传感器）------
// 每只眼：side 镜像方向（转动/眉形）、x/y 位置、scale 大小。
const HEAD_TYPES = {
  '双筒': { eyes: [{ side: -1, x: -0.285, y: 0.13, scale: 1 }, { side: 1, x: 0.285, y: 0.13, scale: 1 }] },
  '单眼': { eyes: [{ side: 0, x: 0, y: 0.13, scale: 1.45 }] },
  // 三眼：不是并排三只虫眼，而是正常的双目 + 额前一只小传感器眼，像多了一只「扫描眼」。
  '三眼': {
    eyes: [
      { side: -1, x: -0.285, y: 0.13, scale: 1 },
      { side: 1, x: 0.285, y: 0.13, scale: 1 },
      { side: 0, x: 0, y: 0.56, scale: 0.5 },
    ],
  },
};
let headType = '双筒';

// ---- 眼睛形状：镜筒截面（圆 / 方 / 六边形 / 三角），切换时重建眼睛 ----------
const EYE_SHAPES = { '圆': 'round', '方': 'square', '六边形': 'hex', '三角': 'tri' };
let eyeShape = '圆';

// ---- 动效强度：省电 / 标准 / 华丽，缩放动作幅度与粒子强度 ------------------
const MOTION_LEVELS = { '省电': 0.6, '标准': 1.0, '华丽': 1.3 };
let motionLevel = '标准';

// ---- 体型：Q版（矮胖）/ 标准 / 修长（瘦高），整体非均匀缩放 ----------------
const BODY_TYPES = {
  'Q版': { x: 1.14, y: 0.86, z: 1.14 },
  '标准': { x: 1.0, y: 1.0, z: 1.0 },
  '修长': { x: 0.9, y: 1.15, z: 0.9 },
};
let bodyType = '标准';

// ---- 手势库：每个状态可配置一种手势（动作系统核心） ------------------------
// z/x/bend/curl 是基值，fx 是特效（tremble 颤抖 / pump 泵动 / wave 挥手 / none）。
const ARM_POSES = {
  '环抱': { z: -0.30, x: -0.40, bend: 0.14, curl: 0.45, fx: 'tremble' },
  '举手': { z: 0.52, x: -0.20, bend: 0.30, curl: -0.32, fx: 'wave' },
  '泵动': { z: 0.03, x: -0.30, bend: 0.14, curl: 0.18, fx: 'pump' },
  '摊开': { z: 0.14, x: -0.10, bend: 0.14, curl: 0.10, fx: 'none' },
  '垂放': { z: 0.02, x: 0.00, bend: 0.14, curl: 0.04, fx: 'none' },
  '叉腰': { z: 0.20, x: -0.25, bend: 0.90, curl: 0.30, fx: 'none' },
  '鼓掌': { z: 0.00, x: -0.35, bend: 0.80, curl: 0.00, fx: 'pump' },
  '托下巴': { z: 0.35, x: -0.48, bend: 1.10, curl: -0.20, fx: 'none' },
  '握拳': { z: -0.20, x: -0.30, bend: 0.14, curl: 0.45, fx: 'tremble' },
};
const POSE_NAMES = Object.keys(ARM_POSES);
// 五个状态各配一种手势（用户可改，存 config）。
const STATE_KEYS = ['error', 'waiting', 'busy', 'done', 'idle'];
let statePoses = { error: '环抱', waiting: '举手', busy: '泵动', done: '摊开', idle: '垂放' };

// 空闲时的自主小动作。编号 → 这段动作演多久（秒）：
//   1 张望  2 伸懒腰  3 抛接小球  4 抖擞  5 看自己的手爪  6 转身巡视  7 点头致意
const IDLE_ACTIONS = [1, 2, 3, 4, 5, 6, 7];
const IDLE_DURATION = { 1: 3.4, 2: 3.2, 3: 3.2, 4: 2.4, 5: 3.6, 6: 4.4, 7: 2.8 };

// ------------------------------------------------------------------ the scene

let renderer;
try {
  // low-power, not high-performance: this is a 300px window that is always on,
  // and waking the discrete GPU for it is a battery bill with no visible return.
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
} catch (err) {
  renderer = null;
}

if (host && renderer) {
  // The frame the drawing had: 340×330 at 300px wide, so the window size, the
  // fuel gauge and every saved window position keep meaning the same thing.
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, 340 / 330, 0.1, 100);
  // A small yaw and a little elevation: enough to read as an object with
  // sides, not so much that the panel stops being legible at 300px.
  // Framed like the drawing it replaced: the machine sits at two-thirds of the
  // frame height with the glow pool still inside it, so the window's edges never
  // slice the shadow off.
  camera.position.set(1.55, 2.66, 9.85);
  camera.lookAt(0, 1.64, 0);

  renderer.setClearAlpha(0);
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.22;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  host.appendChild(renderer.domElement);

  // A GPU reset must not leave a blank rectangle on the desktop forever. Three
  // restores its own state on `webglcontextrestored`; swallowing the lost event
  // is what lets the browser try.
  renderer.domElement.addEventListener('webglcontextlost', (e) => e.preventDefault(), false);

  // An environment made on the fly. Polished metal with no reflection is black
  // plastic; a two-stop gradient and a bright window is enough to sell chrome.
  (function environment() {
    const tex = canvasTexture(256, 128, (g, w, h) => {
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#f4f9ff');
      grad.addColorStop(0.42, '#cfdae8');
      grad.addColorStop(0.5, '#93a1b3');
      grad.addColorStop(0.62, '#49525f');
      grad.addColorStop(1, '#111317');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,.85)';
      g.beginPath();
      g.ellipse(56, 40, 36, 20, 0, 0, Math.PI * 2);
      g.fill();
    });
    tex.mapping = THREE.EquirectangularReflectionMapping;
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromEquirectangular(tex).texture;
    if ('environmentIntensity' in scene) scene.environmentIntensity = 0.5;
    tex.dispose();
    pmrem.dispose();
  })();

  // -------------------------------------------------------------- lighting
  const key = new THREE.DirectionalLight(0xfff3e2, 2.7);
  key.position.set(4.2, 7.4, 5.6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -3.4;
  key.shadow.camera.right = 3.4;
  key.shadow.camera.top = 3.8;
  key.shadow.camera.bottom = -1.2;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 20;
  key.shadow.bias = -0.0008;
  key.shadow.normalBias = 0.02;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xbcd7ff, 1.0);
  fill.position.set(-6, 2.6, 5.0);
  scene.add(fill);

  // Rim light from behind: on a transparent window the silhouette is all the
  // user sees at the edges, so it has to be carved out of the desktop.
  const rim = new THREE.DirectionalLight(0xffffff, 2.0);
  rim.position.set(-1.6, 4.4, -6.5);
  scene.add(rim);

  const hemi = new THREE.HemisphereLight(0xdfe9f7, 0x2b2418, 0.5);
  scene.add(hemi);

  // The lamp is a real light: it throws the state colour onto the robot's own
  // chest, which is the difference between "a coloured sticker" and "a lit lamp".
  const lampLight = new THREE.PointLight(0x34c759, 1.2, 2.2, 2);

  // -------------------------------------------------------------- ground
  const shadowTex = softTexture(128, [[0, 'rgba(0,0,0,.95)'], [0.55, 'rgba(0,0,0,.38)'], [1, 'rgba(0,0,0,0)']]);
  const contact = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 3.4),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.35 })
  );
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = 0.004;
  contact.renderOrder = 1;
  scene.add(contact);

  const glowTex = softTexture(128);
  const poolMat = new THREE.MeshBasicMaterial({
    map: glowTex, transparent: true, depthWrite: false, color: 0x34c759,
    blending: THREE.AdditiveBlending, opacity: 0.45,
  });
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(4.0, 4.0), poolMat);
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.008;
  pool.renderOrder = 2;
  scene.add(pool);

  // The halo sits behind the robot and paints straight onto the desktop, the
  // way the old blurred radial did — but now it can be tinted and pulsed.
  const auraMat = new THREE.SpriteMaterial({
    map: glowTex, color: 0x34c759, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, opacity: 0.4,
  });
  // Sized so its own falloff ends inside the frame: a halo big enough to reach
  // the canvas edge is cut there, and an additive cut is a visible bright line.
  const aura = new THREE.Sprite(auraMat);
  aura.scale.set(3.9, 3.9, 1);
  aura.position.set(0, 1.9, -1.7);
  aura.renderOrder = 0;
  scene.add(aura);

  // A real shadow from a real light, on a plane that only paints where it is
  // dark, so the desktop still shows through the window.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(16, 16), new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.3 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  // 透明窗口里没有真正的桌面承接这块方向光投影：无场景时它就是机器人左下方
  // 一块悬空的灰影，很难看。隐藏它，落地感交给接触阴影，场景模式的地面阴影
  // 由 sceneGround 承接。
  floor.visible = false;
  scene.add(floor);

  // 场景地面：机器人脚下的圆形「立足之地」，程序化纹理，边缘羽化融入桌面。
  const sceneGround = new THREE.Mesh(
    new THREE.CircleGeometry(3.4, 64),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0, alphaMap: edgeFadeTexture(), alphaTest: 0.01 })
  );
  sceneGround.rotation.x = -Math.PI / 2;
  sceneGround.position.y = 0.001;
  sceneGround.receiveShadow = true;
  scene.add(sceneGround);

  // 场景点缀：树 / 仙人掌 / 雪堆 / 石头等，围绕机器人放置。
  const sceneProps = new THREE.Group();
  scene.add(sceneProps);

  // 场景粒子：雪 / 草 / 沙 / 星 / 火星 / 花瓣 / 气泡 / 落叶。
  const PARTICLE_N = 180;
  const particleGeo = new THREE.BufferGeometry();
  const particlePos = new Float32Array(PARTICLE_N * 3);
  const particleVel = new Float32Array(PARTICLE_N);
  for (let i = 0; i < PARTICLE_N; i++) {
    particlePos[i * 3] = (Math.random() - 0.5) * 7;
    particlePos[i * 3 + 1] = Math.random() * 5;
    particlePos[i * 3 + 2] = (Math.random() - 0.5) * 7;
    particleVel[i] = 0.3 + Math.random() * 0.7;
  }
  particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePos, 3));
  const particleMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.06, transparent: true, opacity: 0, depthWrite: false });
  const particles = new THREE.Points(particleGeo, particleMat);
  scene.add(particles);

  // 场景点缀生成：每个场景一组低多边形小物件，围绕机器人一圈摆放。
  function buildProps(type) {
    // 换场景 = 整组点缀重造。旧的那组几何和材质都是每次新建的，不释放的话
    // 切几次场景就会攒下一堆没人用的 GPU 资源。
    while (sceneProps.children.length) {
      const child = sceneProps.children[0];
      sceneProps.remove(child);
      child.traverse((o) => {
        if (!o.isMesh) return;
        if (o.geometry) o.geometry.dispose();
        if (o.material && o.material.dispose) o.material.dispose();
      });
    }
    if (!type) return;
    const r = rng({ 松树: 11, 草丛花: 22, 仙人掌: 33, 月亮: 44, 火山岩: 55, 樱花树: 66, 珊瑚: 77, 树: 88 }[type] || 11);
    const Mwood = new THREE.MeshStandardMaterial({ color: 0x5a3f2a, roughness: 0.9 });
    const Mleaf = new THREE.MeshStandardMaterial({ color: 0x2e5c2e, roughness: 0.9 });
    const Msnow = new THREE.MeshStandardMaterial({ color: 0xf2f6fa, roughness: 0.95 });
    const Mrock = new THREE.MeshStandardMaterial({ color: 0x7a7a72, roughness: 0.9 });
    const Mgreen = new THREE.MeshStandardMaterial({ color: 0x3f8a3f, roughness: 0.9 });
    const Mpink = new THREE.MeshStandardMaterial({ color: 0xf2b8c8, roughness: 0.9 });
    const Mcoral = new THREE.MeshStandardMaterial({ color: 0xe06050, roughness: 0.85 });
    // 点缀落地并开启投影/受影：一棵投下影子的树才「站」在地上，而不是贴图。
    // 同时记录一个随机相位与幅度，供 update 里的「随风摆动」使用。
    const place = (m, x, z, s = 1) => {
      m.position.set(x, 0, z);
      m.scale.setScalar(s);
      m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      m.userData.swayPhase = r() * Math.PI * 2;
      m.userData.swayAmp = 0.035 + r() * 0.05;
      sceneProps.add(m);
    };
    const n = 6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r() * 0.8;
      const rad = 2.0 + r() * 0.7;
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
      if (type === '松树') {
        if (i % 2 === 0) {
          // 雪松：多层深绿树冠，每一层都真实地积一层雪（略小的白圆锥叠在每层树枝上），
          // 雪从树枝边缘垂下来、绿色从雪下透出，而不是树顶放一坨白球。
          const g = new THREE.Group();
          const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 0.28, 8), Mwood); trunk.position.y = 0.14; g.add(trunk);
          for (let k = 0; k < 3; k++) {
            const y = 0.30 + k * 0.24;
            const R = 0.32 - k * 0.085;
            const cone = new THREE.Mesh(new THREE.ConeGeometry(R, 0.36, 12), Mleaf);
            cone.position.y = y;
            g.add(cone);
            // 积雪：略小、略靠上的白圆锥，盖住每层树枝的上半，边缘不规则感用轻微缩放错位
            const snow = new THREE.Mesh(new THREE.ConeGeometry(R * 0.78, 0.20, 12), Msnow);
            snow.position.set((r() - 0.5) * 0.03, y + 0.09, (r() - 0.5) * 0.03);
            g.add(snow);
          }
          place(g, x, z, 0.75 + r() * 0.5);
        } else {
          // 雪堆：不规则的扁半球，边缘起伏，像风把雪吹成堆
          const drift = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 10), Msnow);
          drift.scale.set(1 + r() * 0.5, 0.5 + r() * 0.25, 1 + r() * 0.5);
          drift.position.y = 0.06;
          drift.position.x = (r() - 0.5) * 0.1;
          drift.position.z = (r() - 0.5) * 0.1;
          place(drift, x, z, 0.8 + r() * 0.7);
        }
      } else if (type === '树') {
        const g = new THREE.Group();
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.3, 8), Mwood); trunk.position.y = 0.15; g.add(trunk);
        for (let k = 0; k < 2; k++) { const cone = new THREE.Mesh(new THREE.ConeGeometry(0.30 - k * 0.07, 0.36, 10), Mleaf); cone.position.y = 0.32 + k * 0.24; g.add(cone); }
        place(g, x, z, 0.75 + r() * 0.5);
      } else if (type === '草丛花') {
        const g = new THREE.Group();
        for (let k = 0; k < 5; k++) { const blade = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.2 + r() * 0.15, 5), Mgreen); blade.position.set((r() - 0.5) * 0.5, 0.1, (r() - 0.5) * 0.5); g.add(blade); }
        if (r() > 0.4) { const f = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), Mpink); f.position.set((r() - 0.5) * 0.3, 0.22, (r() - 0.5) * 0.3); g.add(f); }
        place(g, x, z, 0.8 + r() * 0.7);
      } else if (type === '仙人掌') {
        // 萨瓜罗仙人掌：粗主柱 + 左右两根 L 形分支，而不是一根柱加一个横臂。
        const g = new THREE.Group();
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.42, 10), Mgreen); body.position.y = 0.21; g.add(body);
        for (const sx of [0.09, -0.09]) {
          const armLow = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.10, 8), Mgreen);
          armLow.position.set(sx, 0.26, 0); armLow.rotation.z = -sx * 1.1; g.add(armLow);
          const armUp = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.20, 8), Mgreen);
          armUp.position.set(sx * 1.55, 0.37, 0); g.add(armUp);
        }
        place(g, x, z, 0.8 + r() * 0.7);
      } else if (type === '月亮') {
        const g = new THREE.Group();
        const moon = new THREE.Mesh(new THREE.SphereGeometry(0.18, 20, 16), new THREE.MeshStandardMaterial({ color: 0xf0ecd8, roughness: 0.8 }));
        g.add(moon);
        // 环形山：几处深色小斑，让月亮不像一个光溜溜的球
        for (let k = 0; k < 4; k++) {
          const cr = new THREE.Mesh(new THREE.SphereGeometry(0.03 + r() * 0.03, 8, 6), new THREE.MeshStandardMaterial({ color: 0xcfc9b0, roughness: 0.9 }));
          cr.position.set((r() - 0.5) * 0.24, (r() - 0.5) * 0.24, 0.14);
          cr.scale.setScalar(0.7);
          g.add(cr);
        }
        place(g, x, z + 0.3, 0.8);
      } else if (type === '火山岩') {
        // 一堆不规则岩块 + 一处发红光的熔岩缝，而不是单个光秃秃的十二面体。
        const g = new THREE.Group();
        for (let k = 0; k < 3; k++) {
          const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.08 + r() * 0.06, 0), Mrock);
          rock.position.set((r() - 0.5) * 0.45, 0.05 + r() * 0.06, (r() - 0.5) * 0.45);
          rock.rotation.set(r() * 3, r() * 3, r() * 3);
          g.add(rock);
        }
        const ember = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), new THREE.MeshStandardMaterial({ color: 0xff6020, emissive: 0xff4010, emissiveIntensity: 1.6 }));
        ember.position.set((r() - 0.5) * 0.25, 0.03, (r() - 0.5) * 0.25);
        g.add(ember);
        place(g, x, z, 0.8 + r() * 0.8);
      } else if (type === '樱花树') {
        // 樱花树：棕色树干托起一团「粉云」——多个扁球（scale.y 压扁）拼成扁平的
        // 伞形树冠，浅粉到深粉渐变，像真实樱花盛开时一树繁花的云朵感。
        const g = new THREE.Group();
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.10, 0.38, 10), Mwood); trunk.position.y = 0.19; g.add(trunk);
        const pinkShades = [0xf9dce3, 0xf2b8c8, 0xe8a0b8];
        // 中心一大团
        const center = new THREE.Mesh(new THREE.SphereGeometry(0.20, 12, 9), new THREE.MeshStandardMaterial({ color: pinkShades[1], roughness: 0.95 }));
        center.scale.y = 0.62; center.position.y = 0.52; g.add(center);
        // 周围一圈小团，压扁成云
        for (let k = 0; k < 6; k++) {
          const ang = (k / 6) * Math.PI * 2 + r() * 0.4;
          const rad = 0.16 + r() * 0.07;
          const blob = new THREE.Mesh(new THREE.SphereGeometry(0.13 + r() * 0.05, 10, 8),
            new THREE.MeshStandardMaterial({ color: pinkShades[k % 3], roughness: 0.95 }));
          blob.scale.y = 0.58;
          blob.position.set(Math.cos(ang) * rad, 0.5 + r() * 0.1, Math.sin(ang) * rad);
          g.add(blob);
        }
        place(g, x, z, 0.85 + r() * 0.5);
      } else if (type === '珊瑚') {
        // 珊瑚：一根主茎向上，四周分叉出细枝，而不是三根并排的锥子。
        const g = new THREE.Group();
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.3, 6), Mcoral); stem.position.y = 0.15; g.add(stem);
        for (let k = 0; k < 4; k++) {
          const ang = (k / 4) * Math.PI * 2 + r();
          const b = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.16 + r() * 0.1, 5), Mcoral);
          b.position.set(Math.cos(ang) * 0.05, 0.22, Math.sin(ang) * 0.05);
          b.rotation.z = Math.cos(ang) * 0.5;
          b.rotation.x = Math.sin(ang) * 0.5;
          g.add(b);
        }
        place(g, x, z, 0.9 + r() * 0.7);
      } else if (type === '水洼') {
        // 雨夜的水洼：扁平的深色水面，边缘一圈反光，倒映出周围的冷光。
        const g = new THREE.Group();
        const pond = new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.34, 0.02, 18),
          new THREE.MeshStandardMaterial({ color: 0x24303f, roughness: 0.18, metalness: 0.5 }));
        pond.position.y = 0.012;
        g.add(pond);
        const rim = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.008, 6, 24),
          new THREE.MeshStandardMaterial({ color: 0x4a6a88, roughness: 0.2, metalness: 0.6 }));
        rim.rotation.x = Math.PI / 2;
        rim.position.y = 0.02;
        g.add(rim);
        place(g, x, z, 0.7 + r() * 0.6);
      } else if (type === '货箱') {
        // 车间角落：木货箱 + 一只铁皮桶，像流水线边堆的物料。
        const g = new THREE.Group();
        const crateMat = new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.85 });
        const crate = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.26), crateMat);
        crate.position.y = 0.13;
        crate.rotation.y = r() * 0.6;
        g.add(crate);
        const barrelMat = new THREE.MeshStandardMaterial({ color: 0x4a6a52, roughness: 0.5, metalness: 0.4 });
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.24, 14), barrelMat);
        barrel.position.set(0.22, 0.12, -0.14);
        g.add(barrel);
        const hoopMat = new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.4, metalness: 0.6 });
        for (const hy of [0.06, 0.18]) {
          const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.092, 0.008, 6, 18), hoopMat);
          hoop.rotation.x = Math.PI / 2;
          hoop.position.set(0.22, hy, -0.14);
          g.add(hoop);
        }
        place(g, x, z, 0.75 + r() * 0.55);
      }
    }
  }

  function applyScene(name) {
    const s = SCENES[name] || SCENES['无'];
    sceneType = name;
    // 承接投影的平面在透明窗口里已经隐藏了，没有场景时再算阴影就是纯浪费：
    // 关掉之后 three 直接跳过整张 1024² 阴影贴图的渲染。
    key.castShadow = name !== '无';
    const oldGroundMap = sceneGround.material.map;
    if (s.texture) {
      sceneGround.material.map = sceneTexture(s.texture);
      // 从近乎透明淡入：换场景时地面是「浮现」出来的，而不是硬切一下。
      sceneGround.material.opacity = 0.001;
    } else {
      sceneGround.material.map = null;
      sceneGround.material.opacity = 0;
    }
    sceneGround.material.needsUpdate = true;
    if (oldGroundMap && oldGroundMap !== sceneGround.material.map) oldGroundMap.dispose();
    buildProps(s.props);
    const motionScale = MOTION_LEVELS[motionLevel] || 1.0;
    if (s.particle === 'snow') { particleMat.color.set(0xffffff); particleMat.opacity = 0.9 * motionScale; particleMat.size = 0.06; }
    else if (s.particle === 'grass') { particleMat.color.set(0x3f6b26); particleMat.opacity = 0.7 * motionScale; particleMat.size = 0.08; }
    else if (s.particle === 'sand') { particleMat.color.set(0xd8b878); particleMat.opacity = 0.5 * motionScale; particleMat.size = 0.05; }
    else if (s.particle === 'star') { particleMat.color.set(0xffffff); particleMat.opacity = 0.9 * motionScale; particleMat.size = 0.05; }
    else if (s.particle === 'ember') { particleMat.color.set(0xff8020); particleMat.opacity = 0.8 * motionScale; particleMat.size = 0.05; }
    else if (s.particle === 'petal') { particleMat.color.set(0xf2b8c8); particleMat.opacity = 0.8 * motionScale; particleMat.size = 0.07; }
    else if (s.particle === 'bubble') { particleMat.color.set(0xcfefff); particleMat.opacity = 0.7 * motionScale; particleMat.size = 0.06; }
    else if (s.particle === 'leaf') { particleMat.color.set(0x4a8a3a); particleMat.opacity = 0.8 * motionScale; particleMat.size = 0.07; }
    else if (s.particle === 'firefly') { particleMat.color.set(0xd9ff6a); particleMat.opacity = 0.85 * motionScale; particleMat.size = 0.045; }
    else if (s.particle === 'rain') { particleMat.color.set(0xa8c4e0); particleMat.opacity = 0.7 * motionScale; particleMat.size = 0.03; }
    else particleMat.opacity = 0;
    // 场景氛围不再改全局天光——那会让机器人本体的皮肤色跟着偏色（雪地发冷、沙漠发暖），
    // 破坏「皮肤颜色一致性」。氛围完全由地面纹理、点缀、粒子承载，机器人永远保持本色。
    // 海面自发光：海洋场景的地面像水面一样微微泛光，强度随波浪波动（见 update）。
    if (name === '海洋') { sceneGround.material.emissive = new THREE.Color(0x1a5a8a); sceneGround.material.emissiveIntensity = 0.3; }
    else { sceneGround.material.emissive = new THREE.Color(0x000000); sceneGround.material.emissiveIntensity = 0; }
  }

  // -------------------------------------------------------------- the robot
  const robot = new THREE.Group();
  scene.add(robot);
  // 体型切换：整体非均匀缩放，Q版矮胖、修长瘦高。
  function applyBody(name) {
    const b = BODY_TYPES[name] || BODY_TYPES['标准'];
    bodyType = name;
    robot.scale.set(b.x, b.y, b.z);
  }

  // -------------------------------------------------------------- base light
  // Sixteen LEDs on the desk, just outside the belts. They are not decoration:
  // each contiguous stretch belongs to one software, in priority order, so the
  // machine can show four harnesses at once without a second lamp. The round
  // lamp on the chest says how bad the worst one is; the ring says *which* one
  // it is, and the arc that owns the lamp is the arc that chases.
  // With nothing connected the ring falls back to a slow ambient sweep, in hues
  // the three state colours never use.
  const BASE_N = 16;
  const BASE_R = 1.56;
  const ringLeds = [];

  // ---- 底座灯效引擎 --------------------------------------------------------
  // 用户可在设置里切换底座灯环的灯效。默认「状态色」保留四软件红黄绿语义；
  // 其余灯效把底座变成氛围灯（五颜六色流动），此时四软件状态由仪表舱 + 软件
  // 列表 + 主灯承载。每个灯效签名 (i, t, N) => [色相, 饱和度, 明度, 亮度乘数]。
  const BASE_EFFECTS = {
    '彩虹': (i, t, N) => [(i / N + t * 0.08) % 1, 1, 0.5, 1],
    '彩虹波浪': (i, t, N) => [(i / N + t * 0.06) % 1, 1, 0.42 + 0.2 * Math.sin(t * 3 + i * 0.45), 1],
    '双旋转彩虹': (i, t, N) => [((i / N + t * 0.1) % 1 + (i / N - t * 0.1 + 1) % 1) / 2 % 1, 1, 0.5, 1],
    '跑马灯': (i, t, N) => { const h = (t * 3) % N; const d = Math.min(Math.abs(i - h), N - Math.abs(i - h)); return [0, 0, 0.55, Math.max(0, 1 - d / 2.5)]; },
    '彗星': (i, t, N) => { const h = (t * 2) % N; const d = Math.min(Math.abs(i - h), N - Math.abs(i - h)); return [0.55, 1, 0.5, Math.pow(Math.max(0, 1 - d / 4), 2)]; },
    '呼吸': (i, t, N) => [(i / N) % 1, 0.7, 0.5, 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * 2))],
    '警灯扫描': (i, t, N) => { const s = (t * 1.5) % N; const d = Math.min(Math.abs(i - s), N - Math.abs(i - s)); const on = Math.max(0, 1 - d / 1.5); return [on > 0.02 ? 0 : 0.6, 1, 0.5, on]; },
    '波浪': (i, t, N) => [(i / N) % 1, 0.8, 0.4 + 0.25 * Math.sin(t * 2.5 - i * 0.7), 1],
    '螺旋': (i, t, N) => { const p = Math.abs((i - t * 6) % N); return [(i / N + t * 0.05) % 1, 1, 0.5, Math.max(0, 1 - p / 3)]; },
    '随机跑马灯': (i, t, N) => { const h = (t * 4) % N; const d = Math.min(Math.abs(i - h), N - Math.abs(i - h)); return [Math.random(), 1, 0.5, Math.max(0, 1 - d / 2.5)]; },
    '交替': (i, t, N) => [(i % 2) ? 0.6 : 0, 1, 0.5, ((i % 2) === (Math.floor(t * 2) % 2)) ? 1 : 0.05],
    '频闪': (i, t, N) => [0, 0, 0.55, (Math.floor(t * 8) % 2) ? 1 : 0.05],
    '气泡': (i, t, N) => { const r = Math.sin(i * 12.9898 + Math.floor(t * 3) * 78.233) * 43758.5453; return [(i / N) % 1, 1, 0.5, (r - Math.floor(r) > 0.6) ? 1 : 0.05]; },
    '雨滴': (i, t, N) => { const drop = Math.floor(t * 5 + i * 0.8) % N; return [0.6, 1, 0.55, drop === 0 ? 1 : 0.05]; },
    '锯齿蛇': (i, t, N) => [(i / N + t * 0.1) % 1, 1, 0.5, Math.abs(Math.sin(t * 3 + i * 1.2))],
    '绽放': (i, t, N) => { const c = N / 2; const d = Math.min(Math.abs(i - c), N - Math.abs(i - c)); const r = (t * 4) % N; return [(i / N) % 1, 1, 0.5, Math.max(0, 1 - Math.abs(d - r) / 2)]; },
    '呼吸圆环': (i, t, N) => { const c = N / 2; const d = Math.min(Math.abs(i - c), N - Math.abs(i - c)); const r = (t * 3) % N; return [(d / N) % 1, 0.8, 0.5, Math.max(0, 1 - Math.abs(d - r) / 1.5) * (0.5 + 0.5 * Math.sin(t * 2))]; },
    '色彩轮盘': (i, t, N) => [(i / N + t * 0.15) % 1, 1, 0.5, 1],
    '交叉光束': (i, t, N) => { const a = (t * 2) % N; const b = (N - a) % N; const da = Math.min(Math.abs(i - a), N - Math.abs(i - a)); const db = Math.min(Math.abs(i - b), N - Math.abs(i - b)); return [0.55, 1, 0.5, Math.max(0, 1 - Math.min(da, db) / 1.5)]; },
    '填充': (i, t, N) => { const f = (t * 0.6) % 1; return [0.3, 1, 0.5, (i / N) < f ? 1 : 0.05]; },
    '闪电': (i, t, N) => { const b = Math.floor(t * 3) % N; return [0.12, 1, 0.6, Math.abs(i - b) < 1.5 ? 1 : 0.02]; },
    '运动光点': (i, t, N) => { let v = 0.05; for (let k = 0; k < 3; k++) { const p = (t * (1 + k * 0.7) + k * N / 3) % N; const d = Math.min(Math.abs(i - p), N - Math.abs(i - p)); v = Math.max(v, Math.max(0, 1 - d / 1.5)); } return [(i / N) % 1, 1, 0.5, v]; },
    '移动窗格': (i, t, N) => { const w = (t * 2) % N; const d = Math.min(Math.abs(i - w), N - Math.abs(i - w)); return [(i / N) % 1, 0.7, 0.5, d < 4 ? 1 : 0.05]; },
    '径向彩虹': (i, t, N) => { const c = N / 2; const d = Math.min(Math.abs(i - c), N - Math.abs(i - c)); const r = (t * 3) % N; return [(d / N + t * 0.1) % 1, 1, 0.5, Math.max(0, 1 - Math.abs(d - r) / 1.5)]; },
    '随机旋转': (i, t, N) => { const r = Math.sin(i * 7.3 + Math.floor(t * 2) * 3.7) * 43758.5453; return [(i / N) % 1, 1, 0.5, (r - Math.floor(r)) * (0.5 + 0.5 * Math.sin(t * 3))]; },
    '旋转光束': (i, t, N) => { const b = (t * 1.5) % N; const d = Math.min(Math.abs(i - b), N - Math.abs(i - b)); return [0.1, 0.9, 0.6, Math.pow(Math.max(0, 1 - d / 2.5), 3)]; },
    '旋转彩虹': (i, t, N) => [(i / N + t * 0.25) % 1, 1, 0.5, 0.6 + 0.4 * Math.abs(Math.sin(t * 2.5))],
    '序列': (i, t, N) => { const s = (t * 2) % N; return [(i / N) % 1, 1, 0.5, i <= s ? 1 : 0.05]; },
    '平滑闪烁': (i, t, N) => [(i / N) % 1, 0.7, 0.5, Math.max(0, Math.sin(t * 4 - i * 0.5))],
    '光谱循环': (i, t, N) => [(i / N + t * 0.08) % 1, 1, 0.4 + 0.3 * (0.5 + 0.5 * Math.sin(t * 2 - i * 0.3)), 1],
    '堆叠': (i, t, N) => { const seg = 4; const k = Math.floor(i / (N / seg)); const f = (t * 1.5) % 1; return [(k / seg + t * 0.05) % 1, 0.8, 0.5, ((i / (N / seg)) % 1) < f ? 1 : 0.1]; },
    '星夜': (i, t, N) => { const r = Math.sin(i * 5.1 + Math.floor(t * 5) * 91.7) * 43758.5453; return [(i / N) % 1, 0.6, 0.6, (r - Math.floor(r) > 0.85) ? 1 : 0.03]; },
    '漩涡圆环': (i, t, N) => { const a = (i / N * Math.PI * 4 + t * 3) % (Math.PI * 2); return [(i / N + t * 0.05) % 1, 1, 0.5, 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(a))]; },
    '光束扫视': (i, t, N) => { const s = (Math.sin(t * 1.2) * 0.5 + 0.5) * N; const d = Math.min(Math.abs(i - s), N - Math.abs(i - s)); return [0.55, 1, 0.6, Math.pow(Math.max(0, 1 - d / 2), 2)]; },
    '渐变波浪': (i, t, N) => { const g = i / N; return [(g + t * 0.05) % 1, 1, 0.3 + 0.4 * (0.5 + 0.5 * Math.sin(t * 2.5 - g * Math.PI * 2)), 1]; },
  };
  let baseEffect = '状态色';

  const AMBIENT = new THREE.Color();
  const baseLedGeo = new THREE.BoxGeometry(0.075, 0.018, 0.16);
  for (let i = 0; i < BASE_N; i++) {
    const a = (i / BASE_N) * Math.PI * 2;
    const mat = new THREE.MeshStandardMaterial({ color: 0x101010, emissive: 0x000000, emissiveIntensity: 0, roughness: 0.35 });
    const led = mesh(baseLedGeo, mat, { cast: false });
    led.position.set(Math.cos(a) * BASE_R, 0.045, Math.sin(a) * BASE_R);
    led.rotation.y = -a;
    scene.add(led);
    ringLeds.push({ mat, color: new THREE.Color(0x34c759), agent: null, rank: 0, dim: false });
  }

  // Two overlapping rings painted on the desk: a single soft hue reads as a
  // smudge, two offset hues read as light, and together they are the colour
  // that makes the base glow rather than sit there.
  function ringTexture(band) {
    return canvasTexture(256, 256, (g, w, h) => {
      const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(Math.max(0.05, band - 0.24), 'rgba(255,255,255,0.05)');
      grad.addColorStop(band, 'rgba(255,255,255,0.62)');
      grad.addColorStop(Math.min(0.98, band + 0.13), 'rgba(255,255,255,0.14)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
    });
  }

  // 光环样式纹理：环形 / 圆形 / 星形 / 无（透明）。
  function haloTexture(style) {
    return canvasTexture(256, 256, (g, w, h) => {
      const cx = w / 2, cy = h / 2;
      if (style === '圆形') {
        const grad = g.createRadialGradient(cx, cy, 0, cx, cy, w / 2);
        grad.addColorStop(0, 'rgba(255,255,255,0.7)');
        grad.addColorStop(0.45, 'rgba(255,255,255,0.3)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad; g.fillRect(0, 0, w, h);
      } else if (style === '星形') {
        g.translate(cx, cy);
        const spikes = 8, outerR = w * 0.45, innerR = w * 0.12;
        g.fillStyle = 'rgba(255,255,255,0.5)';
        g.beginPath();
        for (let i = 0; i < spikes * 2; i++) {
          const r = i % 2 === 0 ? outerR : innerR;
          const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
          const px = Math.cos(a) * r, py = Math.sin(a) * r;
          if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
        }
        g.closePath(); g.fill();
      } else if (style === '无') {
        g.clearRect(0, 0, w, h);
      } else {
        const grad = g.createRadialGradient(cx, cy, 0, cx, cy, w / 2);
        grad.addColorStop(0, 'rgba(255,255,255,0)');
        grad.addColorStop(0.38, 'rgba(255,255,255,0.05)');
        grad.addColorStop(0.62, 'rgba(255,255,255,0.62)');
        grad.addColorStop(0.75, 'rgba(255,255,255,0.14)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad; g.fillRect(0, 0, w, h);
      }
    });
  }
  const HALO_STYLES = { '环形': 'ring', '圆形': 'disc', '星形': 'star', '无': 'none' };
  let haloStyle = '环形';
  function applyHalo(style) {
    haloStyle = style;
    const tex = haloTexture(style);
    haloA.map = tex; haloA.needsUpdate = true;
    haloB.map = tex; haloB.needsUpdate = true;
  }

  function floorRing(size, band, opacity) {
    const material = new THREE.MeshBasicMaterial({
      map: ringTexture(band), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity, color: 0x66ccff,
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = 0.016;
    plane.renderOrder = 3;
    scene.add(plane);
    return material;
  }

  const haloA = floorRing(3.1, 0.62, 0.55);
  const haloB = floorRing(2.2, 0.52, 0.42);

  // Big tracks that tuck under the body: in the reference the machine sits
  // between its own tracks, so the body must overhang them, not perch on top.
  // Taller than they used to be, and standing on the desk instead of sunk half
  // into it: the reference's treads run up the sides of the body, and the half
  // of a track that used to be under the floor was half the silhouette lost.
  // x is the half-gap between the tracks: the body has to fit between the two
  // inner faces with room to spare. At 0.06 of clearance the paint and the
  // rubber met at 300px and read as one welded lump, so the belts moved out and
  // the hull moved in; the gap is now a visible slot of daylight.
  const TRACK = { w: 2.12, h: 1.36, d: 0.46, r: 0.43, x: 1.20 };
  const lugs = [];          // { mesh, profile, phase }
  const wheels = [];        // spinning sprockets
  const arms = [];          // { group, side, fingers, accent }
  const armAccents = [];    // emissive strips on the booms, tinted by state
  const trackLeds = [];     // LEDs traced along each belt, a chasing marquee
  const trackGroups = [];   // belt groups, for shape switching

  // ---- tracks ------------------------------------------------------------
  function buildTrack(side) {
    const track = new THREE.Group();
    track.position.x = side * TRACK.x;
    track.position.y = TRACK.h / 2;

    // Built in a local space where x runs along the track and z across it.
    const space = new THREE.Group();
    space.rotation.y = Math.PI / 2;
    track.add(space);

    // 履带轮廓：读全局 trackType（圆角矩形 / 三角形 / 梯形）。
    // 三角形 = WALL-E 风格「上窄下宽」的圆角三角（顶部一个小轮、底部两个大轮）；
    // 梯形 = 上边窄、下边宽的圆角梯形。顶点顺序保证轮廓闭合、圆角平滑。
    function outline() {
      const w = TRACK.w, h = TRACK.h;
      if (trackType === '三角形') return roundedPolygon([[0, h * 0.46], [-w * 0.5, -h * 0.30], [w * 0.5, -h * 0.30]], 0.30, 12);
      if (trackType === '梯形') return roundedPolygon([[-w * 0.30, h * 0.46], [w * 0.30, h * 0.46], [w * 0.5, -h * 0.46], [-w * 0.5, -h * 0.46]], 0.22, 12);
      return roundedRectPoints(w, h, TRACK.r, 12);
    }

    // 同心缩小：相对轮廓的包围盒中心缩放，保证内孔与外框同轴，橡胶厚薄均匀。
    function shrinkOutline(pts, ratio) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of pts) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      return pts.map((p) => new V2(cx + (p.x - cx) * ratio, cy + (p.y - cy) * ratio));
    }

    // The belt is a ring, not a block: the side has to be open or the red
    // sprockets inside are invisible and the tank reads as a rubber brick.
    // ExtrudeGeometry extrudes z ∈ [0, depth] — it MUST be centered afterwards,
    // or the belt sits half a thickness off-centre and the sprockets (placed at
    // ±d/2) end up outside the belt on one side. That off-centre belt was the
    // "asymmetric tracks" bug.
    const outerPts = outline();
    const beltShape = new THREE.Shape(outerPts);
    beltShape.holes.push(new THREE.Path(shrinkOutline(outerPts, 0.76)));
    const beltGeo = new THREE.ExtrudeGeometry(beltShape, {
      depth: TRACK.d, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2, curveSegments: 10,
    });
    beltGeo.center();
    const belt = mesh(beltGeo, M.rubber);
    space.add(belt);

    // back plate, so the far side of the belt does not show daylight
    const backGeo = new THREE.ExtrudeGeometry(new THREE.Shape(shrinkOutline(outerPts, 0.70)), {
      depth: 0.10, bevelEnabled: true, bevelSize: 0.01, bevelThickness: 0.01, bevelSegments: 1, curveSegments: 10,
    });
    backGeo.center();
    space.add(mesh(backGeo, M.dark));
    // the belt's inner run, a touch darker so the ring reads as thickness
    const innerShape = new THREE.Shape(shrinkOutline(outerPts, 0.72));
    innerShape.holes.push(new THREE.Path(shrinkOutline(outerPts, 0.50)));
    const innerGeo = new THREE.ExtrudeGeometry(innerShape, {
      depth: TRACK.d - 0.06, bevelEnabled: true, bevelSize: 0.01, bevelThickness: 0.01, bevelSegments: 1, curveSegments: 10,
    });
    innerGeo.center();
    space.add(mesh(innerGeo, M.rubberIn));

    // ribs around the circumference. Scrolling them is the whole "it is
    // driving" cue, and because they wrap the rounded ends they read in 3D.
    const profile = new THREE.Shape(outline()).getSpacedPoints(360);
    const count = 44;
    const lugMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.062, 0.055, TRACK.d * 0.82),
      M.rubberHi,
      count
    );
    lugMesh.castShadow = true;
    lugMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    space.add(lugMesh);
    lugs.push({ mesh: lugMesh, profile, count, phase: 0, side });

    // Sprockets, outer face only: the inner face is behind the chassis. Set
    // nearly flush with the belt so they catch light instead of hiding in it.
    const outer = side * (TRACK.d / 2 - 0.012);
    const spin = [];
    // Three sprockets arranged to the belt shape: for a triangle the top wheel
    // sits near the peak and the two big wheels sit in the two bottom corners;
    // the rectangle keeps its two low + one centred layout.
    const sprocketLayout = trackType === '三角形'
      ? [[0.30, 0, 0.22, 14], [0.42, -0.62, -0.34, 15], [0.42, 0.62, -0.34, 15]]
      : trackType === '梯形'
        ? [[0.30, 0, 0.20, 14], [0.40, -0.58, -0.36, 15], [0.40, 0.58, -0.36, 15]]
        : [[0.345, 0.58, -0.24, 15], [0.335, -0.60, -0.24, 15], [0.145, -0.01, -0.16, 0]];
    for (const [r, x, y, teeth] of sprocketLayout) {
      const g = new THREE.Group();
      g.position.set(x, y, outer);
      const tyre = mesh(new THREE.CylinderGeometry(r, r, 0.05, 26), M.metalDark);
      tyre.rotation.x = Math.PI / 2;
      g.add(tyre);
      for (let i = 0; i < teeth; i++) {
        const a = (i / teeth) * Math.PI * 2;
        const t = mesh(new THREE.BoxGeometry(0.05, 0.07, 0.045), M.wheel);
        t.position.set(Math.cos(a) * (r + 0.008), Math.sin(a) * (r + 0.008), 0);
        t.rotation.z = a;
        g.add(t);
      }
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const spoke = mesh(new THREE.BoxGeometry(r * 0.86, 0.045, 0.03), M.wheelDark);
        spoke.position.set(Math.cos(a) * r * 0.45, Math.sin(a) * r * 0.45, 0.012);
        spoke.rotation.z = a;
        g.add(spoke);
      }
      const hub = mesh(new THREE.CylinderGeometry(r * 0.24, r * 0.24, 0.075, 18), M.wheelDark);
      hub.rotation.x = Math.PI / 2;
      hub.position.z = 0.02;
      g.add(hub);
      space.add(g);
      spin.push(g);
    }
    wheels.push(...spin);

    // ---- track marquee: a chasing strip of LEDs around each belt ----------
    // The rubber is dark; this ring of lights makes the "driving" cue a light
    // cue too, and gives the machine a sci-fi underglow. Colour follows the
    // aggregate tint; the chase follows the state rhythm (see the update loop).
    const TRACK_LED_N = 34;
    const ledProfile = new THREE.Shape(outline()).getSpacedPoints(TRACK_LED_N);
    for (let i = 0; i < TRACK_LED_N; i++) {
      const p = ledProfile[i];
      const mat = new THREE.MeshStandardMaterial({ color: 0x101010, emissive: 0x000000, emissiveIntensity: 0, roughness: 0.3 });
      const led = mesh(new THREE.BoxGeometry(0.075, 0.032, 0.02), mat, { cast: false });
      led.position.set(p.x, p.y, outer + 0.005);
      space.add(led);
      trackLeds.push({ mat, index: i, total: TRACK_LED_N });
    }

    return track;
  }

  const tA = buildTrack(-1), tB = buildTrack(1);
  trackGroups.push(tA, tB);
  robot.add(tA, tB);

  // 切换履带形状时重建：清空履带/链轮/灯带，按新 trackType 重建。
  function rebuildTracks() {
    for (const g of trackGroups) robot.remove(g);
    trackGroups.length = 0;
    // 清空与履带相关的动画条目
    lugs.length = 0;
    wheels.length = 0;
    trackLeds.length = 0;
    const nA = buildTrack(-1), nB = buildTrack(1);
    trackGroups.push(nA, nB);
    robot.add(nA, nB);
  }

  // chassis: what the tracks hang off and what the body sits on. Nearly all of
  // it is hidden behind the yellow cube, which is the point — the machine is
  // the paint, and a bright shelf of chrome between the treads is what made the
  // old version look like a toy.
  // A round turntable, not a box: he swings in place now, and a square pedestal
  // shows a corner the moment the body comes off it.
  // A round turntable under the body, kept up where the body is: a pedestal
  // that reaches the floor between the belts reads as a traffic cone.
  const chassis = mesh(new THREE.CylinderGeometry(0.62, 0.64, 0.58, 28), M.metalDark);
  chassis.position.set(0, 0.86, 0);
  robot.add(chassis);
  const gearbox = mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.30, 24), M.wheelDark);
  gearbox.position.set(0, 0.56, 0);
  robot.add(gearbox);
  // the bearing the body rides on, visible in the gap under the yellow
  const bearing = mesh(new THREE.TorusGeometry(0.63, 0.022, 8, 40), M.steel);
  bearing.rotation.x = Math.PI / 2;
  bearing.position.y = 0.60;
  robot.add(bearing);

  // ---- body --------------------------------------------------------------
  // One yellow cube, the way the reference is a yellow cube: the paint is the
  // machine. Grey only survives as edge trim and the deck.
  const bodyGroup = new THREE.Group();
  robot.add(bodyGroup);

  // Narrow enough to stand between the treads with clearance: the old 1.78 was
  // wider than the gap, so the body and the belts occupied the same space.
  // 1.54 against a 0.97 inner belt face leaves 0.20 of air per side — enough
  // that the slot reads as a slot, not as a seam in the same object.
  const CH = { w: 1.54, h: 1.68, d: 1.10, r: 0.085, y: 1.42 };
  const FRONT = CH.d / 2;

  // The lamp rides with the body, so turning the machine carries its glow with
  // it instead of leaving a green light hovering in the old spot.
  bodyGroup.add(lampLight);
  lampLight.position.set(0.3, 1.72, 0.58);

  // Decals are laid on a real surface, so their height has to come from the
  // geometry, not from arithmetic about bevels. Guessing put them *inside* the
  // door once, and the wordmark simply was not there.
  function frontOf(obj, air = 0.004) {
    const g = obj.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    return obj.position.z + g.boundingBox.max.z + air;
  }

  // The instrument bay is a real hole cut in the paint, with its furniture set
  // back inside it: at a 3/4 angle you see the depth, which no painted panel
  // can fake.
  const BAY = { x: 0.40, y: 1.98, w: 0.60, h: 0.34, depth: 0.05 };
  const hull = mesh(slab(CH.w, CH.h, CH.d, {
    r: CH.r, bevel: 0.024,
    holes: [{ w: BAY.w, h: BAY.h, r: 0.035, x: BAY.x, y: BAY.y - CH.y }],
  }), M.yellow);
  hull.position.set(0, CH.y, 0);
  bodyGroup.add(hull);

  // The compactor door, as a seam and a slightly darker lower plate. One line
  // and one step is all it takes for a box to read as something that opens.
  const seam = mesh(slab(CH.w - 0.22, 0.028, 0.02, { r: 0.012, bevel: 0.006 }), M.dark);
  seam.position.set(0, 1.06, FRONT - 0.004);
  bodyGroup.add(seam);

  const lower = mesh(slab(CH.w - 0.22, 0.46, 0.05, { r: 0.03, bevel: 0.008 }), M.yellowDark);
  lower.position.set(0, 0.81, FRONT - 0.012);
  bodyGroup.add(lower);

  // The back is on show now that he turns, so it cannot be a bare slab: a lift
  // hook on the spine and a vent over the gearbox.
  const hook = mesh(new THREE.TorusGeometry(0.15, 0.026, 10, 24, Math.PI), M.steel);
  hook.position.set(0, 1.86, -FRONT - 0.035);
  bodyGroup.add(hook);
  for (let i = 0; i < 4; i++) {
    const vent = mesh(slab(0.86, 0.045, 0.018, { r: 0.012, bevel: 0.004 }), M.dark);
    vent.position.set(0, 1.58 - i * 0.09, -FRONT - 0.004);
    bodyGroup.add(vent);
  }

  // top deck: thin, dark, and no wider than the body — the old 1.94-wide shelf
  // overhanging a 1.80 body put a hat on the robot
  const deck = mesh(slab(CH.w + 0.05, 0.13, CH.d + 0.03, { r: 0.05, bevel: 0.016 }), M.metal);
  deck.position.set(0, 2.32, 0);
  bodyGroup.add(deck);
  const spine = mesh(slab(0.36, 0.15, 0.86, { r: 0.03, bevel: 0.01 }), M.metalDark);
  spine.position.set(0, 2.40, -0.08);
  bodyGroup.add(spine);

  // side rails, and the shoulder mounts the arms bolt onto
  for (const side of [-1, 1]) {
    // Edge posts and a waist band, not a full plate: the old rail covered the
    // whole flank in gunmetal, which turned the box into a strongbox when he
    // turned round.
    for (const z of [-1, 1]) {
      const post = mesh(slab(0.05, CH.h - 0.10, 0.07, { r: 0.015, bevel: 0.005 }), M.metalDark);
      post.position.set(side * (CH.w / 2 + 0.004), CH.y, z * (CH.d / 2 - 0.05));
      bodyGroup.add(post);
    }
    const waist = mesh(slab(0.045, 0.075, CH.d - 0.14, { r: 0.014, bevel: 0.005 }), M.metalDark);
    waist.position.set(side * (CH.w / 2 + 0.004), 1.24, 0);
    bodyGroup.add(waist);

    // The arm mount lives on the body, not on the arm: it is what the shoulder
    // pivots around, so it must not swing with it. It is a cantilever that
    // reaches out over the belt: the arm used to hang at x=1.34, which is
    // inside the 0.97–1.43 belt wall, so the forearm was cut by the track at
    // every angle. Outside the belt it is free to swing.
    const beam = mesh(slab(0.82, 0.13, 0.22, { r: 0.03, bevel: 0.01 }), M.metalDark);
    beam.position.set(side * (CH.w / 2 + 0.41), 1.93, 0.30);
    beam.rotation.z = side * 0.07;
    bodyGroup.add(beam);

    // A diagonal brace back to the deck: an unsupported cantilever looks like a
    // broken part, a braced one looks like it was engineered.
    const brace = mesh(slab(0.10, 0.42, 0.19, { r: 0.025, bevel: 0.008 }), M.metalDark);
    brace.position.set(side * (CH.w / 2 + 0.15), 2.09, 0.30);
    brace.rotation.z = side * 0.62;
    bodyGroup.add(brace);

    for (const bx of [0.10, 0.48]) {
      const cap = mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.02, 6), M.rust);
      cap.rotation.x = Math.PI / 2;
      cap.position.set(side * (CH.w / 2 + bx), 1.94, 0.415);
      bodyGroup.add(cap);
    }
  }

  // One faded hazard sticker, the only bit of industrial print that earns its
  // place: it says "machinery", not "brand".
  const sticker = new THREE.Mesh(
    new THREE.PlaneGeometry(0.30, 0.115),
    new THREE.MeshStandardMaterial({ map: hazardTexture(), transparent: true, opacity: 0.6, metalness: 0.1, roughness: 0.85 })
  );
  sticker.position.set(-0.56, 2.10, frontOf(hull, 0.002));
  sticker.rotation.z = 0.03;
  bodyGroup.add(sticker);

  // wordmark, small, printed on the paint
  const mark = new THREE.Mesh(
    new THREE.PlaneGeometry(0.62, 0.155),
    new THREE.MeshStandardMaterial({ map: wordmarkTexture(), transparent: true, metalness: 0.1, roughness: 0.8 })
  );
  mark.position.set(-0.40, 1.56, frontOf(hull, 0.002));
  bodyGroup.add(mark);

  // rivets: the four corners of the compactor door
  const rivetGeo = new THREE.CylinderGeometry(0.024, 0.026, 0.012, 12);
  for (const [x, y] of [[-0.66, 1.16], [0.66, 1.16], [-0.66, 0.62], [0.66, 0.62]]) {
    const r = mesh(rivetGeo, M.rust);
    r.rotation.x = Math.PI / 2;
    r.position.set(x, y, FRONT + 0.008);
    bodyGroup.add(r);
  }

  // ---- instrument bay ----------------------------------------------------
  const bayDepth = FRONT - BAY.depth;
  const bayFloor = mesh(slab(BAY.w - 0.02, BAY.h - 0.02, 0.30, { r: 0.03, bevel: 0.008 }), M.panel);
  bayFloor.position.set(BAY.x, BAY.y, bayDepth - 0.15);
  bodyGroup.add(bayFloor);
  const bayFaceZ = bayDepth + 0.002;

  // the plate the lamp and the bars are set into
  const plate = mesh(slab(BAY.w - 0.05, BAY.h - 0.05, 0.02, { r: 0.02, bevel: 0.006 }), M.black);
  plate.position.set(BAY.x, BAY.y, bayFaceZ - 0.012);
  bodyGroup.add(plate);

  // one round pilot lamp — the only thing on the robot that carries state colour
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x0b0d10, emissive: 0x34c759, emissiveIntensity: 2.4, roughness: 0.3, metalness: 0.2 });
  const lampBody = mesh(new THREE.CylinderGeometry(0.078, 0.084, 0.05, 24), M.metalDark);
  lampBody.rotation.x = Math.PI / 2;
  lampBody.position.set(BAY.x - 0.17, BAY.y - 0.055, bayFaceZ + 0.018);
  bodyGroup.add(lampBody);
  const lampLens = mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.02, 24), lampMat, { cast: false });
  lampLens.rotation.x = Math.PI / 2;
  lampLens.position.set(BAY.x - 0.17, BAY.y - 0.055, bayFaceZ + 0.044);
  bodyGroup.add(lampLens);

  // 灯前方的辉光 sprite：模拟真实灯光溢出的「电影感」，纯 additive 贴图，
  // 不经过后处理，所以透明窗口里不会出现方形底。
  const lampGlowMat = new THREE.SpriteMaterial({
    map: softTexture(64), color: 0x34c759, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, opacity: 0,
  });
  const lampGlow = new THREE.Sprite(lampGlowMat);
  lampGlow.scale.set(0.55, 0.55, 1);
  lampGlow.position.set(BAY.x - 0.17, BAY.y - 0.055, bayFaceZ + 0.12);
  bodyGroup.add(lampGlow);

  lampLight.position.set(BAY.x - 0.17, BAY.y - 0.055, bayFaceZ + 0.2);

  // eight segments, one per registered software: the bar chart is the agent
  // list, not decoration. Colour comes from the same table as the DOM mirror.
  const bars = [];
  const barGeo = new THREE.BoxGeometry(0.25, 0.021, 0.012);
  for (let i = 0; i < 8; i++) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x1e2228, emissive: 0x000000, emissiveIntensity: 0, roughness: 0.5 });
    const bar = mesh(barGeo, mat, { cast: false });
    bar.position.set(BAY.x + 0.155, BAY.y + 0.145 - i * 0.0385, bayFaceZ + 0.012);
    bodyGroup.add(bar);
    bars.push(mat);
  }

  // ---- status strip ------------------------------------------------------
  // Fourteen LEDs under the deck: the machine's own status bar. The round lamp
  // carries the aggregate state; this strip carries the *animation* — a chase
  // while it works, a breath while it waits, a strobe when it broke. It is the
  // one part of the robot that can be read from across a room.
  // Nine segments, big enough to count at 300px: a chase of pixels five
  // millimetres apart is invisible on a desktop, and a marquee nobody can see
  // is just a brighter lamp.
  const STRIP_N = 9;
  const strip = [];
  const stripBase = mesh(slab(1.00, 0.052, 0.018, { r: 0.012, bevel: 0.004 }), M.dark);
  stripBase.position.set(0, 2.19, FRONT + 0.003);
  bodyGroup.add(stripBase);
  const stripGeo = new THREE.BoxGeometry(0.086, 0.026, 0.012);
  for (let i = 0; i < STRIP_N; i++) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x141412, emissive: 0x000000, emissiveIntensity: 0, roughness: 0.4 });
    const led = mesh(stripGeo, mat, { cast: false });
    led.position.set(-0.40 + i * 0.10, 2.19, FRONT + 0.012);
    bodyGroup.add(led);
    strip.push(mat);
  }

  // ---- beacon mast -------------------------------------------------------
  // A lit bulb on a short mast at the rear corner of the deck. The strip is on
  // the front face and disappears the moment the machine turns away; this is
  // the one state light that survives every angle and every size, and a mast is
  // also what stops the silhouette from being a yellow box with a head.
  const mastBase = mesh(new THREE.CylinderGeometry(0.058, 0.076, 0.055, 16), M.metalDark);
  mastBase.position.set(0.56, 2.40, -0.33);
  bodyGroup.add(mastBase);
  const mastRod = mesh(new THREE.CylinderGeometry(0.015, 0.020, 0.28, 10), M.steel);
  mastRod.position.set(0.56, 2.56, -0.33);
  bodyGroup.add(mastRod);
  const bulbMat = new THREE.MeshStandardMaterial({ color: 0x101316, emissive: 0x34c759, emissiveIntensity: 0.6, roughness: 0.28, metalness: 0.1 });
  const mastBulb = mesh(new THREE.SphereGeometry(0.042, 16, 12), bulbMat, { cast: false });
  mastBulb.position.set(0.56, 2.73, -0.33);
  bodyGroup.add(mastBulb);

  // engraved name, drawn into a texture so it tracks the model instead of
  // floating in the window like a tooltip
  const nameCanvas = document.createElement('canvas');
  nameCanvas.width = 512;
  nameCanvas.height = 96;
  const nameCtx = nameCanvas.getContext('2d');
  const nameTex = new THREE.CanvasTexture(nameCanvas);
  nameTex.colorSpace = THREE.SRGBColorSpace;
  nameTex.anisotropy = 4;
  const namePlate = new THREE.Mesh(
    new THREE.PlaneGeometry(0.52, 0.098),
    new THREE.MeshBasicMaterial({ map: nameTex, transparent: true, depthWrite: false, opacity: 0.9 })
  );
  namePlate.position.set(BAY.x, 1.70, frontOf(hull, 0.004));
  bodyGroup.add(namePlate);

  function drawName(name) {
    nameCtx.clearRect(0, 0, nameCanvas.width, nameCanvas.height);
    nameCtx.fillStyle = '#3a3016';
    nameCtx.font = '600 50px ui-monospace, SFMono-Regular, Menlo, monospace';
    nameCtx.textBaseline = 'middle';
    nameCtx.fillText(String(name || '').slice(0, 16), 8, 50);
    nameTex.needsUpdate = true;
    namePlate.visible = !!name;
    nameShown = String(name || '').slice(0, 16);
  }

  // ---- neck --------------------------------------------------------------
  // Grey and short: the old neck was a yellow column that made the head look
  // like a periscope bolted to a fridge.
  const neck = new THREE.Group();
  bodyGroup.add(neck);

  const collar = mesh(new THREE.CylinderGeometry(0.17, 0.20, 0.09, 24), M.metalDark);
  collar.position.y = 2.44;
  neck.add(collar);

  const neckLower = mesh(slab(0.19, 0.34, 0.19, { r: 0.045, bevel: 0.01 }), M.metal);
  neckLower.position.y = 2.58;
  neck.add(neckLower);

  const jointGeo = new THREE.CylinderGeometry(0.105, 0.105, 0.22, 20);
  for (const y of [2.46, 2.72]) {
    const j = mesh(jointGeo, M.yellowDark);
    j.rotation.z = Math.PI / 2;
    j.position.y = y;
    neck.add(j);
    const pin = mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.24, 12), M.rust);
    pin.rotation.z = Math.PI / 2;
    pin.position.y = y;
    neck.add(pin);
  }

  const neckUpper = mesh(slab(0.17, 0.24, 0.17, { r: 0.04, bevel: 0.009 }), M.metal);
  neckUpper.position.y = 2.80;
  neck.add(neckUpper);

  // one cable, behind the neck and well under the head: the previous pair
  // looped up beside the eyes and read as a pair of spectacles
  const cable = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.10, 2.36, -0.14),
    new THREE.Vector3(-0.16, 2.52, -0.20),
    new THREE.Vector3(0.02, 2.62, -0.21),
    new THREE.Vector3(0.14, 2.56, -0.16),
  ]), 22, 0.019, 8, false), M.black);
  neck.add(cable);

  // ---- head --------------------------------------------------------------
  const head = new THREE.Group();
  head.position.set(0, 2.86, 0.01);
  neck.add(head);

  const bridge = mesh(slab(0.62, 0.24, 0.32, { r: 0.06, bevel: 0.014 }), M.metalDark);
  bridge.position.y = -0.01;
  head.add(bridge);

  // ---- 头顶天线：一根细杆 + 会随状态发光的顶端小球，像「活物的触角」--------
  // 平时轻微摆动，忙碌时抖得快，出错时乱颤；小球颜色跟着状态灯走。
  const antenna = new THREE.Group();
  antenna.position.set(-0.17, 0.46, -0.06);
  head.add(antenna);
  const antennaRod = mesh(new THREE.CylinderGeometry(0.011, 0.014, 0.52, 8), M.metalDark);
  antennaRod.position.y = 0.24;
  antenna.add(antennaRod);
  const antennaTipMat = new THREE.MeshStandardMaterial({
    color: 0x0a0d10, emissive: 0x34c759, emissiveIntensity: 1.3, metalness: 0.2, roughness: 0.3,
  });
  const antennaTip = mesh(new THREE.SphereGeometry(0.034, 14, 12), antennaTipMat, { cast: false });
  antennaTip.position.y = 0.52;
  antenna.add(antennaTip);
  // 天线根部的固定环，让它看起来是「装上去」的，而不是插在脑袋上的。
  const antennaBase = mesh(new THREE.TorusGeometry(0.035, 0.009, 8, 18), M.rust);
  antennaBase.rotation.x = Math.PI / 2;
  antennaBase.position.y = 0.02;
  antenna.add(antennaBase);

  // ---- 安全帽：一个扁圆的黄色安全帽，带一圈深色帽檐 + 顶部一条加强筋 ---------
  const hat = new THREE.Group();
  hat.position.set(0, 0.50, 0.03);
  head.add(hat);
  const hatMat = new THREE.MeshStandardMaterial({ color: 0xf0c33c, roughness: 0.42, metalness: 0.15 });
  const hatDome = mesh(new THREE.SphereGeometry(0.30, 26, 14, 0, Math.PI * 2, 0, Math.PI / 2), hatMat);
  hatDome.scale.set(1, 0.62, 1);
  hat.add(hatDome);
  const hatBrim = mesh(new THREE.TorusGeometry(0.32, 0.030, 8, 36), M.metalDark);
  hatBrim.rotation.x = Math.PI / 2;
  hatBrim.position.y = 0.02;
  hat.add(hatBrim);
  const hatRidge = mesh(new THREE.BoxGeometry(0.05, 0.06, 0.58), M.metalDark);
  hatRidge.position.y = 0.17;
  hat.add(hatRidge);

  // ---- 皇冠：金色底圈 + 一圈尖角，戴在头顶像加冕一样 -------------------------
  const crown = new THREE.Group();
  crown.position.set(0, 0.46, 0.02);
  head.add(crown);
  const crownMat = new THREE.MeshStandardMaterial({ color: 0xf0c33c, roughness: 0.32, metalness: 0.75 });
  const crownBand = mesh(new THREE.CylinderGeometry(0.28, 0.30, 0.11, 24), crownMat);
  crownBand.position.y = 0.06;
  crown.add(crownBand);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const spike = mesh(new THREE.ConeGeometry(0.034, 0.15, 6), crownMat);
    spike.position.set(Math.cos(a) * 0.26, 0.18, Math.sin(a) * 0.26);
    crown.add(spike);
  }

  // ---- 眼镜：一对圆框架在双筒镜筒外圈，中间鼻梁相连，像戴了副圆框眼镜 --------
  const glasses = new THREE.Group();
  glasses.position.set(0, 0.13, 0.235);
  head.add(glasses);
  const glassesMat = new THREE.MeshStandardMaterial({ color: 0x8a5a3a, roughness: 0.4, metalness: 0.35 });
  for (const sx of [-1, 1]) {
    const frame = mesh(new THREE.TorusGeometry(0.30, 0.022, 10, 36), glassesMat);
    frame.position.set(sx * 0.285, 0, 0);
    glasses.add(frame);
  }
  const glassesBridge = mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.10, 8), glassesMat);
  glassesBridge.rotation.z = Math.PI / 2;
  glassesBridge.position.set(0, 0.02, 0);
  glasses.add(glassesBridge);
  for (const sx of [-1, 1]) {
    const leg = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.30, 8), glassesMat);
    leg.rotation.x = Math.PI / 2;
    leg.position.set(sx * 0.50, 0.02, -0.14);
    glasses.add(leg);
  }

  // ---- 墨镜：实心深色镜片（区别于眼镜的空框），戴了副酷墨镜 --------------------
  const sunglasses = new THREE.Group();
  sunglasses.position.set(0, 0.13, 0.235);
  head.add(sunglasses);
  const shadeMat = new THREE.MeshStandardMaterial({ color: 0x101318, roughness: 0.25, metalness: 0.4 });
  for (const sx of [-1, 1]) {
    const lens = mesh(new THREE.CircleGeometry(0.235, 36), shadeMat, { cast: false });
    lens.position.set(sx * 0.285, 0, 0);
    sunglasses.add(lens);
    const frame = mesh(new THREE.TorusGeometry(0.30, 0.020, 10, 36), M.metalDark);
    frame.position.set(sx * 0.285, 0, 0);
    sunglasses.add(frame);
  }
  const shadeBridge = mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.10, 8), M.metalDark);
  shadeBridge.rotation.z = Math.PI / 2;
  shadeBridge.position.set(0, 0.02, 0);
  sunglasses.add(shadeBridge);

  // ---- 围巾：脖子上绕一圈红围巾，尾巴垂在胸前 --------------------------------
  const scarf = new THREE.Group();
  scarf.position.set(0, 2.52, 0.05);
  neck.add(scarf);
  const scarfMat = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.85 });
  const scarfRing = mesh(new THREE.TorusGeometry(0.29, 0.055, 10, 28), scarfMat);
  scarfRing.rotation.x = Math.PI / 2;
  scarf.add(scarfRing);
  const scarfTail = mesh(new THREE.BoxGeometry(0.13, 0.30, 0.05), scarfMat);
  scarfTail.position.set(0.20, -0.18, 0.08);
  scarfTail.rotation.z = -0.25;
  scarf.add(scarfTail);

  // ---- 背包：背后一个双肩包 -------------------------------------------------
  const backpack = new THREE.Group();
  backpack.position.set(0, 1.55, -0.42);
  bodyGroup.add(backpack);
  const packMat = new THREE.MeshStandardMaterial({ color: 0x3a4a5a, roughness: 0.7 });
  const pack = mesh(new THREE.BoxGeometry(0.50, 0.60, 0.24), packMat);
  backpack.add(pack);
  const packFlap = mesh(new THREE.BoxGeometry(0.50, 0.22, 0.25), M.metalDark);
  packFlap.position.y = 0.23;
  backpack.add(packFlap);
  const packStrap = mesh(new THREE.TorusGeometry(0.30, 0.028, 8, 20, Math.PI), M.black);
  packStrap.rotation.x = Math.PI / 2;
  packStrap.position.y = 0.34;
  backpack.add(packStrap);

  // ---- 礼帽：黑色高礼帽（帽筒 + 帽檐 + 暗红帽带），戴上像位绅士 ----------------
  const tophat = new THREE.Group();
  tophat.position.set(0, 0.50, 0.02);
  head.add(tophat);
  const tophatMat = new THREE.MeshStandardMaterial({ color: 0x161a20, roughness: 0.5, metalness: 0.25 });
  const tophatCrown = mesh(new THREE.CylinderGeometry(0.21, 0.24, 0.34, 26), tophatMat);
  tophatCrown.position.y = 0.19;
  tophat.add(tophatCrown);
  const tophatBrim = mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.028, 34), tophatMat);
  tophat.add(tophatBrim);
  const tophatBand = mesh(new THREE.CylinderGeometry(0.222, 0.245, 0.06, 26),
    new THREE.MeshStandardMaterial({ color: 0x8a1f1f, roughness: 0.6 }));
  tophatBand.position.y = 0.04;
  tophat.add(tophatBand);

  // ---- 领结：脖子正前方一个红色蝴蝶结，配礼帽就是一套绅士行头 ------------------
  const bowtie = new THREE.Group();
  bowtie.position.set(0, 2.46, 0.27);
  neck.add(bowtie);
  const bowtieMat = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.55 });
  for (const sx of [-1, 1]) {
    const wing = mesh(new THREE.BoxGeometry(0.22, 0.15, 0.055), bowtieMat);
    wing.position.set(sx * 0.14, 0, 0);
    wing.rotation.z = sx * 0.32;
    bowtie.add(wing);
  }
  const bowtieKnot = mesh(new THREE.BoxGeometry(0.075, 0.10, 0.07), bowtieMat);
  bowtie.add(bowtieKnot);

  // 装饰：无 / 天线 / 安全帽 / 皇冠 / 眼镜 / 墨镜 / 围巾 / 背包 / 礼帽 / 领结。一次只显示一个。
  const DECORATIONS = ['无', '天线', '安全帽', '皇冠', '眼镜', '墨镜', '围巾', '背包', '礼帽', '领结'];
  let decoration = '无';
  function setDecoration(name) {
    decoration = name;
    antenna.visible = name === '天线';
    hat.visible = name === '安全帽';
    crown.visible = name === '皇冠';
    glasses.visible = name === '眼镜';
    sunglasses.visible = name === '墨镜';
    scarf.visible = name === '围巾';
    backpack.visible = name === '背包';
    tophat.visible = name === '礼帽';
    bowtie.visible = name === '领结';
  }
  setDecoration('无');
  window.addEventListener('bao:decoration', (e) => {
    const name = e.detail && e.detail.decoration;
    if (DECORATIONS.includes(name)) setDecoration(name);
  });

  // The iris ring and the brow both carry expression, and both are shared
  // materials: two lenses, one colour, one update per frame.
  const eyeGlowMat = new THREE.MeshStandardMaterial({
    color: 0x0a0d10, emissive: 0x34c759, emissiveIntensity: 1.1, metalness: 0.2, roughness: 0.34,
  });

  let eyes = [];
  let tearMeshes = [];   // 泪滴：error 时沿镜筒滑落

  // 眼睛构建：读全局 headType（双筒/单眼/三眼），返回新眼睛与泪滴数组。
  function buildEyes() {
    const cfg = HEAD_TYPES[headType] || HEAD_TYPES['双筒'];
    const newEyes = [];
    const newTears = [];
    for (const eyeCfg of cfg.eyes) {
    const side = eyeCfg.side;
    const eye = new THREE.Group();
    eye.position.set(eyeCfg.x, eyeCfg.y, 0.0);
    eye.scale.setScalar(eyeCfg.scale);
    eye.rotation.y = -side * 0.06;
    eye.rotation.x = 0.05;
    head.add(eye);

    // A short binocular barrel, dark and machined. The white plates that used
    // to sit here read as ping-pong balls — the one thing a status robot must
    // not look like is surprised.
    // 镜筒截面随「眼睛形状」变化：圆 = 圆柱，方 = 方柱，六边形 = 六棱柱。
    const shell = eyeShape === '方'
      ? mesh(new THREE.BoxGeometry(0.40, 0.40, 0.40), M.eyeBody)
      : eyeShape === '六边形'
        ? mesh(new THREE.CylinderGeometry(0.255, 0.243, 0.40, 6), M.eyeBody)
        : eyeShape === '三角'
          ? mesh(new THREE.CylinderGeometry(0.255, 0.243, 0.40, 3), M.eyeBody)
          : mesh(new THREE.CylinderGeometry(0.255, 0.243, 0.40, 36), M.eyeBody);
    shell.rotation.x = Math.PI / 2;
    eye.add(shell);

    // bezel 与镜片跟随眼睛形状：圆 = 圆环+圆镜片，方 = 方框+方镜片，六边形 = 六边形镜片。
    let bezel = null;
    let glass = null;
    if (eyeShape === '方') {
      bezel = mesh(new THREE.BoxGeometry(0.42, 0.42, 0.028), M.metalDark);
      // 镜筒是长度 0.40 的柱体，前盖正好在 z=0.20——所以 bezel 必须站到盖子
      // 前面才有意义，否则它一直埋在壳体里，等于一块没人看见的零件。
      bezel.position.z = 0.207;
      glass = mesh(new THREE.PlaneGeometry(0.32, 0.32), M.lens, { cast: false });
      glass.position.z = 0.212;
    } else {
      bezel = mesh(new THREE.TorusGeometry(0.243, 0.026, 12, 40), M.metalDark);
      // 镜筒是长度 0.40 的柱体，前盖正好在 z=0.20——所以 bezel 必须站到盖子
      // 前面才有意义，否则它一直埋在壳体里，等于一块没人看见的零件。
      bezel.position.z = 0.207;
      glass = mesh(new THREE.CircleGeometry(0.226, eyeShape === '六边形' ? 6 : eyeShape === '三角' ? 3 : 44), M.lens, { cast: false });
      glass.position.z = 0.212;
    }
    eye.add(bezel);

    const face = new THREE.Group();
    face.add(glass);

    const look = new THREE.Group();
    look.position.z = 0.216;
    face.add(look);

    // the lens element inside the glass: a dull steel ring, a slightly lighter
    // disc, a small pupil. Enough to aim, not enough to stare.
    const ring = mesh(new THREE.TorusGeometry(0.128, 0.008, 8, 40), M.steel);
    look.add(ring);

    // A lit rim inside the glass, right at the lens edge. A glow in the middle
    // reads as a green eyeball and loses the binocular silhouette; a rim reads
    // as an instrument, which is what this face is. Kept thin and dim on
    // purpose: the chest lamp is the light, this is only the reflection.
    const irisGlow = mesh(new THREE.TorusGeometry(0.196, 0.0075, 8, 44), eyeGlowMat, { cast: false });
    irisGlow.position.z = 0.003;
    look.add(irisGlow);

    const inner = mesh(new THREE.CircleGeometry(0.122, 36), M.irisInner);
    inner.position.z = 0.001;
    look.add(inner);

    const pupil = mesh(new THREE.CircleGeometry(0.062, 32), new THREE.MeshStandardMaterial({ color: 0x07090c, roughness: 0.2 }));
    pupil.position.z = 0.002;
    look.add(pupil);

    // two catchlights, not one: that is what makes glass read as glass
    const spec = new THREE.Mesh(
      new THREE.CircleGeometry(0.030, 20),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 })
    );
    spec.position.set(-0.072, 0.078, 0.004);
    look.add(spec);
    const spec2 = new THREE.Mesh(
      new THREE.CircleGeometry(0.011, 14),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 })
    );
    spec2.position.set(0.062, -0.058, 0.004);
    look.add(spec2);

    // a small stub on the top of each barrel: the reference's eyes are clearly
    // mechanisms, and the stub is what says so from a distance
    const stub = mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.07, 12), M.metalDark);
    stub.position.set(0, 0.265, -0.095);
    eye.add(stub);

    // The brow: a machined visor lip over each barrel that tilts. It is the
    // cheapest expression mechanism on the machine and the only one that reads
    // at arm's length — a squint alone at this size just looks like a thin eye.
    const brow = new THREE.Group();
    brow.position.set(0, 0.30, 0.12);
    brow.rotation.x = -0.22;
    const browPlate = mesh(slab(0.40, 0.055, 0.075, { r: 0.02, bevel: 0.006 }), M.metal);
    brow.add(browPlate);
    for (const bx of [-0.155, 0.155]) {
      const pin = mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.078, 8), M.rust);
      pin.rotation.x = Math.PI / 2;
      pin.position.set(bx, 0, 0);
      brow.add(pin);
    }
    eye.add(brow);

    eye.add(face);

    // 泪滴：error 时沿镜筒下方滑落、淡出再循环——「故障/难过」的拟人化。
    const tear = mesh(new THREE.SphereGeometry(0.032, 12, 10), new THREE.MeshStandardMaterial({
      color: 0x9fd4ff, emissive: 0x1e4e78, emissiveIntensity: 0.5,
      transparent: true, opacity: 0.9, roughness: 0.08,
    }), { cast: false });
    tear.scale.y = 1.6;
    // z 放在镜片前方，否则泪滴会被 bezel/玻璃挡住看不见
    tear.position.set(side * 0.04, -0.30, 0.26);
    tear.visible = false;
    eye.add(tear);
    newTears.push(tear);

    newEyes.push({ group: eye, face, look, side, brow });
    }
    return { eyes: newEyes, tearMeshes: newTears };
  }

  const builtEyes = buildEyes();
  eyes = builtEyes.eyes;
  tearMeshes = builtEyes.tearMeshes;

  // 重建前的清理：几何都是每次新建的（材质是共享的 M.*，不能跟着释放）。
  function disposeGeometries(root) {
    root.traverse((o) => {
      if (o.isMesh && o.geometry) o.geometry.dispose();
    });
  }

  // 切换头形状时重建眼睛：摘掉旧镜筒与泪滴，按新 headType 重建。
  function rebuildEyes() {
    for (const e of eyes) {
      head.remove(e.group);
      disposeGeometries(e.group);
    }
    const built = buildEyes();
    eyes = built.eyes;
    tearMeshes = built.tearMeshes;
    lensTargets = eyes.map((e) => e.face.children[0]);
  }

  // ---- arms --------------------------------------------------------------
  // Twin hydraulic booms hung outside the belts, the way the reference has
  // them: a braced shoulder, two machined plates with the actuator between
  // them, an exposed ram on the forearm, and a two-finger shovel with an
  // opposing thumb. The old arm was three fat prongs on a silver cube — a claw
  // machine, not a worker — and it hung at x=1.34, inside the belt wall, so the
  // track cut it in half at every angle.
  function buildArm(side) {
    const arm = new THREE.Group();
    // outside the belt's outer face (1.43): the arm swings in clear air
    arm.position.set(side * 1.56, 1.93, 0.30);
    bodyGroup.add(arm);

    // One electric-accent material per arm, so the glowing line can carry the
    // state colour without inventing a second light in the scene.
    const accent = new THREE.MeshStandardMaterial({
      color: 0x0d1114, emissive: 0x34c759, emissiveIntensity: 0.9, metalness: 0.35, roughness: 0.4,
    });
    armAccents.push(accent);

    // shoulder: a machined housing with a bearing ring and a hex bolt — the
    // joint is the part that has to look engineered, because it is the part
    // that moves
    const housing = mesh(slab(0.24, 0.30, 0.30, { r: 0.05, bevel: 0.012 }), M.metalDark);
    housing.position.set(0, -0.03, 0.01);
    arm.add(housing);
    const hub = mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.24, 24), M.steel);
    hub.rotation.z = Math.PI / 2;
    arm.add(hub);
    const bearing = mesh(new THREE.TorusGeometry(0.098, 0.012, 10, 30), M.metal);
    bearing.rotation.y = Math.PI / 2;
    bearing.position.x = side * 0.116;
    arm.add(bearing);
    const boltHead = mesh(new THREE.CylinderGeometry(0.030, 0.030, 0.026, 6), M.rust);
    boltHead.rotation.z = Math.PI / 2;
    boltHead.position.x = side * 0.128;
    arm.add(boltHead);
    const shoulderGlow = mesh(new THREE.TorusGeometry(0.070, 0.007, 8, 26), accent, { cast: false });
    shoulderGlow.rotation.y = Math.PI / 2;
    shoulderGlow.position.x = side * 0.136;
    arm.add(shoulderGlow);

    // upper boom: the arm shape switches between three silhouettes —
    //   双板  = two machined plates with the actuator between them (default)
    //   圆筒  = one solid turned cylinder
    //   桁架  = four thin rods around a ring (an open truss)
    // A solid box here is what read as a plastic arm, so each keeps its metal
    // finishes and a visible joint.
    if (armType === '圆筒') {
      const cyl = mesh(new THREE.CylinderGeometry(0.085, 0.095, 0.46, 18), M.arm);
      cyl.position.set(0, -0.27, 0);
      arm.add(cyl);
    } else if (armType === '桁架') {
      for (const [dx, dz] of [[-0.055, -0.055], [0.055, -0.055], [-0.055, 0.055], [0.055, 0.055]]) {
        const strut = mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.46, 8), M.steel);
        strut.position.set(dx, -0.27, dz);
        arm.add(strut);
      }
      const ring = mesh(new THREE.TorusGeometry(0.075, 0.012, 8, 20), M.metal);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(0, -0.27, 0);
      arm.add(ring);
    } else {
      for (const dz of [-0.065, 0.065]) {
        const plate = mesh(slab(0.11, 0.46, 0.045, { r: 0.03, bevel: 0.008 }), M.arm);
        plate.position.set(0, -0.27, dz);
        arm.add(plate);
      }
      const actuator = mesh(new THREE.CylinderGeometry(0.040, 0.040, 0.28, 14), M.metalDark);
      actuator.position.set(0, -0.27, 0);
      arm.add(actuator);
    }

    // the accent line: one glowing strip is what reads as "powered" at 300px
    const accentStrip = mesh(new THREE.BoxGeometry(0.020, 0.30, 0.012), accent, { cast: false });
    accentStrip.position.set(0, -0.27, 0.078);
    arm.add(accentStrip);

    // hinge axis along z, which is the axis the elbow actually turns about
    const elbow = mesh(new THREE.CylinderGeometry(0.078, 0.078, 0.21, 22), M.steel);
    elbow.rotation.x = Math.PI / 2;
    elbow.position.set(0, -0.53, 0);
    arm.add(elbow);
    for (const s of [-1, 1]) {
      const cap = mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.014, 18), M.dark);
      cap.rotation.x = Math.PI / 2;
      cap.position.set(0, -0.53, s * 0.112);
      arm.add(cap);
      const pin = mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.014, 6), M.rust);
      pin.rotation.x = Math.PI / 2;
      pin.position.set(0, -0.53, s * 0.121);
      arm.add(pin);
    }

    // Everything below the elbow hangs off a bent joint: a straight two-stick
    // arm reads as a signpost, and the reference's arms are visibly articulated.
    const bend = new THREE.Group();
    bend.position.set(0, -0.53, 0);
    bend.rotation.z = side * 0.14;
    arm.add(bend);

    const forearm = mesh(slab(0.145, 0.34, 0.13, { r: 0.03, bevel: 0.009 }), M.arm);
    forearm.position.set(0, -0.19, 0);
    bend.add(forearm);

    // the ram runs alongside the forearm, not through it, so the two parts
    // never occupy the same space
    const piston = mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.14, 12), M.metalDark);
    piston.position.set(0, -0.10, -0.10);
    bend.add(piston);
    const rod = mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.19, 10), M.steel);
    rod.position.set(0, -0.28, -0.10);
    bend.add(rod);

    // a single cable loom, bundled and clipped: sci-fi machinery is visible
    // routing, not a smooth shell
    const loom = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.052, -0.01, -0.052),
      new THREE.Vector3(0.072, -0.13, -0.086),
      new THREE.Vector3(0.055, -0.29, -0.074),
    ]), 14, 0.010, 6, false), M.black);
    bend.add(loom);

    const wrist = mesh(new THREE.CylinderGeometry(0.055, 0.062, 0.09, 18), M.metalDark);
    wrist.position.set(0, -0.385, 0);
    bend.add(wrist);
    const wristRing = mesh(new THREE.TorusGeometry(0.052, 0.008, 8, 24), M.steel);
    wristRing.rotation.x = Math.PI / 2;
    wristRing.position.set(0, -0.385, 0);
    bend.add(wristRing);

    // the hand hangs at forty degrees, fingers forward and down: a shovel
    // held level points at the camera and disappears in the foreshortening
    const hand = new THREE.Group();
    hand.position.set(0, -0.435, 0.01);
    hand.rotation.x = 0.40;
    bend.add(hand);

    // Two fingers and an opposing thumb. Three equal jaws read as a claw
    // machine; the thumb is what makes it read as a hand, and it is also what
    // lets the "working" pose pinch instead of just open and shut.
    const palm = mesh(slab(0.15, 0.12, 0.15, { r: 0.03, bevel: 0.009 }), M.arm);
    palm.position.set(0, -0.03, 0);
    hand.add(palm);
    // A hand the size of a thumb disappears at 300px. Fifteen percent bigger
    // than the geometry says, which is the difference between "a tool" and
    // "a detail you cannot see".
    hand.scale.setScalar(1.15);

    const fingers = [];
    // Three segments per finger — phalanx, knuckle, tip — so the hand reads as
    // an articulated shovel, not a pair of slabs. The middle knuckle is the
    // joint that makes a pinch look like a pinch instead of a clamp. The claw
    // type (铲形 2 指 / 三指 3 指 / 钳形粗指) changes the count and width.
    const claw = CLAW_TYPES[clawType] || CLAW_TYPES['铲形'];
    const fingerGeo = slab(claw.w, 0.11, 0.062, { r: 0.016, bevel: 0.005 });
    const knuckleGeo = slab(claw.w - 0.004, 0.09, 0.060, { r: 0.015, bevel: 0.004 });
    const tipGeo = slab(claw.w - 0.008, 0.065, 0.058, { r: 0.014, bevel: 0.004 });
    for (const [fx, dir] of claw.fingers) {
      const f = new THREE.Group();
      f.position.set(fx, -0.075, 0.005);
      // z-rotation on this group is a finger opening or closing, and dir keeps
      // the two of them hinging away from each other instead of together
      f.userData.base = 0.05;
      f.userData.dir = dir;
      const jaw = mesh(fingerGeo, M.arm);
      jaw.position.set(dir * 0.006, -0.05, 0);
      f.add(jaw);
      const knuckle = mesh(knuckleGeo, M.arm);
      knuckle.position.set(dir * 0.010, -0.148, 0);
      knuckle.rotation.z = dir * 0.10;
      f.add(knuckle);
      const tip = mesh(tipGeo, M.steel);
      tip.position.set(dir * 0.014, -0.228, -0.004);
      tip.rotation.z = dir * 0.22;
      f.add(tip);
      const pin = mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.072, 10), M.dark);
      pin.rotation.x = Math.PI / 2;
      f.add(pin);
      hand.add(f);
      fingers.push(f);
    }

    const thumb = new THREE.Group();
    thumb.position.set(0, -0.10, 0.080);
    thumb.rotation.x = -0.52;
    thumb.userData.base = 0.12;
    thumb.userData.dir = -1;
    const thumbJaw = mesh(fingerGeo, M.arm);
    thumbJaw.position.set(0, -0.045, 0);
    thumb.add(thumbJaw);
    const thumbKnuckle = mesh(knuckleGeo, M.arm);
    thumbKnuckle.position.set(0, -0.125, 0);
    thumb.add(thumbKnuckle);
    const thumbTip = mesh(tipGeo, M.steel);
    thumbTip.position.set(0, -0.19, 0.002);
    thumb.add(thumbTip);
    hand.add(thumb);
    fingers.push(thumb);

    return { group: arm, side, fingers, accent, bend };
  }

  arms.push(buildArm(-1), buildArm(1));

  // 切换手爪形状时重建双臂：先摘掉旧手臂与它的光带材质，再按新 clawType 重建。
  function rebuildArms() {
    for (const a of arms) {
      bodyGroup.remove(a.group);
      disposeGeometries(a.group);
      const idx = armAccents.indexOf(a.accent);
      if (idx >= 0) armAccents.splice(idx, 1);
      // 光带材质是每只手臂独有的一份，跟着手臂一起释放。
      a.accent.dispose();
    }
    arms.length = 0;
    arms.push(buildArm(-1), buildArm(1));
  }

  // ---- the speech bubble -------------------------------------------------
  // 静态的 "!" 升级成可重绘的文字气泡：谁需要你、出了什么错，一眼读到。
  const bubbleCanvas = document.createElement('canvas');
  bubbleCanvas.width = 256;
  bubbleCanvas.height = 128;
  const bubbleCtx = bubbleCanvas.getContext('2d');
  const bubbleTex = new THREE.CanvasTexture(bubbleCanvas);
  bubbleTex.colorSpace = THREE.SRGBColorSpace;
  bubbleTex.anisotropy = 4;
  const bubbleMat = new THREE.SpriteMaterial({
    map: bubbleTex, transparent: true, depthWrite: false, opacity: 0,
  });
  const bubble = new THREE.Sprite(bubbleMat);
  bubble.scale.set(0.84, 0.42, 1);
  bubble.position.set(0.94, 3.70, 0.55);
  robot.add(bubble);          // rides with him, so a turn does not leave it behind

  let bubbleText = null;
  // 临时提示（cc-switch 切换等）：气泡短暂显示，优先级低于出错/需要你。
  let noticeText = '';
  let noticeAt = -99;
  window.addEventListener('bao:ccswitch', () => {
    noticeText = '换模型啦';
    noticeAt = clock.t;
  });
  // 拖拽挣扎：被拖着走时手臂乱摆、眼睛睁大。
  let dragging = false;
  window.addEventListener('bao:drag', (e) => { dragging = !!(e.detail && e.detail.on); });
  function drawBubble(text) {
    bubbleText = text;
    const g = bubbleCtx;
    const w = bubbleCanvas.width;
    const h = bubbleCanvas.height;
    g.clearRect(0, 0, w, h);
    if (text) {
      const r = 24;
      const x0 = 6; const y0 = 6; const x1 = w - 6; const y1 = h - 14;
      g.beginPath();
      g.moveTo(x0 + r, y0);
      g.arcTo(x1, y0, x1, y1, r);
      g.arcTo(x1, y1, x0, y1, r);
      g.arcTo(x0, y1, x0, y0, r);
      g.arcTo(x0, y0, x1, y0, r);
      g.closePath();
      g.fillStyle = 'rgba(16,18,22,.94)';
      g.fill();
      g.lineWidth = 7;
      g.strokeStyle = '#ffffff';
      g.stroke();
      // 小尾巴，指向机器人
      g.beginPath();
      g.moveTo(56, y1 - 4);
      g.lineTo(40, h - 2);
      g.lineTo(88, y1 - 4);
      g.closePath();
      g.fillStyle = 'rgba(16,18,22,.94)';
      g.fill();
      g.fillStyle = '#ffffff';
      g.font = 'bold 46px system-ui, -apple-system, "Microsoft YaHei", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(text).slice(0, 6), w / 2, (y0 + y1) / 2 + 2);
    }
    bubbleTex.needsUpdate = true;
  }

  // ---- 生气火焰：error 时头顶 5 簇火苗（跳动 / 摇摆 / 闪烁 / 错峰）---------
  function fireTexture() {
    return canvasTexture(64, 96, (g, w, h) => {
      const grad = g.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, '#ffc800');
      grad.addColorStop(0.55, '#ff6400');
      grad.addColorStop(1, 'rgba(200,0,0,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(w / 2, 0);
      g.quadraticCurveTo(w * 0.96, h * 0.55, w / 2, h);
      g.quadraticCurveTo(w * 0.04, h * 0.55, w / 2, 0);
      g.fill();
    });
  }
  const fires = [];
  for (let i = 0; i < 5; i++) {
    const mat = new THREE.SpriteMaterial({
      map: fireTexture(), transparent: true, depthWrite: false, opacity: 0,
      blending: THREE.AdditiveBlending, color: 0xff8020,
    });
    const s = new THREE.Sprite(mat);
    s.scale.set(0.14, 0.24, 1);
    s.position.set((i - 2) * 0.17, 3.12, 0.10);
    s.visible = false;
    robot.add(s);
    fires.push({ sprite: s, mat, i });
  }

  // ---- 完成庆祝星星：done 瞬间从头顶冒出金色星点 ---------------------------
  const stars = [];
  const starTex = softTexture(64);
  for (let i = 0; i < 8; i++) {
    const mat = new THREE.SpriteMaterial({
      map: starTex, color: 0xffd54a, transparent: true, depthWrite: false, opacity: 0,
      depthTest: false,   // 星星在头部周围，关掉深度测试才不会被头壳挡住
      blending: THREE.AdditiveBlending,
    });
    const s = new THREE.Sprite(mat);
    s.scale.setScalar(0.12);
    s.visible = false;
    robot.add(s);
    stars.push({ sprite: s, mat, i });
  }

  // ---- 今日时长广告牌：一块带金边、时钟图标、辉光的立式招牌 -----------------
  const signCanvas = document.createElement('canvas');
  signCanvas.width = 320;
  signCanvas.height = 96;
  const signCtx = signCanvas.getContext('2d');
  const signTex = new THREE.CanvasTexture(signCanvas);
  signTex.colorSpace = THREE.SRGBColorSpace;
  const signMat = new THREE.SpriteMaterial({ map: signTex, transparent: true, depthWrite: false, opacity: 0 });
  const sign = new THREE.Sprite(signMat);
  sign.scale.set(1.15, 0.345, 1);
  sign.position.set(0.98, 3.32, 0.42);
  robot.add(sign);

  // 招牌后面的光晕：additive 金色，随呼吸脉动，让招牌像「点着灯」。
  const signGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softTexture(64), color: 0xffd54a, transparent: true, depthWrite: false, opacity: 0,
    depthTest: false, blending: THREE.AdditiveBlending,
  }));
  signGlow.scale.set(1.7, 0.62, 1);
  signGlow.position.copy(sign.position);
  robot.add(signGlow);

  let signText = '';
  let signShownAt = -99;
  let signMode = 'top';    // top 最多 / total 合计 / cycle 轮播 / off 关闭
  let signPos = 'right';   // right / left
  let signColor = '#ffd54a';   // 招牌描边 / 图标 / 辉光颜色
  let signShape = '圆角';       // 圆角 / 胶囊 / 方正
  window.addEventListener('bao:sign', (e) => {
    signMode = (e.detail && e.detail.mode) || 'top';
    signPos = (e.detail && e.detail.pos) || 'right';
    if (e.detail && e.detail.color) signColor = e.detail.color;
    if (e.detail && e.detail.shape) signShape = e.detail.shape;
  });
  const hexA = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };
  let drawnSign = { text: '', color: '', shape: '' };
  function drawSign(text) {
    // 文字、颜色、形状都没变就不重画（重绘 canvas 有成本，别每帧白画）。
    if (drawnSign.text === text && drawnSign.color === signColor && drawnSign.shape === signShape) return;
    drawnSign = { text, color: signColor, shape: signShape };
    signText = text;
    const g = signCtx;
    const w = signCanvas.width;
    const h = signCanvas.height;
    g.clearRect(0, 0, w, h);
    if (text) {
      // 形状：胶囊是超大半圆、方正是小圆角、圆角是默认。
      const r = signShape === '胶囊' ? h / 2 - 4 : signShape === '方正' ? 4 : 20;
      const inner = signShape === '胶囊' ? h / 2 - 12 : r - 8;
      // 面板：竖向渐变，比纯黑更有「招牌」的实体感
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#24272e');
      grad.addColorStop(1, '#15171b');
      g.beginPath();
      g.moveTo(r, 4);
      g.arcTo(w - 4, 4, w - 4, h - 4, r);
      g.arcTo(w - 4, h - 4, 4, h - 4, r);
      g.arcTo(4, h - 4, 4, 4, r);
      g.arcTo(4, 4, w - 4, 4, r);
      g.closePath();
      g.fillStyle = grad;
      g.fill();
      // 描边 + 内圈细线，像通电的灯箱（颜色跟着自定义走）
      g.lineWidth = 7;
      g.strokeStyle = signColor;
      g.stroke();
      g.lineWidth = 2;
      g.strokeStyle = hexA(signColor, 0.35);
      g.beginPath();
      g.moveTo(inner + 8, 10);
      g.arcTo(w - 10, 10, w - 10, h - 10, inner);
      g.arcTo(w - 10, h - 10, 10, h - 10, inner);
      g.arcTo(10, h - 10, 10, 10, inner);
      g.arcTo(10, 10, w - 10, 10, inner);
      g.closePath();
      g.stroke();
      // 时钟图标
      const cx = 36, cy = h / 2, cr = 15;
      g.beginPath(); g.arc(cx, cy, cr, 0, Math.PI * 2);
      g.lineWidth = 4; g.strokeStyle = signColor; g.stroke();
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx, cy - 9);
      g.moveTo(cx, cy); g.lineTo(cx + 7, cy + 2);
      g.lineWidth = 3; g.stroke();
      // 文字
      g.fillStyle = '#ffffff';
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      // 名字有长有短（DeepSeek / Claude Code），放不下就自动缩字号。
      let fontSize = 30;
      g.font = `bold ${fontSize}px system-ui, "Microsoft YaHei", sans-serif`;
      while (g.measureText(text).width > 240 && fontSize > 16) {
        fontSize -= 2;
        g.font = `bold ${fontSize}px system-ui, "Microsoft YaHei", sans-serif`;
      }
      g.fillText(text, 62, h / 2 + 1);
    }
    signTex.needsUpdate = true;
  }

  // ---- dust --------------------------------------------------------------
  const dustTex = softTexture(64);
  const dust = [];
  for (let i = 0; i < 4; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: dustTex, color: 0xc8d2de, transparent: true, depthWrite: false, opacity: 0, blending: THREE.AdditiveBlending,
    }));
    s.scale.set(0.16, 0.16, 1);
    scene.add(s);
    dust.push({ sprite: s, t: i / 4, side: i % 2 ? 1 : -1, y: 0.2 + (i * 0.13) });
  }

  // ---- 抛接小球（idle 自娱的第三种动作）----------------------------------
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 16, 12),
    new THREE.MeshStandardMaterial({
      color: 0xffcc00, emissive: 0x8a6600, emissiveIntensity: 0.5, metalness: 0.3, roughness: 0.4,
    }),
  );
  ball.visible = false;
  robot.add(ball);

  // ------------------------------------------------------------------ state
  // The scene never decides what state it is in. It reads the same DOM the
  // tests read, and takes its colour from the same CSS variable the DOM mirror
  // is painted with.
  const FALLBACK = { busy: '#34c759', waiting: '#ffcc00', error: '#ff3b30', done: '#b06bff', idle: '#dfe5ec', unknown: '#ccd3dc', offline: '#4a5058' };

  const theme = { agent: '', slots: [], live: null, agents: [] };
  const tint = new THREE.Color(FALLBACK.offline);
  const want = new THREE.Color(FALLBACK.offline);
  // The strip follows the software that spoke last, so it has its own colour and
  // its own fade — the aggregate lamp must not swallow it.
  const liveTint = new THREE.Color(FALLBACK.offline);
  const liveWant = new THREE.Color(FALLBACK.offline);

  window.addEventListener('bao:render', (e) => {
    const d = e.detail || {};
    theme.slots = d.slots || [];
    theme.live = d.live || null;
    theme.agents = Array.isArray(d.agents) ? d.agents : [];
    if (theme.live) liveWant.set(theme.live); else liveWant.copy(tint);
    if (d.agent !== theme.agent) {
      theme.agent = d.agent || '';
      drawName(theme.agent);
      nameCycle = 0;
    }
    planRing();
    syncSlots();
  });

  window.addEventListener('bao:brightness', (e) => {
    const b = e.detail && typeof e.detail.brightness === 'number' ? e.detail.brightness : 1;
    brightness = Math.max(0.5, Math.min(1, b));
    syncSlots();
  });

  // 底座灯效切换：只在 BASE_EFFECTS 里存在（或回到「状态色」）时生效。
  window.addEventListener('bao:effect', (e) => {
    const name = e.detail && e.detail.effect;
    if (name === '状态色' || BASE_EFFECTS[name]) baseEffect = name;
  });

  // 皮肤切换：重新生成身体主色与暗色的做旧纹理。
  window.addEventListener('bao:skin', (e) => {
    const name = e.detail && e.detail.skin;
    if (SKINS[name]) applySkin(name);
  });

  // 动作风格切换。
  // 眼睛配色 / 履带配色切换。
  window.addEventListener('bao:eyestyle', (e) => {
    const name = e.detail && e.detail.eyestyle;
    if (EYE_STYLES[name]) applyEyeStyle(name);
  });
  window.addEventListener('bao:trackstyle', (e) => {
    const name = e.detail && e.detail.trackstyle;
    if (TRACK_SKINS[name]) applyTrackSkin(name);
  });

  // 某个状态的手势切换（动作系统：每个状态可单独配手势）。
  window.addEventListener('bao:pose', (e) => {
    const st = e.detail && e.detail.state;
    const p = e.detail && e.detail.pose;
    if (STATE_KEYS.includes(st) && ARM_POSES[p]) statePoses[st] = p;
  });

  // 配件配色（手臂/手爪/镜筒）与手爪形状切换。
  window.addEventListener('bao:armskin', (e) => {
    const name = e.detail && e.detail.armskin;
    if (ARM_SKINS[name]) applyArmSkin(name);
  });
  window.addEventListener('bao:claw', (e) => {
    const name = e.detail && e.detail.claw;
    if (CLAW_TYPES[name] && name !== clawType) {
      clawType = name;
      rebuildArms();
    }
  });

  // 胳膊形状切换：重建手臂。
  window.addEventListener('bao:armtype', (e) => {
    const name = e.detail && e.detail.armtype;
    if (ARM_TYPES[name] && name !== armType) {
      armType = name;
      rebuildArms();
    }
  });

  // 头形状切换：重建眼睛。
  window.addEventListener('bao:headtype', (e) => {
    const name = e.detail && e.detail.headtype;
    if (HEAD_TYPES[name] && name !== headType) {
      headType = name;
      rebuildEyes();
    }
  });

  // 眼睛形状切换：重建眼睛。
  window.addEventListener('bao:eyeshape', (e) => {
    const name = e.detail && e.detail.eyeshape;
    if (EYE_SHAPES[name] && name !== eyeShape) {
      eyeShape = name;
      rebuildEyes();
    }
  });

  // 履带形状切换：重建履带。
  window.addEventListener('bao:tracktype', (e) => {
    const name = e.detail && e.detail.tracktype;
    if (TRACK_TYPES[name] && name !== trackType) {
      trackType = name;
      rebuildTracks();
    }
  });

  // 场景切换。
  window.addEventListener('bao:scene', (e) => {
    const name = e.detail && e.detail.scene;
    if (SCENES[name]) applyScene(name);
  });

  // 动效强度切换。
  window.addEventListener('bao:motion', (e) => {
    const name = e.detail && e.detail.motion;
    if (MOTION_LEVELS[name]) {
      motionLevel = name;
      if (SCENES[sceneType]) applyScene(sceneType);  // 重新应用粒子强度
    }
  });

  // 待机动作开关 + 频率。
  window.addEventListener('bao:idle', (e) => {
    if (typeof e.detail.on === 'boolean') idleActionsOn = e.detail.on;
    if (typeof e.detail.freq === 'number') idleFreq = e.detail.freq;
  });

  // 光环样式切换。
  window.addEventListener('bao:halo', (e) => {
    const name = e.detail && e.detail.halo;
    if (HALO_STYLES[name]) applyHalo(name);
  });

  // 体型切换。
  window.addEventListener('bao:body', (e) => {
    const name = e.detail && e.detail.body;
    if (BODY_TYPES[name]) applyBody(name);
  });

  // 铭牌自定义文字：空则显示主灯代表的软件名。
  window.addEventListener('bao:nameplate', (e) => {
    nameplateText = String(e.detail && e.detail.text || '').slice(0, 16);
  });

  function syncSlots() {
    for (let i = 0; i < bars.length; i++) {
      const s = theme.slots[i];
      const mat = bars[i];
      if (!s || !s.hex) {
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 0;
        mat.color.setHex(0x1e2228);
        continue;
      }
      mat.emissive.set(s.hex);
      mat.emissiveIntensity = (s.dim ? 0.35 : 1.9) * brightness;
      mat.color.set(s.hex);
      mat.color.multiplyScalar(0.22);
    }
  }

  // Which software owns which stretch of the base ring. Contiguous arcs, worst
  // state first: the machine that is holding up the desk gets the longest run
  // of light and the arc that chases. This is the whole answer to "one robot,
  // four harnesses" — the lamp aggregates, the strip narrates, the ring
  // attributes. Re-planned only when the roster changes, never per frame.
  function planRing() {
    const agents = theme.agents || [];
    if (!agents.length) {
      for (const l of ringLeds) { l.agent = null; l.rank = 0; l.dim = false; l.state = null; }
      return;
    }
    const share = Math.max(1, Math.floor(BASE_N / agents.length));
    let at = 0;
    for (let i = 0; i < agents.length && at < BASE_N; i++) {
      const a = agents[i];
      const n = i === agents.length - 1 ? BASE_N - at : Math.min(share, BASE_N - at);
      for (let k = 0; k < n; k++) {
        const l = ringLeds[(at + k) % BASE_N];
        l.agent = a.agent;
        l.rank = i;
        l.dim = !!a.dim;
        // Each arc remembers which software owns it and that software's own
        // state, plus where its arc starts and how long it is — enough to run a
        // chase inside a single arc instead of only across the whole ring.
        l.state = a.state;
        l.fresh = !!a.fresh;
        l.worst = !!a.worst;
        l.segStart = at;
        l.segLen = n;
        l.color.set(a.hex || FALLBACK.unknown);
      }
      at += n;
    }
    for (let i = at; i < BASE_N; i++) {
      const l = ringLeds[i];
      l.agent = null;
      l.rank = 0;
      l.state = null;
      l.color.setHex(0x2a3340);
    }
  }

  function cssColor(state) {
    const v = getComputedStyle(body).getPropertyValue('--state').trim();
    return v || FALLBACK[state] || FALLBACK.unknown;
  }

  // ------------------------------------------------------------------ pointer
  // A desktop robot has to notice you. The cursor is sampled in the main process
  // and pushed here, so it works while the window is click-through — and while
  // the cursor is on the far side of the screen, which is exactly when a robot
  // that looks up at you is worth having.
  const pointer = { x: 0, y: 0, w: 340, h: 330, seen: false, over: false, fromIpc: false };

  if (window.bao && window.bao.onCursor) {
    pointer.fromIpc = true;
    window.bao.onCursor((p) => {
      if (!p) return;
      pointer.x = p.x;
      pointer.y = p.y;
      if (p.w) pointer.w = p.w;
      if (p.h) pointer.h = p.h;
      pointer.seen = true;
    });
  }
  window.addEventListener('pointermove', (e) => {
    if (pointer.fromIpc) return;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.w = window.innerWidth;
    pointer.h = window.innerHeight;
    pointer.seen = true;
  });

  const raycaster = new THREE.Raycaster();
  const ndc = new V2();
  // A plane through the robot's chest: the cursor is a screen point, and this
  // turns it into a place in the scene the eyes can aim at.
  const pointerPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.4);
  const pointerHit = new THREE.Vector3();
  const robotBox = document.getElementById('robot');
  let hotBox = null;

  // The interactive rectangle, in the same pixels the cursor arrives in. It is
  // re-measured whenever the window resizes, because the stage is scaled.
  function measureHotBox() {
    if (!robotBox) return;
    const r = robotBox.getBoundingClientRect();
    hotBox = { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  function pointerTarget() {
    if (!pointer.seen || !pointer.w || !pointer.h) return null;
    ndc.set((pointer.x / pointer.w) * 2 - 1, -((pointer.y / pointer.h) * 2 - 1));
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray.intersectPlane(pointerPlane, pointerHit) ? pointerHit : null;
  }

  // ---- which part is under the cursor ------------------------------------
  // Two answers matter, and they are different requests:
  //   "you are pointing at my eyes" — eye contact. Head and barrels follow the
  //   cursor, the body stays put, or it feels like a turret instead of a pet.
  //   "you are pointing at my body" — show me around. The whole machine turns
  //   through the angle the cursor sits at, flanks and back included.
  // Cast against the hull and the two lenses only, and only every 120ms: a
  // per-frame raycast for a desk ornament is battery with no visible return.
  const hoverRay = new THREE.Raycaster();
  const hoverNDC = new V2();
  // 眼睛会被重建（换头型/换镜筒形状），所以这份命中列表也必须是活的：
  // 一旦缓存成常量，重建后它指着已经摘掉的旧镜片，悬停眼睛就再也不生效。
  let lensTargets = eyes.map((e) => e.face.children[0]);
  let hoverPart = null;
  let hoverAt = -1;

  function partUnderPointer() {
    if (!pointer.seen || !pointer.w || !pointer.h) return null;
    hoverNDC.set((pointer.x / pointer.w) * 2 - 1, -((pointer.y / pointer.h) * 2 - 1));
    hoverRay.setFromCamera(hoverNDC, camera);
    // 把手臂也算进来：摸到手时张手爪回应，比只认身体/眼睛更像「活的」。
    const hit = hoverRay.intersectObjects([hull, ...lensTargets, ...arms.map((a) => a.group)], true)[0];
    if (!hit) return null;
    if (hit.object === hull) return 'body';
    if (lensTargets.includes(hit.object)) return 'eye';
    let o = hit.object;
    while (o) {
      for (const a of arms) if (o === a.group) return 'hand';
      o = o.parent;
    }
    return null;
  }

  // ------------------------------------------------------------------ loop
  const clock = { last: performance.now(), t: 0 };
  const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;

  // ---- performance guard -------------------------------------------------
  // This window is on someone's desktop all day, so it is allowed to shed
  // pixels but never to stutter. The measured frame rate is published on
  // #bot[data-fps] — the acceptance check reads it, and a dropped frame rate
  // has a number instead of a feeling. If the machine cannot hold 24fps the
  // backing store drops to 1x and the dust stops; the lights, the ring and the
  // state colours never degrade, because a status robot that hides its state to
  // go faster has no reason to exist.
  const perf = { frames: 0, since: performance.now(), cap: 2.5, lite: false };

  let state = '';
  let dead = false;
  // 灯光亮度：只缩放发光件的强度，机器人本体材质不变，状态颜色与节奏仍可读。
  let brightness = 1;
  let wheelSpin = 0;
  let hotMeasured = -1;
  let pokeAt = -99;
  let greetAt = -99;
  let doneAt = -99;
  let crazyAt = -99;      // 三击彩蛋：原地抓狂转圈 + 抖动
  let activeAt = 0;       // 最近一次「有活」的时间（空闲太久会困倦）
  let comfortAt = -99;    // 长按安抚的起始时间
  let blinkAt = -99;       // 最近一次眨眼的起始时间
  let nextBlinkAt = 3;     // 下一次眨眼的随机时间
  let idleAction = 0;      // 待机小动作：0 无 / 1 张望 / 2 伸懒腰
  let idleActionAt = -99;  // 当前小动作的开始时间
  let idleNextAt = 6;      // 下一次小动作的触发时间
  let idlePlaying = 0;        // 上一帧正在演的自主动作（给降帧用：演的时候要流畅）
  let idleActionsOn = true;   // 待机小动作开关
  let idleFreq = 1.0;         // 待机动作频率倍率（慢 0.5 / 标准 1 / 快 2）
  // 人格：活泼 / 沉稳 / 话痨 / 害羞。首次随机固定，影响动作频率与情绪阈值。
  let personality = '活泼';
  const FREQ_BOOST = { 活泼: 1.4, 沉稳: 0.65, 话痨: 1.0, 害羞: 0.9 };
  let shyLookAt = -99;   // 被盯着看久了 → 害羞地别开视线
  let boredBubbleAt = -99;   // 无聊冒泡的防抖
  let nameCycle = 0;
  let nameShown = '';
  let nameplateText = '';   // 用户自定义铭牌文字，空则显示主灯代表的软件名

  // A click on the machine is a poke, not a command: it looks up, blinks and
  // hops once, then goes back to whatever it was doing.
  window.addEventListener('bao:poke', () => { pokeAt = clock.t; });
  // A double click is a greeting: both arms come up and wave for two seconds,
  // which is the only interaction here that is purely for the human.
  window.addEventListener('bao:greet', () => { greetAt = clock.t; });
  // A run finishing is busy → idle, which the server has no state for. Two
  // quick nods acknowledge it without borrowing the green that means "still
  // working", because a working colour on an idle robot is the one lie this
  // machine exists to prevent.
  window.addEventListener('bao:done', () => { doneAt = clock.t; });
  // 里程碑庆祝：合计工作满整小时时，复用「完成」的转圈 + 星星，并冒个气泡。
  window.addEventListener('bao:milestone', (e) => {
    doneAt = clock.t;
    const h = e.detail && e.detail.hours;
    if (h) { noticeText = `工作 ${h} 小时啦`; noticeAt = clock.t; }
  });
  // 三击彩蛋：原地抓狂（快速转两圈 + 抖动），纯彩蛋，不改变状态。
  window.addEventListener('bao:crazy', () => { crazyAt = clock.t; });
  // 长按安抚：按住机器人 1 秒，眯眼 + 轻微震动。
  window.addEventListener('bao:comfort', () => { comfortAt = clock.t; });
  // 陪伴天数：跨天时冒个气泡「陪你第 N 天啦」。
  window.addEventListener('bao:companion', (e) => {
    const d = e.detail && e.detail.days;
    if (d) { noticeText = `陪你第 ${d} 天啦`; noticeAt = clock.t; }
  });

  const pose = { bob: 0, roll: 0, yaw: 0, lean: 0, headYaw: 0, headPitch: 0, eye: 1, focus: 1 };

  function damp(current, target, rate, dt) {
    return current + (target - current) * (1 - Math.exp(-rate * dt));
  }

  function update(dt) {
    const t = (clock.t += dt);
    state = body.dataset.state || 'offline';
    dead = body.classList.contains('disconnected');

    const busy = !dead && state === 'busy';
    const waiting = !dead && state === 'waiting';
    const error = !dead && state === 'error';
    const finished = !dead && state === 'done';
    const idle = !dead && state === 'idle';
    const unknown = !dead && state === 'unknown';
    const off = dead || state === 'offline';

    // 有活就刷新「活跃时间」；空闲太久就会困。
    if (busy || waiting || error || finished) activeAt = t;

    // 困倦打哈欠：空闲超过 10 分钟，每 5 分钟眯眼仰头「打哈欠」一下。
    const yawnOn = !dead && !reduceMotion && (idle || off) && (t - activeAt > 600);
    const yawnPhase = yawnOn ? ((t - activeAt - 600) % 300) : -1;
    const yawn = yawnOn && yawnPhase < 2.6 ? Math.sin(Math.min(1, yawnPhase / 2.6) * Math.PI) : 0;

    // 思考：运行中偶尔歪头，像在琢磨。
    const thinkCycle = t % 7;
    const thinkTilt = busy && !reduceMotion && thinkCycle < 1.6 ? Math.sin((thinkCycle / 1.6) * Math.PI) * 0.12 : 0;

    // 安抚：长按后眯眼 + 轻微震动。
    const comfort = t - comfortAt;
    const comfortOn = !reduceMotion && comfort >= 0 && comfort < 2.2;
    const comfortShake = comfortOn ? Math.sin(comfort * 20) * 0.015 * (1 - comfort / 2.2) : 0;

    // ---- 人格 + 害羞 + 无聊
    // 每帧比对 dataset：配置是异步加载的，首帧可能还没拿到，不能只读一次。
    const wantPersonality = body.dataset.personality;
    if (wantPersonality && wantPersonality !== personality) personality = wantPersonality;
    // 害羞：被盯着看久了就不好意思地别开视线（害羞人格更早躲）。
    const shyThreshold = personality === '害羞' ? 2.5 : 4.5;
    if (pointer.over && !busy && !waiting && !error) {
      if (shyLookAt < 0) shyLookAt = t;
    } else {
      shyLookAt = -1;
    }
    const shyOn = shyLookAt >= 0 && (t - shyLookAt) > shyThreshold && !reduceMotion;
    // 无聊：空闲太久（30 分钟）偶尔蔫一下，并冒个泡。
    const boredOn = !dead && (idle || off) && (t - activeAt > 1800);
    const boredPhase = boredOn ? ((t - activeAt - 1800) % 240) : -1;
    const bored = boredOn && boredPhase < 3.0 ? Math.sin(Math.min(1, boredPhase / 3.0) * Math.PI) : 0;
    if (boredOn && boredPhase < 0.1 && (t - boredBubbleAt) > 200) {
      boredBubbleAt = t;
      noticeText = '有点无聊';
      noticeAt = t;
    }

    // ---- colour: one transition, same duration as the DOM's .3s fade
    want.set(cssColor(state));
    tint.lerp(want, 1 - Math.exp(-dt / 0.10));
    liveTint.lerp(liveWant, 1 - Math.exp(-dt / 0.12));

    // ---- body
    const bobTarget = reduceMotion ? 0
      : busy ? Math.sin(t * 3.9) * 0.013
        : waiting ? Math.abs(Math.sin(t * 5.2)) * 0.030
          : error ? Math.sin(t * 26) * 0.006
            : idle ? Math.sin(t * 1.37) * 0.012
              : 0;
    pose.bob = damp(pose.bob, bobTarget, 12, dt);

    const rollTarget = reduceMotion ? 0
      : error ? Math.sin(t * 24) * 0.012
        : busy ? Math.sin(t * 1.9) * 0.006
          : unknown ? Math.sin(t * 0.5) * 0.02
            : 0;
    pose.roll = damp(pose.roll, rollTarget, 14, dt);

    // ---- pointer: where is the human?
    // The interactive rect moves when the agent list appears or the stage is
    // scaled, and nothing resizes in a browser tab — so it is re-measured on a
    // timer as well as on resize.
    if (t - hotMeasured > 0.3) { hotMeasured = t; measureHotBox(); }
    if (t - hoverAt > 0.12) { hoverAt = t; hoverPart = partUnderPointer(); }

    const target = pointer.seen ? pointerTarget() : null;
    pointer.over = !!(target && hotBox &&
      pointer.x >= hotBox.x && pointer.x <= hotBox.x + hotBox.w &&
      pointer.y >= hotBox.y && pointer.y <= hotBox.y + hotBox.h);

    // Turn. With the cursor out on the desktop he leans toward it by a few
    // degrees; with the cursor on his body he turns through the angle it sits
    // at, so sweeping left to right walks him round and shows the flanks; with
    // the cursor on his eyes he holds still and lets the head do the work,
    // because a machine that spins when you make eye contact is not looking at
    // you, it is scanning you.
    //
    // The turn is capped at ±49° on purpose. Enough to bring a flank and part
    // of the back into view, but never so far that the chest lamp, the
    // instrument bay and the nameplate swing away — a status robot that hides
    // its own light while "showing you around" has stopped reporting. Capping
    // it to the head's own ±0.85 rad range also lets the neck fully undo the
    // turn, so the eyes stay locked on the cursor instead of swinging past it.
    const TURN_MAX = 0.85;   // rad ≈ 49°
    let yawTarget;
    if (hoverPart === 'eye' || hoverPart === 'hand') {
      yawTarget = 0;
    } else if (!target) {
      yawTarget = reduceMotion ? 0 : (idle || busy ? Math.sin(t * 0.42) * 0.045 : 0);
    } else if (pointer.over && hotBox) {
      // Quadratic ease: a dead zone near the centre so he holds his ground
      // while the cursor is over his middle, then turns harder near the edges.
      const rel = Math.max(-1, Math.min(1, (pointer.x - (hotBox.x + hotBox.w / 2)) / (hotBox.w * 0.5)));
      yawTarget = rel * Math.abs(rel) * TURN_MAX;
    } else {
      const rel = Math.max(-1, Math.min(1, (pointer.x / pointer.w) * 2 - 1));
      yawTarget = rel * 0.2;
    }
    const yawBefore = pose.yaw;
    pose.yaw = damp(pose.yaw, yawTarget, hoverPart === 'eye' || !pointer.over ? 4.5 : 3.0, dt);
    const yawDelta = pose.yaw - yawBefore;

    // Pointing at the body leans the whole machine toward the cursor: turning
    // alone reads as a turntable, and a small lean is what makes it feel like
    // it noticed. The lean pivots on the floor (rotation.x on the root group),
    // so the hull, the pedestal and the tracks tip together — sliding the hull
    // forward in z used to open a seam between it and the pedestal.
    const leanTarget = hoverPart === 'body' && !reduceMotion && !dead ? 0.03 : 0;
    pose.lean = damp(pose.lean, leanTarget, 6, dt);
    robot.rotation.x = pose.lean;

    // a poke gets one hop and a wide-eyed look, then it settles back
    const poke = t - pokeAt;
    // A double click is a greeting: both arms up for two seconds. Rise fast,
    // hold, fall — a wave that fades in and out reads as a machine restarting,
    // not as a machine waving.
    const greet = t - greetAt;
    const greeting = greet >= 0 && greet < 2.0;
    const greetRise = greeting ? Math.min(1, greet / 0.3) * (1 - Math.max(0, greet - 1.45) / 0.55) : 0;
    const done = t - doneAt;
    const doneNod = !reduceMotion && done >= 0 && done < 1.6 ? Math.sin(done * 9) * 0.07 * (1 - done / 1.6) : 0;
    const hop = poke >= 0 && poke < 0.85 ? Math.sin((poke / 0.85) * Math.PI) * 0.075 : 0;
    // 完成时原地转一圈 + 两下小跳：动作确认，不换颜色（绿只代表运行）。
    const doneSpin = !reduceMotion && done >= 0 && done < 1.4 ? Math.min(1, done / 1.4) * Math.PI * 2 : 0;
    const doneHop = !reduceMotion && done >= 0 && done < 1.4
      ? Math.abs(Math.sin(done * 9)) * 0.10 * (1 - done / 1.4) : 0;
    // 三击彩蛋：快速转两圈 + 高频抖动 + 短暂悬停（反重力）。
    const crazy = t - crazyAt;
    const crazySpin = !reduceMotion && crazy >= 0 && crazy < 2.2 ? (crazy / 2.2) * Math.PI * 4 : 0;
    const crazyShake = !reduceMotion && crazy >= 0 && crazy < 2.2
      ? Math.sin(crazy * 40) * 0.035 * (1 - crazy / 2.2) : 0;
    const crazyLift = !reduceMotion && crazy >= 0 && crazy < 2.2
      ? Math.sin(Math.min(1, crazy / 2.2) * Math.PI) * 0.55 : 0;
    // 低电量焦虑：额度 < 20% 时每 3.4 秒抖一下 + 低头，像在犹豫要不要停下来。
    // 只是动作，不占任何状态颜色。
    const fuelPct = Number(body.dataset.fuel);
    const lowFuel = !off && !dead && Number.isFinite(fuelPct) && fuelPct < 20;
    const anxiety = lowFuel && !reduceMotion
      ? (t % 3.4) < 0.55 ? Math.sin(((t % 3.4) / 0.55) * Math.PI) : 0
      : 0;

    // The whole machine turns, tracks included. Turning only the body looked
    // right in a side view and wrong everywhere else: the pedestal it sits on
    // showed its corners the moment it swung, and the body's corners walked
    // through the belts. A tracked machine turning in place is also just true.
    robot.position.y = pose.bob + hop + doneHop + crazyLift;
    robot.rotation.y = pose.yaw + doneSpin + crazySpin;
    bodyGroup.rotation.z = pose.roll + crazyShake + anxiety * 0.035 + comfortShake;

    // ---- head: aims at the cursor; the body only turns part of the way, so
    // the neck does the rest. Offline he droops — a dead robot that still
    // tracks you would be a lie about the state.
    let lookYaw = 0;
    let lookPitch = 0;
    if (target) {
      // Screen space, amplified. The window is 340px wide and covers about 13°
      // of the scene, and a head that turns 13° does not read as looking at
      // you — so the offset is measured against the window and the head is
      // allowed to swing most of the way round.
      const sx = Math.max(-1, Math.min(1, (pointer.x / pointer.w) * 2 - 1));
      const sy = Math.max(-1, Math.min(1, -((pointer.y / pointer.h) * 2 - 1)));
      lookYaw = Math.max(-0.85, Math.min(0.85, sx * 1.15 - pose.yaw));
      lookPitch = Math.max(-0.42, Math.min(0.42, -sy * 0.55));
    }

    // 动效强度缩放：省电缩小动作幅度，华丽放大，标准不变。
    // 提到这里声明：自主动作和手臂都要用，晚声明会踩 TDZ。
    const motionScale = MOTION_LEVELS[motionLevel] || 1.0;

    // 自主小动作：空闲时每隔几秒自己做点什么。
    // 旧条件要求「光标不可见才动」，而桌面版光标一直在下面推着，所以这套动作
    // 从来没触发过——机器人自然显得呆。现在只要鼠标没压在它身上就允许。
    // 空闲（有软件连着但没活）和「全离线」都算「醒着但没事干」：都允许自主小动作。
    // 真正断电（dead）时不动——那是唯一应该完全静止的状态。
    const awake = !dead && (idle || off);
    const idleAllowed = awake && idleActionsOn && !reduceMotion && !pointer.over && !greeting;
    if (idleAllowed) {
      if (idleAction === 0 && t >= idleNextAt) {
        idleAction = IDLE_ACTIONS[Math.floor(Math.random() * IDLE_ACTIONS.length)];
        idleActionAt = t;
      }
      if (idleAction > 0 && t - idleActionAt > (IDLE_DURATION[idleAction] || 3)) {
        idleAction = 0;
        // 频率倍率：快 = 间隔减半，慢 = 间隔翻倍；人格再叠一层（活泼更勤、沉稳更懒）。
        idleNextAt = t + (3.2 + Math.random() * 5.5) / ((idleFreq || 1) * (FREQ_BOOST[personality] || 1));
      }
    } else {
      idleAction = 0;
      // 被打断后别立刻又演一遍；等一小会儿再重新排。
      if (idleNextAt < t + 1.2) idleNextAt = t + 1.2;
    }
    idlePlaying = idleAction;

    const iv = idleAction ? t - idleActionAt : 0;
    const idleSway = idleAction === 1 ? Math.sin(iv * 2.0) * 0.5 : 0;      // 张望
    const idleStretch = idleAction === 2 ? Math.sin(iv * 1.6) * 0.4 : 0;   // 伸懒腰
    const idleShake = idleAction === 4                                        // 抖擞：快速小幅晃身
      ? Math.sin(iv * 24) * 0.022 * Math.sin(Math.min(1, iv / IDLE_DURATION[4]) * Math.PI) : 0;
    const idleLookHand = idleAction === 5                                     // 抬手，低头看自己的手爪
      ? Math.sin(Math.min(1, iv / IDLE_DURATION[5]) * Math.PI) : 0;
    const idlePatrol = idleAction === 6                                       // 原地转身巡视
      ? Math.sin(iv * 1.0) * 0.55 * Math.sin(Math.min(1, iv / IDLE_DURATION[6]) * Math.PI) : 0;
    const idleNod = idleAction === 7                                          // 点头致意
      ? Math.sin(iv * 7) * 0.10 * Math.sin(Math.min(1, iv / IDLE_DURATION[7]) * Math.PI) : 0;

    // 转身/抖擞要叠到车身上，而这两个值在上面赋值之后才算出来 —— 在这里补叠加。
    robot.rotation.y += idlePatrol * motionScale;
    bodyGroup.rotation.z += idleShake * motionScale;

    // 当前正在演哪个自主动作（空 = 没在演）。和 dataset.fps 一样，是给外部
    // 观测用的：没有它，这类「几秒一次、随机」的行为在测试里根本没法断言。
    const idleTag = idleAction ? String(idleAction) : '';
    if (host.dataset.idle !== idleTag) host.dataset.idle = idleTag;
    // 抛接：小球从胸前抛起再落回，双手交替接。
    const juggle = idleAction === 3 && !reduceMotion;
    if (juggle) {
      const k = Math.min(0.999, Math.max(0, (t - idleActionAt) / 3.2));
      ball.visible = true;
      ball.position.set(0, 1.75 + Math.sin(k * Math.PI) * 0.85, 0.62);
      ball.rotation.x = k * 9;
    } else {
      ball.visible = false;
    }

    // 断电才完全不看；离线仍然不追光标（那是「没在跑」该有的样子），
    // 但会跟着自主动作轻微巡视，不至于像块砖。
    const headYaw = dead ? 0
      : off ? idlePatrol * 0.55
      : target ? lookYaw
        : reduceMotion ? 0
          : busy ? Math.sin(t * 0.72) * 0.22
            : waiting ? Math.sin(t * 3.1) * 0.05
              : idle ? Math.sin(t * 0.34) * 0.13 + idleSway
                : unknown ? Math.sin(t * 0.42) * 0.06
                  : 0;
    // 待机时周期性瞄一眼「主灯」代表的软件（最要紧的那个槽位）。
    const mainSlot = Number(body.dataset.mainSlot);
    const glanceWindow = t % 9;
    const glanceOn = !dead && !reduceMotion && !pointer.over && (idle || off)
      && Number.isInteger(mainSlot) && mainSlot >= 0 && glanceWindow < 1.7;
    const glanceYaw = glanceOn ? (mainSlot - 3.5) * 0.14 * Math.sin((glanceWindow / 1.7) * Math.PI) : 0;
    const headPitch = off ? 0.22
      : greeting ? -0.14 + Math.sin(greet * 7) * 0.09
        : target ? lookPitch
          : error ? -0.10
            : finished ? Math.sin(t * 2.2) * 0.06
              : idle ? Math.sin(t * 0.5) * 0.045 : 0;
    pose.headYaw = damp(pose.headYaw, headYaw + glanceYaw + (shyOn ? 0.55 : 0), 6, dt);
    pose.headPitch = damp(pose.headPitch, headPitch + doneNod + idleNod - idleLookHand * 0.22 - anxiety * 0.12 - yawn * 0.18 - bored * 0.12, 6, dt);
    head.rotation.y = pose.headYaw;
    head.rotation.x = pose.headPitch;
    head.rotation.z = damp(head.rotation.z, (off ? 0.10 : unknown ? 0.12 : error ? -0.05 : 0) + thinkTilt, 6, dt);

    // ---- 天线：忙碌抖得快、空闲慢摇、出错乱颤，顶端小球跟着状态灯变色
    antennaTipMat.emissive.copy(tint);
    const antennaFreq = off ? 1.2 : error ? 16 : busy ? 6.5 : waiting ? 4.5 : 2.6;
    const antennaAmp = off ? 0.008 : error ? 0.09 : busy ? 0.055 : idle || unknown ? 0.032 : 0.02;
    antenna.rotation.z = Math.sin(t * antennaFreq) * antennaAmp;
    antenna.rotation.x = -0.16 + Math.sin(t * 2.2) * 0.035;
    antennaTipMat.emissiveIntensity = off ? 0.25 : (error ? 1.9 : 1.1 + Math.sin(t * antennaFreq) * 0.4);

    // ---- eyes: a blink is a squint, which is what these eyes can do
    let eye = 1;
    if (off) eye = 0.05;
    else if (error) eye = 0.55;
    else if (waiting) eye = 1.06;
    else if (unknown) eye = 1.20 + Math.sin(t * 3.5) * 0.06;   // 惊讶：瞳孔放大
    else if (finished) eye = 0.78;   // 完成：满足地眯一下（明显窄于运行的 1.0）
    if (poke >= 0 && poke < 0.7) eye = 1.22;
    if (dragging && !reduceMotion) eye = 1.24;   // 被拖着走：眼睛睁大
    if (yawn > 0.01) eye = 1 - yawn * 0.55;       // 打哈欠：眼睛闭起来
    if (comfortOn) eye = 0.5 + 0.15 * Math.sin(comfort * 6);   // 安抚：满足地半眯
    // 像人一样的眨眼：随机间隔 3–8s，快速闭合再睁开（闭合 45% / 睁开 55%），
    // 不再用固定周期——固定节奏读起来像计时器，随机间隔才像「活物」。
    if (!reduceMotion && (idle || unknown || busy)) {
      if (t >= nextBlinkAt) {
        blinkAt = t;
        nextBlinkAt = t + 3 + Math.random() * 5;
      }
    }
    if (blinkAt >= 0 && t - blinkAt < 0.28) {
      const p = (t - blinkAt) / 0.28;
      eye = p < 0.45 ? 1 - (p / 0.45) * 0.92 : ((p - 0.45) / 0.55) * 0.92;
    }
    // 开机动画：加载后约 1.1 秒内从「闭眼」缓缓睁眼，像个刚通电的机器。
    const boot = Math.max(0, 1 - t / 1.1);
    if (boot > 0) eye *= (1 - boot * 0.95);
    pose.eye = damp(pose.eye, eye, eye < pose.eye ? 26 : 12, dt);

    let focus = 1;
    if (waiting) focus = 0.8;
    if (error) focus = 0.62;
    if (off) focus = 0.4;
    pose.focus = damp(pose.focus, focus, 8, dt);

    // The barrels turn a little further than the neck can: that is the extra
    // half-second of attention that makes it read as a look rather than a
    // turret.
    const eyeExtraY = target ? Math.max(-0.26, Math.min(0.26, lookYaw - head.rotation.y)) : 0;
    const eyeExtraX = target ? Math.max(-0.20, Math.min(0.20, lookPitch - head.rotation.x)) : 0;

    for (const e of eyes) {
      e.group.rotation.y = damp(e.group.rotation.y, -e.side * 0.06 + eyeExtraY, 12, dt);
      e.group.rotation.x = damp(e.group.rotation.x, 0.05 + eyeExtraX, 12, dt);
      e.face.scale.y = pose.eye;
      // x and y only: scaling the iris in z would push it back inside the
      // face plate, which reads as an eye that has gone blank.
      e.look.scale.set(pose.focus, pose.focus, 1);
      // pupils drift together: a robot that looks around looks awake
      e.look.position.x = damp(e.look.position.x, reduceMotion ? 0 : (busy ? Math.sin(t * 0.61) * 0.012 : idle ? Math.sin(t * 0.33) * 0.008 : 0), 6, dt);
      e.look.position.y = damp(e.look.position.y, reduceMotion ? 0 : (idle ? Math.sin(t * 0.27) * 0.006 : 0), 6, dt);

      // ---- brow: the expression
      // Down and inward for a fault, up and outward for a question, level for
      // work. At 300px a squint alone just looks like a thin eye; a 4.8cm
      // visor plate that tilts is what makes the face legible from the desk.
      const browTilt = off ? 0 : error ? e.side * 0.46 : waiting ? -e.side * 0.20 : greeting ? -e.side * 0.28 : 0;
      const browLift = off ? -0.02 : error ? -0.014 : waiting || greeting ? 0.016 : 0;
      e.brow.rotation.z = damp(e.brow.rotation.z, browTilt, 10, dt);
      e.brow.position.y = damp(e.brow.position.y, 0.30 + browLift, 10, dt);
    }

    // ---- 流泪：error 时泪滴沿镜筒下方滑落、淡出，双眼错开循环 ----------------
    for (let i = 0; i < tearMeshes.length; i++) {
      const tm = tearMeshes[i];
      // error 是大哭（快、浓）；waiting 是焦急含泪（慢、淡、单滴）。
      if ((error || waiting) && !reduceMotion) {
        tm.visible = true;
        const speed = error ? 0.55 : 0.26;
        const phase = (t * speed + i * 0.5) % 1;
        tm.position.y = -0.30 - phase * 0.42;
        tm.material.opacity = (error ? 1.0 : 0.8) * (1 - phase * 0.75);
        tm.scale.setScalar((error ? 1.4 : 1.1) * (1 - phase * 0.35));
      } else {
        tm.visible = false;
      }
    }

    // the lit iris ring: the same colour as the chest lamp, a quarter of the
    // brightness — enough to say "awake", never enough to compete with the lamp
    eyeGlowMat.emissive.copy(tint);
    eyeGlowMat.emissiveIntensity = damp(eyeGlowMat.emissiveIntensity,
      (off ? 0.02
        : waiting ? 1.15 + Math.sin(t * 6.4) * 0.4
          : error ? 0.9 + (Math.sin(t * 19) > 0 ? 0.7 : 0)
            : busy ? 1.0 + Math.sin(t * 3.4) * 0.22
              : greeting ? 1.6
                : 0.55) * brightness, 10, dt);

    // error 时虹膜发红（怒目）：内圈从冷黑变成暗红发光，配合头顶火焰。
    M.irisInner.emissive.setHex(error ? 0xff1a00 : 0x000000);
    M.irisInner.emissiveIntensity = error ? (0.75 + Math.sin(t * 19) * 0.25) * brightness : 0;

    // ---- arms
    // Each state gets its own silhouette, not just a different tilt:
    //   working  — both booms down and pumping, fingers pinching
    //   waiting  — the right arm up and waving, left hand held out flat
    //   failed   — both arms clamped in and trembling
    //   idle     — hanging still
    //   greeting — both up and waving (double click)
    // One raised arm reads as "over here"; two raised arms reads as a cheer,
    // and a status light that cheers is noise.
    // 手臂与手爪：拟人化手势，左右臂不对称、节奏有快慢——
    //   error   = 双臂环抱胸前 + 颤抖 + 握拳（抱臂生气）
    //   waiting = 右臂举手挥手，左臂托下巴（思考）
    //   busy    = 双臂前伸交替泵动 + 手指交替张合（像敲键盘）
    //   done    = 双臂向两侧微张摊开（「完成了」）
    //   idle    = 自然垂放 + 偶尔轻晃
    // motionScale 已在上面（自主动作之前）声明。
    // 当前状态的手势（用户可配置），从手势库取参数。
    const poseName = statePoses[state] || statePoses.idle || '垂放';
    const armPose = ARM_POSES[poseName] || ARM_POSES['垂放'];
    const wave = armPose.fx === 'wave' && !reduceMotion ? Math.sin(t * 6.0) * 0.16 * motionScale : 0;
    // 手指张合：运行态随泵动一起开合（像敲键盘），出错态保持握拳，其余按手势基值。
    let curl = armPose.curl;
    if (armPose.fx === 'pump' && !reduceMotion) curl += Math.sin(t * 3.2) * 0.22 * motionScale;
    for (const a of arms) {
      const isRight = a.side > 0;
      const phase = isRight ? 0 : Math.PI;   // 左右臂相位错开，交替动作更拟人
      const raised = greeting ? greetRise : 0;

      // 抛接抬臂：phase 在本循环里已算好，提前声明到这里避免 TDZ。
      const juggleLift = juggle ? Math.max(0, Math.sin((t - idleActionAt) * 5.5 + phase)) * 0.5 : 0;

      // 手臂上下摆（rotation.z）
      let zTarget;
      if (greeting) {
        zTarget = a.side * (0.30 + greetRise * 0.55 + Math.sin(t * 9) * 0.07 * greetRise);
      } else {
        let z = armPose.z;
        if (armPose.fx === 'tremble') z += reduceMotion ? 0 : Math.sin(t * 24) * 0.09 * motionScale;
        if (armPose.fx === 'pump') z += reduceMotion ? 0 : Math.sin(t * 3.2 + phase) * 0.18 * motionScale;
        if (armPose.fx === 'wave' && isRight) z += wave;
        if (idle) z += idleStretch * (isRight ? 1 : 0.7) * motionScale;   // 伸懒腰：双臂抬一下
        if (juggle) z += juggleLift * motionScale;                        // 抛接：双手交替接球
        if (idleLookHand && isRight) z += idleLookHand * 1.05 * motionScale;  // 抬起右手端详
        if (dragging && !reduceMotion) z += Math.sin(t * 28 + phase) * 0.10 * motionScale;  // 拖拽挣扎
        zTarget = z * a.side;
      }
      // 颤抖要用更高的阻尼速率，否则 24Hz 的高频被慢阻尼平滑成「静止」。
      a.group.rotation.z = damp(a.group.rotation.z, zTarget, armPose.fx === 'tremble' ? 20 : greeting ? 12 : 9, dt);

      // 手臂前后摆（rotation.x）
      let xTarget;
      if (greeting) xTarget = -0.34 * raised;
      else {
        let x = armPose.x;
        if (armPose.fx === 'tremble') x += reduceMotion ? 0 : Math.sin(t * 24) * 0.05 * motionScale;
        if (armPose.fx === 'pump') x += reduceMotion ? 0 : Math.sin(t * 3.2 + phase) * 0.30 * motionScale;
        // 前后摆也要镜像：左右臂的本地坐标相同，同一个 x 会让两条胳膊朝同一方向
        // 摆（比如「环抱」变成两条臂平行前伸，而不是在胸前交叉）。乘 side 才对。
        xTarget = x * a.side;
      }
      a.group.rotation.x = damp(a.group.rotation.x, xTarget, armPose.fx === 'tremble' ? 20 : 8, dt);

      // 肘部弯曲（bend.rotation.z）
      let bendTarget;
      if (greeting) bendTarget = a.side * 1.20 * greetRise;
      else bendTarget = a.side * armPose.bend;
      a.bend.rotation.z = damp(a.bend.rotation.z, bendTarget, 10, dt);

      // the accent line on the boom carries the state colour at a brightness
      // that follows the lamp: working pulses, waiting holds, failed is steady
      a.accent.emissive.copy(tint);
      a.accent.emissiveIntensity = damp(a.accent.emissiveIntensity,
        (off ? 0.05
          : waiting ? 1.5
            : error ? 1.9
              : busy ? 2.3 + Math.sin(t * 3.4) * 0.8
                : greeting ? 2.6 : 0.9) * brightness, 8, dt);

      // each finger opens along its own dir, so the pair spreads apart and the
      // thumb opposes them: base + curl*dir is "open" for every digit
      const handHover = hoverPart === 'hand' && !reduceMotion;
      const open = greeting ? 0.36 * greetRise + 0.02 : handHover ? 0.55 : curl;
      for (const f of a.fingers) {
        f.rotation.z = damp(f.rotation.z, (f.userData.base || 0) + open * (f.userData.dir || 1), 14, dt);
      }
    }

    // ---- motion cues: treads and sprockets
    const crazyRun = crazy >= 0 && crazy < 2.2;
    const speed = crazyRun ? 5 : busy ? 1.55 : waiting ? 0 : error ? 0 : 0.12;
    // Forward drives every belt the same way; a turn drives the two belts
    // opposite ways (one runs forward, the other back), which is what a tracked
    // machine does when it steers. The steer term is folded in here so forward
    // motion and steering share one phase and can never fight over it.
    wheelSpin -= dt * speed * 2.2 + yawDelta * 3.2;
    for (const w of wheels) w.rotation.z = wheelSpin;
    for (const l of lugs) {
      // The double modulo keeps the phase in [0,1) even when steering makes the
      // net term negative — a negative phase would index profile[-N] and throw.
      l.phase = ((l.phase + dt * speed * 0.22 - yawDelta * 0.9 * l.side) % 1 + 1) % 1;
      updateLugs(l, l.phase);
    }

    // ---- track marquee: a chase along each belt in the state colour ---------
    // busy drives a fast chase, waiting a slow breath, error a hard strobe,
    // done/idle a lazy drift — the belt is never dark while the machine is on.
    // A long tail and high peak make the chase read as a smooth flow around the
    // belt, not a lone dot hopping between sparse LEDs.
    const trackHead = (busy ? t * 3.5 : waiting ? t * 1.2 : error ? 0 : t * 0.8);
    for (const tl of trackLeds) {
      let lvl = 0;
      if (!off) {
        if (error) {
          lvl = (Math.floor(t * 10) + tl.index) % 2 ? 1 : 0.1;
        } else {
          const head = trackHead % tl.total;
          const d = Math.min(Math.abs(tl.index - head), tl.total - Math.abs(tl.index - head));
          // 所有 LED 保留一个基础亮度，只有 head 附近更亮——否则整条灯带看起来
          // 是「一个点在跳」，大部分灯熄灭，跑马灯就缺了一段。
          lvl = Math.max(0.22, 1 - d / 6.0);
        }
        if (reduceMotion) lvl = 0.4;
      }
      tl.mat.emissive.copy(tint);
      tl.mat.emissiveIntensity = lvl * 6.5 * brightness;
    }

    // ---- lamp, glow, bubble
    // 空闲时灯光缓慢「呼吸」（1.1Hz），像在安静地待命，而不是死板的常亮。
    let lamp = off ? 0.02 : idle ? 0.66 + Math.sin(t * 1.1) * 0.16 : unknown ? 0.5 : 2.7;
    // 开机时灯光从暗到亮，和睁眼同步。
    if (boot > 0) lamp *= (1 - boot * 0.92);
    if (busy) lamp = 2.9 + Math.sin(t * 3.4) * 0.75;
    if (waiting) lamp = 1.6 + Math.sin(t * 6.4) * 1.5;
    if (error) lamp = 0.9 + (Math.sin(t * 19) > 0 ? 3.4 : 0.3);
    if (finished) lamp = 1.9 + Math.sin(t * 2.6) * 0.45;
    // two quick blinks on the state colour it already has: the nod's light
    if (done >= 0 && done < 1.5) lamp = 0.35 + (Math.sin(done * 11) > 0 ? 1.5 : 0.15);
    // Blinking is a motion cue; when motion is unwelcome, hold the light steady
    // at a level that still says which state the robot is in.
    if (reduceMotion) lamp = off ? 0.02 : busy || idle ? 1.4 : 2.2;

    lampMat.emissive.copy(tint);
    lampMat.emissiveIntensity = damp(lampMat.emissiveIntensity, lamp * brightness, 16, dt);
    lampGlowMat.color.copy(tint);
    lampGlowMat.opacity = damp(lampGlowMat.opacity, (off ? 0 : Math.min(1, lamp * 0.32)) * brightness, 10, dt);
    lampLight.color.copy(tint);
    lampLight.intensity = damp(lampLight.intensity, (off ? 0 : lamp * 0.62) * brightness, 12, dt);

    // ---- status strip: four rhythms, four states, no ambiguity
    for (let i = 0; i < strip.length; i++) {
      let level = 0;
      if (!off) {
        if (busy) {
          // a chase: two LEDs of tail running along the bar, over and over
          const head = (t * 7) % STRIP_N;
          const d = Math.abs(i - head);
          level = Math.max(0, 1 - Math.min(d, STRIP_N - d) / 1.4);
        } else if (waiting) {
          level = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * 4.2 - i * 0.55));
        } else if (error) {
          level = (Math.floor(t * 16) + i) % 2 === 0 ? 1 : 0.04;
        } else if (finished) {
          level = 0.6 + 0.25 * (0.5 + 0.5 * Math.sin(t * 2.6 - i * 0.3));
        } else if (unknown) {
          level = 0.22 + 0.22 * (0.5 + 0.5 * Math.sin(t * 1.7 + i * 0.6));
        } else {
          level = 0.16 + 0.16 * (0.5 + 0.5 * Math.sin(t * 1.2 - i * 0.35));
        }
      }
      strip[i].emissive.copy(tint);
      strip[i].emissiveIntensity = damp(strip[i].emissiveIntensity, level * 3.6 * brightness, 12, dt);
    }

    const glow = off ? 0 : idle ? 0.42 : unknown ? 0.32 : waiting ? 0.72 + Math.sin(t * 6.4) * 0.22
      : error ? 0.74 + Math.sin(t * 19) * 0.24 : finished ? 0.50 + Math.sin(t * 2.6) * 0.12
        : 0.58 + Math.sin(t * 3.4) * 0.12;
    poolMat.color.copy(tint);
    poolMat.opacity = damp(poolMat.opacity, glow * 1.45 * brightness, 8, dt);
    auraMat.color.copy(tint);
    auraMat.opacity = damp(auraMat.opacity, glow * 1.10 * brightness, 8, dt);

    // ---- base ring: one arc per software, each animating to ITS OWN state ----
    // The ring is four lamps at once, not a second copy of the aggregate lamp.
    // Every arc reads its own software's state and plays that state's rhythm,
    // so all four harnesses stay visible at the same time and none is hidden
    // behind the one that won the main lamp:
    //   error   — hard strobe in that arc's red
    //   waiting — a breath in that arc's amber
    //   busy    — a chase running inside that arc's green
    //   idle    — slow, dim, unlit-but-alive
    // With nothing connected it falls back to the ambient sweep in hues the
    // state colours never use.
    const hueT = reduceMotion ? 0.37 : t;
    const anyAgent = ringLeds.some((l) => l.agent);
    const fx = BASE_EFFECTS[baseEffect] || null;   // null = 状态色模式
    for (let i = 0; i < ringLeds.length; i++) {
      const l = ringLeds[i];
      let level = 0.1;
      if (!off) {
        if (fx) {
          // 用户选中的灯效：底座变成纯氛围灯，五颜六色流动（状态由仪表舱/列表承载）。
          const out = fx(i, t, BASE_N);
          const h = ((out[0] % 1) + 1) % 1;
          l.mat.emissive.setHSL(h, Math.max(0, Math.min(1, out[1])), Math.max(0, Math.min(1, out[2])));
          level = out[3];
        } else if (anyAgent && l.agent) {
          l.mat.emissive.copy(l.color);
          if (l.state === 'error') {
            level = (Math.floor(t * 10) + i) % 2 ? 2.4 : 0.3;
          } else if (l.state === 'waiting') {
            level = 1.3 + Math.sin(t * 5.0 - i * 0.55) * 0.7;
          } else if (l.state === 'busy') {
            // a fast wave with a phase offset per LED, so each arc shimmers even
            // before the shared rotating highlight passes over it
            level = 1.0 + Math.sin(t * 4.0 - i * 0.6) * 0.55;
          } else if (l.state === 'done') {
            // a run succeeded: a steady, satisfied pulse, clearly brighter than
            // idle but never the running green's chase
            level = 1.2 + Math.sin(t * 2.6 - i * 0.35) * 0.45;
          } else {
            level = l.dim ? 0.55 : 0.9;
          }
          // A change in the last 3 seconds briefly brightens its arc so the eye
          // is drawn to the software that just moved, without reshuffling order.
          if (l.fresh && !reduceMotion) level = Math.min(3.0, level + 0.8);
          // The arc that owns the main lamp stays a notch brighter, so "which
          // software is the lamp about" is also visible down on the ring.
          if (l.worst && !reduceMotion) level = Math.min(3.2, level + 0.5);
          if (reduceMotion) level = (l.state === 'error' || l.state === 'waiting') ? 1.6 : 1.2;
        } else {
          // no software, no claim: slow ambient sweep
          AMBIENT.setHSL(((hueT * 0.05) + i / BASE_N) % 1, 0.85, 0.58);
          l.mat.emissive.copy(AMBIENT);
          level = 0.5 + (reduceMotion ? 0 : 0.35 * (0.5 + 0.5 * Math.sin(hueT * 2.2 - i * 0.7)));
        }
        // 整圈彩虹流光：一个亮斑沿 16 段连续旋转、带拖尾，扫过处变成五颜六色
        // （颜色随位置 + 时间旋转），其余各段保持自己的状态色——既不单调，也不
        // 丢掉红黄绿的状态语义。
        if (!fx && !reduceMotion) {
          const ringHead = (t * 2.2) % BASE_N;
          const rotDist = Math.min(Math.abs(i - ringHead), BASE_N - Math.abs(i - ringHead));
          const rot = Math.max(0, 1 - rotDist / 4.5);
          if (rot > 0.02) {
            l.mat.emissive.setHSL((i / BASE_N + t * 0.12) % 1, 0.9, 0.62);
            level += rot * 2.6;
          }
        }
      }
      // Direct assignment, not damp: the ring is a fast light show (strobe,
      // chase, breath) and a slow damp averaged those rhythms into a steady
      // glow — which read as "the marquee is frozen". Lights follow instantly.
      l.mat.emissiveIntensity = (off ? 0 : level * 2.6) * brightness;
    }

    // The two desk halos follow the same story: the aggregate colour, plus the
    // colour of whatever spoke last, so the pool on the desk is never a third
    // opinion nobody can attribute.
    if (anyAgent) {
      haloA.color.copy(tint);
      haloB.color.copy(liveTint);
      haloA.opacity = damp(haloA.opacity, (off ? 0 : 0.52) * brightness, 6, dt);
      haloB.opacity = damp(haloB.opacity, (off ? 0 : 0.38) * brightness, 6, dt);
    } else {
      const hue = (hueT * 0.045) % 1;
      haloA.color.setHSL(hue, 0.92, 0.62);
      haloA.opacity = damp(haloA.opacity, (off ? 0 : 0.54 + (reduceMotion ? 0 : 0.10 * Math.sin(hueT * 1.3))) * brightness, 6, dt);
      haloB.color.setHSL((hue + 0.4) % 1, 0.95, 0.62);
      haloB.opacity = damp(haloB.opacity, (off ? 0 : 0.42 + (reduceMotion ? 0 : 0.10 * Math.sin(hueT * 1.7 + 1))) * brightness, 6, dt);
    }

    // ---- 场景粒子动画：雪花飘落、草/沙摇曳、星闪烁 --------------------------
    const partKind = SCENES[sceneType] && SCENES[sceneType].particle;
    if (partKind && !reduceMotion) {
      const pos = particleGeo.attributes.position.array;
      // 动效强度真正减少粒子：省电少更新/隐藏粒子，华丽用满，标准按比例。
      const visibleCount = Math.max(0, Math.floor(PARTICLE_N * (MOTION_LEVELS[motionLevel] || 1.0)));
      for (let i = visibleCount; i < PARTICLE_N; i++) pos[i * 3 + 1] = -100;  // 移出视野
      if (partKind === 'petal') {
        // 花瓣：轻、慢、飘摇——像纸片一样左右大幅摆动、前后翻转、缓缓落下。
        for (let i = 0; i < visibleCount; i++) {
          pos[i * 3 + 1] -= particleVel[i] * dt * 0.55;
          pos[i * 3] += Math.sin(t * 1.2 + i) * dt * 1.3;
          pos[i * 3 + 2] += Math.cos(t * 0.9 + i * 1.5) * dt * 0.9;
          if (pos[i * 3 + 1] < 0) {
            pos[i * 3 + 1] = 4.5 + Math.random();
            pos[i * 3] = (Math.random() - 0.5) * 7; pos[i * 3 + 2] = (Math.random() - 0.5) * 7;
          }
        }
      } else if (partKind === 'snow' || partKind === 'leaf' || partKind === 'bubble' || partKind === 'ember' || partKind === 'firefly' || partKind === 'rain') {
        for (let i = 0; i < visibleCount; i++) {
          // 火星/萤火虫上升（萤火虫更慢更轻），其余下落；雨下落最快、几乎不横飘
          const rise = partKind === 'ember' || partKind === 'firefly';
          const speed = partKind === 'rain' ? 5 : (partKind === 'firefly' ? 0.45 : 1);
          pos[i * 3 + 1] += (rise ? 1 : -1) * particleVel[i] * dt * speed;
          pos[i * 3] += Math.sin(t * 0.8 + i) * dt * (partKind === 'rain' ? 0.05 : (partKind === 'firefly' ? 0.7 : 0.4));
          // 下落的重置回顶部、上升的重置回底部。之前写反了：雪落到底却弹回地面，
          // 火星升到顶却钉在顶上，结果雪/火星都只在底部/顶部一格里闪。
          const lo = rise ? 0 : 4.5;
          if (rise ? pos[i * 3 + 1] > 5 : pos[i * 3 + 1] < 0) {
            pos[i * 3 + 1] = lo + Math.random();
            pos[i * 3] = (Math.random() - 0.5) * 7; pos[i * 3 + 2] = (Math.random() - 0.5) * 7;
          }
        }
        if (partKind === 'firefly') {
          // 萤火虫一明一暗地闪烁
          particleMat.opacity = (0.3 + 0.55 * (0.5 + 0.5 * Math.sin(t * 1.7))) * (MOTION_LEVELS[motionLevel] || 1.0);
        }
      } else if (partKind === 'grass') {
        for (let i = 0; i < visibleCount; i++) {
          pos[i * 3 + 1] = Math.abs(Math.sin(t * 1.5 + i)) * 0.35;  // 摇曳
        }
      } else if (partKind === 'sand') {
        for (let i = 0; i < visibleCount; i++) {
          pos[i * 3] += Math.sin(t * 0.7 + i) * dt * 0.3;           // 风卷沙
          pos[i * 3 + 1] = 0.05 + Math.abs(Math.sin(t * 1.2 + i)) * 0.1;
        }
      } else if (partKind === 'star') {
        particleMat.opacity = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(t * 2.0));
      }
      particleGeo.attributes.position.needsUpdate = true;
    }

    // 点缀随风摆动：树/草/珊瑚等轻微摇曳，场景有「风」而不只是静物。
    if (sceneProps.children.length && !reduceMotion) {
      for (const p of sceneProps.children) {
        if (p.userData.swayAmp) {
          p.rotation.z = Math.sin(t * 0.9 + p.userData.swayPhase) * p.userData.swayAmp;
          p.rotation.x = Math.sin(t * 0.7 + p.userData.swayPhase * 1.3) * p.userData.swayAmp * 0.6;
        }
      }
    }
    // 场景地面淡入：换场景后 opacity 从 0 缓升到 1，有「浮现」的过渡感。
    if (sceneGround.material.map) {
      sceneGround.material.opacity = damp(sceneGround.material.opacity, 1, 6, dt);
    }
    // 海面反光：海洋场景的地面自发光强度随波浪起伏。
    if (sceneType === '海洋' && !reduceMotion) {
      sceneGround.material.emissiveIntensity = 0.18 + 0.16 * (0.5 + 0.5 * Math.sin(t * 1.4)) + 0.06 * Math.sin(t * 3.7);
    }

    const urgent = !dead && (waiting || error);
    // 气泡说人话：出错 / 需要你 / 临时提示（切模型等）。文字变化时才重绘纹理。
    let bubbleWord = off ? '' : error ? '出错啦' : waiting ? '需要你' : '';
    if (!bubbleWord && !off && noticeText && (t - noticeAt) < 2.2) bubbleWord = noticeText;
    if (bubbleWord !== bubbleText) drawBubble(bubbleWord);
    bubbleMat.color.copy(tint);
    bubbleMat.opacity = damp(bubbleMat.opacity, bubbleWord ? 1 : 0, 9, dt);
    bubble.position.y = 3.70 + (reduceMotion ? 0 : Math.sin(t * 5.2) * 0.04);
    bubble.scale.set(
      damp(bubble.scale.x, bubbleWord ? 0.84 : 0.72, 10, dt),
      damp(bubble.scale.y, bubbleWord ? 0.42 : 0.36, 10, dt),
      1,
    );

    // ---- 今日时长广告牌：按模式显示某个软件的时长，带辉光 + 弹出动画
    const fmt = (m) => (m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 时 ${m % 60} 分`);
    let statsByAgent = {};
    try { statsByAgent = JSON.parse(body.dataset.stats || '{}'); } catch { /* 坏数据就当作没有 */ }
    let signLabel = '';
    if (signMode !== 'off' && !off) {
      const entries = Object.entries(statsByAgent);
      if (entries.length) {
        const sorted = [...entries].sort((a, b) => b[1] - a[1]);
        if (signMode === 'total') {
          let ev = null;
          try { ev = JSON.parse(body.dataset.events || '{}'); } catch { /* 无战绩数据 */ }
          const bits = [];
          if (ev && ev.done) bits.push(`完成 ${ev.done}`);
          if (ev && ev.error) bits.push(`出错 ${ev.error}`);
          const suffix = bits.length ? ` · ${bits.join(' · ')}` : '';
          signLabel = `合计 ${fmt(entries.reduce((a, [, m]) => a + m, 0))}${suffix}`;
        } else if (signMode === 'cycle') {
          const [name, min] = sorted[Math.floor(t / 4) % sorted.length];
          signLabel = `${name} ${fmt(min)}`;
        } else {
          const [name, min] = sorted[0];
          signLabel = `${name} ${fmt(min)}`;
        }
      }
    }
    if (signLabel && !signText) signShownAt = t;   // 从无到有：弹一下
    drawSign(signLabel);   // 内部对比文字/颜色/形状，没变化就直接返回
    const pop = signLabel && signShownAt >= 0 ? Math.max(0, 1 - (t - signShownAt) / 0.30) : 0;
    const popScale = 1 + pop * 0.22;
    signMat.opacity = damp(signMat.opacity, signLabel ? 1 : 0, 8, dt);
    sign.scale.set(1.15 * popScale, 0.345 * popScale, 1);
    sign.position.x = signPos === 'left' ? -0.98 : 0.98;
    sign.position.y = 3.32 + (reduceMotion ? 0 : Math.sin(t * 1.8) * 0.03);
    // 辉光：像通电灯箱一样呼吸，颜色跟着自定义走
    signGlow.material.color.set(signColor);
    signGlow.opacity = damp(signGlow.opacity, signLabel ? 0.35 + Math.sin(t * 3.2) * 0.15 : 0, 8, dt);
    signGlow.position.set(sign.position.x, sign.position.y - 0.02, sign.position.z);

    // ---- beacon mast -------------------------------------------------------
    // Same colour as the lamp, but visible over the shoulder and from behind,
    // which is the whole point of putting it up there. It blinks only while
    // something needs you: a lamp that blinks all day is a lamp nobody reads.
    bulbMat.emissive.copy(tint);
    bulbMat.emissiveIntensity = damp(bulbMat.emissiveIntensity,
      (off ? 0.02
        : waiting ? 2.4 + Math.sin(t * 6.4) * 1.6
          : error ? (Math.sin(t * 12) > 0 ? 3.2 : 0.4)
            : busy ? 2.2 + Math.sin(t * 3.4) * 0.8
              : 1.3) * brightness, 12, dt);

    // ---- nameplate: always names the software the main lamp is about --------
    // The lamp aggregates "the worst"; the plate under it says WHICH software.
    // No cycling — attribution must be readable without waiting for the next
    // name to come round. Each software's own name still lives in its pill.
    // If the user typed their own text, that wins over the software name.
    const plateText = (nameplateText || String(theme.agent || '')).slice(0, 16);
    if (plateText !== nameShown) {
      nameShown = plateText;
      drawName(plateText);
    }

    // ---- dust behind the treads while it works
    for (const d of dust) {
      d.t = (d.t + dt * (busy ? 0.55 : 0.12)) % 1;
      const k = d.t;
      d.sprite.position.set(d.side * (1.1 + k * 0.55), 0.10 + k * 0.5, -0.35 - k * 0.35);
      d.sprite.scale.setScalar(0.06 + k * 0.20);
      d.sprite.material.opacity = (busy || waiting) && !reduceMotion && !perf.lite
        ? (1 - k) * (busy ? 0.5 : 0.24) : 0;
      d.sprite.material.color.copy(tint);
    }

    // ---- 生气火焰：error 时头顶 5 簇火苗跳动 / 摇摆 / 闪烁 / 错峰
    for (const f of fires) {
      // 火焰是 error 的核心表情，不随性能降级关掉；只有「减少动效」才停。
      const on = error && !reduceMotion;
      f.sprite.visible = on;
      if (!on) { f.mat.opacity = 0; continue; }
      const ph = t * 5.0 + f.i * 0.8;
      f.sprite.position.set(
        (f.i - 2) * 0.17 + Math.sin(ph * 0.7) * 0.035,
        3.34 + Math.abs(Math.sin(ph)) * 0.12,
        0.10,
      );
      f.sprite.scale.set(
        0.16 + Math.sin(ph * 1.3) * 0.03,
        0.26 + Math.abs(Math.sin(ph)) * 0.10,
        1,
      );
      f.mat.opacity = (0.55 + Math.abs(Math.sin(ph * 1.7)) * 0.45) * brightness;
    }

    // ---- 完成庆祝：done 瞬间头顶金色星点向外向上散开并淡出
    for (const st of stars) {
      const on = !reduceMotion && done >= 0 && done < 1.4;
      st.sprite.visible = on;
      if (!on) { st.mat.opacity = 0; continue; }
      const ph = (done / 1.4) + st.i * 0.07;
      const ang = st.i * (Math.PI * 2 / 8) + 0.4;
      const rad = 0.12 + ph * 0.42;
      // y 控制在画面内：头顶 ~3.4，再往上就出画了
      st.sprite.position.set(Math.cos(ang) * rad, 3.05 + ph * 0.45, 0.24);
      st.sprite.scale.setScalar(0.13 + Math.sin(Math.min(1, ph) * Math.PI) * 0.09);
      st.mat.opacity = Math.min(1, 1.1 * (1 - ph / 1.6)) * brightness;
    }

    // ---- light power-down, the way the CSS filter powers the flat one down
    const dim = dead ? 0.16 : 1;
    key.intensity = 2.7 * dim;
    fill.intensity = 1.0 * dim;
    rim.intensity = 2.0 * dim;
    if (dead) {
      lampMat.emissiveIntensity = 0.02;
      lampLight.intensity = 0.0;
      poolMat.opacity = 0;
      auraMat.opacity = 0;
      bubbleMat.opacity = 0;
    }
  }

  function updateLugs(lug, phase) {
    const { profile, count, mesh: inst } = lug;
    const total = profile.length - 1;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3(1, 1, 1);
    const axis = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < count; i++) {
      const s = ((i / count) + phase) % 1;
      const f = s * total;
      const i0 = Math.floor(f);
      const i1 = (i0 + 1) % total;
      const a = profile[i0];
      const b = profile[i1];
      const k = f - i0;
      const x = a.x + (b.x - a.x) * k;
      const y = a.y + (b.y - a.y) * k;
      const len = Math.hypot(x, y) || 1;
      pos.set(x + (x / len) * 0.014, y + (y / len) * 0.014, 0);
      q.setFromAxisAngle(axis, Math.atan2(b.y - a.y, b.x - a.x));
      m.compose(pos, q, scale);
      inst.setMatrixAt(i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden) return;

    const dt = Math.min(0.05, Math.max(0.001, (now - clock.last) / 1000));
    // States that do not move much do not need 60 frames a second. This is a
    // window that is always on someone's desktop; it should not cost a fan.
    // 离线且没在演自主动作时，画面几乎是静止的，15fps 足够 —— 这窗口是常驻的，
    // 省下来的电是实打实的。一旦开始演动作，立刻回到 30fps 保证流畅。
    const active = state === 'busy' || state === 'waiting' || state === 'error';
    const fps = active ? 60
      : reduceMotion ? 8
        : (state === 'offline' && !idlePlaying) ? 15 : 30;
    if (now - clock.last < 1000 / fps - 1) return;
    clock.last = now;

    update(dt);
    renderer.render(scene, camera);

    // Measured, not assumed: the target above is a cadence, this is what the
    // GPU actually managed. One downgrade only — oscillating between quality
    // levels is more distracting than either level.
    perf.frames += 1;
    if (now - perf.since >= 1000) {
      const measured = Math.round((perf.frames * 1000) / (now - perf.since));
      perf.frames = 0;
      perf.since = now;
      host.dataset.fps = String(measured);
      if (!perf.lite && measured > 0 && measured < 24) {
        perf.lite = true;
        perf.cap = 1.25;
        resize();
      }
    }
  }

  function resize() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    // The size slider scales the stage with a CSS transform, which would blow a
    // 300px canvas up into a blurry 480px one. Scale the backing store with it:
    // "bigger" then means more pixels, not bigger pixels.
    const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--scale')) || 1;
    renderer.setPixelRatio(Math.min(perf.cap, Math.max(1, (window.devicePixelRatio || 1) * scale)));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    measureHotBox();
  }

  window.addEventListener('bao:scale', resize);

  if (window.ResizeObserver) new ResizeObserver(resize).observe(host);
  else window.addEventListener('resize', resize);

  resize();
  drawName('');
  syncSlots();

  // Adopt whatever the page rendered before this module finished loading.
  const initial = getComputedStyle(body).getPropertyValue('--state').trim();
  tint.set(initial || FALLBACK.offline);
  want.copy(tint);
  liveTint.copy(tint);
  liveWant.copy(tint);
  for (let i = 0; i < 8; i++) {
    const el = document.getElementById('slot' + i);
    if (el && el.style.fill) theme.slots[i] = { hex: el.style.fill, dim: el.dataset.state === 'idle' };
  }
  syncSlots();

  host.dataset.ready = '1';
  requestAnimationFrame(frame);
} else if (host) {
  // No GL context: the window must still say something true. The CSS fallback
  // lamp takes over rather than leaving a blank rectangle on the desktop.
  body.classList.add('no-webgl');
}
