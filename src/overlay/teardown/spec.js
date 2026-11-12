// 拆解演示的单一真源。
//
// teardown 那套规则里最重要的一条是「真实数字，单一来源」：面板上写的每一个
// 毫米、每一段拆解位移，都从这张表来，几何也从这张表来。这样屏幕上不可能出现
// 「图上是这个尺寸、标签写另一个数」的自相矛盾。
//
// 单位：几何用世界单位（和 robot3d.js 同一套比例），面板按 MM_PER_UNIT 换算成
// 毫米显示。机体外壳 1.54 u 宽 → 308 mm，整机约 780 mm 高。

export const MM_PER_UNIT = 200;

export const DIMS = {
  // 主壳体（1.54 × 1.68 × 1.10 u）
  hull: { w: 1.54, h: 1.68, d: 1.10, r: 0.085, y: 1.42 },
  // 履带：长 2.12、高 1.36、宽 0.46，左右中心距 ±1.20
  track: { w: 2.12, h: 1.36, d: 0.46, r: 0.43, x: 1.20 },
  // 头部（双筒）
  head: { y: 2.86, w: 0.62, h: 0.24, d: 0.32, eyeX: 0.285, eyeR: 0.17 },
  // 颈
  neck: { y: 2.42, r: 0.17, h: 0.5 },
  // 手臂挂在履带**外**侧（0.97–1.43 的履带墙之外）：状态机器人的手臂就是在
  // x=1.56 的净空里摆动，放到履带内或缝里都会被挡得看不见。
  arm: { x: 1.56, y: 1.58, z: 0.30, upper: 0.52, fore: 0.46, claw: 0.20 },
  // 轮系：前后负重轮同径，上托轮略小；宽度是压装尺寸。
  wheel: { r: 0.30, top: 0.26, w: 0.16 },
};

// 拆解阶段。用户要的三段式：整体 → 依次拆解 → 全零件爆炸。
// 每个阶段给一个「一句话说明」，巡游时念的就是它。
export const STAGES = [
  {
    id: 'whole', label: '整机',
    caption: '一台履带机器人，停在桌面上。',
    narration: '这是 B 零一履带机器人。整体看，它是一台放在桌角的黄色小坦克。',
  },
  {
    id: 'top', label: '顶部',
    caption: '先摘掉头顶的信标、天线与双筒护罩 —— 它们只靠三颗螺丝固定。',
    narration: '先看顶部。信标灯、天线，还有那对双筒镜筒，它们只用三颗螺丝固定。',
  },
  {
    id: 'limbs', label: '运动件',
    caption: '两条履带与双臂是整机唯一的运动部件，先从壳体上脱开。',
    narration: '两条履带和双臂，是整机唯一的运动部件。',
  },
  {
    id: 'shell', label: '外壳',
    caption: '卸下前门板、顶盖与侧板，主机架第一次露出来。',
    narration: '卸下前门板、顶盖和侧板，主机架第一次露出来。',
  },
  {
    id: 'core', label: '内部',
    caption: '电池、双电机、齿轮箱与主控板：真正让它动起来的东西。',
    narration: '电池、双电机、齿轮箱，还有主控板。真正让它动起来的东西都在这里。',
  },
  {
    id: 'detail', label: '零件',
    // 这里原来写死「共 120 多件」，而模型实际只有几十件 —— 旁白是念出来的，
    // 观众数一下就能对上。件数以 `parts.length` 为准，文案不再重复这个数字。
    caption: '最后一层：履带齿、链轮、轴承、线束、螺丝与灯珠——每一颗都是独立零件。',
    narration: '最后一层。履带齿、链轮、轴承、线束和螺丝，每一颗都是独立零件。',
  },
];

// 摄影棚：浅色背景 + 一个强调色。强调色只用在「此刻在动/被选中」的东西上。
export const STUDIO = {
  background: '#f4f1ea',
  floor: '#e8e3d8',
  ink: '#1a1a18',
  accent: '#c8452d',
  muted: '#8a8578',
};

// 面板里要显示的关键读数。尺寸类一律取「实测包围盒」，而不是拿某个零件的位置
// 去推算 —— 推算出来的数字会和画面打架（第一版就出现了「标题写 780、面板写 620」）。
export const READOUTS = [
  { key: 'height', label: '整机高度', value: (m) => Math.round(m.size.y * MM_PER_UNIT), unit: 'mm' },
  { key: 'width', label: '整机宽度', value: (m) => Math.round(m.size.x * MM_PER_UNIT), unit: 'mm' },
  { key: 'hull', label: '壳体', value: () => `${Math.round(DIMS.hull.w * MM_PER_UNIT)}×${Math.round(DIMS.hull.d * MM_PER_UNIT)}`, unit: 'mm' },
  {
    key: 'track',
    label: '履带周长',
    // 圆角矩形的真实周长：两条直边 + 两段四分之一圆弧，而不是 2(w+h) 的直线
    // 近似 —— 后者会多算约 11%（1392 mm 对 1244 mm），而面板旁边那条履带就是
    // 照着这个轮廓画出来的。
    value: () => Math.round((2 * (DIMS.track.w - 2 * DIMS.track.r)
      + 2 * (DIMS.track.h - 2 * DIMS.track.r)
      + 2 * Math.PI * DIMS.track.r) * MM_PER_UNIT),
    unit: 'mm',
  },
];
