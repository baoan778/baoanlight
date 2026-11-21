#!/usr/bin/env node
'use strict';
// Generic hook receiver — the escape hatch for agents that have no adapter yet.
//
// Give the agent one command to run at its lifecycle points, and let it pipe a
// JSON object on stdin (or pass it as an argument):
//
//   bao hook --agent deepseek
//   bao hook --agent workbuddy --state waiting --detail "approve plan?"
//
// Accepted payloads are deliberately forgiving, because every harness invents
// its own vocabulary. Any of these decide the robot:
//
//   { "state": "busy" }                        literal state, wins
//   { "event": "task_complete" }               mapped by log-watch.classify
//   { "type": "approval_request" }
//   { "hook_event_name": "Notification" }      Claude-shaped payloads too
//
// Like every other hook, this must never break or stall the agent it watches.

const { setState } = require('../client');

const STATES = ['error', 'waiting', 'busy', 'done', 'idle', 'offline'];

// Claude Code's names are the most common in the wild; reusing the same table
// here means a tool that copied Claude's hook vocabulary just works.
const CLAUDE_STYLE = {
  SessionStart: 'idle',
  UserPromptSubmit: 'busy',
  PreToolUse: 'busy',
  PostToolUse: 'busy',
  PreCompact: 'busy',
  Notification: 'waiting',
  Stop: 'idle',
  // CodeBuddy / WorkBuddy 在会话彻底结束时补发 FinalStop；和 claude.js 一样
  // 当作一次完成，而不是「无法识别的事件」。
  FinalStop: 'done',
  SessionEnd: 'offline',
};

// 与 hooks/claude.js 同一套判断：Claude Code 的 Notification 既可能是「要你
// 授权」，也可能只是「我闲着，等你输入」。后者若也亮黄灯，waiting 不会自己
// 衰减，灯会一直停在错误的状态上。
const IDLE_NOTICE = /waiting for (your|user)[\s-]+input|needs? (your|user)[\s-]+input|awaiting (your )?input/i;

function claudeStyleState(name, evt) {
  if (name !== 'Notification') {
    // 一调用就停下来等人的工具（提问、退出计划模式）：这是黄灯，不是绿灯。
    if (name === 'PreToolUse'
      && /ask_?user|ask_?question|exit_?plan_?mode|user_?input|request_?approval|permission/i
        .test(String(evt.tool_name || ''))) {
      return 'waiting';
    }
    // 和 hooks/claude.js 同一套失败判定：工具结果里显式的 is_error / success:false
    // 是唯一可靠的失败信号。通用钩子既然认 Claude 的事件形状，就不能在失败时
    // 继续亮绿灯 —— 两个入口对同一件事给出两种颜色，灯就在自相矛盾。
    if (name === 'PostToolUse' && evt.tool_response && typeof evt.tool_response === 'object'
      && (evt.tool_response.is_error === true || evt.tool_response.success === false)) {
      return 'error';
    }
    return CLAUDE_STYLE[name];
  }
  const text = `${evt.message || ''} ${evt.title || ''}`.trim();
  return text && IDLE_NOTICE.test(text) ? 'idle' : 'waiting';
}

function parseArgs(argv) {
  const out = { flags: {}, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      // 与 cli.js 同一个理由：只按第一个 `=` 切。`--detail=exit=1` 按所有等号
      // 切会只剩 "exit"，而 detail 正是要给人看的那行字。
      const eq = a.indexOf('=');
      const k = a.slice(2, eq < 0 ? undefined : eq);
      const v = eq < 0 ? undefined : a.slice(eq + 1);
      if (v !== undefined) out.flags[k] = v;
      // 见 cli.js：只把 `--` 开头的下一个参数当成另一个选项，别吞掉负值。
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else out.positional.push(a);
  }
  return out;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let raw = '';
  try {
    for await (const chunk of process.stdin) raw += chunk;
  } catch { /* no stdin is fine */ }
  return raw;
}

function pickState(evt, explicit) {
  if (explicit && STATES.includes(explicit)) return explicit;
  const declared = evt.state || evt.status || evt.new_state;
  if (STATES.includes(declared)) return declared;

  const name = evt.hook_event_name || evt.event || evt.event_type || evt.eventType
    || evt.type || evt.kind || evt.name;
  // 只认自己表里的键：`CLAUDE_STYLE['constructor']` 会顺着原型链返回一个函数
  // （真值），于是一个 `{"hook_event_name":"constructor"}` 的载荷就能绕过
  // 「未知事件不许动灯」，让状态变成一个函数、JSON 里丢掉、服务端按 idle 建会话。
  if (name && Object.prototype.hasOwnProperty.call(CLAUDE_STYLE, name)) return claudeStyleState(name, evt);

  // Defer to the log watcher's table so a new agent only needs one vocabulary.
  const { classify } = require('../adapters/log-watch');
  return classify(name);
}

// Called by `bao hook` with the leftover positional args and the parsed flags.
async function run(positional = [], flags = {}) {
  const agent = String(flags.agent || flags.a || 'agent').toLowerCase();

  const raw = positional.join(' ').trim() || await readStdin();
  let evt = {};
  if (raw) {
    try { evt = JSON.parse(raw); } catch { evt = { detail: raw }; }
  }
  if (!evt || typeof evt !== 'object' || Array.isArray(evt)) evt = {};

  const state = pickState(evt, flags.state);
  if (!state) return;   // unknown event: leave the last good state alone

  const sid = evt.session_id || evt.session || evt.sessionId || evt.thread_id
    || evt.conversation_id || flags.session || 'default';

  const detail = flags.detail
    || evt.detail
    || evt.message
    || (state === 'waiting' ? 'needs you' : state === 'busy' ? 'working' : '');

  const cwd = evt.cwd || process.cwd();

  const eventName = evt.hook_event_name || evt.event || evt.event_type || evt.eventType
    || evt.type || evt.kind || evt.name || '';

  await setState({
    session: `${agent}:${String(sid).slice(0, 64)}`,
    agent,
    state,
    detail: String(detail).slice(0, 120),
    cwd: cwd || '',
    source: 'hook',
    event: eventName,
  });
}

function failSafe(fn) {
  // A wedged socket must never hold the agent hostage.
  const bail = setTimeout(() => process.exit(0), 1500);
  bail.unref?.();
  fn().then(() => process.exit(0)).catch(() => process.exit(0));
}

if (require.main === module) {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  failSafe(() => run(positional, flags));
}

module.exports = { run, pickState, parseArgs, failSafe };
