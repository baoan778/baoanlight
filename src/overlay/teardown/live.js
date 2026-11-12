// 拆解台：整机 → 依次拆解 → 全部零件。
//
// 三条来自参考规范的硬约束，体现在这个文件里：
//   1. 一个输入驱动一切：所有零件的位置都只是 amount(0..1) 的函数，没有关键帧、
//      没有随机、没有帧间状态。滑块拖到哪儿，画面就是哪儿。
//   2. 无人操作时自己巡游，任何输入立刻接管，静默 25 秒后交还。
//   3. 标注不遮零件：引线端点取零件中心向外的方向，并夹在距边缘 60px 以内。
import * as THREE from '../vendor/three.module.js';
import { buildRobot } from './model.js';
import { STAGES, STUDIO, READOUTS, MM_PER_UNIT } from './spec.js';

const stageEl = document.getElementById('frame');
const canvas = document.getElementById('c');
const captionEl = document.getElementById('caption');
const stepsEl = document.getElementById('steps');
const pctEl = document.getElementById('pct');
const scrubEl = document.getElementById('scrub');
const modesEl = document.getElementById('modes');
const tagsEl = document.getElementById('callouts');
const svgEl = document.getElementById('leaders');

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (x) => 1 - Math.pow(1 - clamp(x, 0, 1), 3.2);

// ------------------------------------------------------------------ 摄影棚
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;   // r187 起 PCFSoft 已移除

const scene = new THREE.Scene();
scene.background = new THREE.Color(STUDIO.background);
// 雾把地面圆盘的远边化掉：否则地平线会在画面上半部分切出一道弧线。
scene.fog = new THREE.Fog(STUDIO.background, 24, 62);

const camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 200);
const target = new THREE.Vector3(0, 1.95, 0);

// 浅色摄影棚：环境光垫底、一盏主光出影子、一盏补光把暗面提起来、
// 一盏窄轮廓光勾边。强调色只留给交互，不参与照明。
scene.add(new THREE.HemisphereLight(0xfffdf8, 0xd9d2c2, 1.05));
const key = new THREE.DirectionalLight(0xfff6e8, 2.15);
key.position.set(5.5, 9, 6.5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 1;
key.shadow.camera.far = 30;
key.shadow.camera.left = -7;
key.shadow.camera.right = 7;
key.shadow.camera.top = 8;
key.shadow.camera.bottom = -4;
key.shadow.bias = -0.0012;
key.shadow.radius = 3;
scene.add(key);
const fill = new THREE.DirectionalLight(0xeef2ff, 0.55);
fill.position.set(-7, 4.5, 3.5);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 0.5);
rim.position.set(-2, 3.5, -8);
scene.add(rim);

// 地面：一张无接缝的浅色圆盘 + 接住的阴影。没有地平线，机器像浮在纸上。
const floorMat = new THREE.MeshStandardMaterial({ color: STUDIO.floor, roughness: 0.96, metalness: 0 });
const floor = new THREE.Mesh(new THREE.CircleGeometry(80, 72), floorMat);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// -------------------------------------------------------------------- 模型
const { root, parts } = buildRobot();
scene.add(root);

// 取景按实测包围盒算：机器占视口约 62%（规范要求 60–70%），而不是靠手调半径。
// 手调的结果是「这台机器刚好，换一台就出画」。
const bbox = new THREE.Box3().setFromObject(root);
const modelSize = bbox.getSize(new THREE.Vector3());
const modelCenter = bbox.getCenter(new THREE.Vector3());
target.y = modelCenter.y;
const FIT = 0.62;
const vFov = (camera.fov * Math.PI) / 180;
const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
const distV = modelSize.y / (2 * Math.tan(vFov / 2) * FIT);
const distW = modelSize.x / (2 * Math.tan(hFov / 2) * FIT);
const fitRadius = Math.max(distV, distW);
const byStage = new Map();
for (const p of parts) {
  if (!byStage.has(p.stage)) byStage.set(p.stage, []);
  byStage.get(p.stage).push(p);
}

// 选中标记：一个始终面向相机的强调色细环。不去改材质颜色 —— 材质是共享的，
// 改一个会连带整个模型。
const marker = new THREE.Mesh(
  new THREE.TorusGeometry(0.26, 0.012, 8, 40),
  new THREE.MeshBasicMaterial({ color: STUDIO.accent, transparent: true, opacity: 0.9 })
);
marker.visible = false;
scene.add(marker);

// ---------------------------------------------------------------- 拆解状态
const state = {
  amount: 0,        // 0..1，唯一输入
  stagger: 1,       // 1 = 一段一段来；0 = 全部同时
  mode: 'whole',
  tour: false,      // 是否在自动巡游
  tourT: 0,
  tourFrom: 0,      // 巡游起点/终点：拆解 0→1，部署 1→0
  tourTo: 1,
  selected: null,
  idleAt: 0,        // 最后一次人为操作
};

function localFor(stage, amount, stagger) {
  if (stagger >= 0.99) return clamp(amount * 6 - (stage - 1), 0, 1);
  return clamp(amount, 0, 1);
}

function applyAmount() {
  const a = state.amount;
  for (const p of parts) {
    const u = ease(localFor(p.stage, a, state.stagger));
    p.obj.position.set(
      p.obj.userData.explode.base.x + p.dir.x * p.dist * u,
      p.obj.userData.explode.base.y + p.dir.y * p.dist * u,
      p.obj.userData.explode.base.z + p.dir.z * p.dist * u
    );
  }
  pctEl.textContent = `${Math.round(a * 100)}%`;
  if (scrubEl.value !== String(Math.round(a * 1000))) scrubEl.value = String(Math.round(a * 1000));
  updateSteps();
}

function currentStageIndex() {
  if (state.amount <= 0.001) return 0;
  if (state.stagger < 0.99) return state.amount >= 0.999 ? STAGES.length - 1 : 1;
  return clamp(Math.ceil(state.amount * 6), 0, STAGES.length - 1);
}

// 旁白：巡游推进到新阶段时念一句。只在自动巡游时说 —— 人自己拖滑块/点按钮时
// 不要抢话，否则「讲解员」比用户还吵。默认开，可一键关。
let narration = true;
let spokenStage = -1;
function speak(text) {
  if (!narration || REDUCED) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 0.98;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch { /* 没有语音引擎就算了，不影响画面 */ }
}

// 巡游时 applyAmount 每帧都会调到这里，而 innerHTML 每帧重写会让浏览器每帧
// 重新解析并重排一次。只在阶段真的变了的时候动 DOM。
let shownStage = -1;
function updateSteps() {
  const now = currentStageIndex();
  if (now !== shownStage) {
    shownStage = now;
    [...stepsEl.children].forEach((el, i) => {
      el.classList.toggle('now', i === now);
      el.classList.toggle('on', i < now);
    });
    const s = STAGES[now];
    captionEl.innerHTML = `<b>${String(now + 1).padStart(2, '0')} · ${s.label}</b><br>${s.caption}`;
  }
  if (state.tour && now !== spokenStage) {
    spokenStage = now;
    speak(STAGES[now].narration);
  }
}

const narrationBtn = document.getElementById('narration');
narrationBtn.addEventListener('click', () => {
  narration = !narration;
  narrationBtn.setAttribute('aria-pressed', String(narration));
  narrationBtn.textContent = narration ? '旁白：开' : '旁白：关';
  if (!narration) { try { speechSynthesis.cancel(); } catch { /* 忽略 */ } }
  touched();
});

STAGES.forEach(() => stepsEl.appendChild(document.createElement('i')));

// 读数：全部来自 spec.js
const readoutEl = document.getElementById('readout');
for (const r of READOUTS) {
  const dt = document.createElement('dt');
  dt.textContent = r.label;
  const dd = document.createElement('dd');
  const v = r.value({ size: modelSize });
  dd.innerHTML = `<b>${v}</b> ${r.unit}`;
  readoutEl.append(dt, dd);
}
// 副标题也读实测值，避免「标题写 780、面板写 620」这种自相矛盾。
const specLine = document.querySelector('header p');
if (specLine) specLine.textContent = `B-01 · 整机 ${Math.round(modelSize.y * MM_PER_UNIT)} mm · 1 单位 = ${MM_PER_UNIT} mm`;

// ------------------------------------------------------------------ 相机
const cam = { theta: 0.62, phi: 0.34, radius: fitRadius, tTheta: 0.62, tPhi: 0.34, tRadius: fitRadius };
function placeCamera() {
  // 拆开后零件占地更大：距离随拆解量自动拉远，否则边角零件会被裁掉。
  // 用户滚轮缩放作用在基准距离上，两者相乘，互不干扰。
  const r = cam.radius * (1 + 0.55 * state.amount);
  camera.position.set(
    target.x + Math.sin(cam.theta) * Math.cos(cam.phi) * r,
    target.y + Math.sin(cam.phi) * r,
    target.z + Math.cos(cam.theta) * Math.cos(cam.phi) * r
  );
  camera.lookAt(target);
}
placeCamera();

// ------------------------------------------------------------------ 交互
let dragging = false;
let lastX = 0;
let lastY = 0;
let moved = 0;

function touched() {
  state.idleAt = performance.now();
  if (state.tour) {
    state.tour = false;
    state.mode = 'manual';
    syncModes();
  }
}

canvas.addEventListener('pointerdown', (e) => {
  dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
  touched();
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  moved += Math.abs(dx) + Math.abs(dy);
  lastX = e.clientX; lastY = e.clientY;
  cam.tTheta -= dx * 0.006;
  cam.tPhi = clamp(cam.tPhi + dy * 0.004, -0.12, 1.05);
});
canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  canvas.releasePointerCapture(e.pointerId);
  if (moved < 5) pick(e);
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  cam.tRadius = clamp(cam.tRadius + e.deltaY * 0.004, 4.2, 13);
  touched();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.key === '1') setMode('whole');
  else if (e.key === '2') setMode('steps');
  else if (e.key === '3') setMode('explode');
  else if (e.key === '4') setMode('assemble');
  else if (e.code === 'Space') { e.preventDefault(); state.tour ? pause() : play(); }
});

// ------------------------------------------------------------------ 选中
const raycaster = new THREE.Raycaster();
const markerHost = document.createElement('div');
const leaderLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
const leaderDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
leaderDot.setAttribute('r', '3');
svgEl.append(leaderLine, leaderDot);
tagsEl.appendChild(markerHost);
markerHost.className = 'tag';
markerHost.style.display = 'none';

function partOf(obj) {
  let o = obj;
  while (o && o !== root) {
    if (o.userData && o.userData.explode) return parts.find((p) => p.obj === o) || null;
    o = o.parent;
  }
  return null;
}

function pick(e) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(root, true);
  for (const h of hits) {
    const p = partOf(h.object);
    if (p && p.obj.visible) { select(p); return; }
  }
  select(null);
}

// 选中标记的几何量只在「换选中」时算一次：原来是每帧 new Box3().setFromObject()
// 遍历整棵子树 + 两次 getBoundingClientRect，恰好发生在拖拽旋转最需要帧率的
// 时候。零件在爆炸动画里只做平移、不旋转，所以「中心相对物体原点的偏移」是常量。
const selBox = new THREE.Box3();
const selCenter = new THREE.Vector3();
const selOrigin = new THREE.Vector3();
const selOffset = new THREE.Vector3();
let selRadius = 0.26;
function rememberSelectionBox(p) {
  selBox.setFromObject(p.obj);
  selBox.getCenter(selCenter);
  p.obj.getWorldPosition(selOrigin);
  selOffset.copy(selCenter).sub(selOrigin);
  selRadius = selBox.getSize(new THREE.Vector3()).length() * 0.5 + 0.08;
}

function select(p) {
  state.selected = p;
  marker.visible = !!p;
  if (p) rememberSelectionBox(p);
  if (!p) {
    markerHost.style.display = 'none';
    leaderLine.style.display = 'none';
    leaderDot.style.display = 'none';
    return;
  }
  markerHost.style.display = 'block';
  leaderLine.style.display = 'block';
  leaderDot.style.display = 'block';
  markerHost.innerHTML = '';
  const b = document.createElement('b');
  b.textContent = p.label;
  const span = document.createElement('span');
  span.textContent = p.note || '';
  markerHost.append(b, span);
}

// ------------------------------------------------------------------ 模式
function setMode(mode) {
  state.mode = mode;
  syncModes();
  if (mode === 'whole') {
    state.tour = false;
    state.stagger = 1;
    animateTo(0);
  } else if (mode === 'explode') {
    state.tour = false;
    state.stagger = 0;
    animateTo(1);
  } else if (mode === 'assemble') {
    playAssemble();
  } else {
    state.stagger = 1;
    play();
  }
  // 模式按钮是巡游自己的控制器，不该被当成「用户接管」把刚开播的巡游又停掉。
  state.idleAt = performance.now();
}

function syncModes() {
  for (const b of modesEl.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
  }
}

function play() {
  state.tour = true;
  state.tourT = 0;
  state.tourFrom = state.amount >= 0.999 ? 0 : state.amount;
  state.tourTo = 1;
  state.mode = 'steps';
  state.stagger = 1;
  spokenStage = -1;   // 每轮巡游从头念
  syncModes();
}

// 部署 = 反过来的巡游：从全部散开，一件件装回去。
function playAssemble() {
  state.tour = true;
  state.tourT = 0;
  state.tourFrom = state.amount <= 0.001 ? 1 : state.amount;
  state.tourTo = 0;
  state.mode = 'assemble';
  state.stagger = 1;
  spokenStage = -1;
  syncModes();
  speak('现在把拆散的零件，一件一件装回去。');
}

function pause() {
  state.tour = false;
  state.mode = 'manual';
  syncModes();
}

modesEl.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setMode(b.dataset.mode);
});
scrubEl.addEventListener('input', () => {
  state.tour = false;
  state.stagger = 1;
  state.amount = Number(scrubEl.value) / 1000;
  // 目标值必须同步，否则下一帧的阻尼会把人刚拖到的位置又拉回去。
  amountTarget = state.amount;
  state.mode = 'manual';
  syncModes();
  applyAmount();
  touched();
});

// 平滑过渡：只对 amount 做阻尼，不做关键帧。
let amountTarget = 0;
function animateTo(v) {
  amountTarget = v;
}

// ------------------------------------------------------------------ 循环
const clock = { last: performance.now() };
let frames = 0;
let fpsSince = performance.now();
let lite = false;
// 开头两秒必然掉帧（着色器编译、纹理上传），没有预热的话几乎每台机器第一次
// 打开就会被永久钉在 lite 档，然后再也回不来。
const liteWarmupUntil = performance.now() + 2500;

function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, Math.max(0.001, (now - clock.last) / 1000));
  clock.last = now;

  // 自动巡游：18 秒走完六个阶段，最后停留 3 秒。
  if (state.tour) {
    state.tourT += dt / 18;
    if (state.tourT >= 1) { state.tourT = 1; state.tour = false; }
    state.amount = state.tourFrom + (state.tourTo - state.tourFrom) * ease(state.tourT);
    applyAmount();
  } else if (Math.abs(state.amount - amountTarget) > 0.0005) {
    const k = REDUCED ? 1 : 1 - Math.exp(-6 * dt);
    state.amount += (amountTarget - state.amount) * k;
    if (Math.abs(state.amount - amountTarget) <= 0.0005) state.amount = amountTarget;
    applyAmount();
  }

  // 相机阻尼
  const cd = 1 - Math.exp(-9 * dt);
  cam.theta += (cam.tTheta - cam.theta) * cd;
  cam.phi += (cam.tPhi - cam.phi) * cd;
  cam.radius += (cam.tRadius - cam.radius) * cd;
  placeCamera();

  // 无人操作 25 秒 → 自己巡游（规范里的「交还控制权」）
  if (!state.tour && now - state.idleAt > 25000 && !REDUCED) {
    state.idleAt = now;
    play();
  }

  // 选中标记：跟随零件中心，始终面向相机。复用缓存的偏移与尺寸（每帧新
  // 建 Box3 会把帧时间花在遍历子树上），只在换选中时重算一次。
  if (state.selected) {
    // 先刷一次世界矩阵：渲染在后面发生，不刷的话标记会比零件慢一帧。
    state.selected.obj.updateWorldMatrix(true, false);
    state.selected.obj.getWorldPosition(selOrigin);
    selCenter.copy(selOrigin).add(selOffset);
    marker.position.copy(selCenter);
    marker.quaternion.copy(camera.quaternion);
    marker.scale.setScalar(clamp(selRadius / 0.26, 0.4, 3));
    placeTag(selCenter);
  }

  renderer.render(scene, camera);

  // 质量分档：连续一秒掉到 24fps 以下就降一次，不再来回切。
  frames += 1;
  if (now - fpsSince >= 1000) {
    const fps = (frames * 1000) / (now - fpsSince);
    frames = 0; fpsSince = now;
    stageEl.dataset.fps = String(Math.round(fps));
    if (!lite && now >= liteWarmupUntil && fps > 0 && fps < 24) {
      lite = true;
      renderer.setPixelRatio(1);
      renderer.shadowMap.enabled = false;
      key.castShadow = false;
      floorMat.needsUpdate = true;
      stageEl.dataset.quality = 'lite';
    }
  }
}

// --------------------------------------------------------------- 标注定位
// 画布与舞台的位置只在窗口尺寸/缩放变化时才变，没必要每帧 getBoundingClientRect
// ——那是一次强制布局读取，正好落在拖拽旋转最需要帧率的时候。fit() 负责刷新。
let tagCanvasRect = null;
let tagFrameWidth = 1600;
let tagOffsetX = 0;
let tagOffsetY = 0;

function placeTag(worldPos) {
  const v = worldPos.clone().project(camera);
  const rect = tagCanvasRect || canvas.getBoundingClientRect();
  const scale = tagFrameWidth / 1600;
  // 画布坐标 → 1600×900 控制台坐标
  let x = (v.x * 0.5 + 0.5) * rect.width + tagOffsetX;
  let y = (-v.y * 0.5 + 0.5) * rect.height + tagOffsetY;
  x /= scale; y /= scale;

  // 从画面中心指向零件的方向，把标签推出去 210px：绝不压在被标注的零件上。
  const cx = 800, cy = 420;
  const dx = x - cx, dy = y - cy;
  const len = Math.hypot(dx, dy) || 1;
  const push = 210;
  let tx = x + (dx / len) * push;
  let ty = y + (dy / len) * push;
  // 距边缘至少 60px
  tx = clamp(tx, 60, 1540);
  // 下边界留到 700：再往下就压到底部控件条上了。
  ty = clamp(ty, 60, 700);

  markerHost.style.left = `${tx}px`;
  markerHost.style.top = `${ty}px`;
  leaderLine.setAttribute('x1', String(x));
  leaderLine.setAttribute('y1', String(y));
  leaderLine.setAttribute('x2', String(tx));
  leaderLine.setAttribute('y2', String(ty));
  leaderDot.setAttribute('cx', String(x));
  leaderDot.setAttribute('cy', String(y));
}

// ------------------------------------------------------------------ 适配
function fit() {
  const s = Math.min(innerWidth / 1600, innerHeight / 900);
  stageEl.style.transform = `scale(${s})`;
  const rect = canvas.getBoundingClientRect();
  renderer.setSize(rect.width, rect.height, false);
  // DPR 也要重算：窗口被拖到另一块不同缩放的显示器上时，CSS 尺寸不变而
  // 分辨率变了，只在初始化时设一次的话画面会一直模糊或过度采样。
  if (!lite) renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  // 标注定位要用的两个量一起刷新，placeTag 就不用每帧强制布局。
  const frameRect = stageEl.getBoundingClientRect();
  tagCanvasRect = rect;
  tagFrameWidth = frameRect.width;
  tagOffsetX = rect.left - frameRect.left;
  tagOffsetY = rect.top - frameRect.top;
  camera.aspect = 1600 / 900;
  camera.updateProjectionMatrix();
}
addEventListener('resize', fit);

fit();
applyAmount();
updateSteps();
syncModes();
state.idleAt = performance.now();
requestAnimationFrame(tick);

// 供渲染测试读取：零件数与当前拆解量。这比截图稳定，也不依赖 GPU。
window.__teardown = {
  parts: parts.length,
  stages: STAGES.length,
  amount: () => state.amount,
  mode: () => state.mode,
  stage: () => currentStageIndex(),
  narration: () => narration,
  setMode,
  select: (id) => select(parts.find((p) => p.id === id) || null),
};
