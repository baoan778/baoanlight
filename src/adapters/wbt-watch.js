'use strict';
// CodeBuddy / WorkBuddy CLI 的会话 transcript。
//
// 这类 IDE/CLI 会把每一轮对话按记录类型追加到
//   ~/.workbuddy/projects/<项目名>/<sessionId>.jsonl
// 里面是逐条的 JSON（reasoning / function_call / message …），比「任务板」精确得多：
// 任务板只在你建了任务时才有 in_progress，平时一直是空的。
//
// 我们只读记录的**类型与工具名**，不读正文 —— 这些文件里全是 prompt 和工具输出，
// 一个状态灯没有理由把它们复制到别处。
//
//   reasoning / function_call / function_call_result  -> busy（模型在思考、在调工具）
//   message(role=user)                               -> busy（新一轮开始）
//   message(role=assistant)                          -> done（这一轮结束，紫灯闪一下再回空闲）
//   session-meta / file-history-snapshot / ai-title   -> 不改变状态

const fs = require('fs');
const path = require('path');
const { setState } = require('../client');
const agents = require('./agents');

const POLL_MS = 1500;
const TAIL_MAX = 256 * 1024;      // 首读时只回看尾部，别把 2MB 的老对话整段扫一遍
const ACTIVE_MS = 30 * 60 * 1000; // 半小时没新记录的会话不再显示

// 记录 -> 状态。返回 null 表示「这条不改变状态」。
function stateOf(rec) {
  const t = rec && rec.type;
  if (t === 'reasoning' || t === 'function_call' || t === 'function_call_result') return 'busy';
  if (t === 'message') return rec.role === 'assistant' ? 'done' : 'busy';
  return null;
}

// 一句人话，给列表那一行用。只用到工具名，正文一律不碰。
function detailOf(rec) {
  const t = rec && rec.type;
  if (t === 'function_call') return rec.name ? `运行 ${String(rec.name).slice(0, 24)}` : '调用工具';
  if (t === 'function_call_result') return '工具返回';
  if (t === 'reasoning') return '思考中';
  if (t === 'message') return rec.role === 'assistant' ? '这一轮结束' : '收到新指令';
  return '';
}

function listTranscripts(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (/\.jsonl$/i.test(e.name)) out.push(p);
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

function run({ dir, interval = POLL_MS, quiet = false, agent = 'codebuddy' } = {}) {
  // `--dir` 没给就自己找默认位置：别的 watcher 都这么做，CLI 只负责把 --dir 传进来。
  const root = dir || agents.logDir('codebuddy', { config: require('../config').load() });
  if (!root || !fs.existsSync(root)) {
    console.error(`codebuddy: no transcript directory at ${root || '(unset)'} — run: bao watch codebuddy --dir <path>`);
    process.exit(1);
  }

  const files = new Map();   // path -> { offset, buffer, state, primed, session, cwd }

  const emit = (st, next, detail) => {
    st.state = next;
    setState({ session: st.session, agent, state: next, detail, cwd: st.cwd || '' });
    if (!quiet) {
      const time = new Date().toISOString().slice(11, 19);
      console.log(`  ${time}  ${st.session.split(':').pop().slice(0, 12)} -> ${next}${detail ? ' ' + detail : ''}`);
    }
  };

  const tick = () => {
    const now = Date.now();
    const live = new Set();

    for (const file of listTranscripts(root)) {
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
          primed: false,
          pending: null,
          session: `${agent}:${path.basename(file, path.extname(file))}`,
          cwd: '',
        };
        files.set(file, st);
      }

      readAppended(file, st, (rec) => {
        if (rec && typeof rec.cwd === 'string' && rec.cwd) st.cwd = rec.cwd;
        const next = stateOf(rec);
        if (!next) return;
        if (!st.primed) { st.pending = { state: next, detail: detailOf(rec) }; return; }
        if (next === st.state) return;
        emit(st, next, detailOf(rec));
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
      if (st.state && st.state !== 'offline') setState({ session: st.session, agent, state: 'offline' });
      files.delete(file);
    }
  };

  tick();
  // 不要 unref：这个定时器是进程活着的唯一理由。unref 之后事件循环没有任何
  // 句柄，Node 会在第一次 tick 结束后直接 exit 0 —— 表现就是「灯闪一下就没」。
  return setInterval(tick, interval);
}

module.exports = { run, stateOf, detailOf, listTranscripts };
