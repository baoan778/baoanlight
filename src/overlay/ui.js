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
    rawSave(patch);
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
  const displayName = (agent) => LABEL[agent] || String(agent || '');

  // cc-switch 接管某个软件后，它的名字会撒谎：Claude Code 可能实际跑在 DeepSeek
  // 上。这一行把「实际在用什么模型/供应商」说清楚；没被接管时返回 null，不显示。
  const ccSwitchLabel = (cc) => {
    if (!cc) return null;
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
  const note    = document.getElementById('note');
  const liveEl  = document.getElementById('live');
  const slotEls = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => document.getElementById('slot' + i));

  let cfg = { showLabels: true, theme: 'full', collapsed: false, scale: 1, clickThrough: true, sound: false };
  let collapsed = false;
  let scale = 1;
  let menuOpen = false;
  let sizerOpen = false;
  let sizerTimer = 0;
  let lastSnap = null;
  // 点击聚焦：null = 自动聚合（主灯显示最坏者）；非 null = 聚焦到某个软件，
  // 主灯临时显示该软件的状态，但四个通道始终各自可见。
  let focusedAgent = null;
  // 戳一下 = 「我看到了」：安静 60 秒，不动灯。灯说的是事实，静音只关声音。
  // 原来记的是「哪个状态被静音过」，但提示音本来就只在状态变化时响一次 ——
  // 状态没变就不会再响，那个判断永远不成立，是一句空承诺。
  let silentUntil = 0;
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
      const barVisible = bar.classList.contains('menu-open') || document.body.classList.contains('hovering');
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
    if (Date.now() < silentUntil) return;
    const now = Date.now();
    if (now - lastCue < 2500) return;      // one cue per incident, not per event
    lastCue = now;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      actx = actx || new AC();
      if (actx.state === 'suspended') actx.resume();
      if (!TONES[kind]) return;   // idle / offline 静默：安静是刻意的
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
    silentUntil = Date.now() + 60_000;
    flashNote('已静音提示 60 秒');
  });

  // 一行短提示，1.6 秒后收回；和 `note`（长驻的连接/自检提示）互不覆盖内容。
  let flashTimer = 0;
  function flashNote(text) {
    note.textContent = text;
    note.hidden = false;
    note.classList.add('on');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
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
    return slots
      .filter((s) => s && s.count > 0 && HEX[COLOR[s.state]])
      .map((s) => {
        const at = last.get(s.agent) || 0;
        return {
          agent: s.agent,
          label: displayName(s.agent),
          state: s.state,
          hex: HEX[COLOR[s.state]],
          dim: s.state === 'idle',
          count: s.count,
          at,
          fresh: now - at < FRESH_MS,
          worst: s.agent === worstAgent,
        };
      })
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

  // "Done" is not a state the server has: a run finishing is busy → idle, and
  // the machine answers it with two nods, not a colour change. Green means
  // "working", so a green flash on an idle robot is exactly the lie this tool
  // exists to prevent — the acknowledgement is motion, not light.
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
  function renderRecent() {
    const box = document.getElementById('m-recent');
    if (!box) return;
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
    const byAgent = snap?.stats?.byAgent || {};
    const events = snap?.stats?.events || {};
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
    if (!names.length) {
      const row = document.createElement('div');
      row.className = 'recent';
      row.innerHTML = '<span>今天还没有干活记录</span>';
      box.appendChild(row);
      return;
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
    for (const s of sessions) {
      if (s.state === 'busy' && s.quiet && s.quietFor > 5 * 60 * 1000) {
        stuckAgents.add(s.agent);
        if (!stuckNotified.has(s.agent)) {
          stuckNotified.add(s.agent);
          if (inElectron && bridge.notify) {
            bridge.notify(`${displayName(s.agent)} 好像卡住了`, '已经 5 分钟没有任何动静了，去看看');
          }
        }
        if (s.quietFor > 15 * 60 * 1000 && !stuckEscalated.has(s.agent)) {
          stuckEscalated.add(s.agent);
          if (inElectron && bridge.notify) {
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
    try {
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1.05;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch { /* 没有语音引擎就静默 */ }
  }
  function announce(state) {
    if (!cfg.voice) return;
    if (isMuted()) return;
    if (state === lastAnnounced) return;
    const msg = state === 'waiting' ? '需要你处理'
      : state === 'error' ? '出错了'
        : state === 'done' ? '完成了' : '';
    if (!msg) return;
    lastAnnounced = state;
    say(msg);
  }

  // 静音：一段时间内暂停所有通知/提示音/语音（开会时用）。状态显示照常。
  let mutedUntil = 0;
  const isMuted = () => Date.now() < mutedUntil;

  // 原生系统通知：等待/出错/完成时弹一次。同一状态 6 秒内只弹一次（防抖动），
  // 但换成别的状态要能立刻弹。
  let lastNotifiedState = '';
  let lastNotifiedAt = 0;
  function notifyState(state, agentLabel) {
    if (!inElectron || !bridge.notify) return;
    if (isMuted()) return;
    if (!(state === 'waiting' || state === 'error' || state === 'done')) return;
    const now = Date.now();
    if (state === lastNotifiedState && now - lastNotifiedAt < 6000) return;
    lastNotifiedState = state;
    lastNotifiedAt = now;
    const text = state === 'waiting' ? '需要你处理' : state === 'error' ? '出错了' : '完成了';
    bridge.notify(agentLabel ? `${agentLabel} ${text}` : text, '');
  }

  // 额度见底提醒：剩余额度从 >5% 掉到 ≤5% 时弹一次。
  let lastFuelLow = false;
  function notifyFuel(f) {
    if (!inElectron || !bridge.notify) return;
    if (isMuted()) return;
    const low = !!(f && typeof f.remaining === 'number' && f.remaining <= 5);
    if (low && !lastFuelLow) {
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
      el.setAttribute('aria-label', `${displayName(agent)} — ${VERB[s.state] || s.state}`);
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
    el.title = offline
      ? `${displayName(agent)} — 未运行`
      : (cc ? `用 ${cc} — ` : '') + (s.cwd ? s.cwd + ' — ' : '') + detail + quietFor
        + (s.cwd ? ' — 右键在终端打开' : '')
        + (agent === focusedAgent ? ' — 点击取消聚焦' : ' — 点击聚焦');
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

    const color = COLOR[displayState] || null;
    led.dataset.color = color || 'red';
    led.classList.toggle('on', !!color);

    renderSlots(slots);
    announceDone(sessions);
    if (!previewing) checkStuck(sessions);
    announceCC(snap);
    // 每个软件的今日时长（用短名）传给 3D 广告牌。
    const stats = {};
    for (const [agent, ms] of Object.entries(snap.stats?.byAgent || {})) {
      const min = Math.floor(ms / 60000);
      if (min >= 1) stats[displayName(agent).split(' ')[0]] = min;
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
      lastMilestoneDay = statsDay;
      lastMilestone = 0;
      // 陪伴天数：跨天时问候一次「陪你第 N 天啦」。
      const days = dayDiff(cfg.firstRun || statsDay, statsDay);
      if (days >= 1) window.dispatchEvent(new CustomEvent('bao:companion', { detail: { days } }));
    }
    // 一次跨过多档（比如午休回来一次涨了 3 小时）时只庆祝最高那一档：
    // 用 find 会挑最低的，然后在接下来几帧里一档一档补庆祝，看起来像卡住了。
    const crossed = MILESTONES.filter((m) => totalBusyMs >= m * 3600000 && m > lastMilestone).pop();
    if (crossed) {
      lastMilestone = crossed;
      window.dispatchEvent(new CustomEvent('bao:milestone', { detail: { hours: crossed } }));
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
    const notifyLabel = focusedAgent ? displayName(focusedAgent) : agentLabel;
    if (!previewing && realChanged) notifyState(displayState, notifyLabel);
    renderFuel(snap.fuel);
    if (!previewing) notifyFuel(snap.fuel);
    // sessions arrive newest-first, so [0] is the software that spoke last
    const liveTop = sessions[0];
    publish(displayState, color, slots, agentLabel,
      liveTop ? HEX[COLOR[liveTop.state]] : null,
      activeAgents(snap, slots, worstKey));

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
    note.textContent = text;
    note.hidden = !text;
    note.classList.toggle('on', !!text);

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
    es.onmessage = (e) => { try { render(JSON.parse(e.data)); } catch (_) {} };
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
    if (open) setSizer(false);
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
    previewTimer = setTimeout(() => {
      previewing = false;
      preview.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      if (lastSnap) render(lastSnap);
    }, 3000);
  }
  preview.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => previewState(b.dataset.st));
  });

  const setSizer = (open) => {
    if (open === sizerOpen && open) return;
    sizerOpen = open;
    clearTimeout(sizerTimer);
    if (open) {
      sizer.hidden = false;
      preview.hidden = false;
      if (menuOpen) {
        menuOpen = false;
        menu.hidden = true;
        bar.classList.remove('menu-open');
      }
      requestAnimationFrame(() => {
        if (sizerOpen) { sizer.classList.add('on'); preview.classList.add('on'); }
      });
    } else {
      sizer.classList.remove('on');
      preview.classList.remove('on');
      sizerTimer = setTimeout(() => {
        if (!sizerOpen) { sizer.hidden = true; preview.hidden = true; fit(); }
      }, 160);
    }
    fit();
  };

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
  fillSignOpts(signColorSel, Object.keys(SIGN_COLORS));
  fillSignOpts(signShapeSel, Object.keys(SIGN_SHAPES));
  signSel.value = '最多';
  signPosSel.value = '右侧';
  signColorSel.value = '金色';
  signShapeSel.value = '圆角';
  function applySign() {
    const mode = SIGN_MODES[signSel.value] || 'top';
    const pos = SIGN_POS[signPosSel.value] || 'right';
    const color = SIGN_COLORS[signColorSel.value] || '#ffd54a';
    const shape = SIGN_SHAPES[signShapeSel.value] || '圆角';
    window.dispatchEvent(new CustomEvent('bao:sign', { detail: { mode, pos, color, shape } }));
    if (inElectron) saveConfig({ signMode: mode, signPos: pos, signColor: color, signShape: shape });
  }
  signSel.addEventListener('change', applySign);
  signPosSel.addEventListener('change', applySign);
  signColorSel.addEventListener('change', applySign);
  signShapeSel.addEventListener('change', applySign);



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

  // 皮肤列表来自 palette。换皮肤只改身体主色/暗色，做旧纹理保留。
  const SKIN_NAMES = names(SKIN_TONES);
  const skinSel = document.getElementById('m-skin');
  for (const n of SKIN_NAMES) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n;
    skinSel.appendChild(o);
  }
  skinSel.addEventListener('change', (e) => {
    window.dispatchEvent(new CustomEvent('bao:skin', { detail: { skin: e.target.value } }));
    if (inElectron) saveConfig({ skin: e.target.value });
    updateSwatch('skin-swatch', SKIN_COLORS[e.target.value]);
    syncThemeLabel();
  });

  // 眼睛配色 / 履带配色也来自 palette。
  const EYESTYLE_NAMES = names(EYE_TONES);
  const TRACKSTYLE_NAMES = names(TRACK_TONES);
  const eyestyleSel = document.getElementById('m-eyestyle');
  for (const n of EYESTYLE_NAMES) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n; eyestyleSel.appendChild(o);
  }
  eyestyleSel.addEventListener('change', (e) => {
    window.dispatchEvent(new CustomEvent('bao:eyestyle', { detail: { eyestyle: e.target.value } }));
    if (inElectron) saveConfig({ eyestyle: e.target.value });
    updateSwatch('eye-swatch', EYE_COLORS[e.target.value]);
    syncThemeLabel();
  });
  const trackstyleSel = document.getElementById('m-trackstyle');
  for (const n of TRACKSTYLE_NAMES) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n; trackstyleSel.appendChild(o);
  }
  trackstyleSel.addEventListener('change', (e) => {
    window.dispatchEvent(new CustomEvent('bao:trackstyle', { detail: { trackstyle: e.target.value } }));
    if (inElectron) saveConfig({ trackstyle: e.target.value });
    updateSwatch('track-swatch', TRACK_COLORS[e.target.value]);
    syncThemeLabel();
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

  // 配件配色（手臂/手爪/镜筒）与手爪形状。
  const ARMSKIN_NAMES = names(ARM_TONES);
  const CLAW_NAMES = ['铲形', '三指', '钳形', '四指', '五指'];
  const armskinSel = document.getElementById('m-armskin');
  for (const n of ARMSKIN_NAMES) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n; armskinSel.appendChild(o);
  }
  armskinSel.addEventListener('change', (e) => {
    window.dispatchEvent(new CustomEvent('bao:armskin', { detail: { armskin: e.target.value } }));
    if (inElectron) saveConfig({ armskin: e.target.value });
    updateSwatch('arm-swatch', ARM_COLORS[e.target.value]);
    syncThemeLabel();
  });
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
    if (!t) return;   // 「自定义」：保持当前配色，不做任何套用
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
    pushIdle();
    if (inElectron) saveConfig({ idleActions: e.target.checked });
  });
  idlefreqSel.addEventListener('change', (e) => {
    pushIdle();
    if (inElectron) saveConfig({ idleFreq: e.target.value });
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

  // 软件顺序：动态生成排序行，↑/↓ 调整软件在灯环/列表里的前后顺序。
  function renderOrderUI() {
    const box = document.getElementById('m-order');
    box.innerHTML = '';
    agentOrder.forEach((agent, idx) => {
      const row = document.createElement('div');
      row.className = 'row';
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
    });
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
    renderOrderUI();
    if (lastSnap) render(lastSnap);
  }

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

  // 静音 1 小时：开会/专注时一键暂停通知、提示音、语音；再点一次立即恢复。
  const muteBtn = document.getElementById('m-mute');
  let muteResetTimer = null;
  function refreshMuteButton() {
    const on = isMuted();
    muteBtn.textContent = on ? '已静音 · 点击恢复' : '静音 1 小时（暂停通知/提示音）';
    // 静音中把按钮按「危险/已触发」的样子标出来，而不是一直同一副面孔。
    muteBtn.classList.toggle('danger', on);
    muteBtn.style.opacity = on ? '0.7' : '';
    clearTimeout(muteResetTimer);
    if (on) {
      muteResetTimer = setTimeout(refreshMuteButton, Math.max(0, mutedUntil - Date.now()) + 500);
    }
  }
  muteBtn.addEventListener('click', () => {
    if (isMuted()) {
      mutedUntil = 0;
    } else {
      mutedUntil = Date.now() + 60 * 60 * 1000;
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
    if (cfg.sound) cue('waiting');
  });

  document.getElementById('m-click').addEventListener('change', (e) => {
    if (inElectron) saveConfig({ clickThrough: e.target.checked });
  });
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

  // 一键重置外观：只恢复外观与动作，不碰尺寸、位置、声音和系统开关。
  const LOOK_DEFAULTS = {
    skin: '做旧黄', eyestyle: '默认黑', eyeshape: '圆', trackstyle: '黑', tracktype: '圆角矩形',
    armskin: '枪灰', claw: '铲形', armtype: '双板', headtype: '双筒', scene: '无',
    motion: '标准', halo: '环形', body: '标准', baseEffect: '状态色', brightness: 1,
    poses: { error: '环抱', waiting: '举手', busy: '泵动', done: '摊开', idle: '垂放' },
  };
  // 把一套外观即时套用到界面（不整页刷新）：逐个设置控件值并触发 change，
  // 复用各控件原有的 change 监听（派发 bao:* 事件 + 保存 + 色块/主题联动）。
  function applyLook(look) {
    if (inElectron) saveConfig(look);
    Object.assign(cfg, look);
    const sets = {
      skin: skinSel, eyestyle: eyestyleSel, eyeshape: eyeshapeSel, trackstyle: trackstyleSel,
      tracktype: tracktypeSel, armskin: armskinSel, claw: clawSel, armtype: armtypeSel,
      headtype: headtypeSel, scene: sceneSel, motion: motionSel, halo: haloSel, body: bodySel,
      baseEffect: effectSel, decoration: decorationSel,
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
    'claw', 'armtype', 'headtype', 'scene', 'motion', 'halo', 'body', 'baseEffect', 'brightness', 'decoration'];
  function currentLook() {
    const poses = {};
    for (const st of POSE_STATE_KEYS) poses[st] = poseSels[st].value;
    const brightness = Math.max(0.5, Math.min(1, Number(document.getElementById('m-brightness').value) / 100));
    const look = { poses, brightness };
    const dom = {
      skin: skinSel, eyestyle: eyestyleSel, eyeshape: eyeshapeSel, trackstyle: trackstyleSel,
      tracktype: tracktypeSel, armskin: armskinSel, claw: clawSel, armtype: armtypeSel,
      headtype: headtypeSel, scene: sceneSel, motion: motionSel, halo: haloSel, body: bodySel,
      baseEffect: effectSel, decoration: decorationSel,
    };
    for (const k of LOOK_KEYS) if (dom[k]) look[k] = dom[k].value;
    return look;
  }
  // 把「只在界面上」的值同步回内存里的 cfg。
  // 尺寸、亮度、铭牌、点击穿透、待机动作、广告牌、软件顺序这些控件的 handler
  // 只写盘、不回写 cfg，于是「导出配置」导出的是**启动时**的旧值 —— 用户改过的
  // 设置导入回来会静默消失，而这正是导出功能存在的意义。
  function syncCfg() {
    cfg.scale = scale;
    const bEl = document.getElementById('m-brightness');
    if (bEl) cfg.brightness = Number(bEl.value) / 100;
    cfg.nameplate = nameplateInput.value;
    cfg.clickThrough = document.getElementById('m-click').checked;
    cfg.idleActions = idleSel.checked;
    cfg.idleFreq = idlefreqSel.value;
    cfg.signMode = SIGN_MODES[signSel.value] || cfg.signMode;
    cfg.signPos = SIGN_POS[signPosSel.value] || cfg.signPos;
    cfg.signColor = SIGN_COLORS[signColorSel.value] || cfg.signColor;
    cfg.signShape = SIGN_SHAPES[signShapeSel.value] || cfg.signShape;
    cfg.agentOrder = [...agentOrder];
    cfg.personality = cfg.personality || document.body.dataset.personality;
    return cfg;
  }

  function renderPresetList() {
    presetList.innerHTML = '';
    for (const name of Object.keys(cfg.presets || {})) {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      presetList.appendChild(o);
    }
  }
  document.getElementById('m-preset-save').onclick = () => {
    const name = presetName.value.trim().slice(0, 12);
    if (!name) return;
    cfg.presets = { ...(cfg.presets || {}), [name]: currentLook() };
    if (inElectron) saveConfig({ presets: cfg.presets });
    renderPresetList();
    presetList.value = name;
    presetName.value = '';
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
    renderPresetList();
  };

  // 尺寸快捷键：Ctrl/⌘+Shift + = / - / 0。
  window.addEventListener('keydown', (e) => {
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

  // 配置导出/导入：把当前自定义导出为 JSON 文件，导入后整页重载应用。
  // 导出要覆盖「设置」里的每一类自定义，否则导入回来会静默丢项：
  // 之前就漏了列表显示（是否显示未运行/模型/行数）、外观方案和语音播报。
  const EXPORT_KEYS = ['scale', 'brightness', 'baseEffect', 'body', 'theme', 'skin', 'eyestyle', 'trackstyle',
    'tracktype', 'armskin', 'claw', 'armtype', 'headtype', 'eyeshape', 'scene', 'motion',
    'idleActions', 'idleFreq', 'halo', 'agentOrder', 'poses', 'nameplate', 'sound', 'soundStyle',
    'soundVolume', 'voice', 'clickThrough', 'showLabels', 'showOffline', 'showModel', 'maxRows',
    'presets', 'signMode', 'signPos', 'signColor', 'signShape', 'decoration'];
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
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        // 只接受已知的外观键：挡住 __proto__ / window 之类的脏键，避免污染配置。
        const clean = {};
        for (const k of EXPORT_KEYS) if (data[k] !== undefined) clean[k] = data[k];
        Object.assign(cfg, clean);
        // 立刻落盘：下一行就是 reload，延迟写会被丢掉。
        if (inElectron) saveConfig(clean, { flush: true });
        location.reload();   // 重新加载，getConfig 会按新配置逐项应用
      } catch { /* 坏文件：静默忽略 */ }
    };
    reader.readAsText(file);
    e.target.value = '';
  });
  document.getElementById('m-quit').onclick = () => (inElectron ? bridge.quit() : window.close());

  // 3D 拆解台：Electron 里开一个独立的应用窗口（不是系统浏览器标签），
  // 纯浏览器模式（bao start --browser）下退回新标签。
  document.getElementById('m-teardown').onclick = () => {
    if (inElectron && bridge.openTeardown) bridge.openTeardown();
    else window.open(`${location.origin}/teardown/`, '_blank', 'noopener');
  };

  // ---------------------------------------------------------------- drag
  // The window is click-through except over the robot, and a CSS drag region
  // would swallow the right-click menu. Drag by polling the cursor in main.
  let dragging = false;
  let pressAt = 0;
  let pressX = 0;
  let pressY = 0;
  let pokeTimes = [];   // 三连击彩蛋的时间戳
  let comfortTimer = null;   // 长按 1 秒 = 安抚
  robot.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, .pill')) return;
    pressAt = Date.now();
    pressX = e.clientX;
    pressY = e.clientY;
    // 长按 1 秒触发「安抚」；松手（endDrag）会清掉这个计时器。
    clearTimeout(comfortTimer);
    comfortTimer = setTimeout(() => {
      comfortTimer = null;
      window.dispatchEvent(new CustomEvent('bao:comfort'));
    }, 1000);
    if (!inElectron) return;
    dragging = true;
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
    // once the window has been dragged across the desk.
    if (e && e.type === 'pointerup' && pressAt &&
        Date.now() - pressAt < 400 &&
        Math.hypot(e.clientX - pressX, e.clientY - pressY) < 5) {
      // 三连击彩蛋：原地抓狂（快速转圈 + 抖动）；否则就是普通戳一下。
      const now = Date.now();
      pokeTimes = pokeTimes.filter((x) => now - x < 900);
      pokeTimes.push(now);
      if (pokeTimes.length >= 3) {
        pokeTimes = [];
        window.dispatchEvent(new CustomEvent('bao:crazy'));
      } else {
        window.dispatchEvent(new CustomEvent('bao:poke'));
      }
    }
    pressAt = 0;
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('blur', endDrag);

  // A double click is a greeting, not a command: both arms up for two seconds.
  // It is the only interaction here that is purely for the human, which is the
  // difference between a status light and a desk pet — and it is free, because
  // the arms already exist.
  robot.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input, .pill')) return;
    window.dispatchEvent(new CustomEvent('bao:greet'));
  });

  // ---------------------------------------------------------------- controls
  document.getElementById('btn-quit').onclick = () => (inElectron ? bridge.quit() : window.close());
  collapseBtn.onclick = () => {
    setCollapsed(!collapsed);
    if (inElectron) saveConfig({ collapsed });
  };
  document.getElementById('btn-theme').onclick = () => {
    cfg.theme = cfg.theme === 'mini' ? 'full' : 'mini';
    document.body.dataset.theme = cfg.theme;
    if (inElectron) saveConfig({ theme: cfg.theme });
    fit();
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
      document.body.dataset.personality = cfg.personality;
      document.body.dataset.theme = cfg.theme === 'mini' ? 'mini' : 'full';
      setCollapsed(!!cfg.collapsed);
      document.getElementById('m-sound').checked = !!cfg.sound;
      document.getElementById('m-voice').checked = !!cfg.voice;
      mutedUntil = Number(cfg.mutedUntil) || 0;
      refreshMuteButton();
      if (SOUND_STYLES[cfg.soundStyle]) soundstyleSel.value = cfg.soundStyle;
      document.getElementById('m-click').checked = cfg.clickThrough !== false;
      document.getElementById('m-labels').checked = cfg.showLabels !== false;
      document.getElementById('m-offline').checked = cfg.showOffline !== false;
      document.getElementById('m-model').checked = cfg.showModel !== false;
      maxrowsSel.value = String(Math.max(2, Math.min(8, Number(cfg.maxRows) || 4)));
      renderPresetList();
      nameplateInput.value = cfg.nameplate || '';
      if (cfg.nameplate) window.dispatchEvent(new CustomEvent('bao:nameplate', { detail: { text: cfg.nameplate } }));
      const b = Math.max(0.5, Math.min(1, cfg.brightness ?? 1));
      document.getElementById('m-brightness').value = String(Math.round(b * 100));
      document.getElementById('m-brightness-val').textContent = Math.round(b * 100) + '%';
      window.dispatchEvent(new CustomEvent('bao:brightness', { detail: { brightness: b } }));
      const sm = ['top', 'total', 'cycle', 'off'].includes(cfg.signMode) ? cfg.signMode : 'top';
      signSel.value = Object.keys(SIGN_MODES).find((k) => SIGN_MODES[k] === sm) || '最多';
      const sp = cfg.signPos === 'left' ? 'left' : 'right';
      signPosSel.value = Object.keys(SIGN_POS).find((k) => SIGN_POS[k] === sp) || '右侧';
      const scol = cfg.signColor || '#ffd54a';
      signColorSel.value = Object.keys(SIGN_COLORS).find((k) => SIGN_COLORS[k] === scol) || '金色';
      const sh = ['圆角', '胶囊', '方正'].includes(cfg.signShape) ? cfg.signShape : '圆角';
      signShapeSel.value = sh;
      window.dispatchEvent(new CustomEvent('bao:sign', { detail: { mode: sm, pos: sp, color: scol, shape: sh } }));
      const bd = BODY_NAMES.includes(cfg.body) ? cfg.body : '标准';
      bodySel.value = bd;
      window.dispatchEvent(new CustomEvent('bao:body', { detail: { body: bd } }));
      const eff = EFFECT_NAMES.includes(cfg.baseEffect) ? cfg.baseEffect : '状态色';
      effectSel.value = eff;
      window.dispatchEvent(new CustomEvent('bao:effect', { detail: { effect: eff } }));
      const sk = SKIN_NAMES.includes(cfg.skin) ? cfg.skin : '做旧黄';
      skinSel.value = sk;
      window.dispatchEvent(new CustomEvent('bao:skin', { detail: { skin: sk } }));
      // 主题下拉由 syncThemeLabel 在所有配色就位后自动判定（匹配主题或「自定义」）。
      const es = EYESTYLE_NAMES.includes(cfg.eyestyle) ? cfg.eyestyle : '默认黑';
      eyestyleSel.value = es;
      window.dispatchEvent(new CustomEvent('bao:eyestyle', { detail: { eyestyle: es } }));
      const ts = TRACKSTYLE_NAMES.includes(cfg.trackstyle) ? cfg.trackstyle : '黑';
      trackstyleSel.value = ts;
      window.dispatchEvent(new CustomEvent('bao:trackstyle', { detail: { trackstyle: ts } }));
      const tt = TRACKTYPE_NAMES.includes(cfg.tracktype) ? cfg.tracktype : '圆角矩形';
      tracktypeSel.value = tt;
      window.dispatchEvent(new CustomEvent('bao:tracktype', { detail: { tracktype: tt } }));
      const ask = ARMSKIN_NAMES.includes(cfg.armskin) ? cfg.armskin : '枪灰';
      armskinSel.value = ask;
      window.dispatchEvent(new CustomEvent('bao:armskin', { detail: { armskin: ask } }));
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
      const mo = MOTION_NAMES.includes(cfg.motion) ? cfg.motion : '标准';
      motionSel.value = mo;
      window.dispatchEvent(new CustomEvent('bao:motion', { detail: { motion: mo } }));
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
      updateSwatch('skin-swatch', SKIN_COLORS[skinSel.value]);
      updateSwatch('scene-swatch', SCENE_COLORS[sceneSel.value]);
      updateSwatch('eye-swatch', EYE_COLORS[eyestyleSel.value]);
      updateSwatch('track-swatch', TRACK_COLORS[trackstyleSel.value]);
      updateSwatch('arm-swatch', ARM_COLORS[armskinSel.value]);
      applyScale(cfg.scale || 1, { persist: false, anchor: 'top', expand: false });
      fit();
    });
    // 任何一次过渡结束都重排一次的话，fuel 高度、pill 宽度、`.on` 透明度……
    // 每个都会触发两条 IPC + 一次 setBounds。只关心真正改变布局的那几个容器。
    window.addEventListener('transitionend', (e) => {
      const t = e.target;
      if (e.propertyName !== 'opacity') return;
      if (t !== bar && t !== menu && t !== labels && t !== sizer) return;
      fit();
    });
  } else {
    document.body.dataset.theme = 'full';
  }

  render({ overall: 'offline', sessions: [] });
})();
