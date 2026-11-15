#!/usr/bin/env node
'use strict';
// Claude Code hook adapter.
//
// Claude Code pipes a JSON event on stdin for every lifecycle hook. One script
// handles them all and maps each to a state. Registered by `bao connect claude`.
//
// Never fail loudly: a hook that errors or hangs stalls the agent it watches.

const fs = require('fs');
const path = require('path');
const { setState, noteUnknown } = require('../client');
const { DIR, ensureDir } = require('../config');

// 同一个脚本被多套 hook 协议复用：Claude Code 报 claude，CodeBuddy/WorkBuddy 也
// 用这同一份（命令带 `--agent codebuddy`）。否则 CodeBuddy 的事件会被标成 claude，
// 和真 Claude 撞在同一条会话上互相覆盖。
const agent = (() => {
  const i = process.argv.indexOf('--agent');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'claude';
})();

// Every event that arrives, appended to ~/.baoanlight/hook-events.log.
// Cheap, and the only way to see what an agent actually sends versus what its
// docs claim. Set BAOANLIGHT_LOG=0 to turn it off.
function log(line) {
  if (process.env.BAOANLIGHT_LOG === '0' || process.env.SIGNALHEAD_LOG === '0') return;
  try {
    ensureDir();
    const file = path.join(DIR, 'hook-events.log');
    try { if (fs.statSync(file).size > 256 * 1024) fs.truncateSync(file, 0); } catch {}
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging must never break the agent */ }
}

const EVENT_STATE = {
  SessionStart: 'idle',
  UserPromptSubmit: 'busy',
  PreToolUse: 'busy',
  PostToolUse: 'busy',
  PreCompact: 'busy',
  Notification: 'waiting',   // permission prompt / "Claude is waiting for your input"
  Stop: 'idle',              // turn finished, ready for a new task
  // CodeBuddy / WorkBuddy 在会话彻底结束时补发 FinalStop（带 final_stop_reason）。
  // 不映射的话它会落到「无法识别的事件」，在面板上挂一条提示 —— 而这其实是个
  // 再正常不过的收尾。映射成 done，紫灯闪一下再回空闲。
  FinalStop: 'done',
  SessionEnd: 'offline',
};

// A tool that came back with an error is the only failure signal Claude Code
// gives us, and it is an explicit one: `is_error` / `success: false`. Anything
// softer (an "error" field in otherwise valid output) is left alone — a red
// lamp over a working agent is the one thing this must never do.
function toolFailed(evt) {
  const r = evt.tool_response;
  if (!r || typeof r !== 'object') return false;
  return r.is_error === true || r.success === false;
}

// Events that say nothing reliable about the main agent's state.
//
// SubagentStop looks like it means "a subagent finished, so the parent is still
// working" — but it lands a few seconds *after* Stop at the end of a turn. Mapping
// it to busy turned the lamp yellow again the instant it went green, and left it
// there. The main agent's own Pre/PostToolUse and Stop already track it exactly,
// so this adds nothing but a race.
const IGNORED = new Set(['SubagentStop']);

function detailFor(evt) {
  switch (evt.hook_event_name) {
    case 'PreToolUse':
      return evt.tool_name ? `running ${evt.tool_name}` : 'running a tool';
    case 'PostToolUse':
      return 'thinking';
    case 'UserPromptSubmit':
      return 'thinking';
    case 'Notification':
      return String(evt.message || 'needs your confirmation').slice(0, 80);
    case 'PreCompact':
      return 'compacting context';
    case 'Stop':
      return '';
    default:
      return '';
  }
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let evt = {};
  let parsed = true;
  try { evt = JSON.parse(raw || '{}'); } catch { parsed = false; }

  const name = evt.hook_event_name;
  const sid = String(evt.session_id || 'default').slice(0, 8);

  if (IGNORED.has(name)) {
    log(`${name} ignored [${sid}]`);
    return;
  }

  // An unrecognised event used to fall back to "busy", which pinned the lamp
  // yellow forever whenever anything unexpected arrived. It must not move the
  // lamp — but staying silent about it leaves the user with a robot that
  // "does nothing" and no way to learn why, so the fact is reported separately
  // from the state and shown as a question mark, never as a colour.
  if (!Object.prototype.hasOwnProperty.call(EVENT_STATE, name)) {
    // 只记「结构」，绝不记内容：这些载荷里常带 prompt、tool_input 和完整路径，
    // 而 hook-events.log 是明文的，默认就在 ~/.baoanlight/ 下。排查「是我们没
    // 认出来还是对方换了词汇」时，字段名 + 长度已经足够了。
    const shape = Object.keys(evt).map((k) => {
      const v = evt[k];
      const size = typeof v === 'string' ? v.length
        : (v && typeof v === 'object' ? Object.keys(v).length : 0);
      return `${k}:${typeof v}(${size})`;
    }).join(' ');
    log(`UNKNOWN event=${JSON.stringify(name)} parsed=${parsed} ${shape}`);
    await noteUnknown({ event: String(name || '(no event name)'), session: sid });
    return;
  }

  const state = name === 'PostToolUse' && toolFailed(evt) ? 'error' : EVENT_STATE[name];
  const cwd = evt.cwd || process.cwd();
  log(`${name} -> ${state}${evt.tool_name ? ' (' + evt.tool_name + ')' : ''} [${sid}]`);

  await setState({
    session: evt.session_id ? `${agent}:${evt.session_id}` : `${agent}:default`,
    agent,
    state,
    detail: state === 'error' ? `${evt.tool_name || 'tool'} failed` : detailFor(evt),
    cwd: cwd || '',
  });
}

// Hard stop so a wedged socket can never hold the agent hostage.
const bail = setTimeout(() => process.exit(0), 1500);
bail.unref?.();

main().then(() => process.exit(0)).catch(() => process.exit(0));
