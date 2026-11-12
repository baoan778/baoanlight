// 可拆解的机器人模型。
//
// 和状态机器人（robot3d.js）是同一台机器、同一套比例与配色，但这里是按「装配
// 顺序」重建的：每个零件都是 root 的直接子节点、位置是绝对值，所以爆炸时只需
// 给每个零件一个方向和距离，复位时把位置写回 base 就是原样 —— 不存在「拆完装
// 不回去」的可能。
//
// 每个零件都带 userData.explode = { stage, dir, dist }：
//   stage  第几步拆它（0 = 不参与，随父件走）
//   dir    往哪个方向走（世界坐标，单位向量）
//   dist   走多远（世界单位，1 u ≈ 200 mm）
import * as THREE from '../vendor/three.module.js';
import { slab, mesh } from '../scene/geometry.js';
import { paint } from '../scene/surfaces.js';
import { SKIN_TONES, EYE_TONES, TRACK_TONES, ARM_TONES } from '../shared/palette.mjs';
import { DIMS } from './spec.js';

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

function materials() {
  const skin = SKIN_TONES[0];
  const eye = EYE_TONES[0];
  const track = TRACK_TONES[0];
  const arm = ARM_TONES[0];
  return {
    // 纹理要「细」：整块壳体只有一张 256px 的贴图，repeat 太小会把锈斑放大成
    // 奶牛花纹。2.6 次左右才读作做旧，而不是脏。
    paint: new THREE.MeshStandardMaterial({
      map: paint(skin.hex, { seed: 3, amount: 0.3, repeat: [7, 5.5] }), metalness: 0.14, roughness: 0.66,
    }),
    paintDark: new THREE.MeshStandardMaterial({
      map: paint(skin.dark, { seed: 5, amount: 0.6, repeat: [2.2, 2.2] }), metalness: 0.16, roughness: 0.72,
    }),
    steel: new THREE.MeshStandardMaterial({ color: arm.steel, metalness: 0.72, roughness: 0.46 }),
    gun: new THREE.MeshStandardMaterial({ color: arm.dark, metalness: 0.55, roughness: 0.62 }),
    arm: new THREE.MeshStandardMaterial({ color: arm.arm, metalness: 0.5, roughness: 0.5 }),
    rubber: new THREE.MeshStandardMaterial({ color: track.rubber, metalness: 0.05, roughness: 0.95 }),
    rubberHi: new THREE.MeshStandardMaterial({ color: track.hi, metalness: 0.2, roughness: 0.86 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: eye.lens, metalness: 0.1, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.03,
    }),
    iris: new THREE.MeshStandardMaterial({ color: eye.iris, metalness: 0.45, roughness: 0.32 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xb08a3e, metalness: 0.85, roughness: 0.35 }),
    copper: new THREE.MeshStandardMaterial({ color: 0xb4703c, metalness: 0.8, roughness: 0.4 }),
    cell: new THREE.MeshStandardMaterial({ color: 0x2f4a3a, metalness: 0.3, roughness: 0.7 }),
    pcb: new THREE.MeshStandardMaterial({ color: 0x1f4d3a, metalness: 0.2, roughness: 0.8 }),
    chip: new THREE.MeshStandardMaterial({ color: 0x14161a, metalness: 0.4, roughness: 0.5 }),
    lamp: new THREE.MeshStandardMaterial({
      color: 0x0c0e11, emissive: 0x34c759, emissiveIntensity: 1.4, roughness: 0.4,
    }),
    white: new THREE.MeshStandardMaterial({ color: 0xe9e4d8, metalness: 0.1, roughness: 0.7 }),
  };
}

export function buildRobot() {
  const M = materials();
  const root = new THREE.Group();
  const parts = [];

  // 统一的登记口：零件建好后必须经过这里，才会参与爆炸动画。
  function part(id, label, stage, obj, { dir = [0, 1, 0], dist = 1, note = '', small = false } = {}) {
    const d = V3(...dir).normalize();
    obj.userData.explode = { stage, dir: d, dist, base: obj.position.clone() };
    root.add(obj);
    parts.push({ id, label, stage, obj, dir: d, dist, note, small });
    return obj;
  }

  const box = (w, h, d, mat, opts) => mesh(slab(w, h, d, opts), mat);
  const cyl = (r1, r2, h, mat, seg = 20) => mesh(new THREE.CylinderGeometry(r1, r2, h, seg), mat);

  // ---------------------------------------------------------------- 履带总成
  function belt(side) {
    const T = DIMS.track;
    const g = new THREE.Group();
    const pts = [];
    const w = T.w, h = T.h, r = T.r, seg = 10;
    const x0 = -w / 2, y0 = -h / 2;
    const line = (ax, ay, bx, by) => {
      for (let i = 0; i < seg; i++) pts.push(new THREE.Vector2(ax + (bx - ax) * (i / seg), ay + (by - ay) * (i / seg)));
    };
    const arc = (cx, cy, a0, a1) => {
      for (let i = 0; i < seg; i++) {
        const a = a0 + (a1 - a0) * (i / seg);
        pts.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
      }
    };
    line(x0 + r, y0, -x0 - r, y0); arc(w / 2 - r, y0 + r, -Math.PI / 2, 0);
    line(x0 + w, y0 + r, x0 + w, -y0 - r); arc(w / 2 - r, -y0 - r, 0, Math.PI / 2);
    line(-x0 - r, y0 + h, x0 + r, y0 + h); arc(x0 + r, -y0 - r, Math.PI / 2, Math.PI);
    line(x0, -y0 - r, x0, y0 + r); arc(x0 + r, y0 + r, Math.PI, Math.PI * 1.5);
    const beltShape = new THREE.Shape(pts);
    const hole = new THREE.Path(pts.map((p) => new THREE.Vector2(p.x * 0.74, p.y * 0.74)));
    beltShape.holes.push(hole);
    const beltGeo = new THREE.ExtrudeGeometry(beltShape, {
      depth: T.d, bevelEnabled: true, bevelSize: 0.018, bevelThickness: 0.018, bevelSegments: 2, curveSegments: 8,
    });
    beltGeo.center();
    const ring = mesh(beltGeo, M.rubber);
    ring.rotation.y = Math.PI / 2;
    g.add(ring);

    // 内衬一圈，让履带读作「有厚度」而不是一块橡胶
    const innerShape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x * 0.70, p.y * 0.70)));
    innerShape.holes.push(new THREE.Path(pts.map((p) => new THREE.Vector2(p.x * 0.52, p.y * 0.52))));
    const innerGeo = new THREE.ExtrudeGeometry(innerShape, {
      depth: T.d - 0.06, bevelEnabled: true, bevelSize: 0.01, bevelThickness: 0.01, bevelSegments: 1, curveSegments: 8,
    });
    innerGeo.center();
    const liner = mesh(innerGeo, M.rubberHi);
    liner.rotation.y = Math.PI / 2;
    g.add(liner);

    // 44 颗履带齿：一个 InstancedMesh，拆解时整组一起走（第 6 步才散开）。
    // 用钢色而不是枪灰：深色齿压在深色橡胶上等于没有，整条履带会读成一只轮胎。
    const lugGeo = new THREE.BoxGeometry(0.13, 0.09, T.d * 0.9);
    const lugs = new THREE.InstancedMesh(lugGeo, M.steel, 44);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < 44; i++) {
      const t = (i / 44) * Math.PI * 2;
      const px = Math.cos(t) * (w / 2 - 0.02);
      const py = Math.sin(t) * (h / 2 - 0.02);
      m4.makeRotationZ(Math.atan2(py, px));
      m4.setPosition(px, py, 0);
      lugs.setMatrixAt(i, m4);
    }
    lugs.instanceMatrix.needsUpdate = true;
    // 履带齿是一件独立零件（第 5 步整组飞出去），所以它**不能**同时挂在履带组里：
    // 挂了之后 44 颗齿会被画两遍（一份飞走、一份留在履带上，还互相 z-fighting），
    // 旁白说 44 件、画面上是 88 件。
    const lugGroup = new THREE.Group();
    lugGroup.rotation.y = Math.PI / 2;
    lugGroup.add(lugs);

    g.position.set(side * DIMS.track.x, DIMS.track.h / 2, 0);
    // 齿组现在是 root 的直接子节点，世界位置得自己带上（原来是靠挂在 g 上）。
    lugGroup.position.set(side * DIMS.track.x, DIMS.track.h / 2, 0);
    return { group: g, lugs: lugGroup };
  }

  [-1, 1].forEach((side, i) => {
    const { group, lugs } = belt(side);
    part(`track${i}`, i === 0 ? '左履带' : '右履带', 2, group, {
      dir: [side, 0.1, 0], dist: 2.1, note: '橡胶履带 + 内衬，44 颗履带齿',
    });
    // 履带齿作为独立零件：第 5 步沿 Z 向外散开（拆到「细小零件」那一层）。
    // 直接用原对象，不再 clone —— clone 会让同一批齿在场景里存在两份。
    part(`lugs${i}`, i === 0 ? '左履带齿 ×44' : '右履带齿 ×44', 5, lugs, {
      dir: [0, 0, side], dist: 1.9, small: true, note: '44 颗独立履带齿，压装在橡胶带上',
    });

    // 轮系：前/后/上三只负重轮 + 主动轮
    const wheels = [
      { z: -0.62, y: 0.30, r: 0.30, label: '前负重轮' },
      { z: 0.62, y: 0.30, r: 0.30, label: '后负重轮' },
      { z: 0, y: 0.62, r: 0.26, label: '上托轮' },
    ];
    wheels.forEach((w, k) => {
      const wheel = cyl(w.r, w.r, 0.16, M.steel, 24);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(side * DIMS.track.x, w.y + 0.05, w.z);
      part(`wheel${i}${k}`, `${i === 0 ? '左' : '右'}${w.label}`, 5, wheel, {
        dir: [side, 0, w.z < 0 ? -0.6 : 0.6], dist: 2.5, small: true, note: '双列轴承，压入侧板',
      });
    });

    const sprocket = new THREE.Group();
    const hub = cyl(0.16, 0.16, 0.20, M.brass, 18);
    hub.rotation.z = Math.PI / 2;
    sprocket.add(hub);
    for (let k = 0; k < 8; k++) {
      const tooth = box(0.05, 0.05, 0.18, M.brass);
      const a = (k / 8) * Math.PI * 2;
      tooth.position.set(0, Math.cos(a) * 0.22, Math.sin(a) * 0.22);
      sprocket.add(tooth);
    }
    sprocket.position.set(side * DIMS.track.x, DIMS.track.h / 2, 0);
    part(`sprocket${i}`, i === 0 ? '左主动轮' : '右主动轮', 5, sprocket, {
      dir: [side, 0.2, 0], dist: 2.6, small: true, note: '8 齿，模数 4 mm',
    });
  });

  // -------------------------------------------------------------------- 壳体
  const H = DIMS.hull;
  const hull = box(H.w, H.h, H.d, M.paint, { r: H.r, bevel: 0.024 });
  hull.position.set(0, H.y, 0);
  part('hull', '主壳体', 3, hull, {
    dir: [0, 0, -1], dist: 1.7, note: '1.5 mm 冷轧钢板，做旧喷漆',
  });

  const deck = box(H.w - 0.06, 0.10, H.d - 0.06, M.paintDark, { r: 0.05, bevel: 0.012 });
  deck.position.set(0, H.y + H.h / 2 + 0.05, 0);
  part('deck', '顶盖', 3, deck, { dir: [0, 1, 0.15], dist: 1.5, note: '四颗 M4 螺丝固定' });

  const door = box(H.w - 0.22, 0.52, 0.06, M.paint, { r: 0.03, bevel: 0.01 });
  door.position.set(0, 0.92, H.d / 2 - 0.01);
  part('door', '前门板', 3, door, { dir: [0, -0.15, 1], dist: 1.5, note: '压实斗舱门，单边铰链' });

  const lower = box(H.w - 0.22, 0.42, 0.05, M.paintDark, { r: 0.03, bevel: 0.008 });
  lower.position.set(0, 0.60, H.d / 2 - 0.02);
  part('lowerPlate', '下护板', 3, lower, { dir: [0, -0.6, 0.8], dist: 1.3, note: '兼作配重' });

  [-1, 1].forEach((side, i) => {
    const panel = box(0.05, 0.86, H.d - 0.16, M.paintDark, { r: 0.02, bevel: 0.008 });
    panel.position.set(side * (H.w / 2 - 0.02), H.y - 0.10, 0);
    part(`side${i}`, i === 0 ? '左侧板' : '右侧板', 3, panel, {
      dir: [side, 0, 0], dist: 1.35, note: '走线槽贴在它的内侧',
    });
  });

  const hook = mesh(new THREE.TorusGeometry(0.15, 0.026, 10, 24, Math.PI), M.steel);
  hook.position.set(0, 0.44 + H.y, -H.d / 2 - 0.03);
  part('hook', '背部吊钩', 3, hook, { dir: [0, 0.2, -1], dist: 1.5, note: '整机唯一吊点，承重 12 kg' });

  const vent = box(0.86, 0.30, 0.03, M.gun, { r: 0.012, bevel: 0.004 });
  vent.position.set(0, H.y - 0.55, -H.d / 2 - 0.02);
  part('vent', '散热格栅', 3, vent, { dir: [0, 0, -1], dist: 1.7, note: '10 条横向百叶' });

  // -------------------------------------------------------------------- 头部
  const headY = DIMS.head.y;
  const cap = box(1.02, 0.10, 0.44, M.paint, { r: 0.05, bevel: 0.012 });
  cap.position.set(0, headY + 0.18, 0);
  part('headCap', '头顶护罩', 1, cap, { dir: [0, 1, -0.2], dist: 1.25, note: '双筒的防尘罩' });

  const bridge = box(0.62, 0.20, 0.30, M.gun, { r: 0.06, bevel: 0.014 });
  bridge.position.set(0, headY, -0.02);
  part('headBridge', '双筒桥接件', 1, bridge, { dir: [0, 0.8, -0.4], dist: 1.15, note: '铸铝，连接两只镜筒' });

  [-1, 1].forEach((side, i) => {
    const barrel = cyl(0.20, 0.21, 0.34, M.steel, 24);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(side * DIMS.head.eyeX, headY, 0.14);
    part(`eye${i}`, i === 0 ? '左镜筒' : '右镜筒', 1, barrel, {
      dir: [side * 1, 0.35, 0.25], dist: 1.45, note: '前端镜片可单独更换',
    });

    const lens = mesh(new THREE.SphereGeometry(0.175, 24, 16), M.glass);
    lens.scale.z = 0.55;
    lens.position.set(side * DIMS.head.eyeX, headY, 0.30);
    part(`lens${i}`, i === 0 ? '左镜片' : '右镜片', 1, lens, {
      dir: [side * 1, 0.45, 0.5], dist: 1.7, note: '镀膜光学玻璃，φ 350 mm 等效',
    });

    const iris = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.022, 10, 28), M.iris);
    iris.position.set(side * DIMS.head.eyeX, headY, 0.325);
    part(`iris${i}`, i === 0 ? '左虹膜环' : '右虹膜环', 1, iris, {
      dir: [side * 1, 0.5, 0.7], dist: 1.9, small: true, note: '8 段独立发光',
    });
  });

  const beacon = new THREE.Group();
  const stem = cyl(0.035, 0.045, 0.34, M.gun, 12);
  stem.position.y = 0.17;
  beacon.add(stem);
  const bulb = mesh(new THREE.SphereGeometry(0.10, 20, 14), M.lamp);
  bulb.position.y = 0.38;
  beacon.add(bulb);
  beacon.position.set(0, headY + 0.24, -0.18);
  part('beacon', '信标灯', 1, beacon, { dir: [0, 1, 0], dist: 1.5, note: '状态灯，三色 LED' });

  const antenna = cyl(0.012, 0.012, 0.5, M.steel, 8);
  antenna.position.set(0.34, headY + 0.42, -0.2);
  part('antenna', '天线', 1, antenna, { dir: [0.4, 1, 0], dist: 1.6, note: '0.5 m 鞭状天线' });

  const neck = cyl(DIMS.neck.r, DIMS.neck.r * 1.1, 0.44, M.gun, 20);
  neck.position.set(0, DIMS.neck.y, 0);
  part('neck', '颈部', 1, neck, { dir: [0, 0.6, 0], dist: 1.1, note: '双轴云台，水平 ±90°' });

  // ------------------------------------------------------------ 手臂 ×2
  [-1, 1].forEach((side, i) => {
    const upper = box(0.14, DIMS.arm.upper, 0.16, M.arm, { r: 0.04, bevel: 0.008 });
    upper.position.set(side * DIMS.arm.x, DIMS.arm.y, DIMS.arm.z);
    part(`arm${i}`, i === 0 ? '左上臂' : '右上臂', 2, upper, {
      dir: [side, 0.15, 0.25], dist: 1.7, note: '肩关节内含谐波减速器',
    });

    const fore = box(0.12, DIMS.arm.fore, 0.13, M.steel, { r: 0.03, bevel: 0.006 });
    fore.position.set(side * DIMS.arm.x, DIMS.arm.y - 0.62, DIMS.arm.z + 0.02);
    part(`fore${i}`, i === 0 ? '左前臂' : '右前臂', 2, fore, {
      dir: [side, -0.2, 0.35], dist: 2.0, note: '肘关节 ±110°',
    });

    const claw = new THREE.Group();
    const palm = box(0.16, 0.12, 0.10, M.arm, { r: 0.02, bevel: 0.005 });
    claw.add(palm);
    [-1, 1].forEach((s) => {
      const finger = box(0.05, 0.16, 0.05, M.steel, { r: 0.015, bevel: 0.004 });
      finger.position.set(s * 0.05, -0.12, 0.02);
      finger.rotation.z = s * 0.12;
      claw.add(finger);
    });
    claw.position.set(side * DIMS.arm.x, DIMS.arm.y - 0.92, DIMS.arm.z + 0.04);
    part(`claw${i}`, i === 0 ? '左铲形爪' : '右铲形爪', 2, claw, {
      dir: [side, -0.3, 0.3], dist: 2.3, note: '两指 + 拇指，夹持力 40 N',
    });
  });

  // -------------------------------------------------------------------- 内部
  const bay = box(0.66, 0.38, 0.10, M.gun, { r: 0.03, bevel: 0.008 });
  bay.position.set(0.32, H.y + 0.52, H.d / 2 - 0.06);
  part('bay', '仪表舱', 4, bay, { dir: [0.2, 0.6, 0.9], dist: 1.5, note: '四段灯 + 一位数码管' });

  const battery = box(0.52, 0.36, 0.62, M.cell, { r: 0.04, bevel: 0.01 });
  battery.position.set(0, H.y - 0.30, -0.10);
  part('battery', '电池组', 4, battery, { dir: [0, -0.7, 0], dist: 1.5, note: '24 V 12 Ah 磷酸铁锂' });

  [-1, 1].forEach((side, i) => {
    const motor = cyl(0.17, 0.17, 0.34, M.gun, 20);
    motor.rotation.z = Math.PI / 2;
    motor.position.set(side * 0.44, H.y - 0.34, 0.26);
    part(`motor${i}`, i === 0 ? '左驱动电机' : '右驱动电机', 4, motor, {
      dir: [side * 0.8, -0.4, 0.4], dist: 1.7, note: '无刷直流，2×120 W',
    });

    const gear = cyl(0.14, 0.14, 0.10, M.brass, 18);
    gear.rotation.z = Math.PI / 2;
    gear.position.set(side * 0.44, H.y - 0.34, 0.52);
    part(`gear${i}`, i === 0 ? '左减速齿轮' : '右减速齿轮', 4, gear, {
      dir: [side * 0.9, -0.2, 0.6], dist: 1.9, small: true, note: '18 齿，减速比 24:1',
    });
  });

  const board = box(0.62, 0.05, 0.44, M.pcb, { r: 0.02, bevel: 0.004 });
  board.position.set(0, H.y + 0.42, -0.06);
  part('pcb', '主控板', 4, board, { dir: [0, 0.9, -0.4], dist: 1.55, note: '六层板，32 位 MCU' });

  [[-0.18, 0.02], [0.10, 0.06], [0.22, -0.08]].forEach(([x, z], i) => {
    const chip = box(0.12, 0.03, 0.12, M.chip, { r: 0.008, bevel: 0.002 });
    chip.position.set(x, H.y + 0.46, z);
    part(`chip${i}`, `芯片 ${i + 1}`, 5, chip, {
      dir: [x, 0.7, z], dist: 2.1, small: true, note: 'BGA 封装',
    });
  });

  // 线束：三根细管线，拆到最细一层时单独走
  const cables = [
    { a: [-0.3, H.y + 0.4, -0.2], b: [-0.5, H.y - 0.2, 0.3], r: 0.035, label: '动力线束' },
    { a: [0.3, H.y + 0.4, -0.2], b: [0.5, H.y - 0.2, 0.3], r: 0.03, label: '信号线束' },
    { a: [0, H.y + 0.5, 0.2], b: [0, H.y - 0.1, 0.5], r: 0.025, label: '传感器排线' },
  ];
  cables.forEach((c, i) => {
    const curve = new THREE.CatmullRomCurve3([V3(...c.a), V3(c.a[0] * 0.6, c.a[1] - 0.3, c.b[2] * 0.6), V3(...c.b)]);
    const cable = mesh(new THREE.TubeGeometry(curve, 20, c.r, 6, false), i === 0 ? M.copper : M.gun);
    cable.position.set(0, 0, 0);
    part(`cable${i}`, c.label, 5, cable, {
      dir: [c.a[0] * 1.5, 0.3, 0.8], dist: 2.2, small: true, note: '编织护套，耐 105 °C',
    });
  });

  // 螺丝：12 颗，最后一层散开
  const screws = new THREE.Group();
  for (let k = 0; k < 12; k++) {
    const s = cyl(0.028, 0.028, 0.06, M.steel, 8);
    const col = k % 4;
    const row = Math.floor(k / 4);
    s.position.set(-0.5 + col * 0.33, H.y + 0.78 + row * 0.06, -0.1 + row * 0.1);
    screws.add(s);
  }
  part('screws', '螺丝包 ×12', 5, screws, { dir: [0, 1.4, 0], dist: 2.4, small: true, note: 'M4×10 内六角' });

  return { root, parts, materials: M };
}
