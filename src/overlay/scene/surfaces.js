// 程序化纹理：所有「贴图」都是这里用 canvas 现画的 —— 没有图片文件，不下载。
//
// 每个函数都是纯的：给定名字/种子，返回一张 CanvasTexture。做旧质感（锈迹、
// 掉漆、划痕、泥点）也在这里，因为它是外观的一部分，不是机器人的行为。

import * as THREE from '../vendor/three.module.js';

// A canvas is the cheapest way to get crisp print on a machined panel: stripes,
// the dot-matrix wordmark, the engraved agent name, the "!" bubble.
export function canvasTexture(w, h, draw) {
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
export function sceneTexture(type) {
  const seedMap = { 雪地: 11, 草原: 22, 沙漠: 33, 星空: 44, 岩浆: 55, 樱花: 66, 海洋: 77, 森林: 88, 雨夜: 99, 工厂: 111, 雪夜: 123, 黄昏: 135, 极光: 147 };
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
    } else if (type === '黄昏') {
      // 黄昏：暖橙到紫的地面，落日的余晖洒在地上，带一点紫红的晚霞色调。
      g.fillStyle = '#8a4a3a'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 90; i++) blob(r() * w, r() * h, 12 + r() * 44, '200,110,70', 0.25 + r() * 0.35);
      for (let i = 0; i < 60; i++) blob(r() * w, r() * h, 10 + r() * 30, '120,60,90', 0.2 + r() * 0.3);
      speck('255,205,150', () => 0.3 + r() * 0.4, 120, 2.2);
    } else if (type === '极光') {
      // 极光：深色冰原 + 几条斜向的绿/紫光带，像头顶的极光映在地上。
      g.fillStyle = '#0a1418'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 9; i++) {
        const y0 = r() * h;
        const grad = g.createLinearGradient(0, y0, w, y0 + 90);
        grad.addColorStop(0, 'rgba(60,255,180,0)');
        grad.addColorStop(0.4, `rgba(${40 + r() * 40},${200 + r() * 55},${140 + r() * 60},${0.5 + r() * 0.3})`);
        grad.addColorStop(0.7, `rgba(${130 + r() * 60},${80 + r() * 60},230,${0.4 + r() * 0.25})`);
        grad.addColorStop(1, 'rgba(60,255,180,0)');
        g.fillStyle = grad; g.fillRect(0, y0 - 45, w, 135);
      }
      speck('200,255,230', () => 0.35 + r() * 0.5, 160, 2);
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
export function edgeFadeTexture(size = 256) {
  return canvasTexture(size, size, (g, w, h) => {
    const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.72, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  });
}

export function hazardTexture() {
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

export function softTexture(size = 128, stops = [[0, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]) {
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

export function wordmarkTexture() {
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


// A seeded PRNG, so the weathering lands in the same place on every launch:
// rust that rearranges itself between frames is a rendering bug, not a paint
// job.
export function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Seven hundred years of sun, dust and rain, painted into one 256px canvas:
// a dusty base, dirt blotches, rust blooming up out of the seams, streaks
// running down, and a few chips of bare metal. Flat, saturated yellow is what
// made the old robot read as a toy; the shape was never the whole problem.
// 只在本文件内被 paint() 使用：不导出，避免 API 面比实际需要大一圈。
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

export function paint(base, { seed = 1, amount = 1, repeat = [1, 1] } = {}) {
  const tex = weatherTexture(base, { seed, amount });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  return tex;
}

// 光环底圈纹理：一圈径向亮带，band 是亮带中心（0..1 归一化半径）。
export function ringTexture(band) {
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
export function haloTexture(style) {
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

// 生气火焰：error 时头顶的火苗形状，线性渐变从黄到透明红。
export function fireTexture() {
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
