#!/usr/bin/env node
'use strict';
// Codex CLI adapter.
//
// Codex calls the program in `notify` with a single JSON argument describing the
// event. It only fires on notable moments (turn finished, approval needed), so
// this adapter drives done (purple) and waiting (yellow). For a green "working"
// lamp as well, run Codex through `bao watch codex`, or `bao wrap -- codex` as a
// last resort — notify alone never sees the start of a turn.

const { setState, noteUnknown } = require('../client');

// 认不出来就**不要给状态**。
// 这里原来兜底 `return 'idle'`：任何没见过的/改了名的通知事件都会把灯点亮成
// 「就绪」绿灯，和 claude.js「未知事件不许动灯」的约定正好相反 —— 而绿灯是
// 承诺「它在待命」，是这个工具最不能随口说的一句话。
function classify(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('approval') || t.includes('request') || t.includes('input')) return 'waiting';
  // 成功收尾是 done（紫色），不是 idle（白色）：这是「刚刚做完」和「现在闲着」
  // 的区别，也是 docs/adapters.md 的事件词表。日志观察器早就这样映射了，
  // 两个适配器对同一个词给出两种颜色，就是灯在自相矛盾。
  if (t.includes('complete') || t.includes('finish') || t.includes('done')) return 'done';
  if (t.includes('start') || t.includes('begin') || t.includes('turn')) return 'busy';
  return null;
}

async function main() {
  let evt = {};
  const arg = process.argv.slice(2).join(' ').trim();
  if (arg) { try { evt = JSON.parse(arg); } catch { /* keep defaults */ } }

  const session = evt['thread-id'] || evt.thread_id || evt.session_id
    ? `codex:${evt['thread-id'] || evt.thread_id || evt.session_id}`
    : 'codex:default';
  const state = classify(evt.type);
  if (!state) {
    // 认不出来的通知：把它记下来（仪表板会显示 `?`），但绝不改灯。
    await noteUnknown({ event: String(evt.type || 'codex'), session });
    return;
  }
  await setState({
    session,
    agent: 'codex',
    state,
    detail: state === 'waiting' ? 'needs approval' : '',
    cwd: evt.cwd || '',
  });
}

const bail = setTimeout(() => process.exit(0), 1500);
bail.unref?.();

main().then(() => process.exit(0)).catch(() => process.exit(0));
