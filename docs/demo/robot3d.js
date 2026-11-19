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
// 几何与纹理在 scene/ 下：它们是纯函数（进去是数字，出来是几何/贴图），
// 跟这个文件里的人偶动画没有关系。
import { roundedRectPoints, roundedPolygon, slab, mesh } from './scene/geometry.js';
import {
  canvasTexture, sceneTexture, edgeFadeTexture, hazardTexture, softTexture,
  wordmarkTexture, ringTexture, haloTexture, fireTexture, rng, paint,
} from './scene/surfaces.js';
// 外观色值的唯一真源（ui.js 的色块预览读的是同一份）。
import {
  SKIN_TONES, EYE_TONES, TRACK_TONES, ARM_TONES, DEFAULT_POSES,
} from './shared/palette.mjs';

const body = document.body;
const host = document.getElementById('bot');

const V2 = THREE.Vector2;

// ui.js 把「今日时长」「战绩」以 JSON 字符串放在 body.dataset 上（dataset 只能存
// 字符串）。渲染循环每帧都要读它们，所以按字符串内容缓存解析结果：内容没变就
// 复用上次那个对象，省掉每帧一次 JSON.parse。
const jsonCache = new Map();
function datasetJson(key) {
  const raw = body.dataset[key] || '';
  const hit = jsonCache.get(key);
  if (hit && hit.raw === raw) return hit.value;
  let value = {};
  try { value = raw ? JSON.parse(raw) : {}; } catch { value = {}; }
  jsonCache.set(key, { raw, value });
  return value;
}

// ------------------------------------------------------------------ materials

// The palette is the character: titanium paint over gunmetal, rust where the
// paint has worn through, and not one mirror-bright surface anywhere. Chrome
// reads as "new toy"; this robot reads as a machine that has been outside for years.
// 初始材质取 palette 的第一项（钛金白 / 默认黑瞳 / 黑履带 / 枪灰配件），
// 也就是 config 的出厂默认值 —— 免得同一组颜色在这里被抄第三遍。
const DEFAULT_SKIN = SKIN_TONES[0];
const DEFAULT_EYE = EYE_TONES[0];
const DEFAULT_TRACK = TRACK_TONES[0];
const DEFAULT_ARM = ARM_TONES[0];

const M = {
  yellow: new THREE.MeshStandardMaterial({ map: paint(DEFAULT_SKIN.hex, { seed: 3, repeat: [0.55, 0.72] }), metalness: 0.14, roughness: 0.66 }),
  yellowDark: new THREE.MeshStandardMaterial({ map: paint(DEFAULT_SKIN.dark, { seed: 5, amount: 1.2, repeat: [0.8, 0.8] }), metalness: 0.16, roughness: 0.7 }),
  metal: new THREE.MeshStandardMaterial({ map: paint('#77736a', { seed: 7, amount: 0.7, repeat: [0.9, 0.9] }), metalness: 0.6, roughness: 0.56 }),
  metalDark: new THREE.MeshStandardMaterial({ color: 0x4b4842, metalness: 0.65, roughness: 0.58 }),
  steel: new THREE.MeshStandardMaterial({ map: paint(DEFAULT_ARM.steel, { seed: 11, amount: 0.55, repeat: [1.6, 1.6] }), metalness: 0.74, roughness: 0.44 }),
  // the arms have to read against black rubber at 300px, so they are the one
  // bright surface left on the machine — worn aluminium, not chrome
  arm: new THREE.MeshStandardMaterial({ map: paint(DEFAULT_ARM.arm, { seed: 23, amount: 0.6, repeat: [1.4, 1.4] }), metalness: 0.5, roughness: 0.46 }),
  rust: new THREE.MeshStandardMaterial({ map: paint('#8a4a28', { seed: 13, amount: 0.8, repeat: [2, 2] }), metalness: 0.32, roughness: 0.8 }),
  dark: new THREE.MeshStandardMaterial({ color: DEFAULT_ARM.dark, metalness: 0.5, roughness: 0.62 }),
  black: new THREE.MeshStandardMaterial({ color: 0x141412, metalness: 0.4, roughness: 0.58 }),
  rubber: new THREE.MeshStandardMaterial({ color: DEFAULT_TRACK.rubber, metalness: 0.05, roughness: 0.95 }),
  rubberIn: new THREE.MeshStandardMaterial({ color: 0x121211, metalness: 0.02, roughness: 1.0 }),
  rubberHi: new THREE.MeshStandardMaterial({ color: DEFAULT_TRACK.hi, metalness: 0.22, roughness: 0.86 }),
  wheel: new THREE.MeshStandardMaterial({ map: paint('#7a4530', { seed: 17, amount: 0.9, repeat: [2, 2] }), metalness: 0.45, roughness: 0.62 }),
  wheelDark: new THREE.MeshStandardMaterial({ color: 0x45271b, metalness: 0.5, roughness: 0.66 }),
  // binocular glass, not ping-pong balls: near-black, glossy, with a catchlight
  lens: new THREE.MeshPhysicalMaterial({ color: DEFAULT_EYE.lens, metalness: 0.1, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.03 }),
  eyeBody: new THREE.MeshStandardMaterial({ map: paint(DEFAULT_ARM.eye, { seed: 19, amount: 0.5, repeat: [1.6, 1.6] }), metalness: 0.7, roughness: 0.45 }),
  // 只有 irisInner 真的被装到镜片里（M.iris 曾经是个没有挂到任何几何上的死材质）。
  irisInner: new THREE.MeshStandardMaterial({ color: EYE_TONES[0].iris, metalness: 0.45, roughness: 0.32 }),
  panel: new THREE.MeshStandardMaterial({ color: 0x17171a, metalness: 0.6, roughness: 0.6 }),
  glow: new THREE.MeshStandardMaterial({ color: 0x0c0e11, emissive: 0x34c759, emissiveIntensity: 1.6, roughness: 0.4 }),
  // 眼睛内部的小件（瞳孔、两点高光、泪滴）曾经在 buildEyes 里每次新建，
  // 而换头型时只释放几何 —— 每换一次就漏 4 个材质（三眼头 12 个）。放进共享
  // 表里之后，`disposeGeometries` 那句「材质是共享的」才真的是真的。
  pupil: new THREE.MeshStandardMaterial({ color: 0x07090c, roughness: 0.2 }),
  catchlight: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }),
  catchlightSmall: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }),
  tear: new THREE.MeshStandardMaterial({
    color: 0x9fd4ff, emissive: 0x1e4e78, emissiveIntensity: 0.5, transparent: true, opacity: 0.9, roughness: 0.08,
  }),
};

// ---- 做旧程度：锈迹/污渍/掉漆的强度倍率 ------------------------------------
// 出厂值 1，设置里 0（刚出厂的新漆）～1.5（战损）。只有「贴了做旧贴图」的那几块
// 材质参与，颜色和发光一概不动 —— 状态色在任何自定义下都必须是同一个意思。
// 每条记录都带着重画所需的全部参数（种子/基数/重复次数），所以重画是可逆的：
// 滑回 100% 拿到的一定是当初那张纹理，而不是「又叠了一层锈」。
const AGED = [
  { key: 'body', mat: M.yellow, base: DEFAULT_SKIN.hex, seed: 3, amount: 1, repeat: [0.55, 0.72] },
  { key: 'bodyDark', mat: M.yellowDark, base: DEFAULT_SKIN.dark, seed: 5, amount: 1.2, repeat: [0.8, 0.8] },
  { key: 'metal', mat: M.metal, base: '#77736a', seed: 7, amount: 0.7, repeat: [0.9, 0.9] },
  { key: 'steel', mat: M.steel, base: DEFAULT_ARM.steel, seed: 11, amount: 0.55, repeat: [1.6, 1.6] },
  { key: 'arm', mat: M.arm, base: DEFAULT_ARM.arm, seed: 23, amount: 0.6, repeat: [1.4, 1.4] },
  { key: 'rust', mat: M.rust, base: '#8a4a28', seed: 13, amount: 0.8, repeat: [2, 2] },
  { key: 'wheel', mat: M.wheel, base: '#7a4530', seed: 17, amount: 0.9, repeat: [2, 2] },
  { key: 'eyeBody', mat: M.eyeBody, base: DEFAULT_ARM.eye, seed: 19, amount: 0.5, repeat: [1.6, 1.6] },
];
let wearLevel = 1;
const agedEntry = (key) => AGED.find((a) => a.key === key);
// 只重画点名的几块（换皮肤只动车身两片），不点名就全部重画（改做旧程度）。
function repaintAged(keys) {
  for (const a of AGED) {
    if (keys && !keys.includes(a.key)) continue;
    const next = paint(a.base, {
      seed: a.seed, amount: a.amount, wear: wearLevel, repeat: a.repeat,
    });
    const prev = a.mat.map;
    a.mat.map = next;
    a.mat.needsUpdate = true;
    // 旧贴图要显式释放：不释放的话来回切换会一直吃显存。
    if (prev && prev !== next) prev.dispose();
  }
}
// ---- 皮肤系统：身体主色 + 暗色（门板/下板）可换，做旧纹理保留 --------------
const SKINS = Object.fromEntries(SKIN_TONES.map((t) => [t.name, { main: t.hex, dark: t.dark }]));
// 自定义配色只给一个主色，其余明暗在这里统一推导。返回 null 表示不是合法
// 十六进制 —— 调用方必须保留现状，别把机器人涂成默认色（那会让「选了什么」
// 和「看起来是什么」又一次对不上）。
const parseHex = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex == null ? '' : hex).trim());
  return m ? parseInt(m[1], 16) : null;
};
const toHex = (n) => `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
function darkenHex(hex, k = 0.72) {
  const n = parseHex(hex);
  if (n == null) return null;
  const f = (c) => Math.round(c * k);
  return toHex((f((n >> 16) & 255) << 16) | (f((n >> 8) & 255) << 8) | f(n & 255));
}
// 朝白色混：履齿高光、金属受光面都用它，比 multiplicative 的「提亮」更接近漆面。
function lightenHex(hex, k = 0.22) {
  const n = parseHex(hex);
  if (n == null) return null;
  const f = (c) => Math.round(c + (255 - c) * k);
  return toHex((f((n >> 16) & 255) << 16) | (f((n >> 8) & 255) << 8) | f(n & 255));
}
function applySkin(name, hex) {
  let main, dark;
  if (name === '自定义') {
    const base = parseHex(hex);
    if (base == null) return;       // 非法颜色：保持现状
    main = toHex(base);
    dark = darkenHex(main);
  } else {
    const s = SKINS[name] || SKINS[DEFAULT_SKIN.name];
    main = s.main;
    dark = s.dark;
  }
  // 只换这两片的底色与暗色，做旧程度沿用当前值（重画在 repaintAged 里统一做，
  // 顺带释放旧贴图 —— 来回换皮肤不会一直吃显存）。
  agedEntry('body').base = main;
  agedEntry('bodyDark').base = dark;
  repaintAged(['body', 'bodyDark']);
}

// ---- 眼睛配色：镜片 + 虹膜换色（表情的核心颜色） --------------------------
const EYE_STYLES = Object.fromEntries(EYE_TONES.map((t) => [t.name, { lens: t.lens, iris: t.iris }]));
function applyEyeStyle(name, hex) {
  let s;
  if (name === '自定义') {
    const iris = parseHex(hex);
    if (iris == null) return;
    // 镜片是虹膜外面那层黑玻璃：自己压暗，挑的颜色才真的「亮在里面」。
    s = { iris: toHex(iris), lens: darkenHex(toHex(iris), 0.45) };
  } else {
    s = EYE_STYLES[name] || EYE_STYLES['默认黑'];
  }
  // 镜片本身接近黑玻璃，换色几乎看不出来；真正被看见的是镜片里那圈虹膜，
  // 所以两者一起改，瞳色才真的「换色」而不是只换了一层反光。
  M.lens.color.set(s.lens);
  M.irisInner.color.set(s.iris);
}

// ---- 履带配色：橡胶 + 履带齿高光换色 --------------------------------------
const TRACK_SKINS = Object.fromEntries(TRACK_TONES.map((t) => [t.name, { rubber: t.rubber, hi: t.hi }]));
function applyTrackSkin(name, hex) {
  let s;
  if (name === '自定义') {
    const rubber = parseHex(hex);
    if (rubber == null) return;
    const base = toHex(rubber);
    s = { rubber: base, hi: lightenHex(base, 0.24) };
  } else {
    s = TRACK_SKINS[name] || TRACK_SKINS['黑'];
  }
  M.rubber.color.set(s.rubber);
  M.rubberHi.color.set(s.hi);
}

// ---- 配件配色：手臂金属 / 手爪 / 头镜筒一起换色 ----------------------------
const ARM_SKINS = Object.fromEntries(
  ARM_TONES.map((t) => [t.name, { arm: t.arm, steel: t.steel, dark: t.dark, eye: t.eye }])
);
function applyArmSkin(name, hex) {
  let s;
  if (name === '自定义') {
    const arm = parseHex(hex);
    if (arm == null) return;
    const base = toHex(arm);
    // 一块金属需要三个值：本体、受光面（钢）、背光面（暗）。都从主色推。
    s = { arm: base, steel: lightenHex(base, 0.14), dark: darkenHex(base, 0.32), eye: darkenHex(base, 0.42) };
  } else {
    s = ARM_SKINS[name] || ARM_SKINS['枪灰'];
  }
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
let clawType = '三指';

// ---- 胳膊形状：上臂造型可切换，切换时重建手臂 ------------------------------
const ARM_TYPES = { '双板': 'plate', '圆筒': 'cylinder', '桁架': 'truss' };
let armType = '双板';

// ---- 履带形状：轮廓可切换（圆角矩形 / 三角形 / 梯形），切换时重建履带 ------
const TRACK_TYPES = { '圆角矩形': 'rect', '三角形': 'tri', '梯形': 'trap' };
let trackType = '梯形';

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
  '黄昏': { texture: '黄昏', props: '灯笼', particle: 'ember', fog: 0x6a3a2e },
  '极光': { texture: '极光', props: '松树', particle: 'star', fog: 0x0a1418 },
};
let sceneType = '无';
let particleOpacity = 0;   // 当前场景粒子「不降动效时」的目标透明度（applyScene 记录）

// ---- 头形状：单眼（默认）/ 双筒 / 三眼（双目 + 额前传感器）------
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
let headType = '单眼';

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
// 五个状态各配一种手势（用户可改，存 config）。
const STATE_KEYS = ['error', 'waiting', 'busy', 'done', 'idle'];
let statePoses = { ...DEFAULT_POSES };

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
  // 但「three 自己会恢复」只对渲染状态成立：贴图句柄是驱动那边重新分配的，
  // 不把材质标脏的话，恢复后常常是一台没有纹理、没有发光的白模。恢复时把
  // 所有材质的贴图重新上传一次，再按当前尺寸重建 backing store。
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    scene.traverse((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) {
        for (const key of ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap']) {
          if (m[key]) m[key].needsUpdate = true;
        }
        m.needsUpdate = true;
      }
    });
    resize();
  }, false);

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
      // 树冠的三层共用同一个 Mleaf，按 mesh 释放会把它 dispose 三次。
      // 先按对象去重，再各释放一次。
      const geos = new Set();
      const mats = new Set();
      child.traverse((o) => {
        if (!o.isMesh) return;
        if (o.geometry) geos.add(o.geometry);
        if (o.material) mats.add(o.material);
      });
      for (const g of geos) g.dispose();
      for (const m of mats) if (m.dispose) m.dispose();
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
    // 这 7 个共享材质每次调用都新建；只有真的挂到物件上的才算「在用」。
    const usedMats = new Set();
    const place = (m, x, z, s = 1) => {
      m.position.set(x, 0, z);
      m.scale.setScalar(s);
      m.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true; o.receiveShadow = true;
        if (o.material) usedMats.add(o.material);
      });
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
      } else if (type === '灯笼') {
        // 黄昏的小灯笼：一根木杆挑起一盏暖橙色的灯，傍晚亮起来。
        const g = new THREE.Group();
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.024, 0.42, 8),
          new THREE.MeshStandardMaterial({ color: 0x5a3f2a, roughness: 0.9 }));
        post.position.y = 0.21;
        g.add(post);
        const lantern = new THREE.Mesh(new THREE.SphereGeometry(0.095, 14, 10),
          new THREE.MeshStandardMaterial({ color: 0xffb060, emissive: 0xff7a20, emissiveIntensity: 1.7, roughness: 0.55 }));
        lantern.scale.y = 1.15;
        lantern.position.y = 0.45;
        g.add(lantern);
        place(g, x, z, 0.9 + r() * 0.5);
      }
    }

    // 没被挂上去的那几个（松树场景用不到岩石、珊瑚、粉色花）当场释放：
    // 它们不在场景图里，下一轮 buildProps 的 traverse 永远遍历不到它们。
    for (const m of [Mwood, Mleaf, Msnow, Mrock, Mgreen, Mpink, Mcoral]) {
      if (!usedMats.has(m)) m.dispose();
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
    else if (s.particle === 'firefly') { particleMat.color.set(0xd9ff6a); particleMat.opacity = 0.85 * motionScale; particleMat.size = 0.045; }
    else if (s.particle === 'rain') { particleMat.color.set(0xa8c4e0); particleMat.opacity = 0.7 * motionScale; particleMat.size = 0.03; }
    else particleMat.opacity = 0;
    // 记下「不降动效时」的目标透明度，供 updateSceneParticles 每帧阻尼使用；
    // reduceMotion 时这里就置 0 —— 冻结在半空的雪花/星/火星是「画面卡住了一层
    // 悬浮点阵」，不是「少动」。
    particleOpacity = particleMat.opacity;
    if (reduceMotion) particleMat.opacity = 0;
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
    robot.scale.set(b.x, b.y, b.z);
  }

  // ---- 表面质感：只改金属度与粗糙度，颜色一根汗毛都不动 ---------------------
  // 「哑光 / 标准 / 精工」是在出厂数值上乘一个系数，基准值第一次见到某个材质时
  // 记下来 —— 否则连着切两次「精工」会把倍率越乘越亮，最后真成了亮银玩具。
  const FINISHES = {
    '哑光': { metal: 0.55, rough: 1.35 },
    '标准': { metal: 1, rough: 1 },
    // 精工是「刚上过油」，不是镀铬：即使开到最亮，车身的金属度也只有 0.2 上下，
    // 远不到那面会把桌面照出来的镜子 —— 那是玩具感最重的样子。
    '精工': { metal: 1.45, rough: 0.72 },
  };
  const MAT_BASE = new WeakMap();
  let finishName = '标准';
  function applyFinish(name) {
    finishName = FINISHES[name] ? name : '标准';
    const f = FINISHES[finishName];
    // 新漆比风化过的漆面更光滑一点：做旧程度也参与粗糙度（0% 最亮，100% 起不变）。
    const clean = 1 - 0.12 * Math.max(0, Math.min(1, 1 - wearLevel));
    robot.traverse((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) {
        // MeshPhysicalMaterial（镜片）也是 isMeshStandardMaterial，一并跟着走。
        if (!m || !m.isMeshStandardMaterial) continue;
        let base = MAT_BASE.get(m);
        if (!base) {
          base = { metalness: m.metalness, roughness: m.roughness };
          MAT_BASE.set(m, base);
        }
        m.metalness = Math.max(0, Math.min(1, base.metalness * f.metal));
        m.roughness = Math.max(0.02, Math.min(1, base.roughness * f.rough * clean));
      }
    });
  }
  window.addEventListener('bao:finish', (e) => {
    const name = e.detail && e.detail.finish;
    if (name) applyFinish(name);
  });
  // 做旧程度既改贴图也（轻微）改粗糙度，所以两件事一起做：重画八张做旧纹理，
  // 再在当前质感上重算反光。顺序不能反 —— 后者读的是新的 wearLevel。
  window.addEventListener('bao:wear', (e) => {
    const w = Number(e.detail && e.detail.wear);
    if (!Number.isFinite(w)) return;
    const next = Math.max(0, Math.min(1.5, w));
    // 启动时 UI 会把出厂值再发一次；贴图本来就是这一版，八张 256² 不必重画。
    if (Math.abs(next - wearLevel) < 0.005) return;
    wearLevel = next;
    repaintAged();
    applyFinish(finishName);
  });

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
  const HALO_STYLES = { '环形': 'ring', '圆形': 'disc', '星形': 'star', '无': 'none' };
  function applyHalo(style) {
    const tex = haloTexture(style);
    // 两块光环共用同一张贴图：先记下旧的那一张，再统一换掉。原来的循环
    // 在第一个材质上就把它 dispose 了，第二个材质又 dispose 一次 —— 同一张
    // 纹理被释放两次，three 的纹理计数会漂移，反复切样式后开始误删别的贴图。
    const old = haloA.map;
    for (const h of [haloA, haloB]) {
      h.map = tex;
      h.needsUpdate = true;
    }
    if (old && old !== tex) old.dispose();
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
  // 只属于某一条履带的材质（灯珠那一圈）。其余材质都是共享的 M.*，重建时
  // 千万不能跟着 dispose，否则整台机器会掉材质。
  const trackOwnedMaterials = [];

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
    // 三角形 = 「上窄下宽」的圆角三角轮廓（顶部一个小轮、底部两个大轮）；
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
      trackOwnedMaterials.push(mat);
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
  // 旧的一定要真的释放：每条履带里有 3 个 ExtrudeGeometry、几十个齿/轮/辐条
  // 几何，以及 34 个只属于这条灯带的材质。只 robot.remove() 的话，来回切几次
  // 形状就攒下几百个没人用的 GPU 对象，显存一路涨到标签页崩掉。
  function rebuildTracks() {
    for (const g of trackGroups) {
      robot.remove(g);
      g.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        // InstancedMesh 的实例矩阵是它自己的 buffer，也要还回去。
        if (o.isInstancedMesh) o.dispose();
      });
    }
    for (const m of trackOwnedMaterials) m.dispose();
    trackOwnedMaterials.length = 0;
    trackGroups.length = 0;
    // 清空与履带相关的动画条目
    lugs.length = 0;
    wheels.length = 0;
    trackLeds.length = 0;
    const nA = buildTrack(-1), nB = buildTrack(1);
    trackGroups.push(nA, nB);
    robot.add(nA, nB);
    // 新履带带着新材质（灯带、链轮）：把当前质感再套一遍，否则换一次形状，
    // 这条履带的金属度就会悄悄回到出厂值。
    applyFinish(finishName);
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
  // 逻辑尺寸 512×96，画布按 SS 倍超采样：渲染器把像素比开到 2，1× 的贴图在
  // HiDPI 屏上会明显发虚，而旁边的招牌早就是 2× 了 —— 同一屏上不该一半锐一半糊。
  const NAME_W = 512;
  const NAME_H = 96;
  const NAME_SS = 2;
  const nameCanvas = document.createElement('canvas');
  nameCanvas.width = NAME_W * NAME_SS;
  nameCanvas.height = NAME_H * NAME_SS;
  const nameCtx = nameCanvas.getContext('2d');
  nameCtx.setTransform(NAME_SS, 0, 0, NAME_SS, 0, 0);
  const nameTex = new THREE.CanvasTexture(nameCanvas);
  nameTex.colorSpace = THREE.SRGBColorSpace;
  nameTex.anisotropy = 4;
  const namePlate = new THREE.Mesh(
    new THREE.PlaneGeometry(0.52, 0.098),
    new THREE.MeshBasicMaterial({ map: nameTex, transparent: true, depthWrite: false, opacity: 0.9 })
  );
  namePlate.position.set(BAY.x, 1.70, frontOf(hull, 0.004));
  bodyGroup.add(namePlate);

  // 铭牌画布 512×96，50px 等宽字体只够 16 个半角字符。中文一个字就是一个
  // 全角宽度，16 个汉字要 800px —— 原来那句 slice(0, 16) 让长名字的右半边
  // 直接被画布裁掉，而且裁得毫无提示。这里按实际宽度缩字号，缩到底才省略。
  function drawName(name) {
    const full = [...String(name || '')].join('');
    nameCtx.clearRect(0, 0, NAME_W, NAME_H);
    nameCtx.fillStyle = '#3a3016';
    nameCtx.textBaseline = 'middle';
    const maxW = NAME_W - 16;
    const fontOf = (px) => `600 ${px}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    let size = 50;
    let shown = full;
    nameCtx.font = fontOf(size);
    while (size > 22 && nameCtx.measureText(shown).width > maxW) {
      size -= 2;
      nameCtx.font = fontOf(size);
    }
    if (nameCtx.measureText(shown).width > maxW) {
      let chars = [...shown];
      while (chars.length > 1 && nameCtx.measureText(chars.join('') + '…').width > maxW) chars = chars.slice(0, -1);
      shown = chars.join('') + '…';
    }
    nameCtx.fillText(shown, 8, 50);
    nameTex.needsUpdate = true;
    namePlate.visible = !!full;
    nameShown = full;
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

  // ---- 勋章：左胸一枚金色勋章（蓝缎带 + 圆章），像个立过功的老兵 ---------------
  const medal = new THREE.Group();
  medal.position.set(-0.42, 1.82, frontOf(hull, 0.012));
  bodyGroup.add(medal);
  const medalGold = new THREE.MeshStandardMaterial({ color: 0xe0b23a, roughness: 0.3, metalness: 0.85 });
  const medalRibbon = mesh(new THREE.BoxGeometry(0.13, 0.15, 0.012), new THREE.MeshStandardMaterial({ color: 0x2f6bd9, roughness: 0.7 }));
  medalRibbon.position.y = 0.085;
  medal.add(medalRibbon);
  const medalDisc = mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.014, 22), medalGold);
  medalDisc.rotation.x = Math.PI / 2;
  medal.add(medalDisc);
  const medalStar = mesh(new THREE.TorusGeometry(0.03, 0.008, 6, 5), medalGold);
  medalStar.position.z = 0.012;
  medal.add(medalStar);

  // ---- 贝雷帽：一顶歪戴的软帽，顶上一个小揪，很有艺术家的味道 ------------------
  const beret = new THREE.Group();
  beret.position.set(0.06, 0.47, 0.02);
  beret.rotation.z = 0.22;
  head.add(beret);
  const beretMat = new THREE.MeshStandardMaterial({ color: 0x2a3a5a, roughness: 0.85 });
  const beretDome = mesh(new THREE.SphereGeometry(0.37, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), beretMat);
  beretDome.scale.set(1, 0.46, 1);
  beret.add(beretDome);
  const beretNub = mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.055, 8), beretMat);
  beretNub.position.y = 0.16;
  beret.add(beretNub);

  // 装饰：无 / 天线 / 安全帽 / 皇冠 / 眼镜 / 墨镜 / 围巾 / 背包 / 礼帽 / 领结 / 勋章 / 贝雷帽。
  const DECORATIONS = ['无', '天线', '安全帽', '皇冠', '眼镜', '墨镜', '围巾', '背包', '礼帽', '领结', '勋章', '贝雷帽'];
  function setDecoration(name) {
    antenna.visible = name === '天线';
    hat.visible = name === '安全帽';
    crown.visible = name === '皇冠';
    glasses.visible = name === '眼镜';
    sunglasses.visible = name === '墨镜';
    scarf.visible = name === '围巾';
    backpack.visible = name === '背包';
    tophat.visible = name === '礼帽';
    bowtie.visible = name === '领结';
    medal.visible = name === '勋章';
    beret.visible = name === '贝雷帽';
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
    const cfg = HEAD_TYPES[headType] || HEAD_TYPES['单眼'];
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

    const pupil = mesh(new THREE.CircleGeometry(0.062, 32), M.pupil);
    pupil.position.z = 0.002;
    look.add(pupil);

    // two catchlights, not one: that is what makes glass read as glass
    const spec = new THREE.Mesh(new THREE.CircleGeometry(0.030, 20), M.catchlight);
    spec.position.set(-0.072, 0.078, 0.004);
    look.add(spec);
    const spec2 = new THREE.Mesh(new THREE.CircleGeometry(0.011, 14), M.catchlightSmall);
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
    const tear = mesh(new THREE.SphereGeometry(0.032, 12, 10), M.tear, { cast: false });
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
    applyFinish(finishName);
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
    const claw = CLAW_TYPES[clawType] || CLAW_TYPES['三指'];
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
    applyFinish(finishName);
  }

  // ---- the speech bubble -------------------------------------------------
  // 静态的 "!" 升级成可重绘的文字气泡：谁需要你、出了什么错，一眼读到。
  // 同铭牌：逻辑 256×128，画布 2× 超采样，HiDPI 下气泡里的字才不发虚。
  const BUBBLE_W = 256;
  const BUBBLE_H = 128;
  const BUBBLE_SS = 2;
  const bubbleCanvas = document.createElement('canvas');
  bubbleCanvas.width = BUBBLE_W * BUBBLE_SS;
  bubbleCanvas.height = BUBBLE_H * BUBBLE_SS;
  const bubbleCtx = bubbleCanvas.getContext('2d');
  bubbleCtx.setTransform(BUBBLE_SS, 0, 0, BUBBLE_SS, 0, 0);
  const bubbleTex = new THREE.CanvasTexture(bubbleCanvas);
  bubbleTex.colorSpace = THREE.SRGBColorSpace;
  bubbleTex.anisotropy = 4;
  const bubbleMat = new THREE.SpriteMaterial({
    map: bubbleTex, transparent: true, depthWrite: false, opacity: 0,
  });
  const bubble = new THREE.Sprite(bubbleMat);
  bubble.scale.set(0.84, 0.42, 1);
  bubble.position.set(0.94, 3.56, 0.55);
  // 和广告牌一样挂在场景里：体型缩放（修长 y=1.15）会把气泡顶出画面，
  // 而「说出来的话」被裁掉比没有气泡更糟。位置由 update 按牌子的另一侧摆。
  scene.add(bubble);

  let bubbleText = null;
  // 气泡此刻在机器人哪一侧：决定了小尾巴朝哪边指（见 drawBubble）。
  let bubbleSide = 'right';
  // 临时提示（cc-switch 切换等）：气泡短暂显示，优先级低于出错/需要你。
  let noticeText = '';
  let noticeAt = -99;
  // 台词：设置里写的那几句（空串 = 内置）。取值和语音共用 ui.js 里的同一个函数，
  // 这里只负责把气泡上的字换掉 —— done 不冒泡，那句只走语音。
  const PHRASE_KEYS = ['waiting', 'error', 'done'];
  const phrases = { waiting: '', error: '', done: '' };
  window.addEventListener('bao:phrase', (e) => {
    const d = e.detail || {};
    if (!PHRASE_KEYS.includes(d.state)) return;
    phrases[d.state] = String(d.text || '').slice(0, 10);
  });
  // 「试一句」：走临时提示通道，2.2 秒后自己消失，不改变任何状态。
  window.addEventListener('bao:say', (e) => {
    const text = String((e.detail && e.detail.text) || '').slice(0, 10);
    if (!text) return;
    noticeText = text;
    noticeAt = clock.t;
  });
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
    const w = BUBBLE_W;
    const h = BUBBLE_H;
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
      // 小尾巴，指向机器人。气泡在左边时尾巴在右下，否则在左下。
      g.beginPath();
      if (bubbleSide === 'left') {
        g.moveTo(w - 56, y1 - 4);
        g.lineTo(w - 40, h - 2);
        g.lineTo(w - 88, y1 - 4);
      } else {
        g.moveTo(56, y1 - 4);
        g.lineTo(40, h - 2);
        g.lineTo(88, y1 - 4);
      }
      g.closePath();
      g.fillStyle = 'rgba(16,18,22,.94)';
      g.fill();
      g.fillStyle = '#ffffff';
      // 自适应字号：256px 宽的气泡上，46px 只装得下 6 个汉字。自定义台词最多 10 字，
      // 原来那句 slice(0, 6) 会把用户写的话拦腰截断，而且看不出被截了。
      // 先缩字号（最小 20px），实在放不下才截断并补一个省略号 —— 省略号至少诚实。
      const maxW = w - 44;
      const fontOf = (px) => `bold ${px}px system-ui, -apple-system, "Microsoft YaHei", sans-serif`;
      let size = 46;
      let shown = [...String(text)].join('');
      g.font = fontOf(size);
      while (size > 20 && g.measureText(shown).width > maxW) {
        size -= 2;
        g.font = fontOf(size);
      }
      if (g.measureText(shown).width > maxW) {
        let chars = [...shown];
        while (chars.length > 1 && g.measureText(chars.join('') + '…').width > maxW) chars = chars.slice(0, -1);
        shown = chars.join('') + '…';
      }
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(shown, w / 2, (y0 + y1) / 2 + 2);
    }
    bubbleTex.needsUpdate = true;
  }

  // ---- 生气火焰：error 时头顶 5 簇火苗（跳动 / 摇摆 / 闪烁 / 错峰）---------
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
  // 招牌的位置必须按**相机画面**算，而不是按机器人体型算。
  //
  // 原来它挂在 `robot` 组上，而体型（Q版/修长）会缩放这个组：Q版 x=1.14、
  // y=0.86，牌子的中心和尺寸一起被放大 —— 右边缘被推出画面，顶边更是在默认
  // 体型下就已经贴到 y=1.00（正好被裁掉一条边）。「把牌子做大」于是变成
  // 「换个体型就出画」。
  //
  // 现在它挂在场景上（不跟随机身缩放、转身、点头），位置取到画面内仍有余量
  // 的一组值。按当前相机（fov 26，340×330）投影四个角：
  //   右 0.85 / 左 -0.85 / 上 0.86 / 下 0.64（NDC，±1 为画面边缘）
  // 弹跳动画再放大 10% 也只有 0.89，两边都留得住。
  //   左边缘 = 1.18 - 0.75 = 0.43u，在双筒右沿（0.5）之外，不压眼睛；
  //   底边 = 3.30 - 0.225 = 3.075u，高过双筒顶（约 3.05）与装饰（约 3.4）之上。
  const SIGN_W = 1.5;
  const SIGN_H = 0.45;
  const SIGN_X = 1.18;
  const SIGN_Y = 3.30;
  // 2 倍超采样：170% 缩放 + HiDPI 时这块招牌占约 260 设备像素，320px 的纹理
  // 只够 1:1，稍微一放大就靠插值撑开，字边全是毛的。坐标仍然按 320×96 的旧
  // 逻辑写，靠 drawSign 里的 setTransform 整体放大，布局一个像素都不用动。
  const SIGN_SS = 2;
  const signCanvas = document.createElement('canvas');
  signCanvas.width = 320 * SIGN_SS;
  signCanvas.height = 96 * SIGN_SS;
  const signCtx = signCanvas.getContext('2d');
  const signTex = new THREE.CanvasTexture(signCanvas);
  signTex.colorSpace = THREE.SRGBColorSpace;
  const signMat = new THREE.SpriteMaterial({ map: signTex, transparent: true, depthWrite: false, opacity: 0 });
  const sign = new THREE.Sprite(signMat);
  sign.scale.set(SIGN_W, SIGN_H, 1);
  sign.position.set(SIGN_X, SIGN_Y, 0.42);
  // 挂在场景上，不挂机器人组：体型缩放（Q版 1.14 / 修长 0.9）会把牌子一起
  // 推大推小、推出画面。牌子的位置本来就是按相机画面定的，和机器人体型无关。
  scene.add(sign);

  // 招牌后面的光晕：additive 金色，随呼吸脉动，让招牌像「点着灯」。
  const signGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softTexture(64), color: 0xffd54a, transparent: true, depthWrite: false, opacity: 0,
    depthTest: false, blending: THREE.AdditiveBlending,
  }));
  signGlow.scale.set(SIGN_W + 0.5, SIGN_H + 0.32, 1);
  signGlow.position.copy(sign.position);
  scene.add(signGlow);

  // 位置和尺寸都不再跟着窗口模式变：牌子挂在机器人右上方那片空处，左边缘
  // 落在双筒右沿（0.5）之外、头顶之上，所以既不压眼睛也不压那根细天线。
  // mini 只是画布更小（字自然小一点），位置关系不该因此变 —— 两套尺寸只会让
  // 「它到底在哪儿」多一份需要维护的答案。
  let signText = '';
  let signShownAt = -99;
  let signMode = 'top';    // top 最多 / total 合计 / cycle 轮播 / clock 时钟 / goal 目标 / days 陪伴 / off 关闭
  let signPos = 'right';   // right / left
  let signColor = '#ffd54a';   // 招牌描边 / 图标 / 辉光颜色
  let signShape = '圆角';       // 圆角 / 胶囊 / 方正
  let signGoalHours = 0;   // 今日目标（0 = 没设）
  let signDays = 0;        // 陪伴天数（0 = 不知道 firstRun）
  // 用户拖出来的偏移（机器人组的局部坐标，0 = 牌子自带的肩侧位置）。
  // 和 signPos 是两件事：signPos 选左/右锚点，偏移在锚点上做微调，
  // 所以换边不会把用户摆好的位置丢掉。
  let signOffsetX = 0;
  let signOffsetY = 0;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  window.addEventListener('bao:sign', (e) => {
    signMode = (e.detail && e.detail.mode) || 'top';
    signPos = (e.detail && e.detail.pos) || 'right';
    if (e.detail && e.detail.color) signColor = e.detail.color;
    if (e.detail && e.detail.shape) signShape = e.detail.shape;
    if (e.detail && e.detail.goalHours !== undefined) signGoalHours = Number(e.detail.goalHours) || 0;
    if (e.detail && e.detail.days !== undefined) signDays = Number(e.detail.days) || 0;
    const off = e.detail && e.detail.offset;
    if (off && Number.isFinite(Number(off.x)) && Number.isFinite(Number(off.y))) {
      signOffsetX = clamp(Number(off.x), -3, 3);
      signOffsetY = clamp(Number(off.y), -2.6, 2.6);
    }
  });

  // 拖动广告牌：设置面板只发屏幕像素增量，世界坐标的换算留在这里 ——
  // SIGN_W / SIGN_H 和投影尺寸都在这一侧，分到两处只会得到两套会漂移的答案。
  let signDragBase = null;
  let signBoxW = 0;   // 牌子在 #bot 内部坐标系里的像素宽
  let signBoxH = 0;
  window.addEventListener('bao:sign-drag-start', () => {
    signDragBase = { x: signOffsetX, y: signOffsetY };
  });
  window.addEventListener('bao:sign-drag', (e) => {
    if (!signDragBase || !signBoxW || !signBoxH) return;
    const dx = Number(e.detail && e.detail.dx) || 0;
    const dy = Number(e.detail && e.detail.dy) || 0;
    // 靠近默认锚点就吸附：手不可能刚好停在 0，差几个像素看起来像「没对齐」。
    const snap = (v) => (Math.abs(v) < 0.14 ? 0 : v);
    signOffsetX = clamp(snap(signDragBase.x + (dx / signBoxW) * SIGN_W), -3, 3);
    // 屏幕向下 = 世界 y 变小。
    signOffsetY = clamp(snap(signDragBase.y - (dy / signBoxH) * SIGN_H), -2.6, 2.6);
  });
  window.addEventListener('bao:sign-drag-end', () => {
    if (!signDragBase) return;
    signDragBase = null;
    // 由设置面板负责把最终位置写进配置（写盘与 UI 状态在同一处）。
    window.dispatchEvent(new CustomEvent('bao:sign-offset', {
      detail: { x: Number(signOffsetX.toFixed(3)), y: Number(signOffsetY.toFixed(3)) },
    }));
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
    // 逻辑尺寸固定 320×96，实际画布是它的 SIGN_SS 倍：下面所有坐标、字号、
    // 线宽都按老逻辑写，整体由 transform 放大，等于「同一张图用更高分辨率画」。
    const w = 320;
    const h = 96;
    g.setTransform(SIGN_SS, 0, 0, SIGN_SS, 0, 0);
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
      // 文字：名字一行、时长一行。
      //
      // 单行放「DeepSeek 1 时 35 分」时，可用宽度只有 240px，字号会被
      // measureText 一路压到 16px 下限 —— 那是屏幕上看不清的全部原因。
      // 拆成两行后每行都能用足字号：名字 26px、时长 33px。
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      const family = 'system-ui, "Microsoft YaHei", sans-serif';
      // 放不下就逐级缩，但停在 12px 而不是 16px：再窄也总比截断好。
      const fitFont = (str, size) => {
        let s = size;
        g.font = `bold ${s}px ${family}`;
        while (g.measureText(str).width > w - 62 - 16 && s > 12) {
          s -= 1;
          g.font = `bold ${s}px ${family}`;
        }
        return s;
      };
      // 时长总是以数字开头（「1 时 35 分」「45 分钟」），名字在它前面。
      const split = /^(.*?)(\d.*)$/.exec(text);
      const head = (split ? split[1] : text).trim();
      const span = split ? split[2].trim() : '';
      if (span) {
        fitFont(head, 26);
        g.fillStyle = 'rgba(255,255,255,.74)';
        g.fillText(head, 62, h * 0.34);
        fitFont(span, 33);
        g.fillStyle = signColor;
        g.fillText(span, 62, h * 0.68);
      } else {
        fitFont(head, 33);
        g.fillStyle = '#ffffff';
        g.fillText(head, 62, h / 2 + 1);
      }
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
    if (name === '自定义') applySkin('自定义', e.detail && e.detail.hex);
    else if (SKINS[name]) applySkin(name);
  });

  // 动作风格切换。
  // 眼睛配色 / 履带配色切换。「自定义」只带一个主色，其余明暗由此推导。
  window.addEventListener('bao:eyestyle', (e) => {
    const name = e.detail && e.detail.eyestyle;
    if (name === '自定义') applyEyeStyle('自定义', e.detail && e.detail.hex);
    else if (EYE_STYLES[name]) applyEyeStyle(name);
  });
  window.addEventListener('bao:trackstyle', (e) => {
    const name = e.detail && e.detail.trackstyle;
    if (name === '自定义') applyTrackSkin('自定义', e.detail && e.detail.hex);
    else if (TRACK_SKINS[name]) applyTrackSkin(name);
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
    if (name === '自定义') applyArmSkin('自定义', e.detail && e.detail.hex);
    else if (ARM_SKINS[name]) applyArmSkin(name);
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
        // hex 为空 = 离线占位：用和胸口槽位一致的暗色熄灯，而不是灰白（FALLBACK）。
        l.color.set(a.hex || 0x2a3340);
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

  // 每帧调 getComputedStyle 会强制一次样式计算 —— 60fps 下就是每秒 60 次，
  // 这是常驻窗口里最没必要的一笔固定开销。`--state` 只跟着 body[data-state]
  // 走，所以盯着那个属性就够了，属性不变就不必再算。
  let stateColor = null;
  function readStateColor() {
    stateColor = getComputedStyle(body).getPropertyValue('--state').trim() || null;
  }
  if (typeof MutationObserver === 'function') {
    new MutationObserver(readStateColor).observe(body, { attributes: true, attributeFilter: ['data-state'] });
  }
  function cssColor(state) {
    if (!stateColor) readStateColor();
    return stateColor || FALLBACK[state] || FALLBACK.unknown;
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
  // 跟着系统设置实时变：用户中途打开「减少动态效果」不该要求重启应用。
  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduceMotion = !!(motionQuery && motionQuery.matches);
  if (motionQuery && motionQuery.addEventListener) {
    motionQuery.addEventListener('change', (e) => { reduceMotion = !!e.matches; });
  }
  // 定时勿扰：ui 在进入/离开时段时派发。效果和系统 reduced-motion 一样把
  // 帧率压到 8fps —— 深夜里一个没人的桌面不需要 60 帧的呼吸灯。
  let dnd = false;
  window.addEventListener('bao:dnd', (e) => { dnd = !!(e.detail && e.detail.on); });

  // ---- performance guard -------------------------------------------------
  // This window is on someone's desktop all day, so it is allowed to shed
  // pixels but never to stutter. The measured frame rate is published on
  // #bot[data-fps] — the acceptance check reads it, and a dropped frame rate
  // has a number instead of a feeling. If the machine cannot hold 24fps the
  // backing store drops to 1x and the dust stops; the lights, the ring and the
  // state colours never degrade, because a status robot that hides its state to
  // go faster has no reason to exist.
  // `warmupUntil`：开头两秒在编译着色器、生成纹理，帧率必然难看。拿这段时间去
  // 「测量机器性能」只会把每一台机器都判定成带不动。
  const perf = {
    frames: 0,
    since: performance.now(),
    // 当前档位（fps）。统计只在同一档内累计，见 frame()。
    tier: 0,
    // 与下面的初始 pixelRatio 保持一致（min(2, dpr)）。原来这里是 2.5：
    // 初始化 2、resize 之后 2.5，同一个窗口在缩放的瞬间偷偷多画 56% 的像素，
    // 和「绝不掉帧」的目标正好相反。
    cap: 2,
    lite: false,
    // 完全静止的「离线待机」档：连自主巡游都没在演。这时候不该再为一台
    // 什么都不做的机器人付阴影贴图 + 2x 像素的钱（见 frame() 里的 settled）。
    settled: false,
    warmupUntil: performance.now() + 2500,
  };

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
  // 转身巡视/抖擞的「当前平滑叠加值」：这两个动作直接加到车身上，被打断时不能
  // 一帧归零（否则机器人从转身 ~31° 的状态突然弹回原位）。这里每帧向目标 lerp。
  let smoothPatrol = 0;
  let smoothShake = 0;
  // 人格：活泼 / 沉稳 / 话痨 / 害羞。首次随机固定，影响动作频率与情绪阈值。
  let personality = '活泼';
  const FREQ_BOOST = { 活泼: 1.4, 沉稳: 0.65, 话痨: 1.0, 害羞: 0.9 };
  let shyLookAt = -99;   // 被盯着看久了 → 害羞地别开视线
  let boredBubbleAt = -99;   // 无聊冒泡的防抖
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
  window.addEventListener('bao:done', () => {
    doneAt = clock.t;
    // 完成任务不只是转一圈 + 连跳两下：补一句气泡，给「刚刚那件事成了」一个
    // 文字落点。气泡和状态色一样是短命提示，几秒后自己消失。
    noticeText = '完成啦';
    noticeAt = clock.t;
  });
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

  // 每帧的总编排。分界线是「数据流」而不是行数：
  //
  //   * 前 250 行是一次姿态求解：光标位置 → 转向 → 头部朝向 → 眼睛 → 手臂，
  //     每一步的产出是下一步的输入（yawDelta 决定履带差速，done 决定庆祝动画，
  //     等等）。它不拆成多个函数，因为那样要维护一个十来个字段的中间契约，
  //     读者得在四个函数之间来回跳才能回答「头为什么转过去了」。
  //   * 后面各部件（灯环、状态条、广告牌、信标、铭牌、火焰、星点、熄灯……）
  //     彼此独立，已经拆成 updateXxx()，调用顺序与原来的书写顺序一致。
  //
  // 拆不动的部分保持完整，比为了「短」而拆得更碎更好维护 —— 这个判断写在
  // 这里，免得下一个人再来试一次。
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
    // 双击挥手也和别的动作一样尊重「减少动态效果」：戳一下已经判了 reduceMotion，
    // 这里漏了 —— 关了动效双击还是在挥手，语义被部分破坏。
    const greeting = !reduceMotion && greet >= 0 && greet < 2.0;
    const greetRise = greeting ? Math.min(1, greet / 0.3) * (1 - Math.max(0, greet - 1.45) / 0.55) : 0;
    const done = t - doneAt;
    const doneNod = !reduceMotion && done >= 0 && done < 1.6 ? Math.sin(done * 9) * 0.07 * (1 - done / 1.6) : 0;
    // 减少动态效果时连「戳一下的弹跳」也去掉：同一段里 done / crazy / anxiety
    // 都判了 reduceMotion，只有这里漏了 —— 系统里关了动效，点一下还是会跳。
    const hop = !reduceMotion && poke >= 0 && poke < 0.85 ? Math.sin((poke / 0.85) * Math.PI) * 0.075 : 0;
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
    // 用指数平滑向目标靠近：动作被打断（idleAction 归 0）时不是一帧弹回原位，
    // 而是 ~60ms 内慢慢转回来 —— 帧率无关（exp），低帧率下也不至于跳变。
    const idleK = 1 - Math.exp(-dt * 18);
    smoothPatrol += (idlePatrol - smoothPatrol) * idleK;
    smoothShake += (idleShake - smoothShake) * idleK;
    robot.rotation.y += smoothPatrol * motionScale;
    bodyGroup.rotation.z += smoothShake * motionScale;

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

    updateAntenna(off, error, busy, waiting, idle, unknown, t);
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

    updateTears(error, waiting, t, off, busy, greeting, dt);
    updateArms(t, motionScale, greeting, greetRise, juggle, idle, idleStretch, idleLookHand, dt, off, waiting, error, busy, yawDelta, crazy);
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

    updateStatusStrip(t, dt, busy, waiting, error, finished, idle, unknown, off);
    updateBaseRing(t, dt, off);
    updateSceneParticles(t, dt, error, waiting, off);
    updateSign(t, dt, off);
    updateBeaconMast(t, dt, waiting, error, busy, off);
    updateNameplate();
    updateDust(dt, busy, waiting);
    updateFlame(t, error);
    updateSparkles(done);
    updatePowerDown(dead);
  }

  function updateBeaconMast(t, dt, waiting, error, busy, off) {
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
  }

  function updateNameplate() {
    // ---- nameplate: always names the software the main lamp is about --------
    // The lamp aggregates "the worst"; the plate under it says WHICH software.
    // No cycling — attribution must be readable without waiting for the next
    // name to come round. Each software's own name still lives in its pill.
    // If the user typed their own text, that wins over the software name.
    // 不在这里按字符数硬截断：drawName 会按实际宽度缩字号、实在放不下才加省略号。
    // 用 slice(0,16) 会先砍掉长名字的右半边（而且没有省略号），中文一个字占两个
    // 码元时更短，emoji 还会被从代理对中间切断。上限交给绘制端按宽度决定。
    const plateText = nameplateText || String(theme.agent || '');
    if (plateText !== nameShown) {
      nameShown = plateText;
      drawName(plateText);
    }
  }

  function updateDust(dt, busy, waiting) {
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
  }

  function updateFlame(t, error) {
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
  }

  function updateSparkles(done) {
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
  }

  function updatePowerDown(dead) {
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

  function updateStatusStrip(t, dt, busy, waiting, error, finished, idle, unknown, off) {
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

  }

  function updateBaseRing(t, dt, off) {
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

  }

  function updateSceneParticles(t, dt, error, waiting, off) {
    // ---- 场景粒子动画：雪花飘落、草/沙摇曳、星闪烁 --------------------------
    const partKind = SCENES[sceneType] && SCENES[sceneType].particle;
    if (partKind && !reduceMotion) {
      const pos = particleGeo.attributes.position.array;
      // 动效强度真正减少粒子：省电少更新/隐藏粒子，华丽用满，标准按比例。
      // 上界必须夹住：「华丽」是 1.3 倍，180 × 1.3 = 234 > PARTICLE_N，越界读写
      // Float32Array 会被静默丢弃，等于这一档什么也没多做，还白跑一圈空循环。
      const visibleCount = Math.min(PARTICLE_N,
        Math.max(0, Math.floor(PARTICLE_N * (MOTION_LEVELS[motionLevel] || 1.0))));
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
          // 萤火虫一明一暗地闪烁（同样要听亮度滑杆的）
          particleMat.opacity = (0.3 + 0.55 * (0.5 + 0.5 * Math.sin(t * 1.7)))
            * (MOTION_LEVELS[motionLevel] || 1.0) * brightness;
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
        // 星星的闪烁必须跟着「亮度」和「动效强度」走。写死 0.35–0.8 会把
        // applyScene 设好的值整个盖掉，于是亮度滑杆对星空毫无作用 —— 而那是
        // 用户调夜景的唯一一个旋钮。
        const ms = MOTION_LEVELS[motionLevel] || 1.0;
        particleMat.opacity = (0.35 + 0.45 * (0.5 + 0.5 * Math.sin(t * 2.0))) * ms * brightness;
      }
      // 非 star 粒子：把透明度阻尼回「不降动效」的目标值（被 reduceMotion 淡出后
      // 恢复）。star 的透明度在上面那段按闪烁逐帧算，这里不碰。
      if (partKind !== 'star') particleMat.opacity = damp(particleMat.opacity, particleOpacity, 8, dt);
      particleGeo.attributes.position.needsUpdate = true;
    } else {
      // reduce-motion 或没有粒子：把粒子淡出到 0。原来这里什么都不做，雪花/星/
      // 火星就冻结在半空且完全可见 —— 「少动」不是「把运动定格成悬浮残影」。
      particleMat.opacity = damp(particleMat.opacity, 0, 8, dt);
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

    // 气泡说人话：出错 / 需要你 / 临时提示（切模型等）。文字变化时才重绘纹理。
    // 用户写了台词就用那句：气泡上和耳朵里听到的必须是同一句话。
    let bubbleWord = off ? '' : error ? (phrases.error || '出错啦') : waiting ? (phrases.waiting || '需要你') : '';
    if (!bubbleWord && !off && noticeText && (t - noticeAt) < 2.2) bubbleWord = noticeText;
    // 收起模式是个安静的小助手：广告牌已经藏了，气泡也不该再冒出来。
    if (document.body.classList.contains('collapsed')) bubbleWord = '';
    // 气泡永远在广告牌的另一侧，且固定在画面内的上半区：同一侧会互相盖住，
    // 跟着体型缩放又会被顶出画面（修长 y=1.15）。
    const signRight = (signPos === 'left' ? -SIGN_X : SIGN_X) + signOffsetX >= 0;
    const bubbleX = signMat.opacity > 0.05 && signRight ? -0.94 : 0.94;
    const side = bubbleX < 0 ? 'left' : 'right';
    if (side !== bubbleSide) {
      bubbleSide = side;
      if (bubbleText) drawBubble(bubbleText);
    }
    if (bubbleWord !== bubbleText) drawBubble(bubbleWord);
    bubbleMat.color.copy(tint);
    bubbleMat.opacity = damp(bubbleMat.opacity, bubbleWord ? 1 : 0, 9, dt);
    bubble.position.set(bubbleX, 3.56 + (reduceMotion ? 0 : Math.sin(t * 5.2) * 0.04), 0.55);
    bubble.scale.set(
      damp(bubble.scale.x, bubbleWord ? 0.84 : 0.72, 10, dt),
      damp(bubble.scale.y, bubbleWord ? 0.42 : 0.36, 10, dt),
      1,
    );

  }

  function updateSign(t, dt, off) {
    // ---- 信息牌：按模式显示某一种「今天怎么样」
    const fmt = (m) => (m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 时 ${m % 60} 分`);
    const statsByAgent = datasetJson('stats');
    let signLabel = '';
    // 时间、陪伴天数、合计时长说的是「此刻/今天」，不是「谁在跑」：机器人全部离线时
    // 恰恰最想看一眼，不该跟着一起熄灭。top/cycle/目标仍随 off 隐藏。
    const ambient = signMode === 'clock' || signMode === 'days' || signMode === 'total'
      || signMode === 'needs' || signMode === 'done' || signMode === 'sessions';
    if (signMode !== 'off' && (ambient || !off)) {
      const entries = Object.entries(statsByAgent);
      const total = entries.reduce((a, [, v]) => a + (v && v.m ? v.m : 0), 0);
      if (signMode === 'needs' || signMode === 'done' || signMode === 'sessions') {
        // 计数与时长无关：即使今天还没跑过任何东西，也应当回答「现在要不要管」。
        const c = datasetJson('signcounts') || {};
        if (signMode === 'needs') signLabel = `需要你 ${Math.max(0, Number(c.needs) || 0)}`;
        else if (signMode === 'done') signLabel = `今天完成 ${Math.max(0, Number(c.done) || 0)}`;
        else signLabel = `会话 ${Math.max(0, Number(c.sessions) || 0)}`;
      } else if (signMode === 'clock') {
        // 一周的中文写法 + 24 小时制。drawSign 会在第一个数字处断行：
        // 小字「周三」、大字「09:41」。
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        signLabel = `周${'日一二三四五六'[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      } else if (signMode === 'days') {
        signLabel = signDays > 0 ? `陪伴 ${signDays} 天` : '';
      } else if (signMode === 'goal') {
        if (signGoalHours > 0) {
          const pct = Math.min(999, Math.round((total / (signGoalHours * 60)) * 100));
          signLabel = `目标 ${pct}%`;
        }
      } else if (entries.length) {
        // value 现在是 { n: 显示名, m: 分钟 }：key 是稳定 agent id，显示名放里面。
        const sorted = [...entries].sort((a, b) => b[1].m - a[1].m);
        if (signMode === 'total') {
          const ev = datasetJson('events');
          const bits = [];
          if (ev && ev.done) bits.push(`完成 ${ev.done}`);
          if (ev && ev.error) bits.push(`出错 ${ev.error}`);
          const suffix = bits.length ? ` · ${bits.join(' · ')}` : '';
          signLabel = `合计 ${fmt(total)}${suffix}`;
        } else if (signMode === 'cycle') {
          const [, v] = sorted[Math.floor(t / 4) % sorted.length];
          signLabel = `${v.n} ${fmt(v.m)}`;
        } else {
          const [, v] = sorted[0];
          signLabel = `${v.n} ${fmt(v.m)}`;
        }
      }
    }
    // 收起模式（150px 的小助手）里牌面只有几十像素高，字根本读不出来。
    // 那个模式本来就是「占最少的桌面」，不要留一块看不懂的黄条；展开即恢复。
    if (document.body.classList.contains('collapsed')) signLabel = '';
    if (signLabel && !signText) signShownAt = t;   // 从无到有：弹一下
    drawSign(signLabel);   // 内部对比文字/颜色/形状，没变化就直接返回
    const pop = signLabel && signShownAt >= 0 ? Math.max(0, 1 - (t - signShownAt) / 0.30) : 0;
    // 弹出幅度从 0.22 收到 0.10：招牌顶边本来就在相机的上边界附近，再放大
    // 会有一瞬间被画布切掉一条边。
    const popScale = 1 + pop * 0.10;
    signMat.opacity = damp(signMat.opacity, signLabel ? 1 : 0, 8, dt);
    sign.scale.set(SIGN_W * popScale, SIGN_H * popScale, 1);
    sign.position.x = (signPos === 'left' ? -SIGN_X : SIGN_X) + signOffsetX;
    sign.position.y = SIGN_Y + signOffsetY + (reduceMotion ? 0 : Math.sin(t * 1.8) * 0.03);
    // 辉光：像通电灯箱一样呼吸，颜色跟着自定义走
    signGlow.material.color.set(signColor);
    signGlow.opacity = damp(signGlow.opacity, signLabel ? 0.35 + Math.sin(t * 3.2) * 0.15 : 0, 8, dt);
    signGlow.position.set(sign.position.x, sign.position.y - 0.02, sign.position.z);

    // 给测试与排查用的观测点：招牌四角在画面里的最大 NDC 绝对值。
    // > 1 就是出画；这条曾经在 Q 版体型下真实发生过（牌子挂在会被缩放的
    // 机器人组上），而现在牌子在场景里，位置不该再随体型变化。
    let edge = 0;
    // 同时把四角收进一个屏幕矩形里：DOM 拿不到 3D 牌子的盒子，而「按住牌子
    // 拖」需要一个可以命中测试的区域。矩形写在 #bot 上，单位是它内部的 CSS 像素。
    let minX = 1, maxX = -1, minY = 1, maxY = -1;
    const hw = (SIGN_W * popScale) / 2;
    const hh = (SIGN_H * popScale) / 2;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const p = new THREE.Vector3(
          sign.position.x + sx * hw, sign.position.y + sy * hh, sign.position.z
        ).project(camera);
        edge = Math.max(edge, Math.abs(p.x), Math.abs(p.y));
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    host.dataset.signEdge = edge.toFixed(3);
    const cw = host.clientWidth;
    const ch = host.clientHeight;
    if (signLabel && cw > 0 && ch > 0) {
      const x0 = Math.round((minX * 0.5 + 0.5) * cw);
      const x1 = Math.round((maxX * 0.5 + 0.5) * cw);
      // NDC 的 y 向上，DOM 的 y 向下。
      const y0 = Math.round((-maxY * 0.5 + 0.5) * ch);
      const y1 = Math.round((-minY * 0.5 + 0.5) * ch);
      signBoxW = Math.max(1, x1 - x0);
      signBoxH = Math.max(1, y1 - y0);
      const rect = `${x0},${y0},${signBoxW},${signBoxH}`;
      if (host.dataset.signRect !== rect) host.dataset.signRect = rect;
    } else {
      signBoxW = 0; signBoxH = 0;
      if (host.dataset.signRect) host.dataset.signRect = '';
    }
  }

  function updateMotionCues(dt, yawDelta, crazy, busy, waiting, error) {
    // ---- motion cues: treads and sprockets
    const crazyRun = crazy >= 0 && crazy < 2.2;
    // 「减少动态效果」下履带/轮子也停：busy 时 1.55 的滚速在降动效下还在转，
    // 和静止的主体自相矛盾。
    const speed = reduceMotion ? 0 : (crazyRun ? 5 : busy ? 1.55 : waiting ? 0 : error ? 0 : 0.12);
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

  }

  function updateTrackMarquee(t, dt, busy, waiting, error, off) {
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

  }

  function updateAntenna(off, error, busy, waiting, idle, unknown, t) {
    // ---- 天线：忙碌抖得快、空闲慢摇、出错乱颤，顶端小球跟着状态灯变色
    antennaTipMat.emissive.copy(tint);
    // 「减少动态效果」下天线也该静止：否则主体都停稳了，天线还在 1.2~16Hz 摇摆，
    // 可达性/省电的语义被漏掉一处。
    if (reduceMotion) {
      antenna.rotation.z = 0;
      antenna.rotation.x = -0.16;
      antennaTipMat.emissiveIntensity = off ? 0.25 : 1.1;
      return;
    }
    const antennaFreq = off ? 1.2 : error ? 16 : busy ? 6.5 : waiting ? 4.5 : 2.6;
    const antennaAmp = off ? 0.008 : error ? 0.09 : busy ? 0.055 : idle || unknown ? 0.032 : 0.02;
    antenna.rotation.z = Math.sin(t * antennaFreq) * antennaAmp;
    antenna.rotation.x = -0.16 + Math.sin(t * 2.2) * 0.035;
    antennaTipMat.emissiveIntensity = off ? 0.25 : (error ? 1.9 : 1.1 + Math.sin(t * antennaFreq) * 0.4);

  }

  function updateTears(error, waiting, t, off, busy, greeting, dt) {
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

  }

  function updateArms(t, motionScale, greeting, greetRise, juggle, idle, idleStretch, idleLookHand, dt, off, waiting, error, busy, yawDelta, crazy) {
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

    updateMotionCues(dt, yawDelta, crazy, busy, waiting, error);
    updateTrackMarquee(t, dt, busy, waiting, error, off);
  }

  // 履带齿每帧都在动，所以这几个临时对象放在函数外面复用。每帧新建 5 个对象
  // 不会让画面出错，只会让 GC 在后台定期抖一下 —— 一个常驻窗口不该有这种底噪。
  const LUG_MATRIX = new THREE.Matrix4();
  const LUG_QUAT = new THREE.Quaternion();
  const LUG_POS = new THREE.Vector3();
  const LUG_SCALE = new THREE.Vector3(1, 1, 1);
  const LUG_AXIS = new THREE.Vector3(0, 0, 1);

  function updateLugs(lug, phase) {
    const { profile, count, mesh: inst } = lug;
    const total = profile.length - 1;
    const m = LUG_MATRIX;
    const q = LUG_QUAT;
    const pos = LUG_POS;
    const scale = LUG_SCALE;
    const axis = LUG_AXIS;
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

    // 上限必须覆盖最低的那一档：15fps 的间隔是 66.7ms，8fps 是 125ms，夹到 50ms
    // 会让动画时钟比真实时间慢 25%–60%，于是眨眼间隔、打哈欠的 600 秒、戳一下
    // 的 0.85 秒窗口全都跟着被拉长。夹到 200ms 只是为了挡住「窗口藏了很久」。
    const dt = Math.min(0.2, Math.max(0.001, (now - clock.last) / 1000));
    // States that do not move much do not need 60 frames a second. This is a
    // window that is always on someone's desktop; it should not cost a fan.
    // 离线且没在演自主动作时，画面几乎是静止的，15fps 足够 —— 这窗口是常驻的，
    // 省下来的电是实打实的。一旦开始演动作，立刻回到 30fps 保证流畅。
    // reduce-motion 必须排在最前：系统说「少动一点」时，忙碌状态下也不该
    // 以 60fps 继续跑（README 与文档承诺的是整场降到 8fps）。原来的顺序让
    // active 先命中，8fps 分支在 busy/waiting/error 时永远到不了。
    const active = state === 'busy' || state === 'waiting' || state === 'error';
    const fps = (reduceMotion || dnd) ? 8
      : active ? 60
        : (state === 'offline' && !idlePlaying) ? 15 : 30;

    // 完全静止的离线待机：主动降画质（像素比 1x、关阴影），而不是等它掉帧。
    // 一旦要演自主巡游、或代理报来任何状态，立刻回到完整画质 —— 灯效与状态
    // 颜色从不参与降级（见 updateDust 的注释：状态灯没有「为省电而变暗」的理由）。
    // 「静止」只认离线且没在演自主动作这一档（15fps）：idle 档仍有零星的
    // 巡游/伸展动作，阴影值得留着。
    const settled = state === 'offline' && !idlePlaying;
    if (settled !== perf.settled) {
      perf.settled = settled;
      host.dataset.tier = settled ? 'settled' : 'full';
      resize();
    }

    if (now - clock.last < 1000 / fps - 1) return;
    clock.last = now;

    update(dt);
    renderer.render(scene, camera);

    // Measured, not assumed: the target above is a cadence, this is what the
    // GPU actually managed. One downgrade only — oscillating between quality
    // levels is more distracting than either level.
    // 一秒里混了 60fps 的工作段和 15fps 的空闲段时，measured 会把「这一档本来
    // 就慢」误读成「机器跑不动」。切档就重新起一个统计窗口，数字才只描述一档。
    // `data-target-fps` 是这一档**要求**的节奏，`data-fps` 是实际画出来的。
    // 两者分开，测试才能区分「逻辑把忙碌档写成了 60」和「这台机器跑不到 60」——
    // 后者在软件渲染的 CI、或者一台正在跑别的编译的机器上随时会发生，把
    // 产品逻辑的断言绑在它身上只会得到一条看心情的测试。
    if (fps !== perf.tier) {
      perf.tier = fps;
      host.dataset.targetFps = String(fps);
      perf.frames = 0;
      perf.since = now;
    }
    perf.frames += 1;
    if (now - perf.since >= 1000) {
      const measured = Math.round((perf.frames * 1000) / (now - perf.since));
      perf.frames = 0;
      perf.since = now;
      host.dataset.fps = String(measured);
      // 降级只在「真的在跑 60fps 档位、并且已经过了预热」时判定。
      //
      // 原来写死 `measured < 24`：空闲档位本来就只跑 15fps，会被当成「这台机器
      // 跑不动 60fps」，一次启动就永久降到 1.25 倍分辨率；开头两秒的着色器编译
      // 同样会触发它。机器从来没问题，是判断基准和时机错了。
      const judge = !perf.lite && now >= perf.warmupUntil && fps >= 60
        && measured > 0 && measured < 24;
      if (judge) {
        perf.lite = true;
        // 1x，不是 1.25x：这一档的意义就是「这台机器跑不动」，留 25% 的余量
        // 等于没降。文档里写的也是 drops to 1x。
        perf.cap = 1;
        host.dataset.quality = 'lite';
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
    // lite（机器带不动）与 settled（离线静止）都压到 1x；其余按体型/缩放需要。
    const cap = (perf.lite || perf.settled) ? 1 : perf.cap;
    renderer.setPixelRatio(Math.min(cap, Math.max(1, (window.devicePixelRatio || 1) * scale)));
    // 阴影贴图只在「机器在表现」时才有价值：离线静止时机器人已经压暗了，
    // 再画一层桌面阴影纯粹是白费。开关是渲染器级 flag，切档时 resize 会重算。
    renderer.shadowMap.enabled = !perf.lite && !perf.settled;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    measureHotBox();
  }

  window.addEventListener('bao:scale', resize);

  if (window.ResizeObserver) new ResizeObserver(resize).observe(host);
  else window.addEventListener('resize', resize);

  // 窗口被拖到另一块缩放比例不同的显示器上时，CSS 尺寸没变、devicePixelRatio
  // 变了 —— ResizeObserver 不会触发，画面就一直按旧比例采样（糊或者过度采样）。
  // 每换一档 DPR 重新挂一次监听。
  function watchDpr() {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const onChange = () => { resize(); watchDpr(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange, { once: true });
    else if (mq.addListener) mq.addListener(onChange);
  }
  watchDpr();

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
