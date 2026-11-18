// 外观的唯一真源。
//
// 这些色值原本在 `ui.js`（做色块预览）和 `robot3d.js`（真的给材质上色）各存一份，
// 靠注释「与 robot3d.js 保持一致」维系。一旦有人只改一边，色块和机器人就会分开
// 说谎 —— 而且没有任何测试会失败，因为两边都「自己一致」。现在两边都从这里读。
//
// 顺序即界面顺序：下拉框、随机换装、色块预览都按这个顺序走，不要为了整齐重排。
// 值一律是 CSS 颜色字符串，three.js 的 Color.set() 直接接受。

export const SKIN_TONES = [
  { name: '做旧黄', hex: '#c9a238', dark: '#9a7923' },
  { name: '军绿', hex: '#7d8a4a', dark: '#5a6635' },
  { name: '铁锈橙', hex: '#c2773e', dark: '#8f5628' },
  { name: '深海蓝', hex: '#5a7d9a', dark: '#3f5c72' },
  { name: '岩灰', hex: '#9a968c', dark: '#6e6a60' },
  { name: '暗红', hex: '#a05048', dark: '#743a34' },
  { name: '金属银', hex: '#b9c2cd', dark: '#8a929c' },
  { name: '碳纤黑', hex: '#3a3d42', dark: '#24262a' },
  { name: '森林绿', hex: '#4a6a3a', dark: '#334a28' },
  { name: '日落橙', hex: '#d8823a', dark: '#a85a20' },
  { name: '樱花粉', hex: '#d98aa8', dark: '#a85e7a' },
  // 后加的两档：一冷一暗，给「金属/夜间」两套搭配多一个落点。追加在末尾，
  // 不重排既有顺序 —— 随机换装和已存的配置都按名字取值，顺序只是界面顺序。
  { name: '钛金白', hex: '#cfd6dd', dark: '#9aa3ad' },
  { name: '午夜紫', hex: '#4a3a5a', dark: '#332742' },
];

// 镜片接近黑玻璃，单独换它几乎看不出来；真正被看见的是里面那圈虹膜。
export const EYE_TONES = [
  { name: '默认黑', lens: '#131c23', iris: '#1b242c' },
  { name: '蓝瞳', lens: '#0c1a2e', iris: '#1e3a5f' },
  { name: '绿瞳', lens: '#0c1e14', iris: '#1e4a30' },
  { name: '金瞳', lens: '#1e1408', iris: '#4a3a10' },
  { name: '紫瞳', lens: '#1a0c2e', iris: '#3a1a5f' },
  { name: '红瞳', lens: '#2e0c0c', iris: '#5f1a1a' },
  { name: '橙瞳', lens: '#2e1a0c', iris: '#5f3a1a' },
  { name: '青瞳', lens: '#0c2a2a', iris: '#1a5a5a' },
  { name: '白瞳', lens: '#1a1c20', iris: '#cfd6dd' },
  { name: '玫红瞳', lens: '#2e0c1a', iris: '#a83a5f' },
];

export const TRACK_TONES = [
  { name: '黑', rubber: '#1a1a18', hi: '#3a3833' },
  { name: '深棕', rubber: '#2a1c14', hi: '#4a3428' },
  { name: '岩灰', rubber: '#2a2a28', hi: '#4a4a46' },
  { name: '军绿', rubber: '#1c2418', hi: '#38442e' },
  { name: '深蓝', rubber: '#141a24', hi: '#283848' },
  { name: '暗红', rubber: '#240c0c', hi: '#48201a' },
  { name: '墨绿', rubber: '#141c14', hi: '#2a3a26' },
  { name: '石墨', rubber: '#202024', hi: '#3a3a42' },
  { name: '沙色', rubber: '#3a3024', hi: '#5a4a36' },
];

export const ARM_TONES = [
  { name: '枪灰', arm: '#97958a', steel: '#8b8779', dark: '#2b2b28', eye: '#5c594f' },
  { name: '银白', arm: '#c4c1b6', steel: '#d6d2c6', dark: '#4a4a46', eye: '#9a9a94' },
  { name: '金色', arm: '#b89a55', steel: '#c9ad6e', dark: '#5a4526', eye: '#8a7438' },
  { name: '暗黑', arm: '#4a4a46', steel: '#5f5f5a', dark: '#1f1f1c', eye: '#3a3a36' },
  { name: '铜色', arm: '#b0764a', steel: '#c0895e', dark: '#4a3526', eye: '#7a5a3a' },
  { name: '青铜', arm: '#8a6a3a', steel: '#a07e48', dark: '#3a2a18', eye: '#6a5030' },
  { name: '枪铁', arm: '#5a5f66', steel: '#6e737a', dark: '#22252a', eye: '#454a52' },
  { name: '香槟金', arm: '#c9b48a', steel: '#ddcba0', dark: '#6a5a3a', eye: '#a08a60' },
  { name: '钛银', arm: '#9aa4ad', steel: '#c0cad3', dark: '#2a2e34', eye: '#6e7880' },
  { name: '玫瑰金', arm: '#c9a08a', steel: '#e0bca6', dark: '#6a4a3a', eye: '#a87a62' },
];

// 胸口仪表板的固定槽位。位置是契约的一部分：一个会移动的灯，就是每次开新会话
// 都要重新学一遍的灯。服务端（store.js 的 AGENT_ORDER）与界面共用同一份顺序，
// test/palette.test.mjs 会盯住两者不许分叉。
export const AGENT_SLOTS = ['deepseek', 'claude', 'codex', 'workbuddy', 'codebuddy'];

// 状态优先级。与 src/store.js 的 PRIORITY 必须逐项相同（同样由测试盯住）：
// 服务端用它决定主灯归属，界面用它决定「机器人待机时该瞄哪个槽位」。两份表
// 一旦分叉，机器人会盯着一个不是主灯代表的软件看，而这种错没有任何报错。
export const STATE_PRIORITY = {
  error: 6, waiting: 5, busy: 4, done: 3, unknown: 2, idle: 1, offline: 0,
};

// 每个状态的默认手势：设置里的下拉框和 robot3d.js 的出厂姿态映射共用这一份。
// 分开写的时候，设置界面会显示「垂放」而机器人正在「举手」。
export const DEFAULT_POSES = {
  error: '环抱', waiting: '举手', busy: '泵动', done: '摊开', idle: '垂放',
};

export const names = (list) => list.map((t) => t.name);
