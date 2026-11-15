'use strict';
// 机器人页面的全部 UI 逻辑。单独成文件不是因为「文件太大」，而是因为 CSP：
// 内联 <script> 需要 `unsafe-inline`，那等于让任何一次注入都能执行代码；
// 把它放进同源文件后，CSP 可以是 `script-src 'self'`，注入的标签直接不执行。
// 另外这里所有来自服务端的字符串都走 textContent，绝不拼 innerHTML。
//
// 外观色值不在这里：色块预览与机器人上色读的是同一份 shared/palette.mjs。
// 分开存的话，「色块是蓝的、机器人是绿的」这种分歧不会有任何测试失败。

import {
  SKIN_TONES, EYE_TONES, TRACK_TONES, ARM_TONES, AGENT_SLOTS, names,
  STATE_PRIORITY, DEFAULT_POSES,
} from './shared/palette.mjs';

(() => {

  const bridge = window.bao || null;           // present only inside Electron
  const inElectron = !!bridge;
  if (!inElectron) document.body.classList.add('browser');

  // 配置落盘：主进程的 config.save() 是同步 read-modify-write，而设置里改一次
  // 「配色主题」会连环派发十几个 change 事件，每个都写一次盘 —— 滑块会和主进程
  // 一起卡。这里把 200ms 内的所有补丁合并成一次写；`flush` 给「导入配置」用，
  // 因为紧接着就是 location.reload()，延迟写会被直接丢掉。
  const rawSave = inElectron ? bridge.saveConfig : null;
  let pendingPatch = {};
  let pendingTimer = 0;
  const flushSave = () => {
    if (!Object.keys(pendingPatch).length) return;
    const patch = pendingPatch;
    pendingPatch = {};
    // 写盘失败（配置目录只读、磁盘满、杀软短暂锁文件）必须说出来：界面会一直
    // 显示「已改好」，重启却全部回滚，而用户直到下次开机才知道，且毫无线索。
    const p = rawSave(patch);
    if (p && typeof p.catch === 'function') {
      p.catch(() => flashNote('设置未能保存：检查 ~/.baoanlight 是否可写'));
    }
  };
  const saveConfig = (patch, { flush = false } = {}) => {
    if (!rawSave) return;
    pendingPatch = { ...pendingPatch, ...patch };
    if (flush) { clearTimeout(pendingTimer); pendingTimer = 0; flushSave(); return; }
    if (pendingTimer) return;
    pendingTimer = setTimeout(() => { pendingTimer = 0; flushSave(); }, 200);
  };
  if (inElectron) window.addEventListener('pagehide', flushSave);

  // One table, used by the lamp, the panel, the pills and the text. The order
  // of the keys is the priority order: red beats yellow beats green.
  const COLOR = {
    error: 'red',
    waiting: 'amber',
    busy: 'green',
    done: 'done',
    idle: 'white',
    unknown: 'grey',
    offline: null,
  };
  const HEX = {
    red: '#ff3b30', amber: '#ffcc00', green: '#34c759', done: '#b06bff',
    white: '#dfe5ec', grey: '#ccd3dc',
  };
  const VERB = {
    error: '运行失败',
    waiting: '需要你',
    busy: '运行中',
    done: '已完成',
    idle: '就绪',
    unknown: '未知',
    offline: '未运行',
  };

  // 正式产品名，不是内部标识：列表与铭牌显示「Claude Code」，而不是「claude」。
  const LABEL = {
    claude: 'Claude Code',
    codex: 'Codex',
    workbuddy: 'WorkBuddy',
    deepseek: 'DeepSeek Harness',
  };
  // 显示名：用户改过名就用改过的，否则用内置名。这是唯一的取名入口 —— 列表、
  // 铭牌、通知、语音、广告牌都从这里拿名字，改名才不会漏掉某一块。
  const displayName = (agent) => {
    const alias = agent && cfg.aliases && cfg.aliases[agent];
    return alias || LABEL[agent] || String(agent || '');
  };
  // 今日时长分布堆叠条里的「每个软件一种颜色」。刻意用低饱和、和状态色
  // 分明的色相：红黄绿紫已经被状态占满，这里借用会让人误读成状态。
  const AGENT_COLORS = ['#7ea6e0', '#e0a96d', '#7ec8b0', '#c98bb8', '#a9a6e0', '#9aa7b8'];
  // 语音播报/系统通知跟随浏览器语言：英文环境念英文、用 en-US 的 TTS。
  const english = String(navigator.language || 'zh-CN').toLowerCase().startsWith('en');
  const TXT = english
    ? { waiting: 'needs you', error: 'failed', done: 'finished', doneNotify: 'completed' }
    : { waiting: '需要你处理', error: '出错了', done: '完成了', doneNotify: '完成了' };
  // 台词：机器人冒泡和语音共用同一句话 —— 两处说法不一致，比不说话更像坏了。
  // 空串 = 内置那句（跟着界面语言走）。上限 10 个字：气泡会按字数缩字号，
  // 再多就不是一句话，而是贴在头上的一条通知。
  const PHRASE_MAX = 10;
  const PHRASE_STATES = ['waiting', 'error', 'done'];
  const phraseOf = (state) => {
    const v = cfg.phrases && cfg.phrases[state];
    return typeof v === 'string' ? v.trim().slice(0, PHRASE_MAX) : '';
  };

  // cc-switch 接管某个软件后，它的名字会撒谎：Claude Code 可能实际跑在 DeepSeek
  // 上。这一行把「实际在用什么模型/供应商」说清楚；没被接管时返回 null，不显示。
  const ccSwitchLabel = (cc) => {
    if (!cc) return null;
    // attached:false = cc-switch 已经 detach，磁盘上残留的模型/供应商不代表
    // Claude Code 此刻真在用它们。宁可不说，也不能说错 —— 服务端已经过滤过
    // 一次，这里再挡一次，防止旧缓存帧/别的上报路径漏进来。
    if (cc.attached === false) return null;
    const model = cc.model ? String(cc.model).trim() : '';
    const provider = cc.provider ? String(cc.provider).trim() : '';
    // cc-switch 用 "default" 表示「没切到第三方供应商」，不携带信息。
    const realProvider = provider && provider.toLowerCase() !== 'default' ? provider : '';
    if (!model && !realProvider) return null;
    // 模型名通常已含供应商（如 deepseek-v4.1-flash），有模型就用模型；
    // 供应商只在没有模型名时兜底。
    return model || realProvider;
  };

  const stage   = document.getElementById('stage');
  const robot   = document.getElementById('robot');
  const bar     = document.getElementById('bar');
  const menu    = document.getElementById('menu');
  const sizer   = document.getElementById('sizer');
  const sRange  = document.getElementById('s-range');
  const sVal    = document.getElementById('s-val');
  const labels  = document.getElementById('labels');
  const fuel    = document.getElementById('fuel');
  const fuelFill = fuel.querySelector('b');
  const led     = document.getElementById('status-led');
  const botEl   = document.getElementById('bot');
  const note    = document.getElementById('note');
  const liveEl  = document.getElementById('live');
  const slotEls = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => document.getElementById('slot' + i));
  const sysEl   = document.getElementById('sys');
  const sysCpu  = document.getElementById('sys-cpu');
  const sysMem  = document.getElementById('sys-mem');
  const sysCpuBar = document.getElementById('sys-cpu-bar');
  const sysMemBar = document.getElementById('sys-mem-bar');
  // 设置搜索框的引用放在最前面：动态重建的软件顺序/名称块也要按当前过滤词
  // 重新过滤（见 renderAliasUI 末尾），而那块在模块求值时就会画一次。
  const findInput = document.getElementById('m-find');
  const findEmpty = document.getElementById('m-find-empty');

  let cfg = {
    showLabels: true, theme: 'full', collapsed: false, scale: 1,
    clickThrough: true, sound: false, showSys: true,
  };
  let collapsed = false;
  let scale = 1;
  let menuOpen = false;
  let sizerOpen = false;
  let sizerTimer = 0;
  let lastSnap = null;
  // 窗口藏起来（切屏、最小化）时 SSE 帧只更新内存里的快照、不重建 DOM；
  // 等重新可见再一次性补画。常驻窗口在后台仍每帧重建 pill 是纯耗电。
  let snapDirty = false;
  // 点击聚焦：null = 自动聚合（主灯显示最坏者）；非 null = 聚焦到某个软件，
  // 主灯临时显示该软件的状态，但四个通道始终各自可见。
  let focusedAgent = null;
  // 戳一下 = 「我看到了」：只安静**这一次**事件，不动灯。灯说的是事实，
  // 静音只关声音；一旦状态变了（新的「需要你」、新的报错），声音必须回来。
  // 之前写成固定 60 秒，会把 60 秒内第二个软件的告警一起吞掉 —— 对一个承诺
  // 「绝不漏报」的工具，这不是静音，是漏报。
  let silencedState = null;
  // 预览状态时置 true：预览只改画面，不触发真实的通知/声音/语音，也不让任何
  // 后台刷新把预览状态覆盖掉；预览结束再恢复真实状态。
  let previewing = false;
  // 上一次「真实」状态（不含预览）。通知/提示音按它判断变化，避免预览结束后
  // 把「真实状态」误当成一次新变化又弹一次。
  let lastRealState = '';

  // ---------------------------------------------------------------- layout
  // Every size the window has to agree with the page on: the visible stage
  // (scaled), and the rectangle that may receive clicks. The menu is part of
  // that rectangle, or its slider would be click-through.
  function fit(anchor = 'top') {
    if (!inElectron) return;
    requestAnimationFrame(() => {
      const r = stage.getBoundingClientRect();
      // 菜单在机器人右侧：窗口必须同时装下两者，否则菜单会被窗口裁掉。
      let w = r.width;
      let h = r.height;
      if (!menu.hidden) {
        const mr = menu.getBoundingClientRect();
        w = Math.max(w, mr.right - r.left + 4);
        h = Math.max(h, mr.bottom - r.top + 4);
      }
      bridge.contentSize({ w: Math.ceil(w), h: Math.ceil(h), scale, anchor });

      // 悬停工具栏只在「光标真的靠近机器人」时才进热区（见下面的 cursor 处理）。
      // 无条件放进来的话，stage 顶部那条 340×26 的带子即使什么都没画，也会
      // 让窗口停止点击穿透——用户点在编辑器上的那一下就被这团空气吃掉了。
      // `:focus-within` 也要算：键盘 Tab 进工具栏时它是可见的（见 CSS），
      // 若不进热区，鼠标点得到的是后面的编辑器，而回车却真的会触发。
      const barVisible = bar.classList.contains('menu-open')
        || document.body.classList.contains('hovering')
        || bar.matches(':focus-within');
      const boxes = [robot.getBoundingClientRect()];
      if (barVisible) boxes.push(bar.getBoundingClientRect());
      // The per-software list is interactive (click to focus), so it must be
      // inside the click-through hot rect too — otherwise clicks fall through
      // to whatever window is behind the robot.
      if (labels && labels.children.length) boxes.push(labels.getBoundingClientRect());
      if (!menu.hidden) boxes.push(menu.getBoundingClientRect());
      if (!sizer.hidden) boxes.push(sizer.getBoundingClientRect());
      // 状态速览面板也要进热区：不然它在点击穿透区里，六个按钮全点不了。
      const pv = document.getElementById('preview');
      if (pv && !pv.hidden) boxes.push(pv.getBoundingClientRect());
      const pad = 5;
      const left = Math.min(...boxes.map((b) => b.left)) - pad;
      const top = Math.min(...boxes.map((b) => b.top)) - pad;
      const right = Math.max(...boxes.map((b) => b.right)) + pad;
      const bottom = Math.max(...boxes.map((b) => b.bottom)) + pad;
      bridge.hotRect({ x: left, y: top, w: right - left, h: bottom - top });
    });
  }

  // 焦点进/出工具栏时重算热区：键盘 Tab 会让工具栏现身（CSS :focus-within），
  // 但热区是 fit() 算出来的。不重算就是「看得见、鼠标点不到」，而回车却有效。
  bar.addEventListener('focusin', () => fit());
  bar.addEventListener('focusout', () => fit());

  // 「光标靠近机器人了吗」——驱动悬停工具栏与它的热区。
  // 主进程每 80ms 推一次坐标；只有从这里得到的答案，才能在「窗口默认穿透」
  // 的前提下既让工具栏够得着，又不让看不见的像素吃点击。
  let hovering = false;
  if (inElectron) {
    bridge.onCursor((p) => {
      const r = robot.getBoundingClientRect();
      // 上边界给到 0（窗口顶）：工具栏浮在机器人正上方，从机器人往上走要能
      // 一路够到它；再往上就是窗口外，不该继续吃掉别人的点击。
      const near = p.x >= r.left - 8 && p.x <= r.right + 8 && p.y >= 0 && p.y <= r.bottom + 8;
      if (near === hovering) return;
      hovering = near;
      document.body.classList.toggle('hovering', near);
      fit();
    });
  }

  function applyScale(next, { persist = false, anchor = 'bottom', expand = true } = {}) {
    // 拉尺寸条 = 用户要控制大小。若正处在「收起」态（150px 底座），先展开再缩放，
    // 否则拉到 170% 也只有 150×1.7=255px，比默认 300px 还小——这是「拉满还是很小」的根因。
    // `expand: false` 只给启动时用：那时也调 applyScale 还原用户存的缩放，但
    // 「收起」是另一个配置项，不能被顺手撤销并写回磁盘。
    if (collapsed && expand) {
      setCollapsed(false);
      if (inElectron) saveConfig({ collapsed: false });
    }
    // 70% is still a recognisable robot; 170% is about as tall as a 1080p work
    // area allows once the window is pinned above the taskbar. Both numbers are
    // the whole stage: the robot, the gauge and the agent list move together,
    // because a bigger lamp on a small robot is a bigger lamp, not a bigger
    // robot.
    scale = Math.max(0.7, Math.min(1.7, Number(next) || 1));
    document.documentElement.style.setProperty('--scale', String(scale));
    // The scene redraws its backing store at the new size, so a scaled-up robot
    // stays sharp instead of being a stretched 300px canvas.
    window.dispatchEvent(new CustomEvent('bao:scale', { detail: { scale } }));
    const pct = Math.round(scale * 100);
    const input = document.getElementById('m-size');
    const out = document.getElementById('m-size-val');
    if (input) input.value = String(pct);
    if (out) out.textContent = pct + '%';
    if (sRange) sRange.value = String(pct);
    if (sVal) sVal.textContent = pct + '%';
    fit(anchor);
    if (persist && inElectron) saveConfig({ scale });
  }

  // ---------------------------------------------------------------- sound
  // Generated, not shipped: an oscillator pair is a few lines and keeps the
  // package free of binary assets. Only two states are worth a noise — the
  // ones where the user has to move — and only when they asked for it.
  let actx = null;
  let lastCue = 0;
  // 提示音音色：不同波形 + 音高，让「叮咚」和「机械警报」可区分。
  const SOUND_STYLES = {
    '清脆叮咚': { type: 'sine', mul: 1.0 },
    '低沉机械': { type: 'square', mul: 0.62 },
    '电子脉冲': { type: 'triangle', mul: 1.35 },
  };
  // 每个状态一套音高：出错下降、等待上升、起步上扬、完成三连上扬；idle/offline 静默。
  const TONES = {
    error: [[520, 0], [360, 0.17]],
    waiting: [[600, 0], [860, 0.14]],
    busy: [[440, 0], [520, 0.09]],
    done: [[660, 0], [990, 0.12], [1320, 0.24]],
  };
  function cue(kind) {
    if (!cfg.sound) return;
    if (isMuted()) return;
    if (isDnd()) return;
    if (silencedState && kind === silencedState) return;
    // 先判断「这个状态有没有音效」，再占用限流窗口。反过来的话，一个
    // busy → idle（本来静默）会把 2.5 秒窗口吃掉，紧接着另一个软件报
    // error 就没声了 —— 安静的状态不该消费告警的配额。
    if (!TONES[kind]) return;   // idle / offline 静默：安静是刻意的
    // 「完成」不是需要你处理的事：有人希望它只亮灯、不出声。
    if (kind === 'done' && cfg.soundDone === false) return;
    const now = Date.now();
    if (now - lastCue < 2500) return;      // one cue per incident, not per event
    lastCue = now;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      actx = actx || new AC();
      if (actx.state === 'suspended') actx.resume();
      const style = SOUND_STYLES[cfg.soundStyle] || SOUND_STYLES['清脆叮咚'];
      const tones = TONES[kind];
      const peak = Number(cfg.soundVolume) || 0.22;
      for (const [freq, at] of tones) {
        const t0 = actx.currentTime + at;
        const osc = actx.createOscillator();
        const gain = actx.createGain();
        osc.type = style.type;
        osc.frequency.setValueAtTime(freq * style.mul, t0);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
        osc.connect(gain).connect(actx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.2);
      }
    } catch { /* a silent robot is a bug, not an outage */ }
  }

  // A poke is also "I have seen it": it silences the tone for this incident
  // without touching the lamp. The state stays on screen — going quiet is about
  // the noise, never about the truth.
  window.addEventListener('bao:poke', () => {
    const s = document.body.dataset.state;
    if (s !== 'waiting' && s !== 'error') return;
    silencedState = s;
    flashNote('已静音这次提示');
  });

  // 一行短提示，1.6 秒后收回。
  //
  // 它和常驻的 `note`（连接/自检提示）共用同一个节点，所以「当前该显示谁」必须
  // 由状态决定，而不是谁最后写谁赢：原来 render() 每帧无条件 `note.textContent = text`，
  // 任何一帧 SSE 都会把刚弹出来的提示冲掉（忙碌时几乎立刻就没了）。
  let flashTimer = 0;
  let flashText = '';
  let flashUntil = 0;
  function flashNote(text) {
    flashText = text;
    flashUntil = Date.now() + 1600;
    note.textContent = text;
    note.hidden = false;
    note.classList.add('on');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashText = '';
      flashUntil = 0;
      if (lastSnap) render(lastSnap);
      else { note.textContent = ''; note.hidden = true; note.classList.remove('on'); }
    }, 1600);
  }

  // ---------------------------------------------------------------- fuel
  function renderFuel(f) {
    if (!f || typeof f.remaining !== 'number') {
      fuel.classList.remove('on');
      fuelFill.style.height = '0%';
      delete document.body.dataset.fuel;
      return;
    }
    const pct = Math.max(0, Math.min(100, f.remaining));
    // 暴露给 3D 场景：机器人读这个值做「低电量焦虑」动作。
    document.body.dataset.fuel = String(pct);
    fuel.classList.add('on');
    // Narrow warning bands: colour means "act soon", not "you are at 60%".
    fuel.dataset.level = pct <= 10 ? 'low' : pct <= 25 ? 'mid' : 'ok';
    fuelFill.style.height = pct + '%';
    fuel.title = `${f.label || '剩余'}: ${Math.round(pct)}%` + (f.agent ? ` (${f.agent})` : '');
  }

  // ---------------------------------------------------------------- slots
  // One cell per registered software, in the server's fixed order. A slot with
  // no session is drawn dark rather than hidden: "codex is not running" is
  // information, and a cell that appears and disappears makes the strip
  // unreadable at a glance.
  function renderSlots(slots) {
    slotEls.forEach((el, i) => {
      const s = slots[i];
      const live = s && s.count > 0;
      const colour = live ? COLOR[s.state] : null;
      const hex = colour ? HEX[colour] : null;
      el.style.fill = hex || '';
      el.style.filter = hex ? `drop-shadow(0 0 3px ${hex})` : 'none';
      el.style.opacity = !hex ? '1' : (s.state === 'idle' ? '.5' : '1');
      el.dataset.agent = s ? s.agent : '';
      el.dataset.state = live ? s.state : 'offline';
      el.dataset.count = live ? String(s.count) : '0';
    });
  }

  // ---------------------------------------------------------------- 3D scene
  // The robot is drawn in WebGL, so it cannot be asked "what colour are you".
  // It is told, from the one table above, in the same breath as the markup —
  // which is why the lamp on the panel can never disagree with the lamp in the
  // DOM mirror. Dispatched every render; the scene is idle-cheap.
  // Priority, in the same order the server uses: red beats yellow beats green,
  // and a tie goes to the fixed order (DeepSeek Harness first), never recency —
  // a lamp that picks a different winner on each event is one you cannot trust.
  const PRIO = STATE_PRIORITY;

  // The tie-break order, user-adjustable. On equal severity the first name here
  // wins the main lamp, so the first software is the canonical "main" agent on a
  // tie. The order also drives the ring, the dashboard bars and the pills.
  const DEFAULT_ORDER = AGENT_SLOTS;
  let AGENT_RANK = Object.fromEntries(DEFAULT_ORDER.map((a, i) => [a, i]));
  let agentOrder = [...DEFAULT_ORDER];
  // 用户是否自己排过序。为 true 时不再采用服务端下发的顺序（但会追加新软件）。
  let customOrder = false;
  const FRESH_MS = 3000;

  // Active software, in the FIXED order (DeepSeek Harness → Claude Code → Codex
  // → WorkBuddy). The ring, the dashboard bars and the pills all read this same
  // list, so a software always sits in the same position — the user learns the
  // layout once and never has to re-map "third light = ?" when a state changes.
  // `fresh` brightens a channel for the 3s after it changes; `worst` marks the
  // one that owns the main lamp (highest priority), so it can be ringed/highlit.
  function activeAgents(snap, slots, worstAgent) {
    const last = new Map();
    const now = Date.now();
    for (const s of snap.sessions || []) {
      const at = Number(s.updatedAt) || 0;
      if (!last.has(s.agent) || last.get(s.agent) < at) last.set(s.agent, at);
    }
    // 离线软件也占一段（hex 为空、dim 置真），而不是把它从灯环里摘掉：它一下线
    // 其余软件的段会整体前移，和固定位置的胸口槽位/pills 行错位 —— 第 4 个软件
    // 会在灯环上变成第 3 段。
    return slots
      .map((s) => {
        if (!s) return null;
        const live = s.count > 0 && HEX[COLOR[s.state]];
        if (!live) {
          return {
            agent: s.agent,
            label: displayName(s.agent),
            state: 'offline',
            hex: null,        // planRing 里 null = 熄灯占位
            dim: true,
            count: 0,
            at: 0,
            fresh: false,
            worst: false,
          };
        }
        return {
          agent: s.agent,
          label: displayName(s.agent),
          state: s.state,
          hex: HEX[COLOR[s.state]],
          dim: s.state === 'idle',
          count: s.count,
          at: last.get(s.agent) || 0,
          fresh: now - (last.get(s.agent) || 0) < FRESH_MS,
          worst: s.agent === worstAgent,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (AGENT_RANK[a.agent] ?? 99) - (AGENT_RANK[b.agent] ?? 99));
  }

  function publish(state, colour, slots, agent, liveColour, agents) {
    const detail = {
      state,
      color: colour ? HEX[colour] : null,
      // The strip follows the software that spoke last, not the aggregate: the
      // aggregate is already the big lamp, and a second copy of it says nothing.
      live: liveColour || null,
      dim: state === 'idle',
      dead: state === 'offline',
      agent: agent || '',
      slots: slots.map((s) => {
        const c = s && s.count > 0 ? COLOR[s.state] : null;
        return c ? { hex: HEX[c], dim: s.state === 'idle', state: s.state, agent: s.agent } : null;
      }),
      // Per-software attribution for the base ring and the nameplate.
      agents: agents || [],
    };
    window.dispatchEvent(new CustomEvent('bao:render', { detail }));
  }

  // 完成的两种来源要分开看：
  //   * 只报 Stop 的代理（Claude Code）是 busy → idle。服务端没有额外的完成
  //     信号，于是机器人用「转一圈 + 连跳两下」确认，而不是换颜色。
  //   * 能报显式完成的代理（日志观察器 / MCP / bao set done）会给出 done
  //     （紫色，30 秒后自动回落 idle）。两种都触发同一个动作，绿色永远只
  //     表示「正在跑」——空闲机器人闪绿才是这个工具最不能撒的谎。
  // cc-switch 切换提示：模型/供应商变了，机器人冒个气泡说一句。
  const lastCC = new Map();
  function announceCC(snap) {
    const cc = snap.ccSwitch || {};
    for (const agent of Object.keys(cc)) {
      const label = ccSwitchLabel(cc[agent]) || '';
      const prev = lastCC.get(agent);
      lastCC.set(agent, label);
      if (label && prev !== undefined && prev !== label) {
        window.dispatchEvent(new CustomEvent('bao:ccswitch', { detail: { agent, model: label } }));
      }
    }
  }

  const lastByAgent = new Map();
  // 最近动态：本次运行期间每个软件的状态变化时间线，菜单里一眼可看。
  const recent = [];
  const RECENT_VERB = { busy: '开始运行', waiting: '需要你', error: '出错了', done: '完成了', idle: '就绪', unknown: '状态未知', offline: '离线' };
  // 服务端来的字符串（agent 名、模型名、detail）一律是「文本」，不是「标记」。
  // 这几行曾经拼 innerHTML 模板串：一个
  //   bao set busy --agent '<img src=x onerror=...>'
  // 就能在页面里执行脚本，而页面手里有 preload 的 notify/quit/openTerminal。
  // 现在只走 textContent —— 同样的字符串会原样显示成一个名字。
  function textRow({ cls = 'recent', label = '', value = '', note = '', dot = '' } = {}) {
    const row = document.createElement('div');
    row.className = cls;
    const b = document.createElement('b');
    if (dot) {
      const mark = document.createElement('i');
      mark.className = 'rdot';
      mark.dataset.color = dot;
      b.append(mark);
    }
    b.append(document.createTextNode(label));
    const span = document.createElement('span');
    span.textContent = value;
    const em = document.createElement('em');
    em.textContent = note;
    row.append(b, span, em);
    return row;
  }
  // 这两块只在设置菜单里可见，而 render() 每收到一条 SSE 帧就会调它们一次。
  // 菜单关着的时候重建等于往一个看不见的地方扔几十个节点 —— 常驻窗口里每次
  // 状态变化（忙碌时很密）都白做一次。记一个脏标记，等菜单真的打开再画。
  let panelDirty = false;
  // 今日战绩的数据签名：内容没变就不重建整块 DOM（理由见 renderScore）。
  let scoreSig = '';

  function renderRecent() {
    const box = document.getElementById('m-recent');
    if (!box) return;
    if (menu.hidden) { panelDirty = true; return; }
    box.innerHTML = '';
    for (const r of recent) {
      const ago = Math.round((Date.now() - r.at) / 1000);
      const agoText = ago < 60 ? `${ago} 秒前` : ago < 3600 ? `${Math.round(ago / 60)} 分前` : `${Math.round(ago / 3600)} 时前`;
      box.appendChild(textRow({
        label: displayName(r.agent),
        value: RECENT_VERB[r.state] || r.state,
        note: agoText,
        dot: COLOR[r.state] || 'grey',
      }));
    }
  }
  // 今日战绩：每个软件今天忙了多久 + 完成/出错几次（数据来自 server 累计，重启不丢）。
  function fmtDur(ms) {
    const min = Math.round(ms / 60000);
    if (min < 60) return `${min} 分钟`;
    return `${Math.floor(min / 60)} 时 ${min % 60} 分`;
  }
  function renderScore(snap) {
    const box = document.getElementById('m-score');
    if (!box) return;
    if (menu.hidden) { panelDirty = true; return; }
    // 忙碌时 render() 每帧都会走到这里，而这块内容是「今天」的累计值，分钟级
    // 才变。数据没变就不重建：否则菜单开着时每来一条事件就把战绩列表推倒重画，
    // 高度一抖用户正在看的行就跳了。
    //
    // 签名里的时长要按**分钟**取整：store 的 byAgent 每帧都加上 `now - since`
    // 的实时忙碌毫秒，拿原始值当签名等于每帧都「变了」，去重形同虚设。
    const byAgent = snap?.stats?.byAgent || {};
    const events = snap?.stats?.events || {};
    const byMin = Object.fromEntries(
      Object.entries(byAgent).map(([a, ms]) => [a, Math.floor((ms || 0) / 60000)])
    );
    const sig = JSON.stringify([
      snap?.stats?.day || '', cfg.firstRun || '', Number(cfg.dailyGoalHours) || 0,
      // 改名也要算进签名：这面板里每一行都显示 displayName，漏掉它就会出现
      // 「列表已经叫新名字了，战绩里还是旧的」，最长要等一分钟。
      cfg.aliases || {},
      byMin, events, snap?.stats?.history || {},
    ]);
    if (sig === scoreSig) return;
    scoreSig = sig;
    const names = [...new Set([...Object.keys(byAgent), ...Object.keys(events)])]
      .filter((a) => (byAgent[a] || 0) > 30000 || (events[a] && (events[a].done || events[a].error)));
    box.innerHTML = '';
    // 顶部：陪你第 N 天（首次安装日期起算），给战绩一点「陪伴」的温度。
    if (cfg.firstRun && snap?.stats?.day) {
      const days = dayDiff(cfg.firstRun, snap.stats.day) + 1;
      if (days >= 1) {
        const head = document.createElement('div');
        head.className = 'score-head';
        head.textContent = `陪你第 ${days} 天`;
        box.appendChild(head);
      }
    }
    const totalMs = Object.values(byAgent).reduce((a, b) => a + (b || 0), 0);
    // 每日目标：用户自己定的一个「今天够了」的刻度。它只是把同一份时长换成
    // 进度展示，不参与任何状态判断 —— 达成了也不会把灯变绿，绿只代表在运行。
    const goalH = Number(cfg.dailyGoalHours) || 0;
    if (goalH > 0) {
      const pct = Math.min(100, Math.round((totalMs / (goalH * 3600000)) * 100));
      const goal = document.createElement('div');
      goal.className = pct >= 100 ? 'goal reached' : 'goal';
      const label = document.createElement('span');
      label.textContent = `每日目标 ${fmtDur(totalMs)} / ${goalH} 时 · ${pct}%`;
      const track = document.createElement('em');
      const fill = document.createElement('i');
      fill.style.width = pct + '%';
      track.appendChild(fill);
      goal.append(label, track);
      box.appendChild(goal);
    }
    if (!names.length) {
      const row = document.createElement('div');
      row.className = 'recent';
      row.innerHTML = '<span>今天还没有干活记录</span>';
      box.appendChild(row);
      // 不 return：跨天/早上「今天」还没数据时，历史里的本周合计与 7 天柱状图
      // 仍该显示 —— 那是用户最想看周报的时候。下面的堆叠条/每软件行在 names
      // 为空时本就会自然跳过（totalMs=0、空循环）。
    }
    // 堆叠条：把今天的忙碌时长按软件切成一段，一眼看出「今天谁吃了时间」。
    // 行内条形是各自按今日最长归一化的，这里的段长才是真实占比。
    if (totalMs > 0) {
      const stack = document.createElement('div');
      stack.className = 'stack';
      const legend = document.createElement('div');
      legend.className = 'stack-legend';
      for (const agent of names.slice().sort((a, b) => (byAgent[b] || 0) - (byAgent[a] || 0))) {
        const ms = byAgent[agent] || 0;
        if (ms <= 0) continue;
        const color = AGENT_COLORS[names.indexOf(agent) % AGENT_COLORS.length];
        const seg = document.createElement('i');
        seg.style.width = `${((ms / totalMs) * 100).toFixed(2)}%`;
        seg.style.background = color;
        seg.title = `${displayName(agent)} · ${fmtDur(ms)}`;
        stack.appendChild(seg);
        const item = document.createElement('span');
        const sw = document.createElement('i');
        sw.style.background = color;
        item.append(sw, document.createTextNode(` ${displayName(agent)}`));
        legend.appendChild(item);
      }
      box.appendChild(stack);
      box.appendChild(legend);
    }
    const sorted = names.sort((a, b) => (byAgent[b] || 0) - (byAgent[a] || 0));
    const maxMs = Math.max(1, ...names.map((a) => byAgent[a] || 0));
    for (const agent of sorted) {
      const ev = events[agent] || {};
      const bits = [];
      if (ev.done) bits.push(`完成 ${ev.done}`);
      if (ev.error) bits.push(`出错 ${ev.error}`);
      const dur = (byAgent[agent] || 0) > 30000 ? fmtDur(byAgent[agent]) : '—';
      const row = textRow({ cls: 'recent score-row', label: displayName(agent), value: dur, note: bits.join(' · ') });
      // 时长条形：行背景按「本软件时长 / 今日最长」比例铺一条淡色进度条，数据可视化。
      row.style.setProperty('--pct', Math.max(2, Math.round(((byAgent[agent] || 0) / maxMs) * 100)) + '%');
      box.appendChild(row);
    }
    // 本周合计：今天 + 最近 7 天存档（server 每天自动归档）。
    const week = { ms: 0, done: 0, error: 0 };
    for (const h of Object.values(snap?.stats?.history || {})) {
      for (const ms of Object.values(h.byAgent || {})) week.ms += ms || 0;
      for (const ev of Object.values(h.events || {})) { week.done += ev.done || 0; week.error += ev.error || 0; }
    }
    for (const ms of Object.values(byAgent)) week.ms += ms || 0;
    for (const ev of Object.values(events)) { week.done += ev.done || 0; week.error += ev.error || 0; }
    if (week.ms > 60000 || week.done || week.error) {
      const bits = [];
      if (week.done) bits.push(`完成 ${week.done}`);
      if (week.error) bits.push(`出错 ${week.error}`);
      // 本周有数据的天数（今天 + 有存档的历史天），用来算日均 —— 合计之外再看一眼
      // 「平均每天干了多久」，比单看一个总数更能判断这周是忙是闲。
      const activeDays = new Set();
      if ((snap?.stats?.day || '') && Object.values(byAgent).some((v) => (v || 0) > 0)) activeDays.add(snap.stats.day);
      for (const [k, h] of Object.entries(snap?.stats?.history || {})) {
        if (Object.values(h.byAgent || {}).some((v) => (v || 0) > 0)) activeDays.add(k);
      }
      if (activeDays.size > 1) bits.unshift(`日均 ${fmtDur(Math.round(week.ms / activeDays.size))}`);
      const row = textRow({ label: '本周合计', value: fmtDur(week.ms), note: bits.join(' · ') });
      row.style.borderTop = '1px solid rgba(255,255,255,.12)';
      row.style.paddingTop = '4px';
      box.appendChild(row);
    }
    // 本周 7 天迷你柱状图：每天的总时长一根柱，今天在最右、高亮。
    const dayKeys = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      dayKeys.push(k);
    }
    const dayMs = dayKeys.map((key) => {
      const h = snap?.stats?.history?.[key];
      let ms = h ? Object.values(h.byAgent || {}).reduce((a, b) => a + (b || 0), 0) : 0;
      if (key === snap?.stats?.day) for (const v of Object.values(byAgent)) ms += v || 0;
      return ms;
    });
    const maxDay = Math.max(1, ...dayMs);
    const chart = document.createElement('div');
    chart.className = 'week-chart';
    for (let i = 0; i < 7; i++) {
      const bar = document.createElement('i');
      bar.style.height = Math.max(2, Math.round((dayMs[i] / maxDay) * 100)) + '%';
      bar.classList.toggle('today', i === 6);
      bar.title = `${dayKeys[i].slice(5)} · ${fmtDur(dayMs[i])}`;
      chart.appendChild(bar);
    }
    box.appendChild(chart);
  }
  // 「X 秒前/分前」要会走，不能只在有新事件时才刷新一次。
  setInterval(renderRecent, 30000);
  // 「已运行 X 分钟」也要会走：busy 且长时间无上报时，靠这个定时器推进分钟数。
  setInterval(() => { if (lastSnap) render(lastSnap); }, 30000);
  function announceDone(sessions) {
    // 会话被 /clear、`bao set offline` 或 TTL 清掉后，这里不能留着它的旧状态：
    // 否则同一个软件下次以 idle 出现时会被判成「刚完成」，为一个没发生的事转圈
    // 庆祝，还往「最近动态」里写一条假的完成记录。
    const live = new Set(sessions.map((s) => s.agent));
    for (const a of [...lastByAgent.keys()]) if (!live.has(a)) lastByAgent.delete(a);
    for (const s of sessions) {
      const prev = lastByAgent.get(s.agent);
      lastByAgent.set(s.agent, s.state);
      // 记录状态变化到「最近动态」（首次出现不算变化，避免初始加载刷屏）。
      // 连续两条同 agent 同状态（SSE 连发两帧）只记一条，不刷屏。
      if (prev && prev !== s.state
        && !(recent[0] && recent[0].agent === s.agent && recent[0].state === s.state)) {
        recent.unshift({ at: Date.now(), agent: s.agent, state: s.state });
        if (recent.length > 8) recent.pop();
        renderRecent();
      }
      // A run finishing is busy → done (or busy → idle for agents that do not
      // report a "done" state). Either way the machine answers with two nods,
      // not a colour change.
      if (prev && prev !== 'idle' && prev !== 'done' && prev !== 'offline' && prev !== 'unknown'
        && (s.state === 'idle' || s.state === 'done')) {
        window.dispatchEvent(new CustomEvent('bao:done', { detail: { agent: s.agent } }));
      }
    }
  }

  // 卡住检测（分级）：busy 会话 5 分钟无上报 → 提醒；15 分钟仍无上报 → 升级提醒。
  // 按「软件」去重（不是按会话）：一个软件开三个窗口都卡了，只提醒一次，不刷屏。
  // 该软件不再有卡住的会话就重置，下次再卡仍会提醒。
  const stuckNotified = new Set();   // keyed by agent
  const stuckEscalated = new Set();
  function checkStuck(sessions) {
    const stuckAgents = new Set();
    // 「静音 1 小时」与「定时勿扰」必须对所有出口生效。这里原来直接调 bridge.notify，
    // 是唯一漏掉 isMuted()/isDnd() 的一条 —— 深夜勿扰时段里最不该弹的恰好是它（卡住提醒）。
    const canNotify = inElectron && bridge.notify && !isMuted() && !isDnd();
    for (const s of sessions) {
      // 关掉通知的软件，卡住提醒也不弹（否则「静音」只是少了一类噪音）。
      if (isAgentMuted(s.agent)) continue;
      if (s.state === 'busy' && s.quiet && s.quietFor > 5 * 60 * 1000) {
        stuckAgents.add(s.agent);
        if (!stuckNotified.has(s.agent)) {
          stuckNotified.add(s.agent);
          if (canNotify) {
            bridge.notify(`${displayName(s.agent)} 好像卡住了`, '已经 5 分钟没有任何动静了，去看看');
          }
        }
        if (s.quietFor > 15 * 60 * 1000 && !stuckEscalated.has(s.agent)) {
          stuckEscalated.add(s.agent);
          if (canNotify) {
            bridge.notify(`${displayName(s.agent)} 大概率卡死了`, '15 分钟完全没动静，建议去终端看看');
          }
        }
      }
    }
    for (const a of [...stuckNotified]) if (!stuckAgents.has(a)) stuckNotified.delete(a);
    for (const a of [...stuckEscalated]) if (!stuckAgents.has(a)) stuckEscalated.delete(a);
  }

  // 点击聚焦：点某软件通道 = 聚焦它（主灯切到它）；再点同一个 = 取消聚焦回聚合。
  function toggleFocus(agent) {
    focusedAgent = focusedAgent === agent ? null : agent;
    if (lastSnap) render(lastSnap);
  }

  // ---------------------------------------------------------------- render
  // 语音播报：只在状态真正变化且开启时说一句。
  let lastAnnounced = '';
  // 里程碑庆祝：合计工作时长跨过 1/2/3/4/6/8/12 小时时，让机器人庆祝一次。
  const MILESTONES = [1, 2, 3, 4, 6, 8, 12];
  let lastMilestone = 0;
  let lastMilestoneDay = '';
  let goalDoneDay = '';   // 今天的目标达成提醒已经发过（按 stats.day 去重）
  const dayDiff = (a, b) => {
    const da = new Date(a + 'T00:00:00').getTime();
    const db = new Date(b + 'T00:00:00').getTime();
    if (!Number.isFinite(da) || !Number.isFinite(db)) return 0;
    return Math.max(0, Math.round((db - da) / 86400000));
  };
  // 说一句，不判断状态。`announce` 用它播状态，设置里的开关用它打招呼。
  function say(text) {
    if (!cfg.voice) return;
    if (isMuted()) return;
    if (isDnd()) return;
    try {
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = english ? 'en-US' : 'zh-CN';
      u.rate = 1.05;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch { /* 没有语音引擎就静默 */ }
  }
  function announce(state) {
    if (!cfg.voice) return;
    if (isMuted()) return;
    if (state === lastAnnounced) return;
    // 用户写了台词就念用户那句；没写才念内置的。气泡用同一个取值函数，
    // 于是「屏幕上写的」和「耳朵里听到的」永远是一句话。
    const msg = phraseOf(state) || (state === 'waiting' ? TXT.waiting
      : state === 'error' ? TXT.error
        : state === 'done' ? TXT.done : '');
    // 先记账再判断要不要出声：busy/idle 这些「不值得念」的状态也要把上一次
    // 的 waiting 清掉，否则同一状态第二次出现（waiting → busy → waiting）
    // 会被当成「和上次一样」永远不播 —— 而第二次「需要你」往往才是真的。
    lastAnnounced = state;
    if (!msg) return;
    say(msg);
  }

  // 静音：一段时间内暂停所有通知/提示音/语音（开会时用）。状态显示照常。
  let mutedUntil = 0;
  const isMuted = () => Date.now() < mutedUntil;

  // 定时勿扰：在配置的时段内同样暂停声音/语音，并让 3D 降到 8fps。和「静音 1 小时」
  // 是两套开关：静音是手动一次性，勿扰是每天自动的作息。
  const toMin = (hm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };
  function isDnd() {
    if (!cfg.doNotDisturb) return false;
    const s = toMin(cfg.dndStart);
    const e = toMin(cfg.dndEnd);
    if (s == null || e == null || s === e) return false;
    const d = new Date();
    const hm = d.getHours() * 60 + d.getMinutes();
    // 跨午夜（22:00 → 08:00）时 s > e；同一天内（09:00 → 17:00）时 s < e。
    return s < e ? (hm >= s && hm < e) : (hm >= s || hm < e);
  }
  let dndOn = false;
  function applyDnd() {
    // 起止相同 = isDnd() 永远为 false。这是个合法的选择（等于不设勿扰），但没人
    // 猜得到，所以把原因写在开关下面，而不是让「已开启」和一个永不到来的时段并排。
    const note = document.getElementById('m-dnd-note');
    if (note) {
      const s = toMin(cfg.dndStart);
      const e = toMin(cfg.dndEnd);
      note.hidden = !(cfg.doNotDisturb && s != null && e != null && s === e);
    }
    const on = isDnd();
    if (on === dndOn) return;
    dndOn = on;
    document.body.classList.toggle('dnd', on);
    window.dispatchEvent(new CustomEvent('bao:dnd', { detail: { on } }));
  }
  // 进入/离开勿扰时段的边界靠这个分钟级轮询翻转；跨过 22:00 或 08:00 后一分钟内生效。
  setInterval(applyDnd, 60_000);

  // 原生系统通知：某个软件**进入** waiting / error / done 时弹一次。
  //
  // 去重键必须是「软件 + 状态」，不能是聚合状态。第二个软件也进入「需要你」时
  // 聚合状态没变，原来会被当成重复而吞掉 —— 而它恰恰是用户最需要知道的那一条。
  // 每个软件 6 秒内只弹一次（防抖动，也让 waiting→busy→waiting 的两次都能响）。
  // 第一次见到某个软件只记账不通知：启动瞬间四行都是 waiting，不该一次弹四条。
  const slotSeen = new Map();        // agent -> 上一次看到的状态
  const slotNotifiedAt = new Map();  // agent -> 上次通知的时间
  const NOTIFY_TEXT = { waiting: TXT.waiting, error: TXT.error, done: TXT.doneNotify };

  // 单独关掉某个软件的系统通知：有些软件状态翻来覆去，通知比灯烦人得多。
  // 只关「弹窗」这一条通道 —— 灯、列表、铭牌、广告牌照常，提示音也不受影响
  // （它是按聚合状态播的，不是按软件）。
  const isAgentMuted = (agent) => (cfg.mutedAgents || []).includes(agent);

  function notifySlots(slots) {
    if (!inElectron || !bridge.notify) return;
    if (isDnd()) return;
    for (const s of slots || []) {
      // 离线槽位 = 这个软件的状态归零。必须把它记的状态清掉：否则软件关掉再
      // 打开、第一个事件又是同一种 waiting/error 时，会被当成「没变化」而永远
      // 吞掉通知 —— 灯是红的，通知却一次都不弹。
      if (!s || !s.count) {
        if (s) { slotSeen.delete(s.agent); slotNotifiedAt.delete(s.agent); }
        continue;
      }
      const prev = slotSeen.get(s.agent);
      slotSeen.set(s.agent, s.state);
      if (prev === undefined || prev === s.state) continue;
      // 状态照常记账（上面那行），只是不弹：解除静音后下一次变化能正常提醒。
      if (isAgentMuted(s.agent)) continue;
      const text = NOTIFY_TEXT[s.state];
      if (!text) continue;
      // 「完成」可以单独关通知：和「完成也响一声」是同一件事的两条通道。
      if (s.state === 'done' && cfg.notifyDone === false) continue;
      const now = Date.now();
      if (now - (slotNotifiedAt.get(s.agent) || 0) < 6000) continue;
      // 静音期间不弹，也不记时间戳：解除静音后如果状态还在，下一次变化自然会提醒。
      if (isMuted()) continue;
      slotNotifiedAt.set(s.agent, now);
      bridge.notify(`${displayName(s.agent)} ${text}`, '');
    }
  }

  // 额度见底提醒：剩余额度**从 >5% 掉到 ≤5%** 时弹一次。
  //
  // 初值是 null 而不是 false：`false` 表示「上次看到的时候还够用」，而启动时
  // 我们其实什么都没看到。已经只剩 3% 的用户一开机就被通知「快用完了」，
  // 那不是「刚刚用完」，而是「我们刚知道」—— 两种意思不能共用一次弹窗。
  let lastFuelLow = null;
  function notifyFuel(f) {
    if (!inElectron || !bridge.notify) return;
    if (isMuted()) return;
    if (isDnd()) return;
    // 额度提醒也归属某个软件：关掉它的通知就别弹。
    if (f && f.agent && isAgentMuted(f.agent)) return;
    const low = !!(f && typeof f.remaining === 'number' && f.remaining <= 5);
    if (low && lastFuelLow === false) {
      bridge.notify('额度快用完了', `${f.agent ? displayName(f.agent) + ' ' : ''}只剩 ${Math.round(f.remaining)}%`);
    }
    lastFuelLow = low;
  }

  // 把状态说成一句人话，交给 aria-live 念。这个工具靠颜色工作，而颜色对看不见
  // 屏幕的人没有信息量 —— 第二条输出通道不是锦上添花，是同一个事实的另一种写法。
  // 句子刻意保持稳定：同一状态不重复念，也不跟着 SSE 帧反复念。
  let spoken = '';
  function speakState(state, agent) {
    let text;
    if (state === 'offline') text = '没有代理在运行';
    else if (state === 'unknown') text = '有代理在运行，但没有上报状态';
    else if (agent) text = `${displayName(agent)} ${VERB[state] || state}`;
    else text = VERB[state] || state;
    if (text === spoken) return;
    // 不做节流：aria-live 是 polite，浏览器自己会排队朗读；而把「运行中」
    // 延后两秒，会出现「灯已经变绿、读屏还说需要你」—— 这个工具最不能撒的谎
    // 就是让两条输出通道对同一个事实说法不同。
    spoken = text;
    if (liveEl) liveEl.textContent = text;
  }

  // ---------------------------------------------------------------- pill rows
  // 复用行节点，而不是每条 SSE 帧重建一遍。原来每次 render 都
  // `labels.innerHTML = ''` 再建 4 个 div（各 5 个子节点、3 个监听），常驻窗口里
  // 就是每秒几十次无谓的 DOM 创建、事件解绑和布局失效 —— 全花在一个「什么都没
  // 变」的画面上。现在按软件复用，顺序靠 appendChild 的移动语义维持，
  // 交互改成 labels 上的事件委托（旧写法把 agent 闭包进监听里，复用就必须重建，
  // 那正是这笔开销的来源）。
  const pillPool = new Map();   // agent -> { el, refs }
  let moreRow = null;

  function pillRow(agent) {
    const hit = pillPool.get(agent);
    if (hit) return hit;
    const el = document.createElement('div');
    el.className = 'pill';
    el.dataset.agent = agent;
    // 这段标记是静态的，永远不会掺进服务端字符串（其余字段一律走 textContent）。
    el.innerHTML = '<i></i><b></b><span></span><em><u></u></em>';
    const entry = {
      el,
      refs: {
        dot: el.querySelector('i'),
        name: el.querySelector('b'),
        detail: el.querySelector('span'),
        fuelWrap: el.querySelector('em'),
        fuel: el.querySelector('em u'),
      },
    };
    pillPool.set(agent, entry);
    return entry;
  }

  function paintPill(entry, s, snap, worstKey) {
    const { el, refs } = entry;
    const offline = s.state === 'offline';
    const agent = s.agent;
    el.dataset.state = s.state;
    el.dataset.cwd = s.cwd || '';
    el.classList.toggle('quiet', !!s.quiet);
    el.classList.toggle('offline', offline);
    // 这一行是不是主灯代表的那个软件：在胸口槽位之外再回答一次。
    el.classList.toggle('worst', agent === worstKey && !focusedAgent && !offline);
    el.classList.toggle('focused', agent === focusedAgent);
    // 离线行只是占位，点了也没有可聚焦的状态，所以不进 tab 序列。
    if (offline) {
      el.removeAttribute('tabindex');
      el.removeAttribute('role');
      el.removeAttribute('aria-label');
      el.setAttribute('aria-disabled', 'true');
    } else {
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-pressed', String(agent === focusedAgent));
      el.setAttribute('aria-label', `${displayName(agent)} — ${VERB[s.state] || s.state}`
        + (isAgentMuted(agent) ? '，系统通知已关闭' : ''));
      el.removeAttribute('aria-disabled');
    }
    refs.dot.dataset.color = COLOR[s.state] || 'grey';
    refs.name.textContent = displayName(agent);
    const cc = offline || cfg.showModel === false ? null : ccSwitchLabel(snap.ccSwitch && snap.ccSwitch[agent]);
    // busy 的时长/预估：有历史节奏就估「预计还需」，超了就说「比平时慢」。
    const elapsed = s.state === 'busy' && s.since ? Date.now() - s.since : 0;
    const paceMs = snap.pace && snap.pace[agent];
    let detail = s.detail || VERB[s.state] || '';
    if (s.state === 'busy' && elapsed >= 60000) {
      if (paceMs && elapsed < paceMs) detail = `预计还需 ${Math.max(1, Math.round((paceMs - elapsed) / 60000))} 分钟`;
      else if (paceMs) detail = `比平时慢 · 已运行 ${Math.round(elapsed / 60000)} 分钟`;
      else detail = `已运行 ${Math.round(elapsed / 60000)} 分钟`;
    }
    refs.detail.textContent = cc
      ? (detail ? `用 ${cc} · ${detail}` : `用 ${cc}`)
      : detail;
    if (!offline && s.fuel && typeof s.fuel.remaining === 'number') {
      refs.fuel.style.width = Math.max(0, Math.min(100, s.fuel.remaining)) + '%';
      refs.fuelWrap.style.visibility = '';
    } else {
      refs.fuelWrap.style.visibility = 'hidden';
    }
    const quietFor = s.quiet ? ` — 已静默 ${Math.round(s.quietFor / 60000)} 分钟` : '';
    // 关掉通知的软件在 tooltip 里说清楚：否则「为什么它出错了我没收到通知」
    // 会变成一个查不出来的问题。
    const mutedNote = isAgentMuted(agent) ? ' — 系统通知已关闭' : '';
    el.title = offline
      ? `${displayName(agent)} — 未运行${mutedNote}`
      : (cc ? `用 ${cc} — ` : '') + (s.cwd ? s.cwd + ' — ' : '') + detail + quietFor
        + (s.cwd ? ' — 右键在终端打开' : '')
        + (agent === focusedAgent ? ' — 点击取消聚焦' : ' — 点击聚焦')
        + mutedNote;
  }

  // 一次绑定：点击聚焦、键盘聚焦、右键开终端。行被复用时不需要重绑。
  labels.addEventListener('click', (e) => {
    const el = e.target.closest('.pill');
    if (!el || !el.dataset.agent || el.classList.contains('offline')) return;
    toggleFocus(el.dataset.agent);
  });
  labels.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest('.pill');
    if (!el || !el.dataset.agent || el.classList.contains('offline')) return;
    e.preventDefault();
    toggleFocus(el.dataset.agent);
  });
  labels.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('.pill');
    const cwd = el && el.dataset.cwd;
    if (!cwd) return;
    e.preventDefault();
    e.stopPropagation();
    if (inElectron && bridge.openTerminal) bridge.openTerminal(cwd);
  });

  function render(snap) {
    lastSnap = snap;
    let overall = snap.overall || 'offline';
    if (!previewing) announce(overall);
    const sessions = snap.sessions || [];
    // 托盘 tooltip 跟着整体状态走（hover 托盘图标能看到现在在干什么）。
    if (inElectron && bridge.trayStatus) bridge.trayStatus({ overall, count: sessions.length });

    // "Nothing is running" and "Claude is running but not reporting" look
    // identical from here, and only one of them is a bug the user can fix.
    // We only ever upgrade to the second when a process was actually seen.
    const stalled = overall === 'offline' && snap.presence === true;
    if (stalled) overall = 'unknown';

    const slots = snap.slots || [];

    // ---- 槽位表由服务端下发 ------------------------------------------------
    // 「有哪些软件、各自排第几」的权威在服务端：它决定胸口槽位、灯环和主灯的同级
    // 优先级。界面不再自己维护一份名单 —— 服务端多接一个软件，这里自动多一行、
    // 多一段灯环，不需要改前端。
    //
    // 唯一的例外是用户自己排过序（设置里的 ↑/↓）：那是人的意图，不能被下发覆盖；
    // 服务端新增的软件追加在用户顺序之后。
    const serverOrder = slots.map((s) => s.agent);
    const missing = serverOrder.filter((a) => !agentOrder.includes(a));
    if (serverOrder.length && (missing.length || (!customOrder && serverOrder.join() !== agentOrder.join()))) {
      const next = customOrder ? [...agentOrder, ...missing] : serverOrder;
      if (next.join() !== agentOrder.join()) {
        agentOrder = next;
        AGENT_RANK = Object.fromEntries(agentOrder.map((a, i) => [a, i]));
        renderOrderUI();
      }
    }

    // 点击聚焦：聚焦某软件时主灯临时显示它的状态（否则显示聚合最坏者）；
    // 聚焦的软件下线则自动回到聚合。
    let displayState = overall;
    if (focusedAgent) {
      const f = slots.find((s) => s.agent === focusedAgent && s.count > 0);
      if (f) displayState = f.state;
      else focusedAgent = null;
    }

    // 只有「真实状态」变化才算一次事件；预览不算，预览结束后也不补一次。
    // 关键在「预览期间不要更新 lastRealState」：否则那三秒里真的变成「需要你」，
    // 等预览结束这张账单已经结清，提示音、系统通知、语音这一次就永久丢了 ——
    // 对一个承诺「绝不漏报需要你」的工具，这是最不该有的一种静默。
    const realChanged = !previewing && displayState !== lastRealState;
    if (!previewing) {
      lastRealState = displayState;
      document.body.dataset.state = displayState;
      // 状态已经变了，「这次事件」就结束了：解除单次静音，新的告警必须能出声。
      if (silencedState && displayState !== silencedState) silencedState = null;
    }
    // 主灯代表的软件（状态最要紧的那个）：机器人待机时会瞄一眼它的槽位。
    const mainPriority = PRIO;
    let mainSlotIdx = 0;
    for (let i = 0; i < slots.length; i++) {
      if ((mainPriority[slots[i].state] || 0) > (mainPriority[slots[mainSlotIdx].state] || 0)) mainSlotIdx = i;
    }
    document.body.dataset.mainSlot = String(mainSlotIdx);
    // 真实状态变化才响一次；预览不响（realChanged 里已经排除了预览）。
    if (realChanged) cue(displayState);
    // 第二条输出通道：同上，只在真实状态变化时说一次，不跟着每帧念。
    if (realChanged) speakState(displayState, slots[mainSlotIdx] && slots[mainSlotIdx].agent);

    // 预览期间冻结真实状态的这三条出口（镜面灯、槽位、3D 事件）。否则任何
    // 一条 SSE 帧都会把槽位和 3D 拉回真实颜色，而 --state 还是预览色：同一台
    // 机器人上两处说法不一致，正是这个文件最反对的事。
    const color = COLOR[displayState] || null;
    if (!previewing) {
      led.dataset.color = color || 'red';
      led.classList.toggle('on', !!color);
      renderSlots(slots);
    }
    announceDone(sessions);
    if (!previewing) checkStuck(sessions);
    announceCC(snap);
    // 每个软件的今日时长传给 3D 广告牌。key 用稳定的 agent id（不是显示名首词）：
    // 两个软件改名叫同首词时（把 codex 改名「Claude 2」）会互相覆盖、时长被合并。
    // 显示名放在 value 里，展示时才还原。
    const stats = {};
    for (const [agent, ms] of Object.entries(snap.stats?.byAgent || {})) {
      const min = Math.floor(ms / 60000);
      if (min >= 1) stats[agent] = { n: displayName(agent), m: min };
    }
    document.body.dataset.stats = JSON.stringify(stats);
    // 今日战绩：完成 / 出错总次数，交给 3D 广告牌展示。
    const events = snap.stats?.events || {};
    let doneTotal = 0;
    let errorTotal = 0;
    for (const agent of Object.keys(events)) {
      doneTotal += events[agent] && events[agent].done || 0;
      errorTotal += events[agent] && events[agent].error || 0;
    }
    document.body.dataset.events = JSON.stringify({ done: doneTotal, error: errorTotal });
    renderScore(snap);

    // 里程碑：合计时长跨过整点小时庆祝一次（跨天自动清零）。
    const totalBusyMs = Object.values(snap.stats?.byAgent || {}).reduce((a, b) => a + b, 0);
    const statsDay = snap.stats?.day || '';
    if (statsDay !== lastMilestoneDay) {
      const firstFrame = !lastMilestoneDay;
      lastMilestoneDay = statsDay;
      // 首帧只是「知道今天几号」：stats 是持久化的，重启时累计时长已经可能是
      // 五小时 —— 从 0 起算会把今天早已跨过的里程碑重新庆祝一遍；陪伴问候同理，
      // 每次开应用都说「陪你第 N 天啦」不是问候，是噪音。
      lastMilestone = firstFrame ? Math.floor(totalBusyMs / 3600000) : 0;
      if (firstFrame) {
        // 重启时今天可能早就超过目标了：只记账，不补发一条「目标达成」。
        const goalH = Number(cfg.dailyGoalHours) || 0;
        if (goalH > 0 && totalBusyMs >= goalH * 3600000) goalDoneDay = statsDay;
      } else {
        const days = dayDiff(cfg.firstRun || statsDay, statsDay);
        if (days >= 1) window.dispatchEvent(new CustomEvent('bao:companion', { detail: { days } }));
      }
    }
    // 一次跨过多档（比如午休回来一次涨了 3 小时）时只庆祝最高那一档：
    // 用 find 会挑最低的，然后在接下来几帧里一档一档补庆祝，看起来像卡住了。
    const crossed = MILESTONES.filter((m) => totalBusyMs >= m * 3600000 && m > lastMilestone).pop();
    if (crossed) {
      lastMilestone = crossed;
      window.dispatchEvent(new CustomEvent('bao:milestone', { detail: { hours: crossed } }));
    }

    // 每日目标达成：一天只提醒一次。用系统通知而不是 3D 庆祝 —— 4/6/8 小时
    // 同时也是内置里程碑，两个庆祝叠在同一帧看起来像卡住了。
    const goalH = Number(cfg.dailyGoalHours) || 0;
    if (goalH > 0 && totalBusyMs >= goalH * 3600000 && goalDoneDay !== statsDay) {
      goalDoneDay = statsDay;
      if (!isMuted() && !isDnd() && inElectron && bridge.notify) {
        bridge.notify(`今日目标达成 · ${goalH} 小时`, `今天累计工作 ${fmtDur(totalBusyMs)}，可以去歇一会儿了`);
      }
    }

    // Whose panel is this? Focused software when focused, otherwise the worst.
    // 聚合态可能是 `unknown`（presence 探测不到，但也没有软件在报），而槽位表
    // 里没有 unknown 这一档 —— 直接按 state 找会返回 undefined，铭牌和
    // `.pill.worst` 会在这一帧里无声消失。退一步取当前最要紧的那个槽位，
    // 但只在这个槽位真的有会话时才这么做（否则就是给「什么都没在跑」编名字）。
    const fallback = slots[mainSlotIdx] && slots[mainSlotIdx].count > 0 ? slots[mainSlotIdx] : null;
    const top = focusedAgent
      ? slots.find((s) => s.agent === focusedAgent && s.count > 0)
      : (slots.find((s) => s.state === overall && s.count > 0) || fallback);
    const agentLabel = top ? displayName(top.agent) : '';
    const worstKey = top ? top.agent : '';

    // 聚焦某个软件时，通知要说「被聚焦的那个」，而不是聚合里的最坏者——
    // 否则会弹出「Claude 出错了」但其实是你在盯的 Codex 出错。
    // 逐软件检测「进入」边沿：聚合状态没变时，也要能提醒第二个需要你的软件。
    if (!previewing) notifySlots(slots);
    renderFuel(snap.fuel);
    if (!previewing) notifyFuel(snap.fuel);
    // sessions arrive newest-first, so [0] is the software that spoke last
    const liveTop = sessions[0];
    if (!previewing) {
      publish(displayState, color, slots, agentLabel,
        liveTop ? HEX[COLOR[liveTop.state]] : null,
        activeAgents(snap, slots, worstKey));
    }

    // 按软件聚合：同一软件多个会话只占一行（取最坏状态），否则一个多会话的软件
    // 会把别的软件挤出前几行——workbuddy 同时有「idle」和「error」两个会话时，
    // 会显示两行 workbuddy，而 claude 被挤掉。
    const seen = new Map();
    for (const s of sessions) {
      if (s.state === 'offline') continue;
      const cur = seen.get(s.agent);
      if (!cur || PRIO[s.state] > PRIO[cur.state]) seen.set(s.agent, s);
    }
    // 每个注册软件始终各占一行：offline 也是暗行，位置固定——和胸口槽位、灯环一致。
    // 软件不会因为没在跑就凭空消失，眼睛也不用重新学「第几行是谁」。顺序直接取
    // 服务端的固定槽位表（它已经把离线软件排在固定位置）。
    // 顺序由「软件顺序」决定：slots 说明「有哪些软件」，agentOrder 说明「排第几」。
    // 只按 server 的固定槽位排，会让设置里的 ↑/↓ 只影响主灯、不影响这份列表。
    const slotAgents = slots.map((x) => x.agent);
    const rowOrder = slotAgents.length
      ? [...agentOrder.filter((a) => slotAgents.includes(a)),
        ...slotAgents.filter((a) => !agentOrder.includes(a))]
      : agentOrder;
    // showOffline=false 时退回旧行为：只显示真正有会话的软件。默认每个注册软件
    // 都占一行（离线是暗行），位置固定。
    const offlineRows = cfg.showOffline !== false;
    const list = rowOrder
      .map((agent) => seen.get(agent) || (offlineRows
        ? { agent, state: 'offline', detail: '', count: 0, quiet: false }
        : null))
      .filter(Boolean);
    const maxRows = Math.max(2, Math.min(8, Number(cfg.maxRows) || 4));
    const showPills = cfg.showLabels && !collapsed && list.length > 0;
    const shown = showPills ? list.slice(0, maxRows) : [];
    const keep = new Set(shown.map((x) => x.agent));
    // 退役不再显示的行：软件被关掉、行数被调小、或者列表被折叠了。
    for (const [agent, entry] of pillPool) {
      if (!keep.has(agent)) { entry.el.remove(); pillPool.delete(agent); }
    }
    if (showPills) {
      // Four rows fit comfortably; the rest collapse into a count rather than
      // pushing the robot off the bottom of the desk.
      for (const s of shown) {
        const { el } = pillRow(s.agent);
        paintPill({ el, refs: pillPool.get(s.agent).refs }, s, snap, worstKey);
        // appendChild 对已在文档里的节点是「移动」，所以这一行同时保证顺序。
        labels.appendChild(el);
      }
      if (list.length > maxRows) {
        if (!moreRow) {
          moreRow = document.createElement('div');
          moreRow.className = 'pill more';
        }
        moreRow.textContent = `还有 ${list.length - maxRows} 个`;
        labels.appendChild(moreRow);
      } else if (moreRow && moreRow.parentNode) {
        moreRow.remove();
      }
    } else if (moreRow && moreRow.parentNode) {
      moreRow.remove();
    }

    // Say the awkward thing out loud instead of showing a blank robot.
    let text = '';
    if (snap.slotsOverflow > 0) {
      text = `还有 ${snap.slotsOverflow} 个软件在运行，超出面板槽位`;
    } else if (stalled) {
      text = '检测到 Claude Code 正在运行，但未上报状态 — 请执行：bao connect claude';
    } else if (snap.unknownEvent && Date.now() - snap.unknownEvent.at < 10 * 60 * 1000) {
      text = `无法识别的事件 "${snap.unknownEvent.event}" — 请查看 ~/.baoanlight/hook-events.log`;
    } else {
      // 启动自检：只在没有任何更急的事时，提醒安装层面的硬错误。
      const sc = snap.selfcheck;
      const fails = sc && Array.isArray(sc.checks) ? sc.checks.filter((x) => x.status === 'fail') : [];
      if (fails.length) {
        text = `自检发现 ${fails.length} 个问题 — ${fails[0].name}（运行 bao doctor 看详情）`;
      }
    }
    // 正在显示的短提示优先；它过期后这里自然换回常驻文案。
    const noteShown = (Date.now() < flashUntil && flashText) ? flashText : text;
    note.textContent = noteShown;
    note.hidden = !noteShown;
    note.classList.toggle('on', !!noteShown);

    fit();
  }

  // ---------------------------------------------------------------- live state
  const disconnectedEl = document.getElementById('disconnected');
  let es = null;
  let retry = 0;
  let retryTimer = 0;
  function connect() {
    const base = inElectron ? bridge.serverUrl : location.origin;
    // 先关掉上一条流：并存两条 SSE 会让每一帧渲染两次、通知响两遍。
    if (es) { try { es.close(); } catch { /* 已经关了 */ } }
    es = new EventSource(base + '/events');
    es.onopen = () => {
      retry = 0;
      disconnectedEl.hidden = true;
      document.body.classList.remove('disconnected');
    };
    es.onmessage = (e) => {
      let snap;
      try { snap = JSON.parse(e.data); } catch (_) { return; }
      lastSnap = snap;
      // 藏起来时别重建 DOM：把快照记下，等可见了再 render 一次补齐。
      if (document.hidden) { snapDirty = true; return; }
      snapDirty = false;
      // 心跳帧的唯一作用是让 quietFor 往前走（卡住检测依赖它）。状态没变时
      // 不重写 pill / 槽位 / 铭牌 —— 一个常驻窗口每次心跳都重排 DOM 是要耗电的，
      // 而这条通道每 30 秒就来一次。
      if (snap.heartbeat) {
        if (!previewing) checkStuck(snap.sessions || []);
        if (!menu.hidden) renderScore(snap);
        return;
      }
      render(snap);
    };
    // 计划内关闭（`bao stop`）：服务端先发一条 quit 事件再退出。窗口必须跟着
    // 退出 —— 否则它变成「未连接」的孤儿，还占着单实例锁与全局快捷键，下次
    // `bao start` 只能复用它。崩溃断线不发这条，界面照旧显示「未连接」。
    es.addEventListener('quit', () => {
      try { es.close(); } catch { /* 已经关了 */ }
      if (inElectron && bridge.quit) bridge.quit();
    });
    es.onerror = () => {
      document.body.classList.add('disconnected');
      disconnectedEl.hidden = false;
      try { es.close(); } catch { /* 已经关了 */ }
      // 指数退避，上限 15 秒。原来固定 1.5 秒且没有上限：服务没起或端口被
      // 别的程序占着时，就是在后台永远每 1.5 秒失败一次的循环。
      retry = Math.min(retry + 1, 6);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, Math.min(15_000, 500 * 2 ** retry));
    };
  }
  connect();

  // 重新可见时补齐后台攒下的一帧，并立刻刷新系统面板（后台那几次都跳过了）。
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (snapDirty && lastSnap) { snapDirty = false; render(lastSnap); }
    pollSys();
  });

  // ---------------------------------------------------------------- collapsing
  const collapseBtn = document.getElementById('btn-collapse');
  const setCollapsed = (next) => {
    collapsed = next;
    document.body.classList.toggle('collapsed', collapsed);
    collapseBtn.textContent = collapsed ? '+' : '–';
    labels.innerHTML = '';
    fit();
    if (lastSnap) render(lastSnap);
  };

  // ---------------------------------------------------------------- menu
  const setMenu = (open) => {
    menuOpen = open;
    menu.hidden = !open;
    bar.classList.toggle('menu-open', open);
    // 关菜单时清掉过滤：下次打开应该是一份完整菜单，而不是上次搜索的残留。
    if (!open && findInput.value) { findInput.value = ''; applyFind(); }
    // 每次打开都重读一次：用户可能在终端里用 `bao autostart on/off` 改过。
    if (open) refreshAutostart();
    if (open) setSizer(false);
    // 菜单关着时那两块面板不重建（见 renderRecent / renderScore），所以打开
    // 的这一刻必须补画一次，否则看到的是上次打开时的旧内容。
    if (open && panelDirty && lastSnap) {
      panelDirty = false;
      renderScore(lastSnap);
      renderRecent();
    }
    fit();
  };

  // The quick size bar. Deliberately not the settings pane: right-click is a
  // one-gesture request, and answering it with sound, click-through and a quit
  // button is how you get a slider nobody can hit.
  const preview = document.getElementById('preview');
  let previewTimer = null;
  // 预览某状态 3 秒：直接改 body.dataset.state，CSS 颜色和 3D 机器人一起变，
  // 结束后用最后一份快照还原真实状态。
  function previewState(state) {
    previewing = true;
    document.body.dataset.state = state;
    // 高亮当前正在预览的那个按钮，一眼知道「我现在看的是哪个状态」。
    preview.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.st === state));
    clearTimeout(previewTimer);
    previewTimer = setTimeout(stopPreview, 3000);
  }
  // 立刻结束预览并回到真实状态。面板被收起/Esc 时必须调它：否则预览的 3 秒
  // 会继续把假状态挂在机器人身上，而这期间真实状态是被冻结的 —— 面板已经关了，
  // 用户却看到一盏在说谎的灯。
  function stopPreview() {
    if (!previewing) return;
    clearTimeout(previewTimer);
    previewing = false;
    preview.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    if (lastSnap) render(lastSnap);
  }
  preview.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => previewState(b.dataset.st));
  });

  // 空闲多久自动收起尺寸条/预览：窗口在热区外是点击穿透的，用户去点桌面或
  // 别的窗口时，document 根本收不到 pointerdown —— 没有超时的话它们会一直挂着，
  // 而它们占的那条带子仍在热区里，继续吃掉桌面点击。
  // 20 秒而不是几秒：面板刚打开、光标停在上面思考时被自动收走，比一直挂着
  // 更像 bug。20 秒足够看完，也足够让「忘了关」的局面自己结束。
  const SIZER_IDLE_MS = 20000;
  let sizerIdleTimer = 0;
  function armSizerIdle() {
    clearTimeout(sizerIdleTimer);
    if (!sizerOpen) return;
    sizerIdleTimer = setTimeout(() => setSizer(false), SIZER_IDLE_MS);
  }

  const setSizer = (open) => {
    if (open === sizerOpen && open) return;
    sizerOpen = open;
    clearTimeout(sizerTimer);
    clearTimeout(sizerIdleTimer);
    if (open) {
      sizer.hidden = false;
      preview.hidden = false;
      if (menuOpen) {
        menuOpen = false;
        menu.hidden = true;
        bar.classList.remove('menu-open');
      }
      requestAnimationFrame(() => {
        if (sizerOpen) { sizer.classList.add('on'); preview.classList.add('on'); armSizerIdle(); }
      });
    } else {
      // 收起面板 = 用户不再看预览，假状态必须马上结束（见 stopPreview）。
      stopPreview();
      sizer.classList.remove('on');
      preview.classList.remove('on');
      sizerTimer = setTimeout(() => {
        if (!sizerOpen) { sizer.hidden = true; preview.hidden = true; fit(); }
      }, 160);
    }
    fit();
  };
  // 鼠标在面板里动一动/按一下都算「还在用」，重新计时。
  for (const el of [sizer, preview]) {
    el.addEventListener('pointermove', armSizerIdle);
    el.addEventListener('pointerdown', armSizerIdle);
  }

  document.getElementById('btn-menu').onclick = (e) => {
    e.stopPropagation();
    setMenu(!menuOpen);
  };
  // Right-click on the robot is the size bar. Everything else lives behind the
  // gear, which is on the bar and on the size panel — never behind another
  // right-click.
  robot.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setSizer(!sizerOpen);
  });
  document.addEventListener('pointerdown', (e) => {
    if (menuOpen && !menu.contains(e.target) && !e.target.closest('#btn-menu')) setMenu(false);
    // 机器人自己、工具栏、尺寸条、预览面板都不算「别处」。
    // 之前没排除机器人：右键按下的 pointerdown 先把 sizerOpen 置 false，
    // 紧接着的 contextmenu 又 toggle 回 true（Windows 上顺序如此），
    // 于是右键只能开、永远关不掉。
    if (sizerOpen
        && !sizer.contains(e.target)
        && !preview.contains(e.target)
        && !robot.contains(e.target)
        && !bar.contains(e.target)) setSizer(false);
  });

  document.getElementById('m-size').addEventListener('input', (e) => {
    applyScale(Number(e.target.value) / 100, { persist: false });
  });
  document.getElementById('m-size').addEventListener('change', () => {
    if (inElectron) saveConfig({ scale });
  });

  // 灯光亮度：只调发光件的亮度，不碰机器人本体材质，所以状态颜色与节奏不变、
  // 仍可读。实时预览，松开时写入配置。
  document.getElementById('m-brightness').addEventListener('input', (e) => {
    const b = Math.max(0.5, Math.min(1, Number(e.target.value) / 100));
    document.getElementById('m-brightness-val').textContent = Math.round(b * 100) + '%';
    window.dispatchEvent(new CustomEvent('bao:brightness', { detail: { brightness: b } }));
  });
  document.getElementById('m-brightness').addEventListener('change', (e) => {
    const b = Math.max(0.5, Math.min(1, Number(e.target.value) / 100));
    if (inElectron) saveConfig({ brightness: b });
  });

  // 「自定义」配色 + 十六进制归一化：广告牌和四部位配色共用同一套规则。
  // 定义在这里（而不是四部位那一节）是因为下面的广告牌先用到它们。
  const CUSTOM = '自定义';
  const HEX_RE = /^#?([0-9a-f]{6})$/i;
  // 取色器只认 #rrggbb；配置里手写的 "3aa5c9"、大写、带空格都收，归一化后再比较。
  const normHex = (v) => {
    const m = HEX_RE.exec(String(v == null ? '' : v).trim());
    return m ? `#${m[1].toLowerCase()}` : null;
  };

  // 今日时长广告牌：显示哪个软件、放哪一侧、什么颜色、什么形状。
  const SIGN_MODES = { '最多': 'top', '合计': 'total', '轮播': 'cycle', '关闭': 'off' };
  const SIGN_POS = { '右侧': 'right', '左侧': 'left' };
  const SIGN_COLORS = { '金色': '#ffd54a', '白色': '#e9edf2', '青色': '#4ad5ff', '粉色': '#ff8ac2', '紫色': '#b48aff', '绿色': '#34c759', '红色': '#ff3b30', '蓝色': '#4a9dff' };
  const SIGN_SHAPES = { '圆角': '圆角', '胶囊': '胶囊', '方正': '方正' };
  const signSel = document.getElementById('m-sign');
  const signPosSel = document.getElementById('m-sign-pos');
  const signColorSel = document.getElementById('m-sign-color');
  const signShapeSel = document.getElementById('m-sign-shape');
  const fillSignOpts = (sel, labels) => {
    for (const l of labels) {
      const o = document.createElement('option');
      o.value = l;
      o.textContent = l;
      sel.appendChild(o);
    }
  };
  fillSignOpts(signSel, Object.keys(SIGN_MODES));
  fillSignOpts(signPosSel, Object.keys(SIGN_POS));
  // 颜色也支持「自定义」：牌面颜色只是画在 canvas 上的描边/文字，任意十六进制
  // 都能直接用，没有理由把它锁在八色调色板里。
  fillSignOpts(signColorSel, [...Object.keys(SIGN_COLORS), CUSTOM]);
  fillSignOpts(signShapeSel, Object.keys(SIGN_SHAPES));
  signSel.value = '最多';
  signPosSel.value = '右侧';
  signColorSel.value = '金色';
  signShapeSel.value = '圆角';
  const signCustomInput = document.getElementById('m-sign-color-custom');
  const signCustomRow = document.getElementById('custom-sign-row');
  signCustomInput.value = SIGN_COLORS['金色'];
  // 当前牌面颜色：选「自定义」时读取色器，否则读调色板。归一化失败回落到金色，
  // 与 dispatch、落盘、cfg 用的是同一个值。
  const signColorValue = () => (signColorSel.value === CUSTOM
    ? (normHex(signCustomInput.value) || SIGN_COLORS['金色'])
    : (SIGN_COLORS[signColorSel.value] || SIGN_COLORS['金色']));
  function applySign() {
    const mode = SIGN_MODES[signSel.value] || 'top';
    const pos = SIGN_POS[signPosSel.value] || 'right';
    const shape = SIGN_SHAPES[signShapeSel.value] || '圆角';
    const custom = signColorSel.value === CUSTOM;
    signCustomRow.hidden = !custom;
    if (custom) signCustomInput.value = signColorValue();   // 归一化：取色器只认 #rrggbb
    const color = signColorValue();
    window.dispatchEvent(new CustomEvent('bao:sign', { detail: { mode, pos, color, shape } }));
    if (inElectron) saveConfig({ signMode: mode, signPos: pos, signColor: color, signShape: shape });
    return custom;
  }
  signSel.addEventListener('change', applySign);
  signPosSel.addEventListener('change', applySign);
  signColorSel.addEventListener('change', (e) => {
    const custom = applySign();
    // 与四部位配色一致：选中「自定义」就把取色器弹出来，并立刻记住颜色。
    if (custom && e.isTrusted && typeof signCustomInput.showPicker === 'function') {
      try { signCustomInput.showPicker(); } catch { /* 没有用户手势：不弹 */ }
    }
    if (custom && inElectron) saveConfig({ customSign: signColorValue() });
  });
  signShapeSel.addEventListener('change', applySign);
  // 拖动取色器实时预览（松手才落盘）。牌面重绘要重画 320×96 的 canvas，
  // 所以同样限速，别让一次拖动把菜单拖成幻灯片。
  let signPreviewAt = 0;
  signCustomInput.addEventListener('input', () => {
    if (signColorSel.value !== CUSTOM) return;
    const now = Date.now();
    if (now - signPreviewAt < 80) return;
    signPreviewAt = now;
    applySign();
  });
  signCustomInput.addEventListener('change', () => {
    if (signColorSel.value !== CUSTOM) return;
    applySign();
    if (inElectron) saveConfig({ customSign: signColorValue() });
  });



  // 体型（Q版/标准/修长）。
  const BODY_NAMES = ['Q版', '标准', '修长'];
  const bodySel = document.getElementById('m-body');
  for (const n of BODY_NAMES) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n; bodySel.appendChild(o);
  }
  bodySel.addEventListener('change', (e) => {
    window.dispatchEvent(new CustomEvent('bao:body', { detail: { body: e.target.value } }));
    if (inElectron) saveConfig({ body: e.target.value });
  });

  // 底座灯效列表（与 robot3d.js 的 BASE_EFFECTS 对应）。「状态色」是默认：四软件
  // 状态色 + 彩虹流光；其余是纯氛围灯效（五颜六色流动）。
  const EFFECT_NAMES = ['状态色', '彩虹', '彩虹波浪', '双旋转彩虹', '跑马灯', '彗星', '呼吸',
    '警灯扫描', '波浪', '螺旋', '随机跑马灯', '交替', '频闪', '气泡', '雨滴', '锯齿蛇',
    '绽放', '呼吸圆环', '色彩轮盘', '交叉光束', '填充', '闪电', '运动光点', '移动窗格',
    '径向彩虹', '随机旋转', '旋转光束', '旋转彩虹', '序列', '平滑闪烁', '光谱循环',
    '堆叠', '星夜', '漩涡圆环', '光束扫视', '渐变波浪'];
  const effectSel = document.getElementById('m-effect');
  for (const n of EFFECT_NAMES) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n;
    effectSel.appendChild(o);
  }
  effectSel.addEventListener('change', (e) => {
    window.dispatchEvent(new CustomEvent('bao:effect', { detail: { effect: e.target.value } }));
    if (inElectron) saveConfig({ baseEffect: e.target.value });
  });

  // 皮肤/场景色块预览用的颜色表（与 robot3d.js 保持一致）。
  const SKIN_COLORS = Object.fromEntries(SKIN_TONES.map((t) => [t.name, t.hex]));
  const SCENE_COLORS = {
    '无': '#4a5058', '雪地': '#d8e2ec', '草原': '#6a8a4a', '沙漠': '#c9a562',
    '星空': '#14162a', '岩浆': '#1a0e0a', '樱花': '#f0dcd8', '海洋': '#1a4a6a', '森林': '#2c4a24',
    '雨夜': '#1c2530', '工厂': '#2e3238', '雪夜': '#1a2230', '黄昏': '#8a4a3a', '极光': '#0a1418',
  };
  // 瞳色 / 履带 / 配件 的代表色（与 robot3d.js 的 EYE_STYLES / TRACK_SKINS / ARM_SKINS 对应）。
  const EYE_COLORS = Object.fromEntries(EYE_TONES.map((t) => [t.name, t.iris]));
  const TRACK_COLORS = Object.fromEntries(TRACK_TONES.map((t) => [t.name, t.rubber]));
  const ARM_COLORS = Object.fromEntries(ARM_TONES.map((t) => [t.name, t.arm]));
  const updateSwatch = (id, color) => {
    const el = document.getElementById(id);
    if (el) el.style.background = color || 'transparent';
  };

  // 皮肤/眼睛/履带/配件的列表来自 palette。固定配色只换材质色，做旧纹理保留。
  // 每一项还多一个「自定义」：用户可以随手挑任意颜色（存 config.customSkin 等），
  // 明暗由主色推导。四个部位共用一条规则，色块、事件、落盘读的是同一个值。
  const SKIN_NAMES = names(SKIN_TONES);
  const EYESTYLE_NAMES = names(EYE_TONES);
  const TRACKSTYLE_NAMES = names(TRACK_TONES);
  const ARMSKIN_NAMES = names(ARM_TONES);
  // 事件名与载荷都写成字面量：test/events.test.js 用文本匹配守住「发出的事件
  // 都有人听、两边读的字段一致」。表驱动能少写几行，但那条守卫会失效 ——
  // 而它守的正是「点了没反应、控制台一片安静」这类最难查的故障。
  const EMIT = {
    skin: (custom, hex, value) => {
      if (custom) window.dispatchEvent(new CustomEvent('bao:skin', { detail: { skin: CUSTOM, hex } }));
      else window.dispatchEvent(new CustomEvent('bao:skin', { detail: { skin: value } }));
    },
    eyestyle: (custom, hex, value) => {
      if (custom) window.dispatchEvent(new CustomEvent('bao:eyestyle', { detail: { eyestyle: CUSTOM, hex } }));
      else window.dispatchEvent(new CustomEvent('bao:eyestyle', { detail: { eyestyle: value } }));
    },
    trackstyle: (custom, hex, value) => {
      if (custom) window.dispatchEvent(new CustomEvent('bao:trackstyle', { detail: { trackstyle: CUSTOM, hex } }));
      else window.dispatchEvent(new CustomEvent('bao:trackstyle', { detail: { trackstyle: value } }));
    },
    armskin: (custom, hex, value) => {
      if (custom) window.dispatchEvent(new CustomEvent('bao:armskin', { detail: { armskin: CUSTOM, hex } }));
      else window.dispatchEvent(new CustomEvent('bao:armskin', { detail: { armskin: value } }));
    },
  };
  const PARTS = [
    { key: 'skin', detailKey: 'skin', configKey: 'customSkin',
      options: SKIN_NAMES, fixed: SKIN_COLORS, swatch: 'skin-swatch',
      ids: ['m-skin', 'm-skin-custom', 'custom-skin-row'], fallback: SKIN_TONES[0].hex },
    { key: 'eye', detailKey: 'eyestyle', configKey: 'customEye',
      options: EYESTYLE_NAMES, fixed: EYE_COLORS, swatch: 'eye-swatch',
      ids: ['m-eyestyle', 'm-eyestyle-custom', 'custom-eye-row'], fallback: EYE_TONES[0].iris },
    { key: 'track', detailKey: 'trackstyle', configKey: 'customTrack',
      options: TRACKSTYLE_NAMES, fixed: TRACK_COLORS, swatch: 'track-swatch',
      ids: ['m-trackstyle', 'm-trackstyle-custom', 'custom-track-row'], fallback: TRACK_TONES[0].rubber },
    { key: 'arm', detailKey: 'armskin', configKey: 'customArm',
      options: ARMSKIN_NAMES, fixed: ARM_COLORS, swatch: 'arm-swatch',
      ids: ['m-armskin', 'm-armskin-custom', 'custom-arm-row'], fallback: ARM_TONES[0].arm },
  ];
  // 出厂颜色取自 palette 第一项（也是机器人的初始外观），不在这里另抄一份，
  // 否则改了 palette 的默认色，取色器会停在一个机器人从来不用的颜色上。
  for (const p of PARTS) {
    const [selId, inputId, rowId] = p.ids;
    p.sel = document.getElementById(selId);
    p.input = document.getElementById(inputId);
    p.row = document.getElementById(rowId);
    for (const n of [...p.options, CUSTOM]) {
      const o = document.createElement('option');
      o.value = n;
      o.textContent = n;
      p.sel.appendChild(o);
    }
    p.input.value = p.fallback;
    p.hex = () => normHex(p.input.value) || p.fallback;
    p.color = () => (p.sel.value === CUSTOM ? p.hex() : p.fixed[p.sel.value]);
    p.paint = () => updateSwatch(p.swatch, p.color());
    p.apply = () => {
      const custom = p.sel.value === CUSTOM;
      p.row.hidden = !custom;
      if (custom) p.input.value = p.hex();    // 归一化：取色器只认 #rrggbb
      EMIT[p.detailKey](custom, p.hex(), p.sel.value);
      p.paint();
      return custom ? p.hex() : null;
    };
    p.sel.addEventListener('change', (e) => {
      const custom = p.apply();
      // 选「自定义」就直接把取色器弹出来：用户下一个动作必然是挑颜色，
      // 省掉「再点一下输入框」。只对真实操作弹 —— 应用方案 / 重置外观是用
      // 脚本派发 change 的，那时突然弹一个系统取色器只会打断用户。
      if (custom && e.isTrusted && typeof p.input.showPicker === 'function') {
        try { p.input.showPicker(); } catch { /* 没有用户手势：不弹 */ }
      }
      // 选「自定义」的同一刻就把颜色落盘：否则配置里只留下「自定义」这个名字，
      // 重启后没有颜色可用，界面只能悄悄回落到出厂色。
      if (inElectron) {
        saveConfig(custom ? { [p.detailKey]: CUSTOM, [p.configKey]: custom } : { [p.detailKey]: p.sel.value });
      }
      syncThemeLabel();
    });
    // 拖动取色器时实时预览，松手（change）才落盘，避免一拖写几十次配置。
    // 预览本身也要限速：皮肤每次上色要重画两张 256×256 的做旧纹理，而拖动
    // 一分钟能发上百次 input；不限速会把窗口拖成幻灯片。松手那一下补最终值。
    let lastPreview = 0;
    p.input.addEventListener('input', () => {
      if (p.sel.value !== CUSTOM) return;
      const now = Date.now();
      if (now - lastPreview < 80) return;
      lastPreview = now;
      p.apply();
    });
    p.input.addEventListener('change', () => {
      if (p.sel.value !== CUSTOM) return;
      p.apply();
      const v = p.hex();
      p.input.value = v;
      if (inElectron) saveConfig({ [p.configKey]: v });
    });
  }
  const partOf = (key) => PARTS.find((p) => p.key === key);
  const skinSel = partOf('skin').sel;
  const eyestyleSel = partOf('eye').sel;
  const trackstyleSel = partOf('track').sel;
  const armskinSel = partOf('arm').sel;

  // ---- 材质 --------------------------------------------------------------
  // 做旧程度（锈迹/掉漆/污渍的强度）与表面质感（金属度/粗糙度）。这是「外观」
  // 之外的第二个维度：前者改贴图，后者改光照响应，两者都不改颜色 —— 红黄绿在
  // 这台机器上只能表示状态，自定义再多也不能借用它们。
  const WEAR_MIN = 0;
  const WEAR_MAX = 150;                // 百分比，100 = 出厂强度
  const wearInput = document.getElementById('m-wear');
  const wearOut = document.getElementById('m-wear-val');
  const FINISH_NAMES = ['哑光', '标准', '精工'];
  const finishSel = document.getElementById('m-finish');
  for (const n of FINISH_NAMES) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n; finishSel.appendChild(o);
  }
  finishSel.value = '标准';
  // 滑杆的合法范围只在这里判一次：落盘、派发、导出、套用方案读的都是它。
  const wearValue = () => {
    const n = Number(wearInput.value);
    if (!Number.isFinite(n)) return 1;                       // 读不出就回出厂强度
    const pct = Math.max(WEAR_MIN, Math.min(WEAR_MAX, n));
    return Math.round(pct) / 100;
  };
  const pushWear = () => {
    const w = wearValue();
    wearOut.textContent = Math.round(w * 100) + '%';
    window.dispatchEvent(new CustomEvent('bao:wear', { detail: { wear: w } }));
    return w;
  };
  // 拖动时实时预览，但一次重绘要重画八张 256×256 的做旧纹理；不限速会把设置
  // 面板拖成幻灯片。松手（change）那一下补最终值并落盘。
  let lastWearPush = 0;
  wearInput.addEventListener('input', () => {
    const w = wearValue();
    wearOut.textContent = Math.round(w * 100) + '%';
    const now = Date.now();
    if (now - lastWearPush < 90) return;
    lastWearPush = now;
    window.dispatchEvent(new CustomEvent('bao:wear', { detail: { wear: w } }));
  });
  wearInput.addEventListener('change', () => {
    if (inElectron) saveConfig({ wear: pushWear() });
  });
  finishSel.addEventListener('change', (e) => {
    window.dispatchEvent(new CustomEvent('bao:finish', { detail: { finish: e.target.value } }));
    if (inElectron) saveConfig({ finish: e.target.value });
  });

  // 履带形状（圆角矩形/三角形/梯形）。
  const TRACKTYPE_NAMES = ['圆角矩形', '三角形', '梯形'];
  const tracktypeSel = document.getElementById('m-tracktype');
  for (const n of TRACKTYPE_NAMES) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n; tracktypeSel.appendChild(o);
  }
  tracktypeSel.addEventListener('change', (e) => {
    window.dispatchEvent(new CustomEvent('bao:tracktype', { detail: { tracktype: e.target.value } }));
    if (inElectron) saveConfig({ tracktype: e.target.value });
  });

  // 手爪形状。
  const CLAW_NAMES = ['铲形', '三指', '钳形', '四指', '五指'];
  const clawSel = document.getElementById('m-claw');
  for (const n of CLAW_NAMES) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n; clawSel.appendChild(o);
  }
  clawSel.addEventListener('change', (e) => {
    window.dispatchEvent(new CustomEvent('bao:claw', { detail: { claw: e.target.value } }));
    if (inElectron) saveConfig({ claw: e.target.value });
  });

  // 配色主题：一键套用整套协调配色（皮肤/眼睛/履带/配件），仍可单独微调。
  const THEMES = {
    '经典战损黄': { skin: '做旧黄', eye: '默认黑', track: '黑', arm: '枪灰' },
    '纯白机甲': { skin: '岩灰', eye: '蓝瞳', track: '岩灰', arm: '银白' },
    '赛博霓虹': { skin: '深海蓝', eye: '蓝瞳', track: '黑', arm: '暗黑' },
    '军绿迷彩': { skin: '军绿', eye: '绿瞳', track: '军绿', arm: '铜色' },
    '暗夜黑金': { skin: '暗红', eye: '金瞳', track: '黑', arm: '金色' },
    '银翼猎手': { skin: '金属银', eye: '青瞳', track: '岩灰', arm: '枪铁' },
    '森林守望': { skin: '森林绿', eye: '绿瞳', track: '军绿', arm: '青铜' },
    '暮色玫瑰': { skin: '樱花粉', eye: '红瞳', track: '暗红', arm: '香槟金' },
  };
  const themeSel = document.getElementById('m-theme');
  for (const n of [...Object.keys(THEMES), '自定义']) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n; themeSel.appendChild(o);
  }
  // 判断当前配色是否已偏离主题；偏离则主题下拉标记为「自定义」。
  function syncThemeLabel() {
    for (const [name, t] of Object.entries(THEMES)) {
      if (t.skin === skinSel.value && t.eye === eyestyleSel.value
        && t.track === trackstyleSel.value && t.arm === armskinSel.value) {
        themeSel.value = name;
        return;
      }
    }
    themeSel.value = '自定义';
  }
  themeSel.addEventListener('change', (e) => {
    const t = THEMES[e.target.value];
    // 「自定义」不是一套可套用的配色，只是 syncThemeLabel 推导出来的标记。
    // 用户主动选它时保持现有配色，但下拉要立刻退回**真实**的那一项，否则它会
    // 一直显示「自定义」而机器人还是原主题，直到下一次改配色才被纠正。
    if (!t) { syncThemeLabel(); return; }
    skinSel.value = t.skin; skinSel.dispatchEvent(new Event('change'));
    eyestyleSel.value = t.eye; eyestyleSel.dispatchEvent(new Event('change'));
    trackstyleSel.value = t.track; trackstyleSel.dispatchEvent(new Event('change'));
    armskinSel.value = t.arm; armskinSel.dispatchEvent(new Event('change'));
    // 只存四项配色。曾经还写过一个 `palette` 键（「配色主题名」），但全仓没有人
    // 读它 —— 主题名一直是靠 syncThemeLabel() 现算的。一个只写、永不读的配置项，
    // 只会让「配置里到底哪些有用」这个问题多一个坑。
    if (inElectron) saveConfig({ skin: t.skin, eyestyle: t.eye, trackstyle: t.track, armskin: t.arm });
  });

  // 胳膊形状（双板/圆筒/桁架）。
  const ARMTYPE_NAMES = ['双板', '圆筒', '桁架'];
  const armtypeSel = document.getElementById('m-armtype');
  for (const n of ARMTYPE_NAMES) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n; armtypeSel.appendChild(o);
  }
  armtypeSel.addEventListener('change', (e) => {
    window.dispatchEvent(new CustomEvent('bao:armtype', { detail: { armtype: e.target.value } }));
    if (inElectron) saveConfig({ armtype: e.target.value });
  });

  // 头形状（双筒/单眼/三眼）。
  const HEADTYPE_NAMES = ['双筒', '单眼', '三眼'];
  const headtypeSel = document.getElementById('m-headtype');
  for (const n of HEADTYPE_NAMES) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n; headtypeSel.appendChild(o);
  }

  // 头部装饰（无/天线/安全帽/皇冠/眼镜/墨镜/围巾/背包/礼帽/领结/勋章/贝雷帽）。
  const DECORATION_NAMES = ['无', '天线', '安全帽', '皇冠', '眼镜', '墨镜', '围巾', '背包', '礼帽', '领结', '勋章', '贝雷帽'];
  const decorationSel = document.getElementById('m-decoration');
  for (const n of DECORATION_NAMES) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n; decorationSel.appendChild(o);
  }
  decorationSel.value = '无';
  decorationSel.addEventListener('change', (e) => {
    window.dispatchEvent(new CustomEvent('bao:decoration', { detail: { decoration: e.target.value } }));
    if (inElectron) saveConfig({ decoration: e.target.value });
  });
  headtypeSel.addEventListener('change', (e) => {
    window.dispatchEvent(new CustomEvent('bao:headtype', { detail: { headtype: e.target.value } }));
    if (inElectron) saveConfig({ headtype: e.target.value });
  });

  // 眼睛形状（圆/方/六边形/三角）。
  const EYESHAPE_NAMES = ['圆', '方', '六边形', '三角'];
  const eyeshapeSel = document.getElementById('m-eyeshape');
  for (const n of EYESHAPE_NAMES) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n; eyeshapeSel.appendChild(o);
  }
  eyeshapeSel.addEventListener('change', (e) => {
    window.dispatchEvent(new CustomEvent('bao:eyeshape', { detail: { eyeshape: e.target.value } }));
    if (inElectron) saveConfig({ eyeshape: e.target.value });
  });

  // 场景。
  const SCENE_NAMES = ['无', '雪地', '草原', '沙漠', '星空', '岩浆', '樱花', '海洋', '森林', '雨夜', '工厂', '雪夜', '黄昏', '极光'];
  const sceneSel = document.getElementById('m-scene');
  for (const n of SCENE_NAMES) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n; sceneSel.appendChild(o);
  }
  sceneSel.addEventListener('change', (e) => {
    window.dispatchEvent(new CustomEvent('bao:scene', { detail: { scene: e.target.value } }));
    if (inElectron) saveConfig({ scene: e.target.value });
    updateSwatch('scene-swatch', SCENE_COLORS[e.target.value]);
  });

  // 场景按时间自动切换：白天一个、夜晚一个，夜晚时段可跨午夜。打开后上面的「场景」
  // 下拉不再生效（由时间决定），所以把它置灰。
  const daySceneSel = document.getElementById('m-dayscene');
  const nightSceneSel = document.getElementById('m-nightscene');
  for (const n of SCENE_NAMES) {
    for (const sel of [daySceneSel, nightSceneSel]) {
      const o = document.createElement('option');
      o.value = n; o.textContent = n; sel.appendChild(o);
    }
  }
  const autoSceneInput = document.getElementById('m-autoscene');
  const autoSceneOpts = document.getElementById('autoscene-opts');
  const nightStartInput = document.getElementById('m-night-start');
  const nightEndInput = document.getElementById('m-night-end');

  // 当前是否处在「夜晚时段」。跨午夜（20:00 → 07:00）时 s > e，否则 s < e。
  const inNightWindow = () => {
    const s = toMin(cfg.nightStart);
    const e = toMin(cfg.nightEnd);
    if (s == null || e == null || s === e) return false;
    const d = new Date();
    const hm = d.getHours() * 60 + d.getMinutes();
    return s < e ? (hm >= s && hm < e) : (hm >= s || hm < e);
  };
  // 应用当前应显示的场景（仅 autoScene 打开时生效）。被打断时（手动关掉自动）由
  // 关掉的那一处负责把场景还原。
  let lastAutoScene = '';
  const applyAutoScene = () => {
    if (!cfg.autoScene) return;
    const pick = inNightWindow() ? cfg.nightScene : cfg.dayScene;
    const name = SCENE_NAMES.includes(pick) ? pick : '无';
    if (name === lastAutoScene) return;
    lastAutoScene = name;
    // 下拉虽被置灰，也要显示「此刻生效的是哪个场景」，否则用户不知道自动切到了哪一档。
    sceneSel.value = name;
    window.dispatchEvent(new CustomEvent('bao:scene', { detail: { scene: name } }));
    updateSwatch('scene-swatch', SCENE_COLORS[name]);
  };
  const autoSceneTime = (v, fallback) => (/^\d{1,2}:\d{2}$/.test(String(v || '')) ? v : fallback);
  const refreshAutoSceneUI = () => {
    autoSceneOpts.hidden = !cfg.autoScene;
    sceneSel.disabled = !!cfg.autoScene;
    daySceneSel.value = SCENE_NAMES.includes(cfg.dayScene) ? cfg.dayScene : '无';
    nightSceneSel.value = SCENE_NAMES.includes(cfg.nightScene) ? cfg.nightScene : '星空';
    nightStartInput.value = autoSceneTime(cfg.nightStart, '20:00');
    nightEndInput.value = autoSceneTime(cfg.nightEnd, '07:00');
  };
  const saveAutoScene = () => {
    if (inElectron) saveConfig({
      autoScene: cfg.autoScene, dayScene: cfg.dayScene, nightScene: cfg.nightScene,
      nightStart: cfg.nightStart, nightEnd: cfg.nightEnd,
    });
    refreshAutoSceneUI();
    lastAutoScene = '';
    applyAutoScene();
  };
  autoSceneInput.addEventListener('change', (e) => {
    cfg.autoScene = e.target.checked;
    saveAutoScene();
    if (!cfg.autoScene) {
      // 退回手动模式：把场景还原成用户之前选的，别停在自动切到的那一档。
      window.dispatchEvent(new CustomEvent('bao:scene', { detail: { scene: sceneSel.value } }));
      updateSwatch('scene-swatch', SCENE_COLORS[sceneSel.value]);
    }
  });
  daySceneSel.addEventListener('change', (e) => { cfg.dayScene = e.target.value; saveAutoScene(); });
  nightSceneSel.addEventListener('change', (e) => { cfg.nightScene = e.target.value; saveAutoScene(); });
  nightStartInput.addEventListener('change', (e) => { cfg.nightStart = e.target.value; saveAutoScene(); });
  nightEndInput.addEventListener('change', (e) => { cfg.nightEnd = e.target.value; saveAutoScene(); });
  refreshAutoSceneUI();
  // 每分钟看一次：跨过夜晚时段边界时自动切场景。
  setInterval(() => { applyAutoScene(); }, 60_000);

  // 动效强度（省电/标准/华丽）。
  const MOTION_NAMES = ['省电', '标准', '华丽'];
  const motionSel = document.getElementById('m-motion');
  for (const n of MOTION_NAMES) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n; motionSel.appendChild(o);
  }
  motionSel.addEventListener('change', (e) => {
    window.dispatchEvent(new CustomEvent('bao:motion', { detail: { motion: e.target.value } }));
    if (inElectron) saveConfig({ motion: e.target.value });
  });
  // 点一下机器人时的反应：戳一下 / 挥挥手 / 不反应。三连击彩蛋不受影响。
  const clickActionSel = document.getElementById('m-clickaction');
  clickActionSel.addEventListener('change', (e) => {
    cfg.clickAction = ['poke', 'greet', 'none'].includes(e.target.value) ? e.target.value : 'poke';
    if (inElectron) saveConfig({ clickAction: cfg.clickAction });
  });
  // 双击的反应：打招呼是这里唯一「纯粹为人」的动作，但不是每个人都想在工作时
  // 被一只小机器人挥手。
  const dblClickSel = document.getElementById('m-dblclick');
  dblClickSel.addEventListener('change', (e) => {
    cfg.doubleClick = e.target.value === 'none' ? 'none' : 'greet';
    if (inElectron) saveConfig({ doubleClick: cfg.doubleClick });
  });

  // 待机动作开关 + 频率。
  const idleSel = document.getElementById('m-idle');
  const idlefreqSel = document.getElementById('m-idlefreq');
  for (const n of ['慢', '标准', '快']) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n; idlefreqSel.appendChild(o);
  }
  const IDLE_FREQ = { 慢: 0.5, 标准: 1, 快: 2 };
  function pushIdle() {
    window.dispatchEvent(new CustomEvent('bao:idle', {
      detail: { on: idleSel.checked, freq: IDLE_FREQ[idlefreqSel.value] || 1 },
    }));
  }
  idleSel.addEventListener('change', (e) => {
    cfg.idleActions = e.target.checked;
    pushIdle();
    if (inElectron) saveConfig({ idleActions: cfg.idleActions });
  });
  idlefreqSel.addEventListener('change', (e) => {
    cfg.idleFreq = e.target.value;
    pushIdle();
    if (inElectron) saveConfig({ idleFreq: cfg.idleFreq });
  });

  // 光环样式（环形/圆形/星形/无）。
  const HALO_NAMES = ['环形', '圆形', '星形', '无'];
  const haloSel = document.getElementById('m-halo');
  for (const n of HALO_NAMES) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n; haloSel.appendChild(o);
  }
  haloSel.addEventListener('change', (e) => {
    window.dispatchEvent(new CustomEvent('bao:halo', { detail: { halo: e.target.value } }));
    if (inElectron) saveConfig({ halo: e.target.value });
  });

  // 设置搜索：菜单里已经五十多个控件、十个分组，记得住名字但记不住位置。
  // 只改可见性 —— 没命中的行收起，整组没命中就收起整组；清空后恢复过滤前的
  // 展开状态，别把用户手动展开的分组弄乱。
  let groupsWereOpen = null;
  function applyFind() {
    const q = findInput.value.trim().toLowerCase();
    menu.classList.toggle('searching', !!q);
    const groups = [...menu.querySelectorAll('details.group')];
    if (q && !groupsWereOpen) groupsWereOpen = new Map(groups.map((g) => [g, g.open]));
    if (!q && groupsWereOpen) {
      for (const [g, was] of groupsWereOpen) g.open = was;
      groupsWereOpen = null;
    }
    // 一行可搜的文字：可见文本 + 输入框的占位符/无障碍标签（改名输入框的
    // value 不是文本，只靠 textContent 会让「软件」这一组永远搜不到）。
    const rowText = (row) => {
      let t = row.textContent;
      for (const el of row.querySelectorAll('input, select')) {
        t += ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.placeholder || '');
      }
      return t.toLowerCase();
    };
    let hits = 0;
    for (const g of groups) {
      // 分组名或组内小标题命中时，整组都算命中：「名称」「顺序」「外观」这类
      // 词本来就是在指一个区块，而不是某一行。
      const groupText = `${g.querySelector('summary')?.textContent || ''} ${
        [...g.querySelectorAll(':scope > .title')].map((t) => t.textContent).join(' ')}`.toLowerCase();
      const groupMatch = !!q && groupText.includes(q);
      let inGroup = 0;
      for (const row of g.querySelectorAll('.row')) {
        const match = !q || groupMatch || rowText(row).includes(q);
        // 用 `.no-find` 而不是 `hidden`：后者是「是不是自定义配色」的地盘，
        // 搜索清空时把取色器行一起放出来，它就会永远露在设置里。
        row.classList.toggle('no-find', !!q && !match);
        if (match) inGroup += 1;
      }
      g.hidden = !!q && inGroup === 0;
      if (q && inGroup) g.open = true;
      hits += inGroup;
    }
    // 分组之外的散行。现在菜单里已经没有这种行（每日目标已经归进「基础」），
    // 但保留这条兜底：分组是手写的 HTML，下一次加控件时漏写一层 wrapper，
    // 它至少还能被搜到，而不是永远显示在那里。
    for (const row of menu.querySelectorAll(':scope > .row')) {
      const match = !q || rowText(row).includes(q);
      row.classList.toggle('no-find', !!q && !match);
      if (match) hits += 1;
    }
    findEmpty.hidden = !q || hits > 0;
  }
  findInput.addEventListener('input', applyFind);
  findInput.addEventListener('keydown', (e) => {
    // Esc 在搜索框里先清空过滤；空的时候让给全局的「关菜单」。
    if (e.key === 'Escape' && findInput.value) {
      e.stopPropagation();
      findInput.value = '';
      applyFind();
    }
  });

  // 软件顺序：动态生成排序行，↑/↓ 调整软件在灯环/列表里的前后顺序。
  function renderOrderUI(focusAgent, focusDir) {
    const box = document.getElementById('m-order');
    box.innerHTML = '';
    agentOrder.forEach((agent, idx) => {
      const row = document.createElement('div');
      row.className = 'row';
      // 改名时要就地更新这一行的名字（见 renderAliasUI 的 commit），不整块重建。
      row.dataset.agent = agent;
      const label = document.createElement('span');
      label.textContent = displayName(agent);
      row.appendChild(label);
      const up = document.createElement('button');
      up.textContent = '↑'; up.disabled = idx === 0; up.onclick = () => moveAgent(agent, -1);
      row.appendChild(up);
      const down = document.createElement('button');
      down.textContent = '↓'; down.disabled = idx === agentOrder.length - 1; down.onclick = () => moveAgent(agent, 1);
      row.appendChild(down);
      box.appendChild(row);
      if (agent === focusAgent) {
        // 整块重建会连焦点一起扔掉：键盘用户每按一次 ↑ 就得重新 Tab 回来。
        // 把焦点还给刚操作的那一行（到顶/到底时那个按钮 disabled，就退到另一个）。
        const target = focusDir < 0 ? up : down;
        const other = focusDir < 0 ? down : up;
        requestAnimationFrame(() => (target.disabled ? other : target).focus({ preventScroll: true }));
      }
    });
    // 两个块共用同一份 agentOrder（服务端新增软件时两边一起长出来）。
    renderAliasUI();
  }
  // 软件改名：一个软件一个输入框，占位符是内置名，留空即恢复默认。
  // 只改显示名（列表/铭牌/通知/广告牌都走 displayName），服务端上报的 agent
  // 键不变 —— 改名不该影响任何状态匹配。
  function renderAliasUI() {
    const box = document.getElementById('m-alias');
    if (!box) return;
    box.innerHTML = '';
    for (const agent of agentOrder) {
      const builtin = LABEL[agent] || agent;
      const row = document.createElement('div');
      row.className = 'row';
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 10;
      input.placeholder = builtin;
      input.value = (cfg.aliases && cfg.aliases[agent]) || '';
      input.setAttribute('aria-label', `给「${builtin}」改名`);
      let applied = input.value;
      const commit = () => {
        const v = input.value.trim().slice(0, 10);
        if (v !== input.value) input.value = v;
        if (v === applied) return;
        applied = v;
        const aliases = { ...(cfg.aliases || {}) };
        // 改回内置名就等于没改名：删掉键，别在配置里留一条同名的无效项。
        if (v && v !== builtin) aliases[agent] = v; else delete aliases[agent];
        cfg.aliases = aliases;
        if (inElectron) saveConfig({ aliases });
        // 顺序列表里那一行的名字就地改掉：整块重建会把焦点从这个输入框上抢走。
        for (const orderRow of document.querySelectorAll('#m-order .row')) {
          if (orderRow.dataset.agent === agent) {
            orderRow.querySelector('span').textContent = displayName(agent);
            break;
          }
        }
        // 立刻把新名字推到列表/铭牌：改名最怕「设置里变了、桌面上没变」。
        if (lastSnap) render(lastSnap);
      };
      input.addEventListener('input', commit);
      input.addEventListener('change', commit);
      row.appendChild(input);
      // 通知开关：只关这个软件的系统通知，灯/列表/铭牌照旧。
      const bell = document.createElement('input');
      bell.type = 'checkbox';
      bell.className = 'notify-toggle';
      bell.checked = !isAgentMuted(agent);
      bell.title = `接收「${builtin}」的系统通知`;
      bell.setAttribute('aria-label', `接收「${builtin}」的系统通知`);
      bell.addEventListener('change', () => {
        const next = new Set(cfg.mutedAgents || []);
        if (bell.checked) next.delete(agent); else next.add(agent);
        cfg.mutedAgents = [...next];
        row.classList.toggle('muted', !bell.checked);
        if (inElectron) saveConfig({ mutedAgents: cfg.mutedAgents });
        // 列表的 tooltip/无障碍标签会说明「通知已关闭」，改完立刻刷新。
        if (lastSnap) render(lastSnap);
      });
      row.classList.toggle('muted', !bell.checked);
      row.appendChild(bell);
      box.appendChild(row);
    }
    // 重建出来的行默认是可见的：正在搜索时要把它们也过一遍过滤。
    applyFind();
  }
  function moveAgent(agent, dir) {
    const idx = agentOrder.indexOf(agent);
    const j = idx + dir;
    if (j < 0 || j >= agentOrder.length) return;
    [agentOrder[idx], agentOrder[j]] = [agentOrder[j], agentOrder[idx]];
    AGENT_RANK = Object.fromEntries(agentOrder.map((a, i) => [a, i]));
    // 人排过之后，服务端下发的顺序不再覆盖它。
    customOrder = true;
    if (inElectron) saveConfig({ agentOrder });
    renderOrderUI(agent, dir);
    if (lastSnap) render(lastSnap);
  }
  // 先按内置顺序画一次：浏览器模式没有 getConfig（设置面板不初始化），
  // 不在这里画的话「软件顺序/软件名称」会是一块空白，而这些控件本身是可用的。
  // Electron 里 config 读回来后会再画一次。
  renderOrderUI();

  // 状态手势：五个状态各配一种手势（动作系统核心）。
  const POSE_NAMES = ['环抱', '举手', '泵动', '摊开', '垂放', '叉腰', '鼓掌', '托下巴', '握拳'];
  const POSE_STATE_KEYS = ['error', 'waiting', 'busy', 'done', 'idle'];
  const poseSels = {};
  for (const st of POSE_STATE_KEYS) {
    const sel = document.getElementById('m-pose-' + st);
    poseSels[st] = sel;
    for (const n of POSE_NAMES) {
      const o = document.createElement('option');
      o.value = n; o.textContent = n; sel.appendChild(o);
    }
    sel.addEventListener('change', (e) => {
      const pose = e.target.value;
      window.dispatchEvent(new CustomEvent('bao:pose', { detail: { state: st, pose } }));
      const patch = { poses: { ...(cfg.poses || {}) , [st]: pose } };
      cfg.poses = patch.poses;
      if (inElectron) saveConfig({ poses: patch.poses });
    });
  }

  // ---- the quick size bar itself
  sRange.addEventListener('input', (e) => {
    applyScale(Number(e.target.value) / 100, { persist: false, anchor: 'bottom' });
  });
  sRange.addEventListener('change', () => {
    if (inElectron) saveConfig({ scale });
  });
  document.getElementById('s-down').onclick = () => applyScale(scale - 0.05, { persist: true, anchor: 'bottom' });
  document.getElementById('s-up').onclick = () => applyScale(scale + 0.05, { persist: true, anchor: 'bottom' });
  document.getElementById('s-reset').onclick = () => applyScale(1, { persist: true, anchor: 'bottom' });
  document.getElementById('s-val').onclick = () => applyScale(1, { persist: true, anchor: 'bottom' });
  document.getElementById('s-gear').onclick = () => { setSizer(false); setMenu(true); };
  document.getElementById('m-sound').addEventListener('change', (e) => {
    cfg.sound = e.target.checked;
    lastCue = 0;
    // Written immediately, so the next start reads the same value. A setting
    // that silently resets on restart is worse than having no setting.
    if (inElectron) saveConfig({ sound: cfg.sound });
    // 打开开关只是「试个音」，不能顺手报一次「需要你处理」—— 用户什么也没做，
    // 机器人却说有人在等他，这正是这个工具最不该撒的谎。用中性的上扬音。
    if (cfg.sound) { cue('busy'); flashNote('提示音已开启'); }
  });
  document.getElementById('m-voice').addEventListener('change', (e) => {
    cfg.voice = e.target.checked;
    if (inElectron) saveConfig({ voice: cfg.voice });
    if (cfg.voice) { lastAnnounced = ''; say('语音播报已开启'); }
  });

  // 静音：开会/专注时一键暂停通知、提示音、语音；再点一次立即恢复。
  // 时长可选 30 分钟 / 1 小时 / 2 小时 —— 开半小时的会和出两小时的门不一样。
  const MUTE_CHOICES = { 30: '30 分钟', 60: '1 小时', 120: '2 小时' };
  const muteBtn = document.getElementById('m-mute');
  const muteDurSel = document.getElementById('m-mutedur');
  let muteResetTimer = null;
  const muteMinutes = () => (MUTE_CHOICES[Number(cfg.muteMinutes)] ? Number(cfg.muteMinutes) : 60);
  function refreshMuteButton() {
    const on = isMuted();
    muteBtn.textContent = on ? '已静音 · 点击恢复' : `静音 ${MUTE_CHOICES[muteMinutes()]}（暂停通知与声音）`;
    // 静音中把按钮按「危险/已触发」的样子标出来，而不是一直同一副面孔。
    muteBtn.classList.toggle('danger', on);
    muteBtn.style.opacity = on ? '0.7' : '';
    clearTimeout(muteResetTimer);
    if (on) {
      muteResetTimer = setTimeout(refreshMuteButton, Math.max(0, mutedUntil - Date.now()) + 500);
    }
  }
  muteDurSel.addEventListener('change', (e) => {
    cfg.muteMinutes = MUTE_CHOICES[Number(e.target.value)] ? Number(e.target.value) : 60;
    if (inElectron) saveConfig({ muteMinutes: cfg.muteMinutes });
    refreshMuteButton();
  });
  muteBtn.addEventListener('click', () => {
    if (isMuted()) {
      mutedUntil = 0;
    } else {
      mutedUntil = Date.now() + muteMinutes() * 60 * 1000;
    }
    if (inElectron) saveConfig({ mutedUntil });
    refreshMuteButton();
  });


  // 提示音风格（清脆叮咚 / 低沉机械 / 电子脉冲）。
  const soundstyleSel = document.getElementById('m-soundstyle');
  for (const n of Object.keys(SOUND_STYLES)) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n; soundstyleSel.appendChild(o);
  }
  soundstyleSel.addEventListener('change', (e) => {
    cfg.soundStyle = e.target.value;
    if (inElectron) saveConfig({ soundStyle: e.target.value });
    // 试听一次新音色，但用中性的上扬音：换成「需要你」的音等于凭空报一次警，
    // 还会占掉 2.5 秒的告警限流，把紧随其后的真实等待吞掉（和上面的开关同理）。
    if (cfg.sound) { lastCue = 0; cue('busy'); }
  });

  // 提示音音量：config.soundVolume 一直是 cue() 真正读取的值，却从来没有入口。
  // 0.22 在安静的桌前刚好，在放着音乐的桌上等于没有 —— 而用户无从调整。
  const soundvolInput = document.getElementById('m-soundvol');
  const soundvolOut = document.getElementById('m-soundvol-val');
  const soundVolPct = (v) => Math.round(Math.max(0.05, Math.min(0.6, Number(v) || 0.22)) * 100);
  soundvolInput.addEventListener('input', (e) => {
    const pct = Math.max(5, Math.min(60, Number(e.target.value) || 22));
    cfg.soundVolume = pct / 100;
    soundvolOut.textContent = pct + '%';
  });
  soundvolInput.addEventListener('change', () => {
    if (inElectron) saveConfig({ soundVolume: cfg.soundVolume });
    // 松手试听一次：音量是唯一「看不见、只能听」的设置，不试听等于没调。
    if (cfg.sound) { lastCue = 0; cue('busy'); }
  });
  // 完成音：完成不是「需要你」，有人只想要灯、不想听声。打开时试听一下完成音，
  // 否则用户根本不知道这一项关掉的是什么。
  const soundDoneInput = document.getElementById('m-sounddone');
  soundDoneInput.addEventListener('change', (e) => {
    cfg.soundDone = e.target.checked;
    if (inElectron) saveConfig({ soundDone: cfg.soundDone });
    if (cfg.sound && cfg.soundDone) { lastCue = 0; cue('done'); }
  });
  // 「完成」通知与「完成」音是两回事：有人要灯要声、不要通知，有人反过来。
  const notifyDoneInput = document.getElementById('m-notifydone');
  notifyDoneInput.addEventListener('change', (e) => {
    cfg.notifyDone = e.target.checked;
    if (inElectron) saveConfig({ notifyDone: cfg.notifyDone });
  });
  document.getElementById('m-click').addEventListener('change', (e) => {
    // 内存里的 cfg 也要跟着走：只写盘的控件会让「导出配置」导出一份旧值。
    cfg.clickThrough = e.target.checked;
    if (inElectron) saveConfig({ clickThrough: cfg.clickThrough });
  });

  // 全局快捷键开关：主进程收到 hotkeyOn 会立刻重新注册/注销，无需重启窗口。
  const hotkeyInput = document.getElementById('m-hotkey');
  hotkeyInput.addEventListener('change', (e) => {
    cfg.hotkeyOn = e.target.checked;
    if (inElectron) saveConfig({ hotkeyOn: cfg.hotkeyOn });
  });

  // 开机自启：真正的安装由 server（node 进程）完成，主进程只代发一条带 token
  // 的本地请求 —— 在 Electron 里装会把启动项写成 Electron 可执行文件。
  // 它是机器状态而不是配置，所以不进 config / 导出文件。
  const autostartInput = document.getElementById('m-autostart');
  function refreshAutostart() {
    if (!inElectron || !bridge.getAutostart) return;
    bridge.getAutostart().then((st) => {
      if (st && !st.error) autostartInput.checked = !!st.enabled;
    }).catch(() => { /* 服务没起来：保持原样 */ });
  }
  if (!inElectron || !bridge.getAutostart) {
    autostartInput.disabled = true;
    autostartInput.title = '只在桌面版可用';
  } else {
    refreshAutostart();
    autostartInput.addEventListener('change', async () => {
      const want = autostartInput.checked;
      autostartInput.disabled = true;
      try {
        const st = await bridge.setAutostart(want);
        if (!st || st.error) throw new Error(st && st.error);
        autostartInput.checked = !!st.enabled;
        flashNote(st.enabled ? '已开启开机自启' : '已关闭开机自启');
      } catch {
        autostartInput.checked = !want;   // 安装失败就把勾回去，别骗人
        flashNote('开机自启设置失败');
      } finally {
        autostartInput.disabled = false;
      }
    });
  }
  document.getElementById('m-labels').addEventListener('change', (e) => {
    cfg.showLabels = e.target.checked;
    if (inElectron) saveConfig({ showLabels: cfg.showLabels });
    if (lastSnap) render(lastSnap);
  });

  // 软件列表的显示细项：未运行软件是否占一行、是否显示模型/供应商、最多几行。
  document.getElementById('m-offline').addEventListener('change', (e) => {
    cfg.showOffline = e.target.checked;
    if (inElectron) saveConfig({ showOffline: cfg.showOffline });
    if (lastSnap) render(lastSnap);
  });
  document.getElementById('m-model').addEventListener('change', (e) => {
    cfg.showModel = e.target.checked;
    if (inElectron) saveConfig({ showModel: cfg.showModel });
    if (lastSnap) render(lastSnap);
  });
  const maxrowsSel = document.getElementById('m-maxrows');
  for (let n = 2; n <= 8; n++) {
    const o = document.createElement('option');
    o.value = String(n);
    o.textContent = n + ' 行';
    maxrowsSel.appendChild(o);
  }
  maxrowsSel.value = '4';
  maxrowsSel.addEventListener('change', (e) => {
    cfg.maxRows = Number(e.target.value);
    if (inElectron) saveConfig({ maxRows: cfg.maxRows });
    if (lastSnap) render(lastSnap);
  });

  // 每日目标（0 = 关闭）：只影响「今日战绩」里的进度条和达成提醒，不参与任何
  // 状态判断 —— 达成了也不会把灯变绿，绿只代表「正在运行」。
  const goalSel = document.getElementById('m-goal');
  goalSel.addEventListener('change', (e) => {
    cfg.dailyGoalHours = Number(e.target.value) || 0;
    if (inElectron) saveConfig({ dailyGoalHours: cfg.dailyGoalHours });
    if (lastSnap) render(lastSnap);
  });

  // ---- 本机资源面板 ------------------------------------------------------
  // 和代理状态无关：每 2 秒单独取一次 /sys。混进 SSE 快照会让「CPU 占用」
  // 变成「代理状态变化」的副产品 —— 忙碌时每秒好几帧，闲置时一动不动。
  const fmtGB = (bytes) => `${(Number(bytes || 0) / 1073741824).toFixed(1)}G`;
  function renderSys(data) {
    const on = cfg.showSys !== false && !!data;
    const was = sysEl.hidden;
    sysEl.hidden = !on;
    if (!on) {
      if (was !== sysEl.hidden) fit();
      return;
    }
    const cpu = Math.max(0, Math.min(100, Math.round(data.cpu || 0)));
    const mem = data.mem || {};
    const mp = Math.max(0, Math.min(100, Math.round(mem.percent || 0)));
    sysCpu.textContent = `${cpu}%`;
    sysMem.textContent = `${mp}%`;
    sysCpuBar.style.width = `${cpu}%`;
    sysMemBar.style.width = `${mp}%`;
    const memTitle = `已用 ${fmtGB(mem.used)} / 共 ${fmtGB(mem.total)}`;
    sysMem.title = memTitle;
    sysMem.parentElement.title = memTitle;
    if (was !== sysEl.hidden) fit();
  }
  async function pollSys() {
    if (cfg.showSys === false || document.hidden) return;
    try {
      const base = inElectron ? bridge.serverUrl : location.origin;
      const r = await fetch(`${base}/sys`, { cache: 'no-store' });
      if (r.ok) renderSys(await r.json());
    } catch { /* 读不到就保留上一次读数，不把面板清空 */ }
  }
  setInterval(pollSys, 2000);
  pollSys();
  document.getElementById('m-sys').addEventListener('change', (e) => {
    cfg.showSys = e.target.checked;
    if (inElectron) saveConfig({ showSys: cfg.showSys });
    if (cfg.showSys) pollSys(); else renderSys(null);
  });

  // 菜单底部两块面板的可见性：纯显示开关。不关心战绩/动态的用户收起它们，
  // 菜单短一截；对状态、灯、通知没有任何影响。
  const panelScore = document.getElementById('panel-score');
  const panelRecent = document.getElementById('panel-recent');
  const scorePanelInput = document.getElementById('m-score-panel');
  const recentPanelInput = document.getElementById('m-recent-panel');
  scorePanelInput.addEventListener('change', (e) => {
    cfg.showScore = e.target.checked;
    panelScore.hidden = !e.target.checked;
    if (inElectron) saveConfig({ showScore: cfg.showScore });
    fit();
  });
  recentPanelInput.addEventListener('change', (e) => {
    cfg.showRecent = e.target.checked;
    panelRecent.hidden = !e.target.checked;
    if (inElectron) saveConfig({ showRecent: cfg.showRecent });
    fit();
  });
  // 定时勿扰：开关与两个时间都立即生效并落盘。改时间后立刻重算一次边界。
  document.getElementById('m-dnd').addEventListener('change', (e) => {
    cfg.doNotDisturb = e.target.checked;
    if (inElectron) saveConfig({ doNotDisturb: cfg.doNotDisturb });
    applyDnd();
  });
  document.getElementById('m-dnd-start').addEventListener('change', (e) => {
    cfg.dndStart = e.target.value || '22:00';
    if (inElectron) saveConfig({ dndStart: cfg.dndStart });
    applyDnd();
  });
  document.getElementById('m-dnd-end').addEventListener('change', (e) => {
    cfg.dndEnd = e.target.value || '08:00';
    if (inElectron) saveConfig({ dndEnd: cfg.dndEnd });
    applyDnd();
  });

  // 一键重置外观：只恢复外观与动作，不碰尺寸、位置、声音和系统开关。
  const LOOK_DEFAULTS = {
    skin: '做旧黄', eyestyle: '默认黑', eyeshape: '圆', trackstyle: '黑', tracktype: '圆角矩形',
    armskin: '枪灰', claw: '铲形', armtype: '双板', headtype: '双筒', scene: '无',
    motion: '标准', halo: '环形', body: '标准', baseEffect: '状态色', brightness: 1,
    decoration: '无', wear: 1, finish: '标准',
    poses: { error: '环抱', waiting: '举手', busy: '泵动', done: '摊开', idle: '垂放' },
  };
  // 把一套外观即时套用到界面（不整页刷新）：逐个设置控件值并触发 change，
  // 复用各控件原有的 change 监听（派发 bao:* 事件 + 保存 + 色块/主题联动）。
  function applyLook(look) {
    if (inElectron) saveConfig(look);
    Object.assign(cfg, look);
    // 自定义颜色要先于对应下拉的 change 就位：change 会立刻按取色器上色。
    for (const p of PARTS) {
      const v = normHex(look[p.configKey]);
      if (v) p.input.value = v;
    }
    const sets = {
      skin: skinSel, eyestyle: eyestyleSel, eyeshape: eyeshapeSel, trackstyle: trackstyleSel,
      tracktype: tracktypeSel, armskin: armskinSel, claw: clawSel, armtype: armtypeSel,
      headtype: headtypeSel, scene: sceneSel, motion: motionSel, halo: haloSel, body: bodySel,
      baseEffect: effectSel, decoration: decorationSel, finish: finishSel,
    };
    for (const [k, sel] of Object.entries(sets)) {
      if (look[k] != null && [...sel.options].some((o) => o.value === String(look[k]))) {
        sel.value = String(look[k]);
        sel.dispatchEvent(new Event('change'));
      }
    }
    for (const st of POSE_STATE_KEYS) {
      const p = look.poses && look.poses[st];
      if (p && poseSels[st]) { poseSels[st].value = p; poseSels[st].dispatchEvent(new Event('change')); }
    }
    if (typeof look.brightness === 'number') {
      const v = Math.round(Math.max(0.5, Math.min(1, look.brightness)) * 100);
      document.getElementById('m-brightness').value = String(v);
      document.getElementById('m-brightness-val').textContent = v + '%';
      window.dispatchEvent(new CustomEvent('bao:brightness', { detail: { brightness: v / 100 } }));
    }
    // 做旧程度是滑杆而不是下拉，和亮度一样单独处理：先落到界面，再派发。
    if (typeof look.wear === 'number') {
      const v = Math.round(Math.max(0, Math.min(1.5, look.wear)) * 100);
      wearInput.value = String(v);
      pushWear();
    }
  }

  document.getElementById('m-reset-look').onclick = () => applyLook(LOOK_DEFAULTS);

  // 随机换装：一键随机一套外观（含动作手势），即时生效。
  document.getElementById('m-random-look').onclick = () => {
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    applyLook({
      skin: pick(SKIN_NAMES), eyestyle: pick(EYESTYLE_NAMES), eyeshape: pick(EYESHAPE_NAMES),
      trackstyle: pick(TRACKSTYLE_NAMES), tracktype: pick(TRACKTYPE_NAMES),
      armskin: pick(ARMSKIN_NAMES), claw: pick(CLAW_NAMES), armtype: pick(ARMTYPE_NAMES),
      headtype: pick(HEADTYPE_NAMES), scene: pick(SCENE_NAMES), motion: pick(MOTION_NAMES),
      halo: pick(HALO_NAMES), body: pick(BODY_NAMES), baseEffect: pick(EFFECT_NAMES),
      decoration: pick(DECORATION_NAMES),
    });
  };

  // 外观方案：把当前外观存成一套命名方案，之后一键切换。
  const presetList = document.getElementById('m-preset-list');
  const presetName = document.getElementById('m-preset-name');
  const LOOK_KEYS = ['skin', 'eyestyle', 'eyeshape', 'trackstyle', 'tracktype', 'armskin',
    'claw', 'armtype', 'headtype', 'scene', 'motion', 'halo', 'body', 'baseEffect', 'brightness',
    'decoration', 'finish'];
  function currentLook() {
    const poses = {};
    for (const st of POSE_STATE_KEYS) poses[st] = poseSels[st].value;
    const brightness = Math.max(0.5, Math.min(1, Number(document.getElementById('m-brightness').value) / 100));
    const look = { poses, brightness, wear: wearValue() };
    const dom = {
      skin: skinSel, eyestyle: eyestyleSel, eyeshape: eyeshapeSel, trackstyle: trackstyleSel,
      tracktype: tracktypeSel, armskin: armskinSel, claw: clawSel, armtype: armtypeSel,
      headtype: headtypeSel, scene: sceneSel, motion: motionSel, halo: haloSel, body: bodySel,
      baseEffect: effectSel, decoration: decorationSel, finish: finishSel,
    };
    for (const k of LOOK_KEYS) if (dom[k]) look[k] = dom[k].value;
    // 方案也要记住自定义颜色本身，否则存下「自定义」却存不下「是什么颜色」。
    for (const p of PARTS) if (p.sel.value === CUSTOM) look[p.configKey] = p.hex();
    return look;
  }
  // 把「只在界面上」的值同步回内存里的 cfg。
  // 尺寸、亮度、铭牌、点击穿透、待机动作、广告牌、软件顺序这些控件的 handler
  // 只写盘、不回写 cfg，于是「导出配置」导出的是**启动时**的旧值 —— 用户改过的
  // 设置导入回来会静默消失，而这正是导出功能存在的意义。
  function syncCfg() {
    // 外观类下拉的 handler 只写盘、不回写 cfg（见上方注释）。整组从界面读回来，
    // 否则「本次运行改成 Q 版 / 换了皮肤」后点导出，文件里还是启动时的旧值。
    Object.assign(cfg, currentLook());
    cfg.scale = scale;
    cfg.nameplate = nameplateInput.value;
    // 台词从界面读回来（空串 = 用内置），否则导出的是启动时的那几句。
    cfg.phrases = {};
    for (const st of PHRASE_STATES) {
      const v = document.getElementById('m-phrase-' + st).value;
      cfg.phrases[st] = String(v || '').replace(/\s+/g, ' ').trim().slice(0, PHRASE_MAX);
    }
    cfg.clickThrough = document.getElementById('m-click').checked;
    cfg.hotkeyOn = document.getElementById('m-hotkey').checked;
    cfg.idleActions = idleSel.checked;
    cfg.idleFreq = idlefreqSel.value;
    cfg.signMode = SIGN_MODES[signSel.value] || cfg.signMode;
    cfg.signPos = SIGN_POS[signPosSel.value] || cfg.signPos;
    cfg.signColor = signColorValue();
    // 只有取色器真的在用时才更新「上次挑的色」。否则导出会把当前生效的调色板
    // 颜色写进 customSign，用户的自定义色就再也回不来了。
    if (signColorSel.value === CUSTOM) cfg.customSign = normHex(signCustomInput.value) || cfg.customSign;
    cfg.signShape = SIGN_SHAPES[signShapeSel.value] || cfg.signShape;
    // 取色器里的颜色即使当前没选「自定义」也要记住：用户切回自定义时应当
    // 看到自己上次调的那个色，而不是出厂色。
    for (const p of PARTS) cfg[p.configKey] = p.hex();
    cfg.dailyGoalHours = Number(goalSel.value) || 0;
    cfg.clickAction = clickActionSel.value || 'poke';
    cfg.doubleClick = dblClickSel.value === 'none' ? 'none' : 'greet';
    cfg.soundDone = soundDoneInput.checked;
    cfg.notifyDone = notifyDoneInput.checked;
    cfg.muteMinutes = muteMinutes();
    cfg.showSys = document.getElementById('m-sys').checked;
    cfg.showScore = scorePanelInput.checked;
    cfg.showRecent = recentPanelInput.checked;
    cfg.doNotDisturb = document.getElementById('m-dnd').checked;
    cfg.dndStart = document.getElementById('m-dnd-start').value || cfg.dndStart;
    cfg.dndEnd = document.getElementById('m-dnd-end').value || cfg.dndEnd;
    cfg.agentOrder = [...agentOrder];
    cfg.personality = cfg.personality || document.body.dataset.personality;
    return cfg;
  }

  function renderPresetList(keep = presetList.value) {
    presetList.innerHTML = '';
    for (const name of Object.keys(cfg.presets || {})) {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      presetList.appendChild(o);
    }
    // 重建后把选中项还回去。否则列表会跳回第一项，连点两次「删除」删掉的是
    // 另一个方案 —— 而屏幕上那个名字已经换了，用户很难把两件事对上。
    if (keep && Object.prototype.hasOwnProperty.call(cfg.presets || {}, keep)) presetList.value = keep;
  }
  document.getElementById('m-preset-save').onclick = () => {
    const name = presetName.value.trim().slice(0, 12);
    if (!name) return;
    const existed = Object.prototype.hasOwnProperty.call(cfg.presets || {}, name);
    cfg.presets = { ...(cfg.presets || {}), [name]: currentLook() };
    if (inElectron) saveConfig({ presets: cfg.presets });
    renderPresetList();
    presetList.value = name;
    presetName.value = '';
    // 同名直接覆盖是这里唯一的行为，但必须说出来：否则用户以为「又存了一套」，
    // 而旧方案已经没了、并且已落盘 —— 没有任何可撤销的地方。
    flashNote(existed ? `已覆盖方案「${name}」` : `已保存方案「${name}」`);
  };
  document.getElementById('m-preset-apply').onclick = () => {
    const look = (cfg.presets || {})[presetList.value];
    if (!look) return;
    applyLook(look);
  };
  document.getElementById('m-preset-del').onclick = () => {
    const name = presetList.value;
    if (!name) return;
    const presets = { ...(cfg.presets || {}) };
    delete presets[name];
    cfg.presets = presets;
    if (inElectron) saveConfig({ presets });
    // 删掉的那一项已经不在了，这里传空让浏览器落到剩下的第一项（合理）。
    renderPresetList('');
  };

  // 键盘出口：工具栏和尺寸条都依赖指针，键盘用户至少要有办法打开设置、
  // 关掉浮层。Esc 关菜单/尺寸条，Ctrl/⌘+, 开设置（和大多数应用的偏好设置一致）。
  window.addEventListener('keydown', (e) => {
    // 焦点在文本框/下拉里时，这些是「打字」不是「快捷键」。以前没这层判断：
    // 在铭牌或台词框里按 Esc，会把整块设置连同刚输入还没提交的文字一起关掉；
    // 按其它组合键也会顺手把机器人放大缩小。
    const inField = e.target instanceof Element && e.target.closest('input, textarea, select');
    if (e.key === 'Escape') {
      if (inField) { e.preventDefault(); e.target.blur(); return; }
      if (menuOpen) { e.preventDefault(); setMenu(false); }
      else if (sizerOpen) { e.preventDefault(); setSizer(false); }
      return;
    }
    if (inField) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === ',' || e.key === '，')) {
      e.preventDefault();
      setSizer(false);
      setMenu(!menuOpen);
      return;
    }
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); applyScale(scale + 0.1, { persist: true }); }
    // Shift 按着时 '-' 的 e.key 是 '_'：只认 '-' 的话，界面上写着的那条快捷键
    // （Ctrl/⌘+Shift+-）按下去什么都不会发生。
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); applyScale(scale - 0.1, { persist: true }); }
    else if (e.key === '0') { e.preventDefault(); applyScale(1, { persist: true }); }
  });

  // 铭牌文字：留空显示软件名，输入则显示自定义文字（实时预览，失焦保存）。
  const nameplateInput = document.getElementById('m-nameplate');
  nameplateInput.addEventListener('input', (e) => {
    window.dispatchEvent(new CustomEvent('bao:nameplate', { detail: { text: e.target.value } }));
  });
  nameplateInput.addEventListener('change', (e) => {
    if (inElectron) saveConfig({ nameplate: e.target.value });
  });

  // ---- 台词：气泡与语音共用同一句 -----------------------------------------
  // 只给三种「要人处理」的状态开入口。busy / idle 冒泡是噪音而不是台词，
  // 让用户去自定义噪音只会让这台机器更难懂。
  const pushPhrase = (state) => {
    window.dispatchEvent(new CustomEvent('bao:phrase', { detail: { state, text: phraseOf(state) } }));
  };
  for (const state of PHRASE_STATES) {
    const input = document.getElementById('m-phrase-' + state);
    // 空白折成一个空格：台词是要显示在一张小气泡上的，换行和连串空格都会
    // 变成一块看不懂的黑斑。截断用 PHRASE_MAX，和气泡的自适应字号对齐。
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, PHRASE_MAX);
    // 边打边预览：气泡立刻换成这句话，不必等失焦。
    input.addEventListener('input', (e) => {
      window.dispatchEvent(new CustomEvent('bao:phrase', { detail: { state, text: clean(e.target.value) } }));
    });
    input.addEventListener('change', (e) => {
      const text = clean(e.target.value);
      e.target.value = text;
      cfg.phrases = { ...(cfg.phrases || {}), [state]: text };
      if (inElectron) saveConfig({ phrases: cfg.phrases });
      pushPhrase(state);
    });
  }
  document.getElementById('m-phrase-try').onclick = () => {
    // 读输入框而不是 cfg：用户刚打完字还没失焦时，cfg 还是上一句。
    const typed = String(document.getElementById('m-phrase-waiting').value || '').replace(/\s+/g, ' ').trim();
    const text = typed.slice(0, PHRASE_MAX) || TXT.waiting;
    // 走「临时提示」通道：不改变任何真实状态，也不占用告警限流。
    window.dispatchEvent(new CustomEvent('bao:say', { detail: { text } }));
    say(text);
  };
  document.getElementById('m-phrase-reset').onclick = () => {
    cfg.phrases = { waiting: '', error: '', done: '' };
    for (const state of PHRASE_STATES) {
      document.getElementById('m-phrase-' + state).value = '';
      pushPhrase(state);
    }
    if (inElectron) saveConfig({ phrases: cfg.phrases });
  };

  // 配置导出/导入：把当前自定义导出为 JSON 文件，导入后整页重载应用。
  // 导出要覆盖「设置」里的每一类自定义，否则导入回来会静默丢项：
  // 之前就漏了列表显示（是否显示未运行/模型/行数）、外观方案和语音播报。
  const EXPORT_KEYS = ['scale', 'brightness', 'baseEffect', 'body', 'theme', 'skin', 'eyestyle', 'trackstyle',
    'tracktype', 'armskin', 'claw', 'armtype', 'headtype', 'eyeshape', 'scene',
    'autoScene', 'dayScene', 'nightScene', 'nightStart', 'nightEnd', 'motion',
    'idleActions', 'idleFreq', 'halo', 'agentOrder', 'poses', 'phrases', 'nameplate', 'sound', 'soundStyle',
    'soundVolume', 'soundDone', 'notifyDone', 'dailyGoalHours', 'clickAction', 'doubleClick', 'muteMinutes', 'wear', 'finish',
    'voice', 'clickThrough', 'hotkeyOn', 'showLabels', 'showOffline', 'showModel', 'maxRows', 'showSys',
    'showScore', 'showRecent', 'doNotDisturb', 'dndStart', 'dndEnd', 'customSkin', 'customEye', 'customTrack', 'customArm',
    'customSign', 'presets', 'aliases', 'mutedAgents', 'signMode', 'signPos', 'signColor', 'signShape', 'decoration'];
  // "HH:MM"（24 小时制）。勿扰时间是要拿去和当前时间比较的，一个随手写的
  // "abc" 会让整段时间静默失效：界面显示「已开启」，而那段时间永远不会来。
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  // 导入的是别人给的文件，不能假设类型正确：一条 "scale": 1e9、一个列表里混进
  // 数字、或者十万字的铭牌，都能把布局撑坏，而 reload 之后没有撤销按钮。
  // 所以按已知键逐个归一化，坏值直接丢弃（保留当前设置），绝不原样落盘。
  function sanitizeImport(data) {
    const out = {};
    for (const k of EXPORT_KEYS) {
      const v = data[k];
      if (v === undefined) continue;
      // 台词是对象：必须先拦下，否则下面「长度 ≤ 64 的字符串」那条通用分支
      // 会把一个 "phrases": "x" 当成合法值收下，气泡那边再去读字符串的字段。
      // 只收三个已知状态键，顺手挡掉 __proto__ 之类的脏键。
      if (k === 'phrases') {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const map = {};
          for (const st of PHRASE_STATES) {
            const s = v[st];
            if (typeof s !== 'string') continue;
            const text = s.replace(/\s+/g, ' ').trim().slice(0, PHRASE_MAX);
            if (text) map[st] = text;
          }
          out[k] = map;
        }
        continue;
      }
      if (typeof v === 'boolean') out[k] = v;
      else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      else if (typeof v === 'string' && v.length <= 64) out[k] = v;
      else if (Array.isArray(v) && v.length <= 32
        && v.every((x) => typeof x === 'string' && x.length <= 64)) out[k] = v;
      else if (k === 'poses' && v && typeof v === 'object' && !Array.isArray(v)
        && Object.values(v).every((x) => typeof x === 'string' && x.length <= 16)) out[k] = v;
      else if (k === 'presets' && v && typeof v === 'object' && !Array.isArray(v)
        && JSON.stringify(v).length <= 20000) out[k] = v;
      else if (k === 'aliases' && v && typeof v === 'object' && !Array.isArray(v)) {
        // 只收「agent 键 → 短名字」，并重新建一个干净对象：不把文件里的
        // __proto__ / constructor 之类的键原样带进配置。
        const map = {};
        for (const [agent, name] of Object.entries(v)) {
          if (agent === '__proto__' || !/^[\w-]{1,32}$/.test(agent)) continue;
          if (typeof name !== 'string' || !name.trim()) continue;
          map[agent] = name.trim().slice(0, 10);
        }
        out[k] = map;
      }
    }
    // 长度上限挡不住 1e9：数值与颜色再夹一次。
    if (out.scale !== undefined) out.scale = Math.max(0.7, Math.min(1.7, out.scale));
    if (out.brightness !== undefined) out.brightness = Math.max(0.5, Math.min(1, out.brightness));
    if (out.soundVolume !== undefined) out.soundVolume = Math.max(0.05, Math.min(0.6, out.soundVolume));
    // 目标只能是下拉里那几档：别的值界面上表示不出来。
    if (out.dailyGoalHours !== undefined) {
      out.dailyGoalHours = [0, 2, 4, 6, 8].includes(out.dailyGoalHours) ? out.dailyGoalHours : 0;
    }
    if (out.clickAction !== undefined) {
      out.clickAction = ['poke', 'greet', 'none'].includes(out.clickAction) ? out.clickAction : 'poke';
    }
    if (out.doubleClick !== undefined) {
      out.doubleClick = out.doubleClick === 'none' ? 'none' : 'greet';
    }
    if (out.muteMinutes !== undefined) {
      out.muteMinutes = [30, 60, 120].includes(out.muteMinutes) ? out.muteMinutes : 60;
    }
    if (out.finish !== undefined) {
      out.finish = FINISH_NAMES.includes(out.finish) ? out.finish : '标准';
    }
    if (out.wear !== undefined) out.wear = Math.max(0, Math.min(1.5, out.wear));
    // 行数是下拉里 2–8 那几档，超出范围会让列表被裁掉或多出空行。
    if (out.maxRows !== undefined) {
      const n = Math.round(out.maxRows);
      out.maxRows = n >= 2 && n <= 8 ? n : 4;
    }
    // 勿扰时间必须是真时间：写不出 HH:MM 就整条丢掉（保留当前设置），
    // 而不是存一个让这段静音永远不触发的字符串。
    for (const k of ['dndStart', 'dndEnd']) {
      if (out[k] === undefined) continue;
      if (!TIME_RE.test(out[k])) delete out[k];
    }
    // 自动切换：白天/夜晚只能是已知场景，时段必须是真时间（否则这段永不触发）。
    for (const k of ['dayScene', 'nightScene']) {
      if (out[k] === undefined) continue;
      if (!SCENE_NAMES.includes(out[k])) delete out[k];
    }
    for (const k of ['nightStart', 'nightEnd']) {
      if (out[k] === undefined) continue;
      if (!TIME_RE.test(out[k])) delete out[k];
    }
    if (out.autoScene !== undefined) out.autoScene = !!out.autoScene;
    // 铭牌在机器人身上只画得下 16 个字（robot3d 会硬截断）。这里就截到同一个
    // 长度，否则设置里看到的和机器人身上写的永远不是同一句话。
    if (out.nameplate !== undefined) out.nameplate = out.nameplate.slice(0, 16);
    for (const k of ['customSkin', 'customEye', 'customTrack', 'customArm', 'customSign', 'signColor']) {
      if (out[k] === undefined) continue;
      const hex = normHex(out[k]);
      if (hex) out[k] = hex; else delete out[k];
    }
    return out;
  }
  document.getElementById('m-export').onclick = () => {
    syncCfg();
    const data = {};
    for (const k of EXPORT_KEYS) if (cfg[k] !== undefined) data[k] = cfg[k];
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'bao-config.json';
    // 必须挂进 DOM 才 click，且 revoke 要延后——同步 revoke 会在下载真正开始前
    // 把 blob URL 作废，导致导出的文件是空的/下载失败。
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  document.getElementById('m-import').onclick = () => document.getElementById('m-import-file').click();
  document.getElementById('m-import-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    // 配置文件本该只有几 KB。一个几百 MB 的 JSON 会在主线程上解析到窗口假死，
    // 而这里没有「取消」按钮 —— 直接拒绝，比让用户等一个卡死的窗口好。
    if (file.size > 256 * 1024) {
      e.target.value = '';
      flashNote('导入失败：文件过大（限 256KB）');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        // 只接受已知的外观键：挡住 __proto__ / window 之类的脏键，避免污染配置。
        const clean = sanitizeImport(data);
        Object.assign(cfg, clean);
        // 立刻落盘：下一行就是 reload，延迟写会被丢掉。
        if (inElectron) saveConfig(clean, { flush: true });
        location.reload();   // 重新加载，getConfig 会按新配置逐项应用
      } catch {
        // 坏文件不能静默：文件选择框一闪而过，用户分不清是「文件不对」还是
        // 「按钮没反应」，而这两件事的下一步动作完全不同。
        flashNote('导入失败：不是有效的配置文件');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });
  document.getElementById('m-quit').onclick = () => (inElectron ? bridge.quit() : window.close());

  // ---------------------------------------------------------------- drag
  // The window is click-through except over the robot, and a CSS drag region
  // would swallow the right-click menu. Drag by polling the cursor in main.
  let dragging = false;
  let pressAt = 0;
  let pressX = 0;
  let pressY = 0;
  let pokeTimes = [];   // 三连击彩蛋的时间戳
  let pendingReaction = null;   // 延迟派发的单击/双击反应（等确认不是连击再发）
  let comfortTimer = null;   // 长按 1 秒 = 安抚
  robot.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, .pill')) return;
    pressAt = Date.now();
    // 用**屏幕坐标**判断「松手时有没有移动过」。窗口是跟着光标走的，所以拖动
    // 机器人时 clientX/clientY 几乎不变 —— 拿它判断的话，每次拖拽都会被当成
    // 「戳一下」，顺手把当前这次告警静音掉。
    pressX = e.screenX;
    pressY = e.screenY;
    // 长按 1 秒触发「安抚」；松手（endDrag）会清掉这个计时器。
    clearTimeout(comfortTimer);
    comfortTimer = setTimeout(() => {
      comfortTimer = null;
      window.dispatchEvent(new CustomEvent('bao:comfort'));
    }, 1000);
    if (!inElectron) return;
    dragging = true;
    // 抓住这个 pointer：拖到窗口外、系统弹窗抢走焦点、触控笔离开屏幕时，
    // 浏览器会把 pointerup 补发回同一个元素，而不是让它凭空消失。
    // 没有这一句，`dragging` 会留在 true，主进程的 16ms 轮询继续把窗口钉在
    // 光标上 —— 用户看到的是「机器人黏住了」，只能再点一下才松开。
    try { robot.setPointerCapture(e.pointerId); } catch { /* 老引擎不支持 */ }
    bridge.dragStart();
    window.dispatchEvent(new CustomEvent('bao:drag', { detail: { on: true } }));
  });
  const endDrag = (e) => {
    clearTimeout(comfortTimer);
    if (dragging) {
      dragging = false;
      if (inElectron) bridge.dragEnd();
      window.dispatchEvent(new CustomEvent('bao:drag', { detail: { on: false } }));
    }
    // A press that never became a drag is a poke: he looks up and hops once.
    // A threshold rather than a click listener, because a click never arrives
    // once the window has been dragged across the desk. 比较屏幕坐标（见 press
    // 处注释）：窗口跟着光标走时，相对坐标是骗人的。
    if (e && e.type === 'pointerup' && pressAt &&
        Date.now() - pressAt < 400 &&
        Math.hypot(e.screenX - pressX, e.screenY - pressY) < 5) {
      // 一下 = 戳/挥手，两下 = 挥手，三下 = 彩蛋。原来每次 pointerup 都立刻派发，
      // 结果双击 = 两次戳 + 一次挥手，三连击 = 前两下先戳/挥手、第三下才抓狂 ——
      // 注释说「彩蛋不受点击反应影响」，实现却在三下之前就把前两下发了出去。
      // 这里统一延迟 300ms 再决定：期间再来一下就重新计时，三连击的第三下直接走
      // 彩蛋分支并把前面的反应取消掉。
      const now = Date.now();
      pokeTimes = pokeTimes.filter((x) => now - x < 900);
      pokeTimes.push(now);
      clearTimeout(pendingReaction);
      if (pokeTimes.length >= 3) {
        pokeTimes = [];
        pendingReaction = null;
        window.dispatchEvent(new CustomEvent('bao:crazy'));
      } else {
        pendingReaction = setTimeout(() => {
          pendingReaction = null;
          if (pokeTimes.length >= 2) {
            // 双击 = 挥手（若开启）。
            if (cfg.doubleClick !== 'none') window.dispatchEvent(new CustomEvent('bao:greet'));
          } else if (cfg.clickAction === 'greet') {
            window.dispatchEvent(new CustomEvent('bao:greet'));
          } else if (cfg.clickAction !== 'none') {
            window.dispatchEvent(new CustomEvent('bao:poke'));
          }
        }, 300);
      }
    }
    pressAt = 0;
  };
  window.addEventListener('pointerup', endDrag);
  // 指针被系统收走（切虚拟桌面、弹出的系统对话框抢焦点、触控笔离屏）时不一定
  // 有 pointerup。少了这两条兜底，窗口会一直跟着光标走到下一次点击。
  window.addEventListener('pointercancel', endDrag);
  document.addEventListener('lostpointercapture', endDrag);
  window.addEventListener('blur', endDrag);
  // 按下后真的移动了（拖窗口）就取消长按安抚：否则按住拖过 1 秒，机器人会在
  // 被搬动的过程中突然眯眼+抖动（安抚的抖动叠在位移上），像卡住了一样。
  window.addEventListener('pointermove', (e) => {
    if (!pressAt || !e.buttons) return;
    if (Math.hypot(e.screenX - pressX, e.screenY - pressY) > 5) clearTimeout(comfortTimer);
  });

  // ---------------------------------------------------------------- controls
  document.getElementById('btn-quit').onclick = () => (inElectron ? bridge.quit() : window.close());
  collapseBtn.onclick = () => {
    setCollapsed(!collapsed);
    if (inElectron) saveConfig({ collapsed });
  };
  // 尺寸模式：工具栏里那个图标按钮和设置里的下拉必须是同一个开关（按钮标题只
  // 写「切换尺寸」，很多人不知道它切的是什么）。两处都走 setThemeMode。
  const themeModeSel = document.getElementById('m-thememode');
  const setThemeMode = (mode, { persist = false } = {}) => {
    cfg.theme = mode === 'mini' ? 'mini' : 'full';
    document.body.dataset.theme = cfg.theme;
    themeModeSel.value = cfg.theme;
    if (persist && inElectron) saveConfig({ theme: cfg.theme });
    fit();
  };
  themeModeSel.addEventListener('change', (e) => setThemeMode(e.target.value, { persist: true }));
  document.getElementById('btn-theme').onclick = () => {
    setThemeMode(cfg.theme === 'mini' ? 'full' : 'mini', { persist: true });
  };

  if (inElectron) {
    bridge.getConfig().then((c) => {
      cfg = { ...cfg, ...c };
      // 首次安装日期：记录一次，用于「陪伴天数」。必须用**本地**日期 ——
      // toISOString() 是 UTC，东八区 0 点到 8 点安装的人，「陪你第 N 天」会
      // 永远差一天，因为 stats.day 用的是 store.js 的本地 dayKey()。
      if (!cfg.firstRun) {
        const d = new Date();
        cfg.firstRun = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        saveConfig({ firstRun: cfg.firstRun });
      }
      // 人格种子：首次随机固定一个，之后不再变——它「天生」是这脾气。
      if (!cfg.personality) {
        const PERSONALITIES = ['活泼', '沉稳', '话痨', '害羞'];
        cfg.personality = PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)];
        saveConfig({ personality: cfg.personality });
      }
      // 软件改名：只保留短字符串，脏值（手改配置、旧版本导入、空名字）丢掉。
      const rawAliases = cfg.aliases && typeof cfg.aliases === 'object' && !Array.isArray(cfg.aliases)
        ? cfg.aliases : {};
      const cleanAliases = {};
      for (const [agent, name] of Object.entries(rawAliases)) {
        if (agent === '__proto__') continue;
        if (typeof name === 'string' && name.trim()) cleanAliases[agent] = name.trim().slice(0, 10);
      }
      cfg.aliases = cleanAliases;
      // 通知开关名单：只收合法的 agent 键，去重。手改配置塞进来的脏值丢掉。
      cfg.mutedAgents = Array.isArray(cfg.mutedAgents)
        ? [...new Set(cfg.mutedAgents.filter((a) => typeof a === 'string' && /^[\w-]{1,32}$/.test(a)))]
        : [];
      document.body.dataset.personality = cfg.personality;
      setThemeMode(cfg.theme);
      setCollapsed(!!cfg.collapsed);
      goalSel.value = String([0, 2, 4, 6, 8].includes(Number(cfg.dailyGoalHours)) ? Number(cfg.dailyGoalHours) : 0);
      document.getElementById('m-sound').checked = !!cfg.sound;
      const sv = soundVolPct(cfg.soundVolume);
      soundvolInput.value = String(sv);
      soundvolOut.textContent = sv + '%';
      document.getElementById('m-voice').checked = !!cfg.voice;
      mutedUntil = Number(cfg.mutedUntil) || 0;
      muteDurSel.value = String(muteMinutes());
      refreshMuteButton();
      if (SOUND_STYLES[cfg.soundStyle]) soundstyleSel.value = cfg.soundStyle;
      soundDoneInput.checked = cfg.soundDone !== false;
      notifyDoneInput.checked = cfg.notifyDone !== false;
      document.getElementById('m-click').checked = cfg.clickThrough !== false;
      document.getElementById('m-hotkey').checked = cfg.hotkeyOn !== false;
      document.getElementById('m-labels').checked = cfg.showLabels !== false;
      document.getElementById('m-offline').checked = cfg.showOffline !== false;
      document.getElementById('m-model').checked = cfg.showModel !== false;
      document.getElementById('m-sys').checked = cfg.showSys !== false;
      if (cfg.showSys === false) renderSys(null);
      scorePanelInput.checked = cfg.showScore !== false;
      panelScore.hidden = cfg.showScore === false;
      recentPanelInput.checked = cfg.showRecent !== false;
      panelRecent.hidden = cfg.showRecent === false;
      document.getElementById('m-dnd').checked = !!cfg.doNotDisturb;
      // 手改过的配置里可能是一个写不出 HH:MM 的值。直接塞进 input[type=time]
      // 会得到一个空框，而空框让这段勿扰永远不生效 —— 回落到出厂时段更诚实。
      document.getElementById('m-dnd-start').value = TIME_RE.test(cfg.dndStart) ? cfg.dndStart : '22:00';
      document.getElementById('m-dnd-end').value = TIME_RE.test(cfg.dndEnd) ? cfg.dndEnd : '08:00';
      applyDnd();
      maxrowsSel.value = String(Math.max(2, Math.min(8, Number(cfg.maxRows) || 4)));
      renderPresetList();
      // 铭牌最长 16 个字（3D 那边画不下更多）。配置里更长时在这里就截断，
      // 界面和机器人身上才不会写着两句不一样的话。
      nameplateInput.value = String(cfg.nameplate || '').slice(0, 16);
      if (cfg.nameplate) window.dispatchEvent(new CustomEvent('bao:nameplate', { detail: { text: nameplateInput.value } }));
      // 台词：把配置里的值归一化后再交出去。手改配置写进来的超长串、非字符串、
      // 或者夹着换行的句子，都会在气泡上变成一块看不懂的黑斑。
      cfg.phrases = cfg.phrases && typeof cfg.phrases === 'object' ? cfg.phrases : {};
      for (const st of PHRASE_STATES) {
        const raw = typeof cfg.phrases[st] === 'string' ? cfg.phrases[st] : '';
        cfg.phrases[st] = raw.replace(/\s+/g, ' ').trim().slice(0, PHRASE_MAX);
        document.getElementById('m-phrase-' + st).value = cfg.phrases[st];
        pushPhrase(st);
      }
      const b = Math.max(0.5, Math.min(1, cfg.brightness ?? 1));
      document.getElementById('m-brightness').value = String(Math.round(b * 100));
      document.getElementById('m-brightness-val').textContent = Math.round(b * 100) + '%';
      window.dispatchEvent(new CustomEvent('bao:brightness', { detail: { brightness: b } }));
      // 材质：做旧程度 0–1.5，质感三档。脏值一律回出厂（1 / 标准）。
      const wr = Number(cfg.wear);
      wearInput.value = String(Math.round((Number.isFinite(wr) ? Math.max(0, Math.min(1.5, wr)) : 1) * 100));
      pushWear();
      const fn = FINISH_NAMES.includes(cfg.finish) ? cfg.finish : '标准';
      finishSel.value = fn;
      window.dispatchEvent(new CustomEvent('bao:finish', { detail: { finish: fn } }));
      const sm = ['top', 'total', 'cycle', 'off'].includes(cfg.signMode) ? cfg.signMode : 'top';
      signSel.value = Object.keys(SIGN_MODES).find((k) => SIGN_MODES[k] === sm) || '最多';
      const sp = cfg.signPos === 'left' ? 'left' : 'right';
      signPosSel.value = Object.keys(SIGN_POS).find((k) => SIGN_POS[k] === sp) || '右侧';
      // 牌面颜色：先认调色板里的名字，认不出但仍是合法十六进制就落到「自定义」
      // 并填进取色器（不再像上一版那样强行改成金色，把用户挑的颜色丢掉）。
      // 取色器要恢复成**上次挑的那个自定义色**（customSign），而不是当前生效的
      // 牌面色：后者可能是一个调色板颜色，填进去就等于把用户自己的色覆盖掉，
      // 于是「切回自定义用上次挑的色」这句承诺永远不会兑现。
      const signHex = normHex(cfg.signColor);
      const lastCustom = normHex(cfg.customSign) || signHex || SIGN_COLORS['金色'];
      signColorSel.value = Object.keys(SIGN_COLORS).find((k) => SIGN_COLORS[k] === cfg.signColor)
        || (signHex ? CUSTOM : '金色');
      signCustomInput.value = signColorSel.value === CUSTOM ? (signHex || lastCustom) : lastCustom;
      signCustomRow.hidden = signColorSel.value !== CUSTOM;
      const scol = signColorValue();
      const sh = ['圆角', '胶囊', '方正'].includes(cfg.signShape) ? cfg.signShape : '圆角';
      signShapeSel.value = sh;
      window.dispatchEvent(new CustomEvent('bao:sign', { detail: { mode: sm, pos: sp, color: scol, shape: sh } }));
      const bd = BODY_NAMES.includes(cfg.body) ? cfg.body : '标准';
      bodySel.value = bd;
      window.dispatchEvent(new CustomEvent('bao:body', { detail: { body: bd } }));
      const eff = EFFECT_NAMES.includes(cfg.baseEffect) ? cfg.baseEffect : '状态色';
      effectSel.value = eff;
      window.dispatchEvent(new CustomEvent('bao:effect', { detail: { effect: eff } }));
      // 四个部位的配色：自定义色必须是合法十六进制，否则回落到出厂固定色 ——
      // 配置里只留下「自定义」这个名字而没有颜色时，界面不能停在一个渲染不出来
      // 的状态（那正是上一版只存名字不存颜色的样子）。
      for (const p of PARTS) {
        const custom = normHex(cfg[p.configKey]);
        if (custom) p.input.value = custom;
        const fixed = p.options.includes(cfg[p.detailKey]) ? cfg[p.detailKey] : p.options[0];
        p.sel.value = cfg[p.detailKey] === CUSTOM && custom ? CUSTOM : fixed;
        p.apply();
      }
      // 主题下拉由 syncThemeLabel 在所有配色就位后自动判定（匹配主题或「自定义」）。
      const tt = TRACKTYPE_NAMES.includes(cfg.tracktype) ? cfg.tracktype : '圆角矩形';
      tracktypeSel.value = tt;
      window.dispatchEvent(new CustomEvent('bao:tracktype', { detail: { tracktype: tt } }));
      // 四项配色都已就位，现在才能判定主题；否则下拉停在第一项「经典战损黄」，
      // 与机器人实际配色不符，用户也没法靠「再选一次」纠正。
      syncThemeLabel();
      const cw = CLAW_NAMES.includes(cfg.claw) ? cfg.claw : '铲形';
      clawSel.value = cw;
      window.dispatchEvent(new CustomEvent('bao:claw', { detail: { claw: cw } }));
      const at = ARMTYPE_NAMES.includes(cfg.armtype) ? cfg.armtype : '双板';
      armtypeSel.value = at;
      window.dispatchEvent(new CustomEvent('bao:armtype', { detail: { armtype: at } }));
      const ht = HEADTYPE_NAMES.includes(cfg.headtype) ? cfg.headtype : '双筒';
      headtypeSel.value = ht;
      window.dispatchEvent(new CustomEvent('bao:headtype', { detail: { headtype: ht } }));
      const dc = DECORATION_NAMES.includes(cfg.decoration) ? cfg.decoration : '无';
      decorationSel.value = dc;
      window.dispatchEvent(new CustomEvent('bao:decoration', { detail: { decoration: dc } }));
      const esh = EYESHAPE_NAMES.includes(cfg.eyeshape) ? cfg.eyeshape : '圆';
      eyeshapeSel.value = esh;
      window.dispatchEvent(new CustomEvent('bao:eyeshape', { detail: { eyeshape: esh } }));
      const sc = SCENE_NAMES.includes(cfg.scene) ? cfg.scene : '无';
      sceneSel.value = sc;
      window.dispatchEvent(new CustomEvent('bao:scene', { detail: { scene: sc } }));
      // 自动切换打开时，上面按 cfg.scene 设的那一下要被时间决定的结果覆盖掉。
      refreshAutoSceneUI();
      lastAutoScene = '';
      applyAutoScene();
      const mo = MOTION_NAMES.includes(cfg.motion) ? cfg.motion : '标准';
      motionSel.value = mo;
      window.dispatchEvent(new CustomEvent('bao:motion', { detail: { motion: mo } }));
      clickActionSel.value = ['poke', 'greet', 'none'].includes(cfg.clickAction) ? cfg.clickAction : 'poke';
      dblClickSel.value = cfg.doubleClick === 'none' ? 'none' : 'greet';
      idleSel.checked = cfg.idleActions !== false;
      idlefreqSel.value = ['慢', '标准', '快'].includes(cfg.idleFreq) ? cfg.idleFreq : '标准';
      pushIdle();
      const hl = HALO_NAMES.includes(cfg.halo) ? cfg.halo : '环形';
      haloSel.value = hl;
      window.dispatchEvent(new CustomEvent('bao:halo', { detail: { halo: hl } }));
      // 软件顺序：用户排过就以它为准。长度不再要求等于内置数量 —— 服务端可能
      // 多接了一个软件，那份顺序里就该有它。
      if (Array.isArray(cfg.agentOrder) && cfg.agentOrder.length) {
        agentOrder = [...cfg.agentOrder];
        AGENT_RANK = Object.fromEntries(agentOrder.map((a, i) => [a, i]));
        customOrder = true;
      }
      renderOrderUI();
      // 状态手势：默认映射来自 shared/palette.mjs（robot3d.js 读同一份）。
      const poses = cfg.poses || {};
      for (const st of POSE_STATE_KEYS) {
        const p = POSE_NAMES.includes(poses[st]) ? poses[st] : DEFAULT_POSES[st];
        poseSels[st].value = p;
        window.dispatchEvent(new CustomEvent('bao:pose', { detail: { state: st, pose: p } }));
      }
      for (const p of PARTS) p.paint();
      updateSwatch('scene-swatch', SCENE_COLORS[sceneSel.value]);
      applyScale(cfg.scale || 1, { persist: false, anchor: 'top', expand: false });
      fit();
    });
    // 任何一次过渡结束都重排一次的话，fuel 高度、pill 宽度、`.on` 透明度……
    // 每个都会触发两条 IPC + 一次 setBounds。只关心真正改变布局的那几个容器。
    window.addEventListener('transitionend', (e) => {
      const t = e.target;
      // #bot 的 width 有 220ms 过渡（收起 150px / mini 210px）。不过滤它就等于
      // 在过渡起点量一次尺寸：窗口和点击热区停在收起前的大小，多出来的透明
      // 区域会继续吃桌面点击，直到下一次 fit 才有机会纠正。
      if (t === botEl && e.propertyName === 'width') { fit(); return; }
      if (e.propertyName !== 'opacity') return;
      if (t !== bar && t !== menu && t !== labels && t !== sizer) return;
      fit();
    });
  } else {
    document.body.dataset.theme = 'full';
  }

  render({ overall: 'offline', sessions: [] });
})();
