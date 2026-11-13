'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

const HOME = os.homedir();
const DIR = process.env.BAOANLIGHT_HOME || path.join(HOME, '.baoanlight');
// The project used to be called signalhead. Anyone upgrading keeps their port,
// window position and choices instead of starting from an empty desktop.
const LEGACY_DIR = path.join(HOME, '.signalhead');

const CONFIG_FILE = path.join(DIR, 'config.json');
const PORT_FILE = path.join(DIR, 'port');
const LOG_FILE = path.join(DIR, 'server.log');

const DEFAULTS = {
  port: 4747,
  // Window position is remembered between runs. null => bottom-right of the display.
  window: { x: null, y: null },
  theme: 'full',           // full | mini
  scale: 1,
  collapsed: false,        // shrink the robot to a small helper
  clickThrough: true,      // let clicks pass through everywhere except the robot itself
  showLabels: true,        // show per-agent pills when more than one agent is active
  // Software list controls: whether agents that are not running keep a dark
  // row, whether the pill shows the real model/provider, and how many rows at most.
  showOffline: true,
  showModel: true,
  maxRows: 4,
  // 机器人下方那块 CPU / 内存小面板：默认开着，它是「这台机器现在忙不忙」
  // 的旁证，和代理状态是两回事（所以用中性色，不占红黄绿）。
  showSys: true,
  // Named look presets: { "name": { skin, eyestyle, scene, ... } }.
  presets: {},
  // Audible cue for the two states that want a human. Off by default: a desktop
  // robot that makes noise unasked is a robot people uninstall. This is written
  // on every toggle, so the choice survives a restart.
  sound: false,
  // 语音播报：状态变成 waiting/error/done 时用系统 TTS 说一句，默认关。
  voice: false,
  // 静音截止时间戳（ms）。大于当前时间则暂停通知/提示音/语音。
  mutedUntil: 0,
  // 今日时长广告牌显示谁：top 最多 / total 合计 / cycle 轮播 / off 关闭。
  signMode: 'top',
  // 广告牌位置：right 右侧 / left 左侧。
  signPos: 'right',
  // 广告牌颜色（描边/图标/辉光）与形状（圆角/胶囊/方正）。
  signColor: '#ffd54a',
  signShape: '圆角',
  // 头部装饰：无 / 天线 / 安全帽 / 皇冠 / 眼镜 / 墨镜 / 围巾 / 背包 / 礼帽 / 领结。
  decoration: '无',
  // 人格种子：首次启动随机固定一个（活泼/沉稳/话痨/害羞），决定动作频率与语气。
  personality: null,
  soundVolume: 0.22,
  sessionTtlMs: 6 * 60 * 60 * 1000,
  // A green session nobody has touched in this long is treated as gone.
  idleTtlMs: 30 * 60 * 1000,
  // A session that has not reported in this long is shown as quiet, not fresh.
  quietAfterMs: 90 * 1000,
  // A session that announced itself and then never did anything is forgotten
  // this quickly, rather than waiting out the full idle timeout.
  unusedTtlMs: 2 * 60 * 1000,
  // Per-agent overrides, e.g. { "workbuddy": { "dir": "D:/WorkBuddy/logs" } }.
  // Anything an agent keeps in a non-standard place can be pointed at here
  // instead of passing --dir on every `bao watch` invocation.
  agents: {},
};

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
  migrateLegacy();
}

// One-way, silent, idempotent: copy the old config across the first time the
// new directory is used. Never delete the old one — an agent may still be
// hooked up to an older install, and losing its window position is not fatal
// but losing its settings without being asked is rude.
function migrateLegacy() {
  try {
    if (DIR === LEGACY_DIR) return;
    if (!fs.existsSync(LEGACY_DIR)) return;
    if (fs.existsSync(CONFIG_FILE)) return;
    const legacyConfig = path.join(LEGACY_DIR, 'config.json');
    if (!fs.existsSync(legacyConfig)) return;
    fs.copyFileSync(legacyConfig, CONFIG_FILE);
  } catch { /* migration is a courtesy, never a failure */ }
}

let warnedCorrupt = false;

function load() {
  let cfg;
  try {
    const text = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (!text.trim()) throw new Error('empty config file');
    const raw = JSON.parse(text);
    cfg = {
      ...DEFAULTS,
      ...raw,
      window: { ...DEFAULTS.window, ...(raw.window || {}) },
      agents: { ...DEFAULTS.agents, ...(raw.agents || {}) },
    };
  } catch (err) {
    // 回落默认值是对的（一个跑不起来的机器人更糟），但**不能是无声的**：
    // 配置文件坏了意味着用户存下的窗口位置、皮肤和 presets 都读不到，而界面
    // 看上去只是「变回了出厂设置」。说一次，别每帧刷屏。
    if (!warnedCorrupt && err.code !== 'ENOENT') {
      warnedCorrupt = true;
      console.error(`baoanlight: ${CONFIG_FILE} could not be read (${err.message}); using defaults.`);
    }
    cfg = { ...DEFAULTS, window: { ...DEFAULTS.window }, agents: { ...DEFAULTS.agents } };
  }
  // theme 只允许 full / mini。早期「配色主题」曾把这个字段写成「赛博霓虹」之类，
  // 残留值会把窗口布局顶掉；读到脏值就归一化，下一次 save 会自动写回。
  if (cfg.theme !== 'mini') cfg.theme = 'full';
  return cfg;
}

// 写盘必须原子：先写同目录的临时文件，再 rename 覆盖。直接截断写如果在中途
// 崩掉（窗口拖动时每个滑杆都会写盘），留下的半个 JSON 会让下一次 load() 回落
// 到 DEFAULTS —— 用户不会收到任何提示，只是设置全没了。
function save(patch) {
  ensureDir();
  const next = { ...load(), ...patch };
  const body = JSON.stringify(next, null, 2);
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  try {
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (err) {
    // Windows 上 rename 会被杀毒/索引服务短暂占用。退回直接写并清掉临时文件：
    // 比让用户这次设置丢失要好，而且下次保存还会再试原子路径。
    try { fs.writeFileSync(CONFIG_FILE, body); } catch { /* 真的写不进去，调用方自己决定 */ }
    try { fs.unlinkSync(tmp); } catch { /* 已经被 rename 走了 */ }
    if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') throw err;
  }
  return next;
}

function port() {
  const env = process.env.BAOANLIGHT_PORT || process.env.SIGNALHEAD_PORT;
  if (env) return Number(env);
  return load().port;
}

module.exports = {
  DIR, CONFIG_FILE, PORT_FILE, LOG_FILE, DEFAULTS,
  ensureDir, load, save, port,
};
