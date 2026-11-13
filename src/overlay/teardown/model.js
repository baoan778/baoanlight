// 可拆解的机器人模型 —— 与状态机器人（robot3d.js）是**同一台机器**。
//
// 这里的每一件零件都照着 robot3d.js 里的同一组尺寸、同一套材质、同一批贴图
// 重建：主壳体开仪表舱孔、前脸警示贴/字标/铭牌、侧轨与肩架、后散热格栅、
// 底盘转盘、双板液压臂 + 铲形爪，履带是同一条圆角矩形轮廓 + 44 颗齿。拆解
// 的目的就是把「你桌面上那台」拆开，所以它不能是另一台长得像的机器。
//
// 结构沿用「装配顺序」：每个零件是 root 的直接子节点、位置是绝对值，爆炸时
// 只做 base + dir·dist·amount 的平移，复位写回 base —— 不存在拆完装不回去。
import * as THREE from '../vendor/three.module.js';
import { slab, mesh, roundedRectPoints } from '../scene/geometry.js';
import { paint, hazardTexture, wordmarkTexture, canvasTexture } from '../scene/surfaces.js';
import { SKIN_TONES, EYE_TONES, TRACK_TONES, ARM_TONES } from '../shared/palette.mjs';
import { DIMS } from './spec.js';

const V2 = THREE.Vector2;
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

// 和 robot3d.js 的 M 同一套配方（同 seed / 同 repeat），否则拆解出来的机身
// 和桌面上的机器人肤色不同、锈迹疏密不同。
function materials() {
  const skin = SKIN_TONES[0];
  const eye = EYE_TONES[0];
  const track = TRACK_TONES[0];
  const arm = ARM_TONES[0];
  return {
    yellow: new THREE.MeshStandardMaterial({ map: paint(skin.hex, { seed: 3, repeat: [0.55, 0.72] }), metalness: 0.14, roughness: 0.66 }),
    yellowDark: new THREE.MeshStandardMaterial({ map: paint(skin.dark, { seed: 5, amount: 1.2, repeat: [0.8, 0.8] }), metalness: 0.16, roughness: 0.7 }),
    metal: new THREE.MeshStandardMaterial({ map: paint('#77736a', { seed: 7, amount: 0.7, repeat: [0.9, 0.9] }), metalness: 0.6, roughness: 0.56 }),
    metalDark: new THREE.MeshStandardMaterial({ color: 0x4b4842, metalness: 0.65, roughness: 0.58 }),
    steel: new THREE.MeshStandardMaterial({ map: paint(arm.steel, { seed: 11, amount: 0.55, repeat: [1.6, 1.6] }), metalness: 0.74, roughness: 0.44 }),
    arm: new THREE.MeshStandardMaterial({ map: paint(arm.arm, { seed: 23, amount: 0.6, repeat: [1.4, 1.4] }), metalness: 0.5, roughness: 0.46 }),
    rust: new THREE.MeshStandardMaterial({ map: paint('#8a4a28', { seed: 13, amount: 0.8, repeat: [2, 2] }), metalness: 0.32, roughness: 0.8 }),
    dark: new THREE.MeshStandardMaterial({ color: arm.dark, metalness: 0.5, roughness: 0.62 }),
    black: new THREE.MeshStandardMaterial({ color: 0x141412, metalness: 0.4, roughness: 0.58 }),
    rubber: new THREE.MeshStandardMaterial({ color: track.rubber, metalness: 0.05, roughness: 0.95 }),
    rubberIn: new THREE.MeshStandardMaterial({ color: 0x121211, metalness: 0.02, roughness: 1.0 }),
    rubberHi: new THREE.MeshStandardMaterial({ color: track.hi, metalness: 0.22, roughness: 0.86 }),
    wheel: new THREE.MeshStandardMaterial({ map: paint('#7a4530', { seed: 17, amount: 0.9, repeat: [2, 2] }), metalness: 0.45, roughness: 0.62 }),
    wheelDark: new THREE.MeshStandardMaterial({ color: 0x45271b, metalness: 0.5, roughness: 0.66 }),
    lens: new THREE.MeshPhysicalMaterial({ color: eye.lens, metalness: 0.1, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.03 }),
    eyeBody: new THREE.MeshStandardMaterial({ map: paint(arm.eye, { seed: 19, amount: 0.5, repeat: [1.6, 1.6] }), metalness: 0.7, roughness: 0.45 }),
    iris: new THREE.MeshStandardMaterial({ color: eye.iris, metalness: 0.45, roughness: 0.32 }),
    panel: new THREE.MeshStandardMaterial({ color: 0x17171a, metalness: 0.6, roughness: 0.6 }),
    glow: new THREE.MeshStandardMaterial({ color: 0x0c0e11, emissive: 0x34c759, emissiveIntensity: 1.6, roughness: 0.4 }),
  };
}

export function buildRobot() {
  const M = materials();
  const root = new THREE.Group();
  const parts = [];

  const box = (w, h, d, mat, opts) => mesh(slab(w, h, d, opts), mat);
  const cyl = (r1, r2, h, mat, seg = 20) => mesh(new THREE.CylinderGeometry(r1, r2, h, seg), mat);

  // 统一的登记口：零件必须经过这里才参与爆炸动画。
  function part(id, label, stage, obj, { dir = [0, 1, 0], dist = 1, note = '', small = false } = {}) {
    const d = V3(...dir).normalize();
    obj.userData.explode = { stage, dir: d, dist, base: obj.position.clone() };
    root.add(obj);
    parts.push({ id, label, stage, obj, dir: d, dist, note, small });
    return obj;
  }

  // 车体坐标：和 robot3d 完全一致。
  const CH = { w: DIMS.hull.w, h: DIMS.hull.h, d: DIMS.hull.d, r: DIMS.hull.r, y: DIMS.hull.y };
  const FRONT = CH.d / 2;
  const BAY = { x: 0.40, y: 1.98, w: 0.60, h: 0.34, depth: 0.05 };
  const bayDepth = FRONT - BAY.depth;
  const bayFaceZ = bayDepth + 0.002;

  function frontOf(obj, air = 0.004) {
    const g = obj.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    return obj.position.z + g.boundingBox.max.z + air;
  }

  // ---------------------------------------------------------------- 履带总成
  const T = DIMS.track;
  function belt(side) {
    const g = new THREE.Group();
    const outer = roundedRectPoints(T.w, T.h, T.r, 12);
    const shrink = (ratio) => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of outer) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      return outer.map((p) => new V2(cx + (p.x - cx) * ratio, cy + (p.y - cy) * ratio));
    };

    // 履带本体：一个开侧孔的环，不是一块实心橡胶。
    const beltShape = new THREE.Shape(outer);
    beltShape.holes.push(new THREE.Path(shrink(0.76)));
    const beltGeo = new THREE.ExtrudeGeometry(beltShape, { depth: T.d, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2, curveSegments: 10 });
    beltGeo.center();
    const belt = mesh(beltGeo, M.rubber);
    belt.rotation.y = Math.PI / 2;
    g.add(belt);

    // 背板，挡住履带内圈不该透出来的亮光。
    const backGeo = new THREE.ExtrudeGeometry(new THREE.Shape(shrink(0.70)), { depth: 0.10, bevelEnabled: true, bevelSize: 0.01, bevelThickness: 0.01, bevelSegments: 1, curveSegments: 10 });
    backGeo.center();
    const back = mesh(backGeo, M.dark);
    back.rotation.y = Math.PI / 2;
    g.add(back);

    // 内圈，比外圈暗一档，让环读作「有厚度」。
    const innerShape = new THREE.Shape(shrink(0.72));
    innerShape.holes.push(new THREE.Path(shrink(0.50)));
    const innerGeo = new THREE.ExtrudeGeometry(innerShape, { depth: T.d - 0.06, bevelEnabled: true, bevelSize: 0.01, bevelThickness: 0.01, bevelSegments: 1, curveSegments: 10 });
    innerGeo.center();
    const liner = mesh(innerGeo, M.rubberIn);
    liner.rotation.y = Math.PI / 2;
    g.add(liner);

    g.position.set(side * T.x, T.h / 2, 0);
    return g;
  }

  function lugs(side) {
    // 44 颗履带齿，一个 InstancedMesh；拆到最细一层时整组一起飞。
    const T1 = DIMS.track;
    const g = new THREE.Group();
    const lugGeo = new THREE.BoxGeometry(0.062, 0.055, T1.d * 0.82);
    const inst = new THREE.InstancedMesh(lugGeo, M.rubberHi, 44);
    const outline = roundedRectPoints(T1.w, T1.h, T1.r, 60);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < 44; i++) {
      const p = outline[Math.floor((i / 44) * outline.length)];
      m4.makeRotationZ(Math.atan2(p.y, p.x));
      m4.setPosition(p.x, p.y, 0);
      inst.setMatrixAt(i, m4);
    }
    inst.instanceMatrix.needsUpdate = true;
    g.rotation.y = Math.PI / 2;
    g.position.set(side * T1.x, T1.h / 2, 0);
    g.add(inst);
    return g;
  }

  function wheel(side, z, y, r, label) {
    const T1 = DIMS.track;
    const g = new THREE.Group();
    const tyre = cyl(r, r, T1.d - 0.08, M.metalDark, 26);
    tyre.rotation.z = Math.PI / 2;
    g.add(tyre);
    const hub = cyl(r * 0.3, r * 0.3, T1.d - 0.02, M.wheelDark, 16);
    hub.rotation.z = Math.PI / 2;
    g.add(hub);
    g.position.set(side * T1.x, y + 0.05, z);
    return { group: g, label };
  }

  function sprocket(side) {
    const T1 = DIMS.track;
    const g = new THREE.Group();
    const hub = cyl(0.16, 0.16, 0.20, M.wheel, 18);
    hub.rotation.z = Math.PI / 2;
    g.add(hub);
    for (let k = 0; k < 8; k++) {
      const tooth = box(0.05, 0.05, 0.18, M.wheel);
      const a = (k / 8) * Math.PI * 2;
      tooth.position.set(0, Math.cos(a) * 0.22, Math.sin(a) * 0.22);
      g.add(tooth);
    }
    g.position.set(side * T1.x, T1.h / 2, 0);
    return g;
  }

  // 左右履带
  [-1, 1].forEach((side, i) => {
    part(`track${i}`, i === 0 ? '左履带' : '右履带', 2, belt(side), {
      dir: [side, 0.1, 0], dist: 2.1, note: '橡胶履带 + 内衬 + 背板',
    });
    part(`lugs${i}`, i === 0 ? '左履带齿 ×44' : '右履带齿 ×44', 5, lugs(side), {
      dir: [0, 0, side], dist: 1.9, small: true, note: '44 颗独立履带齿，压装在橡胶带上',
    });
    // 轮组（每侧三只负重轮并成一件）
    const wg = new THREE.Group();
    [[-0.62, DIMS.wheel.r, '前'], [0.62, DIMS.wheel.r, '后'], [0, DIMS.wheel.top, '上']].forEach(([z, r]) => {
      const w = wheel(side, z, r === DIMS.wheel.top ? 0.62 : 0.30, r);
      wg.add(w.group);
    });
    part(`wheels${i}`, i === 0 ? '左轮组 ×3' : '右轮组 ×3', 5, wg, {
      dir: [side, -0.2, 0], dist: 2.3, small: true, note: '前/后负重轮 + 上托轮，双列轴承',
    });
    part(`sprocket${i}`, i === 0 ? '左主动轮' : '右主动轮', 5, sprocket(side), {
      dir: [side, 0.2, 0], dist: 2.6, small: true, note: '8 齿，模数 4 mm',
    });
  });

  // ---------------------------------------------------------------- 底盘
  const chassis = new THREE.Group();
  const turntable = mesh(new THREE.CylinderGeometry(0.62, 0.64, 0.58, 28), M.metalDark);
  turntable.position.set(0, 0.86, 0);
  chassis.add(turntable);
  const gearbox = mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.30, 24), M.wheelDark);
  gearbox.position.set(0, 0.56, 0);
  chassis.add(gearbox);
  const bearing = mesh(new THREE.TorusGeometry(0.63, 0.022, 8, 40), M.steel);
  bearing.rotation.x = Math.PI / 2;
  bearing.position.y = 0.60;
  chassis.add(bearing);
  part('chassis', '底盘总成', 3, chassis, { dir: [0, -0.8, 0], dist: 1.6, note: '回转台 + 变速箱 + 回转支承' });

  // ---------------------------------------------------------------- 壳体
  const hull = box(CH.w, CH.h, CH.d, M.yellow, {
    r: CH.r, bevel: 0.024,
    holes: [{ w: BAY.w, h: BAY.h, r: 0.035, x: BAY.x, y: BAY.y - CH.y }],
  });
  hull.position.set(0, CH.y, 0);
  part('hull', '主壳体', 3, hull, { dir: [0, 0, -1], dist: 1.7, note: '1.5 mm 冷轧钢板，做旧喷漆' });

  const deck = new THREE.Group();
  const deckTop = box(CH.w + 0.05, 0.13, CH.d + 0.03, M.metal, { r: 0.05, bevel: 0.016 });
  deckTop.position.set(0, 2.32, 0);
  deck.add(deckTop);
  const spine = box(0.36, 0.15, 0.86, M.metalDark, { r: 0.03, bevel: 0.01 });
  spine.position.set(0, 2.40, -0.08);
  deck.add(spine);
  part('deck', '顶盖 + 脊梁', 3, deck, { dir: [0, 1, 0.15], dist: 1.5, note: '四颗 M4 螺丝固定' });

  // 前门下沿 + 门缝（合并成「下护板」）
  const lower = new THREE.Group();
  const seam = box(CH.w - 0.22, 0.028, 0.02, M.dark, { r: 0.012, bevel: 0.006 });
  seam.position.set(0, 1.06, FRONT - 0.004);
  lower.add(seam);
  const plate = box(CH.w - 0.22, 0.46, 0.05, M.yellowDark, { r: 0.03, bevel: 0.008 });
  plate.position.set(0, 0.81, FRONT - 0.012);
  lower.add(plate);
  part('lower', '下护板', 3, lower, { dir: [0, -0.6, 0.8], dist: 1.3, note: '压实斗舱门的下沿，兼作配重' });

  const hook = mesh(new THREE.TorusGeometry(0.15, 0.026, 10, 24, Math.PI), M.steel);
  hook.position.set(0, 1.86, -FRONT - 0.035);
  part('hook', '背部吊钩', 3, hook, { dir: [0, 0.2, -1], dist: 1.5, note: '整机唯一吊点，承重 12 kg' });

  const vents = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const v = box(0.86, 0.045, 0.018, M.dark, { r: 0.012, bevel: 0.004 });
    v.position.set(0, 1.58 - i * 0.09, -FRONT - 0.004);
    vents.add(v);
  }
  part('vent', '散热格栅 ×4', 3, vents, { dir: [0, 0, -1], dist: 1.7, note: '10 条横向百叶' });

  // 侧轨（立柱 + 腰线）与肩架（悬臂 + 斜撑 + 端盖）
  [-1, 1].forEach((side, i) => {
    const rail = new THREE.Group();
    for (const z of [-1, 1]) {
      const post = box(0.05, CH.h - 0.10, 0.07, M.metalDark, { r: 0.015, bevel: 0.005 });
      post.position.set(side * (CH.w / 2 + 0.004), CH.y, z * (CH.d / 2 - 0.05));
      rail.add(post);
    }
    const waist = box(0.045, 0.075, CH.d - 0.14, M.metalDark, { r: 0.014, bevel: 0.005 });
    waist.position.set(side * (CH.w / 2 + 0.004), 1.24, 0);
    rail.add(waist);
    part(`rail${i}`, i === 0 ? '左侧轨' : '右侧轨', 3, rail, { dir: [side, 0, 0], dist: 1.35, note: '边角立柱 + 腰线' });

    const mount = new THREE.Group();
    const beam = box(0.82, 0.13, 0.22, M.metalDark, { r: 0.03, bevel: 0.01 });
    beam.position.set(side * (CH.w / 2 + 0.41), 1.93, 0.30);
    beam.rotation.z = side * 0.07;
    mount.add(beam);
    const brace = box(0.10, 0.42, 0.19, M.metalDark, { r: 0.025, bevel: 0.008 });
    brace.position.set(side * (CH.w / 2 + 0.15), 2.09, 0.30);
    brace.rotation.z = side * 0.62;
    mount.add(brace);
    for (const bx of [0.10, 0.48]) {
      const cap = cyl(0.026, 0.026, 0.02, M.rust, 6);
      cap.rotation.x = Math.PI / 2;
      cap.position.set(side * (CH.w / 2 + bx), 1.94, 0.415);
      mount.add(cap);
    }
    part(`mount${i}`, i === 0 ? '左肩架' : '右肩架', 3, mount, { dir: [side, 0.3, 0.2], dist: 1.9, note: '手臂挂点：悬臂 + 斜撑' });
  });

  // 前脸贴纸与铭牌
  const sticker = new THREE.Mesh(
    new THREE.PlaneGeometry(0.30, 0.115),
    new THREE.MeshStandardMaterial({ map: hazardTexture(), transparent: true, opacity: 0.6, metalness: 0.1, roughness: 0.85 })
  );
  sticker.position.set(-0.56, 2.10, frontOf(hull, 0.002));
  sticker.rotation.z = 0.03;
  part('hazard', '警示贴', 3, sticker, { dir: [0, 0.2, 1], dist: 1.2, note: '工业警示纹，唯一一块工业印刷' });

  const mark = new THREE.Mesh(
    new THREE.PlaneGeometry(0.62, 0.155),
    new THREE.MeshStandardMaterial({ map: wordmarkTexture(), transparent: true, metalness: 0.1, roughness: 0.8 })
  );
  mark.position.set(-0.40, 1.56, frontOf(hull, 0.002));
  part('wordmark', '字标', 3, mark, { dir: [0, 0.1, 1], dist: 1.2, note: '点阵字标，印在漆面上' });

  const nameTex = canvasTexture(512, 96, (g, w, h) => {
    g.fillStyle = '#3a3016';
    g.font = '600 50px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textBaseline = 'middle';
    g.fillText('B-01', 8, 50);
  });
  const nameplate = new THREE.Mesh(
    new THREE.PlaneGeometry(0.52, 0.098),
    new THREE.MeshBasicMaterial({ map: nameTex, transparent: true, depthWrite: false, opacity: 0.9 })
  );
  nameplate.position.set(BAY.x, 1.70, frontOf(hull, 0.004));
  part('nameplate', '铭牌', 3, nameplate, { dir: [0, -0.1, 1], dist: 1.2, note: 'B-01，蚀刻名牌' });

  const rivets = new THREE.Group();
  const rivetGeo = new THREE.CylinderGeometry(0.024, 0.026, 0.012, 12);
  for (const [x, y] of [[-0.66, 1.16], [0.66, 1.16], [-0.66, 0.62], [0.66, 0.62]]) {
    const r = mesh(rivetGeo, M.rust);
    r.rotation.x = Math.PI / 2;
    r.position.set(x, y, FRONT + 0.008);
    rivets.add(r);
  }
  part('rivets', '门板铆钉 ×4', 3, rivets, { dir: [0, 0, 1], dist: 1.1, small: true, note: '斗舱门四角的铆钉' });

  // ---------------------------------------------------------------- 仪表舱 + 状态条
  const bayFloor = box(BAY.w - 0.02, BAY.h - 0.02, 0.30, M.panel, { r: 0.03, bevel: 0.008 });
  bayFloor.position.set(BAY.x, BAY.y, bayDepth - 0.15);
  part('bayFloor', '仪表舱底', 4, bayFloor, { dir: [0, -0.2, 0.6], dist: 1.3, note: '凹进漆面的舱体' });

  const facePlate = box(BAY.w - 0.05, BAY.h - 0.05, 0.02, M.black, { r: 0.02, bevel: 0.006 });
  facePlate.position.set(BAY.x, BAY.y, bayFaceZ - 0.012);
  part('bayPlate', '仪表舱板', 4, facePlate, { dir: [0, 0, 0.9], dist: 1.4, note: '灯与槽位条的底板' });

  const pilot = new THREE.Group();
  const lampBody = cyl(0.078, 0.084, 0.05, M.metalDark, 24);
  lampBody.rotation.x = Math.PI / 2;
  lampBody.position.set(BAY.x - 0.17, BAY.y - 0.055, bayFaceZ + 0.018);
  pilot.add(lampBody);
  const lampLens = mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.02, 24), M.glow, { cast: false });
  lampLens.rotation.x = Math.PI / 2;
  lampLens.position.set(BAY.x - 0.17, BAY.y - 0.055, bayFaceZ + 0.044);
  pilot.add(lampLens);
  part('lamp', '指示灯', 4, pilot, { dir: [0, 0, 1.2], dist: 1.6, note: '圆形主灯，唯一带状态色的部件' });

  const bars = new THREE.Group();
  const barGeo = new THREE.BoxGeometry(0.25, 0.021, 0.012);
  for (let i = 0; i < 8; i++) {
    const bar = mesh(barGeo, M.panel, { cast: false });
    bar.position.set(BAY.x + 0.155, BAY.y + 0.145 - i * 0.0385, bayFaceZ + 0.012);
    bars.add(bar);
  }
  part('bars', '槽位灯条 ×8', 4, bars, { dir: [0, 0, 1], dist: 1.3, note: '八个软件各占一段，顺序固定' });

  const strip = new THREE.Group();
  const stripBase = box(1.00, 0.052, 0.018, M.dark, { r: 0.012, bevel: 0.004 });
  stripBase.position.set(0, 2.19, FRONT + 0.003);
  strip.add(stripBase);
  const ledGeo = new THREE.BoxGeometry(0.086, 0.026, 0.012);
  for (let i = 0; i < 9; i++) {
    const led = mesh(ledGeo, M.glow, { cast: false });
    led.position.set(-0.40 + i * 0.10, 2.19, FRONT + 0.012);
    strip.add(led);
  }
  part('strip', '状态条 ×9', 4, strip, { dir: [0, 0.4, 1], dist: 1.5, note: '九颗状态灯，隔着房间也能看见节奏' });

  // ---------------------------------------------------------------- 信标灯杆
  const mast = new THREE.Group();
  const mastBase = cyl(0.058, 0.076, 0.055, M.metalDark, 16);
  mastBase.position.set(0.56, 2.40, -0.33);
  mast.add(mastBase);
  const mastRod = cyl(0.015, 0.020, 0.28, M.steel, 10);
  mastRod.position.set(0.56, 2.56, -0.33);
  mast.add(mastRod);
  const bulb = mesh(new THREE.SphereGeometry(0.042, 16, 12), M.glow, { cast: false });
  bulb.position.set(0.56, 2.73, -0.33);
  mast.add(bulb);
  part('mast', '信标灯杆', 1, mast, { dir: [0, 1, 0], dist: 1.5, note: '尾部桅杆，任何角度都看得见' });

  // ---------------------------------------------------------------- 颈部
  const neck = new THREE.Group();
  const collar = cyl(0.17, 0.20, 0.09, M.metalDark, 24);
  collar.position.y = 2.44;
  neck.add(collar);
  const neckLower = box(0.19, 0.34, 0.19, M.metal, { r: 0.045, bevel: 0.01 });
  neckLower.position.y = 2.58;
  neck.add(neckLower);
  for (const y of [2.46, 2.72]) {
    const j = cyl(0.105, 0.105, 0.22, M.yellowDark, 20);
    j.rotation.z = Math.PI / 2;
    j.position.y = y;
    neck.add(j);
    const pin = cyl(0.038, 0.038, 0.24, M.rust, 12);
    pin.rotation.z = Math.PI / 2;
    pin.position.y = y;
    neck.add(pin);
  }
  const neckUpper = box(0.17, 0.24, 0.17, M.metal, { r: 0.04, bevel: 0.009 });
  neckUpper.position.y = 2.80;
  neck.add(neckUpper);
  const cable = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
    V3(-0.10, 2.36, -0.14), V3(-0.16, 2.52, -0.20), V3(0.02, 2.62, -0.21), V3(0.14, 2.56, -0.16),
  ]), 22, 0.019, 8, false), M.black);
  neck.add(cable);
  part('neck', '颈部', 1, neck, { dir: [0, 0.6, 0], dist: 1.1, note: '双轴云台，水平 ±90°' });

  // ---------------------------------------------------------------- 头部
  const headY = DIMS.head.y + 0.01;
  const bridge = box(DIMS.head.w, DIMS.head.h, DIMS.head.d, M.metalDark, { r: 0.06, bevel: 0.014 });
  bridge.position.set(0, headY - 0.01, -0.02);
  part('headBridge', '双筒桥接件', 1, bridge, { dir: [0, 0.8, -0.4], dist: 1.15, note: '铸铝，连接两只镜筒' });

  [-1, 1].forEach((side, i) => {
    const barrel = new THREE.Group();
    const tube = cyl(0.20, 0.21, 0.34, M.eyeBody, 24);
    tube.rotation.x = Math.PI / 2;
    tube.position.set(side * DIMS.head.eyeX, headY, 0.14);
    barrel.add(tube);
    const lens = mesh(new THREE.SphereGeometry(0.175, 24, 16), M.lens);
    lens.scale.z = 0.55;
    lens.position.set(side * DIMS.head.eyeX, headY, 0.30);
    barrel.add(lens);
    const iris = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.022, 10, 28), M.iris);
    iris.position.set(side * DIMS.head.eyeX, headY, 0.325);
    barrel.add(iris);
    part(`eye${i}`, i === 0 ? '左镜筒' : '右镜筒', 1, barrel, {
      dir: [side * 1, 0.35, 0.25], dist: 1.45, note: '镜筒 + 镀膜镜片 + 虹膜环',
    });
  });

  // 眉板：一条压在双眼上方的深色 visor，和状态机器人的同款。
  const brow = box(0.72, 0.07, 0.06, M.metalDark, { r: 0.03, bevel: 0.006 });
  brow.position.set(0, headY + 0.15, 0.30);
  part('brow', '眉板', 1, brow, { dir: [0, 1, 0.2], dist: 1.1, note: '眉形随状态变化，这里拆下来是一整条' });

  const antenna = new THREE.Group();
  const rod = cyl(0.011, 0.014, 0.52, M.metalDark, 8);
  rod.position.set(-0.17, headY + 0.46 + 0.24, -0.06);
  antenna.add(rod);
  const tip = mesh(new THREE.SphereGeometry(0.034, 14, 12), M.glow, { cast: false });
  tip.position.set(-0.17, headY + 0.46 + 0.52, -0.06);
  antenna.add(tip);
  const antennaBase = mesh(new THREE.TorusGeometry(0.035, 0.009, 8, 18), M.rust);
  antennaBase.rotation.x = Math.PI / 2;
  antennaBase.position.set(-0.17, headY + 0.46 + 0.02, -0.06);
  antenna.add(antennaBase);
  part('antenna', '天线', 1, antenna, { dir: [0.4, 1, 0], dist: 1.6, note: '0.5 m 鞭状天线，顶端随状态发光' });

  // ---------------------------------------------------------------- 手臂 ×2
  [-1, 1].forEach((side, i) => {
    const ax = side * DIMS.arm.x;

    // 上臂：双板 + 中间液压缸，挂在肩架外，读作工程件而不是两根棍。
    const upper = new THREE.Group();
    for (const ox of [-0.05, 0.05]) {
      const boom = box(0.10, DIMS.arm.upper, 0.16, M.arm, { r: 0.04, bevel: 0.008 });
      boom.position.set(ax + ox, DIMS.arm.y, DIMS.arm.z);
      upper.add(boom);
    }
    const actuator = cyl(0.045, 0.045, DIMS.arm.upper - 0.08, M.steel, 16);
    actuator.position.set(ax, DIMS.arm.y, DIMS.arm.z + 0.05);
    upper.add(actuator);
    part(`arm${i}`, i === 0 ? '左上臂' : '右上臂', 2, upper, {
      dir: [side, 0.15, 0.25], dist: 1.7, note: '双板 + 液压缸，肩关节含谐波减速器',
    });

    const fore = new THREE.Group();
    const foreArm = box(0.11, DIMS.arm.fore, 0.14, M.steel, { r: 0.03, bevel: 0.006 });
    foreArm.position.set(ax, DIMS.arm.y - 0.62, DIMS.arm.z + 0.02);
    fore.add(foreArm);
    const elbow = mesh(new THREE.TorusGeometry(0.09, 0.018, 8, 24), M.metalDark);
    elbow.position.set(ax, DIMS.arm.y - 0.27, DIMS.arm.z + 0.02);
    fore.add(elbow);
    part(`fore${i}`, i === 0 ? '左前臂' : '右前臂', 2, fore, {
      dir: [side, -0.2, 0.35], dist: 2.0, note: '前臂 + 肘关节环，肘 ±110°',
    });

    const claw = new THREE.Group();
    const palm = box(0.16, 0.12, 0.10, M.arm, { r: 0.02, bevel: 0.005 });
    palm.position.set(ax, DIMS.arm.y - 0.92, DIMS.arm.z + 0.04);
    claw.add(palm);
    for (const s of [-1, 1]) {
      const finger = box(0.05, 0.16, 0.05, M.steel, { r: 0.015, bevel: 0.004 });
      finger.position.set(ax + s * 0.05, DIMS.arm.y - 1.06, DIMS.arm.z + 0.06);
      finger.rotation.z = s * 0.12;
      claw.add(finger);
    }
    part(`claw${i}`, i === 0 ? '左铲形爪' : '右铲形爪', 2, claw, {
      dir: [side, -0.3, 0.3], dist: 2.3, note: '两指 + 拇指，夹持力 40 N',
    });
  });

  // ---------------------------------------------------------------- 内部
  const battery = box(0.52, 0.36, 0.62, M.panel, { r: 0.04, bevel: 0.01 });
  battery.position.set(0, CH.y - 0.30, -0.10);
  part('battery', '电池组', 4, battery, { dir: [0, -0.7, 0], dist: 1.5, note: '24 V 12 Ah 磷酸铁锂' });

  [-1, 1].forEach((side, i) => {
    const motor = cyl(0.17, 0.17, 0.34, M.metalDark, 20);
    motor.rotation.z = Math.PI / 2;
    motor.position.set(side * 0.44, CH.y - 0.34, 0.26);
    part(`motor${i}`, i === 0 ? '左驱动电机' : '右驱动电机', 4, motor, {
      dir: [side * 0.8, -0.4, 0.4], dist: 1.7, note: '无刷直流，2×120 W',
    });

    const gear = cyl(0.14, 0.14, 0.10, M.wheel, 18);
    gear.rotation.z = Math.PI / 2;
    gear.position.set(side * 0.44, CH.y - 0.34, 0.52);
    part(`gear${i}`, i === 0 ? '左减速齿轮' : '右减速齿轮', 4, gear, {
      dir: [side * 0.9, -0.2, 0.6], dist: 1.9, small: true, note: '18 齿，减速比 24:1',
    });
  });

  const board = box(0.62, 0.05, 0.44, M.panel, { r: 0.02, bevel: 0.004 });
  board.position.set(0, CH.y + 0.42, -0.06);
  part('pcb', '主控板', 4, board, { dir: [0, 0.9, -0.4], dist: 1.55, note: '六层板，32 位 MCU' });

  const chips = new THREE.Group();
  [[-0.18, 0.02], [0.10, 0.06], [0.22, -0.08]].forEach(([x, z]) => {
    const chip = box(0.12, 0.03, 0.12, M.black, { r: 0.008, bevel: 0.002 });
    chip.position.set(x, CH.y + 0.46, z);
    chips.add(chip);
  });
  part('chips', '芯片 ×3', 5, chips, { dir: [0, 0.7, 0.3], dist: 2.1, small: true, note: 'BGA 封装' });

  const cables = new THREE.Group();
  const cableDefs = [
    { a: [-0.3, CH.y + 0.4, -0.2], b: [-0.5, CH.y - 0.2, 0.3], r: 0.035, mat: M.wheel },
    { a: [0.3, CH.y + 0.4, -0.2], b: [0.5, CH.y - 0.2, 0.3], r: 0.03, mat: M.metalDark },
    { a: [0, CH.y + 0.5, 0.2], b: [0, CH.y - 0.1, 0.5], r: 0.025, mat: M.metalDark },
  ];
  cableDefs.forEach((c) => {
    const curve = new THREE.CatmullRomCurve3([V3(...c.a), V3(c.a[0] * 0.6, c.a[1] - 0.3, c.b[2] * 0.6), V3(...c.b)]);
    const cable = mesh(new THREE.TubeGeometry(curve, 20, c.r, 6, false), c.mat);
    cables.add(cable);
  });
  part('cables', '线束 ×3', 5, cables, { dir: [0, 0.3, 0.8], dist: 2.2, small: true, note: '编织护套，耐 105 °C' });

  const screws = new THREE.Group();
  for (let k = 0; k < 12; k++) {
    const s = cyl(0.028, 0.028, 0.06, M.steel, 8);
    const col = k % 4;
    const row = Math.floor(k / 4);
    s.position.set(-0.5 + col * 0.33, CH.y + 0.78 + row * 0.06, -0.1 + row * 0.1);
    screws.add(s);
  }
  part('screws', '螺丝包 ×12', 5, screws, { dir: [0, 1.4, 0], dist: 2.4, small: true, note: 'M4×10 内六角' });

  return { root, parts, materials: M };
}
