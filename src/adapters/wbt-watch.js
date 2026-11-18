'use strict';
// CodeBuddy / WorkBuddy CLI 的会话 transcript。
//
// 这类 IDE/CLI 会把每一轮对话按记录类型追加到
//   ~/.workbuddy/projects/<项目名>/<sessionId>.jsonl
// 里面是逐条的 JSON（reasoning / function_call / message …），比「任务板」精确得多：
// 任务板只在你建了任务时才有 in_progress，平时一直是空的。
//
// 我们只取记录的**类型与工具名**，正文不会进入状态、日志或任何输出 —— 这些文件里
// 全是 prompt 和工具输出，一个状态灯没有理由把它们复制到别处。
//
//   reasoning / function_call / function_call_result  -> busy（模型在思考、在调工具）
//   message(role=user)                               -> busy（新一轮开始）
//   message(role=assistant)                          -> done（这一轮结束，紫灯闪一下再回空闲）
//   session-meta / file-history-snapshot / ai-title   -> 不改变状态

const fs = require('fs');
const path = require('path');
const { setState } = require('../client');
const { keepAliveWith } = require('./watchdog');
const agents = require('./agents');

const POLL_MS = 1500;
const TAIL_MAX = 256 * 1024;      // 首读时只回看尾部，别把 2MB 的老对话整段扫一遍
const ACTIVE_MS = 30 * 60 * 1000; // 半小时没新记录的会话不再显示

// assistant message 只有在这一轮真的结束时才算 done。中途发言常常是「我要调用
// 工具了」，后面紧跟 function_call；无条件按 done 处理会让灯闪一下紫灯再变绿，
// 看起来像是刚完成又立刻重来。
function stopsForToolUse(rec) {
  if (rec.stop_reason === 'tool_use' || rec.stopReason === 'tool_use') return true;
  const content = rec.content ?? rec.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((c) => {
    const t = c && (c.type || c.kind);
    return t === 'tool_use' || t === 'function_call' || t === 'tool_call';
  });
}

// 有些工具一调用就停下来等人：提问、请求批准、退出计划模式。它们不是「在干活」，
// 而是「在等你」—— 灯必须是黄色，否则用户会盯着一盏绿灯，而代理正等他回答。
const AWAITING_TOOL = /ask_?user|ask_?question|user_?input|needs?_?input|request_?approval|approval_?request|exit_?plan_?mode|permission/i;

// 记录 -> 状态。返回 null 表示「这条不改变状态」。
function stateOf(rec) {
  const t = rec && rec.type;
  if (t === 'function_call') {
    return AWAITING_TOOL.test(String(rec.name || '')) ? 'waiting' : 'busy';
  }
  if (t === 'reasoning' || t === 'function_call_result') return 'busy';
  if (t === 'message') {
    const role = rec.role || rec.message?.role;
    if (role !== 'assistant') return 'busy';
    return stopsForToolUse(rec) ? 'busy' : 'done';
  }
  return null;
}

// 一句人话，给列表那一行用。只用到工具名，正文一律不碰。
function detailOf(rec) {
  const t = rec && rec.type;
  if (t === 'function_call') {
    if (AWAITING_TOOL.test(String(rec.name || ''))) return '等你回答';
    return rec.name ? `运行 ${String(rec.name).slice(0, 24)}` : '调用工具';
  }
  if (t === 'function_call_result') return '工具返回';
  if (t === 'reasoning') return '思考中';
  if (t === 'message') {
    const role = rec.role || rec.message?.role;
    return role === 'assistant' ? (stopsForToolUse(rec) ? '继续调用工具' : '这一轮结束') : '收到新指令';
  }
  return '';
}

// 扫描 transcript 目录。只返回 `sinceMs` 之后改过的文件，并顺手带上大小/时间：
// 半年历史会攒下几百个会话文件，每 1.5 秒对全部文件 readdir + stat 一次是纯浪费
// —— 老文件永远不会再变，没必要每一轮都去问它。
function listTranscripts(root, sinceMs = 0) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!/\.jsonl$/i.test(e.name)) continue;
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= sinceMs) out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* 扫描途中被删掉 */ }
    }
  };
  walk(root, 0);
  return out;
}

// 把一个文件从 offset 起的新内容喂给 handle，按行切（末尾不完整的行留到下次）。
function readAppended(file, st, handle) {
  let size;
  try { size = fs.statSync(file).size; } catch { return; }
  if (size < st.offset) { st.offset = 0; st.buffer = ''; }   // 文件被截断/轮转
  if (size === st.offset) return;
  const len = size - st.offset;
  const buf = Buffer.alloc(len);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, st.offset);
  } catch {
    return;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 已经关了 */ } }
  }
  st.offset = size;
  const text = st.buffer + buf.toString('utf8');
  const lines = text.split(/\r?\n/);
  st.buffer = lines.pop() || '';       // 最后一段可能还没写完
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }   // 半行/坏行：跳过，别让整条链停摆
    handle(rec);
  }
}

// 同一个家目录里既有 WorkBuddy 桌面端、也有 CodeBuddy CLI，transcript 的格式
// 一模一样。唯一的可靠线索是路径：
//   ~/.codebuddy/...            -> CodeBuddy
//   ~/.workbuddy/... 或 cwd 里带 WorkBuddy -> WorkBuddy
// 以前一律记成 codebuddy，于是只开着 WorkBuddy 的人会看到「CodeBuddy 在运行」，
// 而真正在跑的 WorkBuddy 显示未运行 —— 两个软件的名字互相顶替。
function agentFor(file, cwd, requested = 'codebuddy') {
  const text = `${file} ${cwd || ''}`.toLowerCase().replace(/\\/g, '/');
  if (text.includes('/.codebuddy/')) return 'codebuddy';
  if (requested === 'codebuddy' && (text.includes('/.workbuddy/') || text.includes('workbuddy'))) {
    return 'workbuddy';
  }
  return requested;
}

function run({
  dir, interval = POLL_MS, quiet = false, agent = 'codebuddy', throwOnMissing = false, manual = false,
  heartbeat = 20_000,
} = {}) {
  // `--dir` 没给就自己找默认位置：别的 watcher 都这么做，CLI 只负责把 --dir 传进来。
  const root = dir || agents.logDir('codebuddy', { config: require('../config').load() });
  if (!root || !fs.existsSync(root)) {
    // In `bao watch all` this watcher must fail alone, not kill the process.
    if (throwOnMissing) throw new Error(`codebuddy: no transcript directory at ${root || '(unset)'}`);
    console.error(`codebuddy: no transcript directory at ${root || '(unset)'} — run: bao watch codebuddy --dir <path>`);
    process.exit(1);
  }

  const files = new Map();   // path -> { offset, buffer, state, primed, session, cwd }

  const emit = (st, next, detail, pulse = false) => {
    st.state = next;
    st.detail = detail;
    st.reportedAt = Date.now();
    setState({ session: st.session, agent: st.agent, state: next, detail, cwd: st.cwd || '', source: 'log', event: detail, pulse });
    if (!quiet) {
      const time = new Date().toISOString().slice(11, 19);
      console.log(`  ${time}  ${st.session.split(':').pop().slice(0, 12)} -> ${next}${detail ? ' ' + detail : ''}`);
    }
  };

  // 会话第一次被认出属于另一个软件时，旧键要收摊，否则灯上会同时留下
  // 「codebuddy:abc 忙碌」和「workbuddy:abc 忙碌」两条记录。
  const adoptAgent = (st) => {
    const wanted = agentFor(st.file, st.cwd, agent);
    if (wanted === st.agent) return;
    if (st.state && st.state !== 'offline') {
      setState({ session: st.session, agent: st.agent, state: 'offline' });
    }
    st.agent = wanted;
    st.session = `${wanted}:${st.sessionId}`;
    st.state = null;
    st.detail = '';
    st.reportedAt = 0;
  };

  // 目录树 5 秒重扫一次就够了：新会话文件不可能一秒冒出两批，而正在跟踪的
  // 文件每一轮仍会重新 stat（它们正在被写，尺寸必须是最新的）。
  let scanCache = [];
  let scanAt = 0;

  const tick = () => {
    const now = Date.now();
    if (now - scanAt >= 5000) {
      scanAt = now;
      scanCache = listTranscripts(root, now - ACTIVE_MS);
    }
    const live = new Set();

    for (const entry of scanCache) {
      const file = entry.path;
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (now - stat.mtimeMs > ACTIVE_MS) continue;     // 老会话不再占灯
      live.add(file);

      let st = files.get(file);
      if (!st) {
        // 第一次看到它：只回看尾部。primed=false 期间把「最后一条有状态意义的记录」
        // 攒起来，读完后一次性上报 —— 既不补发历史，也不会让灯空等下一轮。
        st = {
          offset: Math.max(0, stat.size - TAIL_MAX),
          buffer: '',
          state: null,
          detail: '',
          primed: false,
          pending: null,
          file,
          sessionId: path.basename(file, path.extname(file)),
          agent,
          session: `${agent}:${path.basename(file, path.extname(file))}`,
          cwd: '',
          reportedAt: 0,
        };
        files.set(file, st);
      }
      // 路径本身就能说明是谁：先按路径定一次，读到 cwd 之后再纠正一次。
      adoptAgent(st);

      let sawState = false;
      readAppended(file, st, (rec) => {
        if (rec && typeof rec.cwd === 'string' && rec.cwd) st.cwd = rec.cwd;
        const next = stateOf(rec);
        if (!next) return;
        sawState = true;
        adoptAgent(st);
        const detail = detailOf(rec);
        if (!st.primed) { st.pending = { state: next, detail }; return; }
        // 状态没变也要更新那行小字：从「收到新指令」到「运行 Bash」再到「思考中」，
        // 一直是忙碌，但那一行得说它此刻到底在干什么。
        if (next === st.state && detail === st.detail) {
          // 新记录还在来、状态没变 = 它还在干活。重报一次把「静默」计时推新，
          // 否则一个长时间跑工具的忙碌会话会在 90 秒后变暗、30 分钟后被丢掉。
          if (sawState && next === 'busy' && Date.now() - (st.reportedAt || 0) > heartbeat) {
            emit(st, next, detail, true);
          }
          return;
        }
        emit(st, next, detail);
      });

      if (!st.primed) {
        st.primed = true;
        if (st.pending) emit(st, st.pending.state, st.pending.detail);
        st.pending = null;
      }
    }

    // 文件消失 / 过期：把对应会话收摊，别在灯上留残影。
    for (const [file, st] of files) {
      if (live.has(file)) continue;
      if (st.state && st.state !== 'offline') setState({ session: st.session, agent: st.agent, state: 'offline' });
      files.delete(file);
    }
  };

  tick();
  // 不要 unref：这个定时器是进程活着的唯一理由。unref 之后事件循环没有任何
  // 句柄，Node 会在第一次 tick 结束后直接 exit 0 —— 表现就是「灯闪一下就没」。
  const timer = setInterval(tick, interval);

  let watchServer = null;
  const stop = () => {
    clearInterval(timer);
    if (watchServer) clearInterval(watchServer);
    const jobs = [];
    for (const st of files.values()) {
      // watcher 退出 = 证据没了。已经亮着的会话要熄掉，否则它会替一个
      // 已经关掉的程序继续说话，直到 6 小时 TTL。
      if (st.state && st.state !== 'offline') {
        jobs.push(setState({ session: st.session, agent: st.agent, state: 'offline' }));
      }
    }
    files.clear();
    if (manual) return undefined;
    return Promise.allSettled(jobs).finally(() => process.exit(0));
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stop);
  // server 重启后把还活着的会话重报一遍：store 是新的，transcript 还在，
  // 但会话要等下一条记录才会重新出现。
  const resend = () => {
    for (const st of files.values()) {
      if (!st.state || st.state === 'offline') continue;
      setState({ session: st.session, agent: st.agent, state: st.state, detail: st.detail || '', cwd: st.cwd || '' });
    }
  };
  // 机器人退了就收摊：这个 watcher 原来没有守护，`bao stop` 之后会一直轮询。
  watchServer = keepAliveWith(stop, { onRecover: resend });
  // `watch all` 按 h.stop 优先于 clearInterval 处理，挂上去才能一并熄灯。
  timer.stop = stop;
  return timer;
}

module.exports = { run, stateOf, detailOf, listTranscripts, agentFor };
