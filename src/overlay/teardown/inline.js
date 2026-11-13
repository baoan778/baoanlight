// 桌面内联拆解：不打开网页、不开第二个窗口，直接把桌面上的机器人换成
// 可拆解的零件模型，并在原地爆炸/装回。
//
// 和 teardown/live.js 共用同一份模型与阶段（model.js / spec.js），但这里没有
// 摄影棚、没有独立画布：场景、相机、渲染器都是浮层自己的，所以它出现的位置
// 就是用户把机器人拖到的位置。
//
// 三条约束：
//   1. 一个输入驱动一切：零件位置只是 amount(0..1) 的函数；
//   2. 相机随爆炸范围自动后退，零件不会被画布裁掉；
//   3. 模型在关闭时释放（几何、材质、贴图），一个常驻窗口不该为一次演示
//      一直占着显存。
import * as THREE from '../vendor/three.module.js';
import { buildRobot } from './model.js';
import { STAGES } from './spec.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (x) => 1 - Math.pow(1 - clamp(x, 0, 1), 3.2);

// 桌面窗口只有几百像素，把爆炸位移压紧一点：螺丝仍然散开，但整体不会
// 退到「整机只剩一个点」的距离。
const SPREAD = 0.72;

// 和 robot3d.js 的开场机位一致：关闭拆解时回到这里。
const HOME = { x: 1.55, y: 2.66, z: 9.85, ly: 1.64 };

export function createInlineTeardown({ scene, camera, hide = [], onState, onHover }) {
  let root = null;
  let parts = [];
  let on = false;
  let amount = 0;
  let target = 0;
  let stagger = 0;
  let mode = 'whole';

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hoverAt = 0;
  let hovered = '';

  function stageIndex() {
    if (amount <= 0.001) return 0;
    if (stagger < 0.99) return amount >= 0.999 ? STAGES.length - 1 : 1;
    return clamp(Math.ceil(amount * 6), 0, STAGES.length - 1);
  }

  // 每帧都往 UI 派事件是白费：滑块位置和百分比只在真的变了才需要重画。
  let lastEmitKey = '';
  function emit(force = false) {
    if (!onState) return;
    const stage = stageIndex();
    const key = `${on ? 1 : 0}:${Math.round(amount * 100)}:${stage}:${parts.length}`;
    if (!force && key === lastEmitKey) return;
    lastEmitKey = key;
    onState({
      on,
      amount,
      mode,
      stage,
      stageLabel: STAGES[stage].label,
      parts: parts.length,
    });
  }

  function build() {
    const built = buildRobot();
    root = built.root;
    parts = built.parts;
    // 每个零件对象自己记住元数据：射线命中任意子网格时往上找一层就能认出来。
    for (const p of parts) p.obj.userData.tdPart = p;
    scene.add(root);
  }

  function apply() {
    if (!root) return;
    for (const p of parts) {
      const u = ease(stagger >= 0.99 ? clamp(amount * 6 - (p.stage - 1), 0, 1) : amount) * SPREAD;
      const base = p.obj.userData.explode.base;
      p.obj.position.set(
        base.x + p.dir.x * p.dist * u,
        base.y + p.dir.y * p.dist * u,
        base.z + p.dir.z * p.dist * u
      );
    }
  }

  // 画面内留 18% 余量：爆炸时零件是「飞出去」的，贴边就等于被切掉。
  function viewFor(a) {
    const w = 3.6 + 5.2 * SPREAD * a;
    const h = 3.9 + 2.6 * SPREAD * a;
    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (camera.aspect || 1));
    const dist = Math.max(
      h / (2 * Math.tan(vFov / 2) * 0.82),
      w / (2 * Math.tan(hFov / 2) * 0.82)
    );
    return { x: 2.3, y: 3.0 + 0.2 * a, z: dist, ly: 1.75 + 0.25 * a };
  }

  function placeCamera(dt, immediate = false) {
    const v = viewFor(amount);
    const k = immediate ? 1 : 1 - Math.exp(-6 * dt);
    camera.position.x += (v.x - camera.position.x) * k;
    camera.position.y += (v.y - camera.position.y) * k;
    camera.position.z += (v.z - camera.position.z) * k;
    camera.lookAt(0, v.ly, 0);
  }

  function dispose() {
    if (!root) return;
    const geos = new Set();
    const mats = new Set();
    root.traverse((o) => {
      if (o.geometry) geos.add(o.geometry);
      if (o.material) mats.add(o.material);
    });
    for (const g of geos) g.dispose();
    for (const m of mats) {
      for (const key of ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap']) {
        if (m[key]) m[key].dispose();
      }
      if (m.dispose) m.dispose();
    }
    scene.remove(root);
    root = null;
    parts = [];
  }

  function open() {
    if (on) return;
    if (!root) build();
    on = true;
    for (const o of hide) o.visible = false;
    amount = 0;
    target = 0;
    stagger = 0;
    mode = 'whole';
    apply();
    placeCamera(0, true);
    hovered = '';
    if (onHover) onHover(null);
    emit(true);
  }

  function close() {
    if (!on) return;
    on = false;
    for (const o of hide) o.visible = true;
    camera.position.set(HOME.x, HOME.y, HOME.z);
    camera.lookAt(0, HOME.ly, 0);
    hovered = '';
    if (onHover) onHover(null);
    dispose();
    emit(true);
  }

  function setMode(next) {
    if (!on) return;
    mode = next;
    if (next === 'whole') { stagger = 0; target = 0; }
    else if (next === 'explode') { stagger = 0; target = 1; }
    else if (next === 'steps') {
      // 依次拆解：从整机开始，14 秒走完六段。任何手动输入都会接管。
      stagger = 1;
      amount = 0;
      target = 1;
    }
    emit(true);
  }

  function setAmount(v) {
    if (!on) return;
    mode = 'manual';
    stagger = 0;
    amount = clamp(Number(v) || 0, 0, 1);
    target = amount;
    apply();
    emit(true);
  }

  function pick(x, y, w, h) {
    if (!root || !w || !h) return null;
    ndc.set((x / w) * 2 - 1, -(y / h) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObject(root, true);
    for (const hit of hits) {
      let o = hit.object;
      while (o && o !== root) {
        if (o.userData && o.userData.tdPart) return o.userData.tdPart;
        o = o.parent;
      }
    }
    return null;
  }

  // 返回 true 表示这一帧由拆解场景接管，普通机器人的姿态/灯效不用再算。
  function update(dt, pointer) {
    if (!on) return false;

    if (mode === 'steps' && amount < 1) amount = Math.min(1, amount + dt / 14);
    else amount += (target - amount) * (1 - Math.exp(-7 * dt));
    if (Math.abs(target - amount) < 0.0005) amount = target;
    apply();
    placeCamera(dt);

    if (pointer && pointer.seen && pointer.w && pointer.h) {
      const now = performance.now();
      if (now - hoverAt > 120) {
        hoverAt = now;
        const part = pick(pointer.x, pointer.y, pointer.w, pointer.h);
        const label = part ? part.label : '';
        if (label !== hovered) {
          hovered = label;
          if (onHover) onHover(part ? { label: part.label, note: part.note || '' } : null);
        }
      }
    }

    emit();
    return true;
  }

  return {
    open,
    close,
    setMode,
    setAmount,
    update,
    isOpen: () => on,
    parts: () => parts.length,
    state: () => ({ on, amount, target, mode, stagger }),
  };
}
