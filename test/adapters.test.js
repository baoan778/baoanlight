'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { profileFor, stripAnsi, PROFILES } = require('../src/adapters/patterns');
const { classify } = require('../src/adapters/codex-watch');

// ---------------------------------------------------------------- patterns

test('agent profiles resolve from however the binary is named', () => {
  assert.equal(profileFor('gemini').name, 'gemini');
  assert.equal(profileFor('/usr/local/bin/claude').name, 'claude');
  assert.equal(profileFor('C:\\Users\\x\\AppData\\npm\\cursor-agent.cmd').name, 'cursor');
  assert.equal(profileFor('totally-unknown-agent').name, 'totally-unknown-agent');
  assert.deepEqual(profileFor('totally-unknown-agent').waiting, PROFILES.default.waiting);
});

test('ANSI is stripped so patterns match what the user actually sees', () => {
  assert.equal(stripAnsi('\u001b[1;32mDone\u001b[0m'), 'Done');
  assert.equal(stripAnsi('\u001b]0;window title\u0007text'), 'text');
  assert.equal(stripAnsi('plain'), 'plain');
});

const hits = (rules, s) => rules.some((re) => re.test(s));

test('real confirmation prompts are recognised as waiting', () => {
  const p = profileFor('default');
  for (const prompt of [
    'Do you want to proceed? (y/n)',
    'Apply this change? [y/N]',
    'Allow Bash to run this command?',
    '  1. Yes\n  2. No\n❯ 1. Yes',
    'Press Enter to continue',
    'Waiting for your confirmation',
    // 中文确认框：中文界面的代理（WorkBuddy、自研 harness）不带英文 (y/n)，
    // 认不出来就会把「在等你」显示成绿灯。
    '是否继续？',
    '是否允许执行此命令？',
    '确认删除？',
    '请确认 [是/否]',
    '按回车继续',
    '等待你的确认',
  ]) {
    assert.ok(hits(p.waiting, prompt), `should be waiting: ${JSON.stringify(prompt)}`);
  }
});

test('ordinary output is not mistaken for a prompt', () => {
  const p = profileFor('default');
  for (const line of [
    'Reading src/server.js',
    'Wrote 42 lines to disk.',
    'All tests passed.',
    'Committed as a1b2c3d',
    // 中文正文里出现「确认」很常见：只有行尾问号/括号选择才算在等你。
    '已确认配置文件路径，继续读取。',
    '这里需要一个确认机制，我们稍后实现。',
    '更新时间：2026-11-15',
  ]) {
    assert.ok(!hits(p.waiting, line), `should NOT be waiting: ${JSON.stringify(line)}`);
  }
});

test('silent thinking still reads as busy', () => {
  const p = profileFor('claude');
  assert.ok(hits(p.busy, '⠹ Thinking…'));
  assert.ok(hits(p.busy, '(esc to interrupt)'));
  // 中文「进行中」的常见说法。
  assert.ok(hits(p.busy, '正在思考…'));
  assert.ok(hits(p.busy, '正在执行命令'));
});

// ------------------------------------------------------------------ codex

test('codex events map onto the full state set', () => {
  assert.equal(classify('task_started'), 'busy');
  assert.equal(classify('task_complete'), 'done');
  assert.equal(classify('task_completed'), 'done');
  assert.equal(classify('task_aborted'), 'idle');
  assert.equal(classify('task_failed'), 'error');
  assert.equal(classify('run_failed'), 'error');
  assert.equal(classify('exec_approval_request'), 'waiting');
  assert.equal(classify('apply_patch_approval_request'), 'waiting');
});

// Same class of bug as Claude's SubagentStop: an event arriving after the turn
// ended must not be able to change the lamp.
test('ambient codex events are inert and cannot revive a finished session', () => {
  for (const t of ['token_count', 'agent_message', 'agent_reasoning', 'web_search_end', 'mcp_tool_call_end']) {
    assert.equal(classify(t), null, `${t} must not decide state`);
  }
});

// ------------------------------------------------------- claude hook mapping

const HOOK = path.join(__dirname, '..', 'src', 'hooks', 'claude.js');

// Runs the hook with no server listening: it must still exit 0 and stay silent,
// because a hook that fails or hangs stalls the agent it is supposed to watch.
function runHook(event) {
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify(event),
    env: { ...process.env, BAOANLIGHT_PORT: '4999', BAOANLIGHT_LOG: '0' },
    encoding: 'utf8',
    timeout: 5000,
  });
  return out;
}

test('hook never breaks the agent when the light is not running', () => {
  for (const name of ['Stop', 'PreToolUse', 'Notification', 'SubagentStop', 'WhoKnows']) {
    assert.doesNotThrow(() => runHook({ session_id: 't', hook_event_name: name }), name);
  }
});

test('hook survives malformed input', () => {
  assert.doesNotThrow(() =>
    execFileSync(process.execPath, [HOOK], {
      input: 'not json at all',
      env: { ...process.env, BAOANLIGHT_PORT: '4999', BAOANLIGHT_LOG: '0' },
      encoding: 'utf8',
      timeout: 5000,
    })
  );
});

// ------------------------------------------------------- other harnesses

const logWatch = require('../src/adapters/log-watch');
const agents = require('../src/adapters/agents');
const { pickState } = require('../src/hooks/event');

// DeepSeek Harness and WorkBuddy do not ship log schemas we control, so they
// share one forgiving vocabulary. The point is that a new agent needs a
// profile entry, not a new watcher.
test('one event vocabulary covers the new harnesses', () => {
  for (const name of ['approval_request', 'needs_input', 'exec_approval_request', 'user_input_request']) {
    assert.equal(logWatch.classify(name), 'waiting', name);
  }
  for (const name of ['run_started', 'turn_started', 'step_started', 'reasoning_started']) {
    assert.equal(logWatch.classify(name), 'busy', name);
  }
  for (const name of ['task_completed', 'turn_completed', 'finished', 'completed', 'done']) {
    assert.equal(logWatch.classify(name), 'done', name);
  }
  for (const name of ['turn_end', 'stop', 'agent_end', 'task_aborted']) {
    assert.equal(logWatch.classify(name), 'idle', name);
  }
  for (const name of ['task_failed', 'run_failed', 'error', 'crashed']) {
    assert.equal(logWatch.classify(name), 'error', name);
  }
  // Codex 的模型流中断：同时含 "stream"，不能被当成环境噪音静默吞掉。
  for (const name of ['stream_error', 'stream_failed', 'upstream_error', 'connection_failed']) {
    assert.equal(logWatch.classify(name), 'error', name);
  }
  assert.equal(logWatch.classify('session_end'), 'offline');
  for (const name of ['token_count', 'agent_message', 'reasoning_delta', 'mcp_tool_call_end']) {
    assert.equal(logWatch.classify(name), null, `${name} must stay ambient`);
  }
});

// Codex 把真正的事件嵌在 payload 里。response_item 直接返回自身类型，会让一个
// 工具调用变成字面量 "response_item"，没有任何状态表认识它 —— 整轮工作对灯是隐形的。
test('codex response_item turns are recognised, not hidden behind the wrapper name', () => {
  const at = (payload) => logWatch.typeOf({ type: 'response_item', payload });
  assert.equal(at({ type: 'function_call' }), 'function_call');
  assert.equal(logWatch.classify(at({ type: 'function_call' })), 'busy');
  assert.equal(logWatch.classify(at({ type: 'function_call_output' })), 'busy');
  assert.equal(logWatch.classify(at({ type: 'reasoning' })), 'busy');
  assert.equal(logWatch.classify(at({ type: 'local_shell_call' })), 'busy');
  // event_msg 一直是对的，别改坏。
  assert.equal(logWatch.typeOf({ type: 'event_msg', payload: { type: 'task_complete' } }), 'task_complete');
  // 元数据行保留自己的类型，由上层忽略。
  assert.equal(logWatch.typeOf({ type: 'turn_context', payload: { cwd: '/x' } }), 'turn_context');
});

// Every advertised agent must resolve, or `bao agents` lies.
test('the registry knows every agent the CLI advertises', () => {
  for (const name of ['claude', 'codex', 'deepseek', 'workbuddy', 'gemini', 'aider', 'cursor', 'opencode', 'copilot']) {
    assert.ok(agents.find(name), `${name} must be in the registry`);
    assert.equal(agents.find(name).name, name);
  }
  assert.equal(agents.find('deepseek-harness').name, 'deepseek', 'long names resolve too');
  assert.equal(agents.find('nonsense-agent'), null);
  assert.ok(agents.candidates('deepseek').length >= 3, 'deepseek has candidate log dirs');
  assert.ok(agents.candidates('workbuddy').length >= 3, 'workbuddy has candidate log dirs');
});

// The generic hook is the escape hatch for a tool nobody has written an
// adapter for: a literal state, a Claude-shaped event, or a plain synonym.
test('the generic hook maps literal states and common event names', () => {
  assert.equal(pickState({}, 'waiting'), 'waiting');
  assert.equal(pickState({ state: 'busy' }), 'busy');
  assert.equal(pickState({ state: 'done' }), 'done');
  assert.equal(pickState({ state: 'error' }), 'error');
  assert.equal(pickState({ hook_event_name: 'Notification' }), 'waiting');
  // 空闲提醒不是「需要你处理」：waiting 不会自己衰减，认错了灯会黄很久。
  assert.equal(pickState({ hook_event_name: 'Notification', message: 'Claude is waiting for your input' }), 'idle');
  assert.equal(pickState({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }), 'waiting');
  // 一调用就停下来等人的工具：PreToolUse 应该是黄灯，而不是绿灯。
  assert.equal(pickState({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }), 'waiting');
  assert.equal(pickState({ hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode' }), 'waiting');
  assert.equal(pickState({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }), 'busy');
  // 工具结果里的显式失败必须是红灯：通用钩子认的是 Claude 的形状，就必须和
  // hooks/claude.js 给出同一个颜色。
  assert.equal(pickState({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { is_error: true },
  }), 'error');
  assert.equal(pickState({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { success: false },
  }), 'error');
  assert.equal(pickState({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: 'ok' },
  }), 'busy', 'an ordinary result does not turn the lamp red');
  // CodeBuddy 的收尾事件与 claude.js 保持一致。
  assert.equal(pickState({ hook_event_name: 'FinalStop' }), 'done');
  assert.equal(pickState({ event: 'task_complete' }), 'done');
  assert.equal(pickState({ type: 'approval_request' }), 'waiting');
  assert.equal(pickState({ type: 'something_unknown' }), null, 'unknown leaves state alone');
});

// DeepSeek Harness (dsh) writes a projection of reducer rows per session. Only
// three of those rows describe live state; everything else is history.
const dsh = require('../src/adapters/dsh-watch');

test('dsh projection rows map onto the three robot states', () => {
  const rows = (val) => ({ rows: val });

  assert.equal(
    dsh.deriveDshState(rows({ userQuestions: { val: { questions: { active: [{ id: 'q1' }] } } } })),
    'waiting',
    'a pending question needs a human'
  );
  assert.equal(
    dsh.deriveDshState(rows({ turnBoundary: { val: { openTurnStartSeq: 4 } } })),
    'busy',
    'an open turn is working'
  );
  assert.equal(
    dsh.deriveDshState(rows({ sessionStats: { val: { openStep: { id: 1 } } } })),
    'busy',
    'an open step is working even before the turn boundary is written'
  );
  assert.equal(
    dsh.deriveDshState(rows({ turnBoundary: { val: { lastTurn: 2, openTurnStartSeq: null } } })),
    'idle',
    'a finished turn is ready for the next task'
  );
  assert.equal(dsh.deriveDshState(rows({})), null, 'a brand-new session claims nothing');
  assert.equal(dsh.deriveDshState(null), null);
});

// dsh is the only source that hands us a real "how much is left" number:
// context pressure. It must be reported as remaining, never as used — and it
// must come from the provider-anchored figure, not the heuristic breakdown.
test('dsh context pressure becomes remaining context', () => {
  const at = (pressure) => dsh.deriveDshFuel({ rows: { contextPressure: { val: pressure } } });

  assert.equal(Math.round(at({ pressureTokens: 64000, contextWindow: 256000 }).remaining), 75);
  assert.equal(Math.round(at({ projectedTokens: 64000, contextWindow: 256000 }).remaining), 75);
  assert.equal(Math.round(at({ projectedTokens: 70000, pressureTokens: 64000, contextWindow: 256000 }).remaining), 73,
    'the projected size of the next request wins when both exist');
  assert.equal(at({ pressureTokens: 300000, contextWindow: 256000 }).remaining, 0,
    'overfull clamps at empty, not negative');
  assert.equal(at({ surfaceTokens: 1979825, contextWindow: 1048576 }), null,
    'heuristic surfaceTokens is composition, not occupancy — 0% would be a false alarm');
  assert.equal(at({ surfaceTokens: 64000, contextWindow: 256000 }), null,
    'no provider-anchored number means no honest percentage');
  assert.equal(at({ projectedTokens: null, pressureTokens: 64000, contextWindow: 256000 }).remaining, 75,
    'a null projection falls back to the reported pressure');
  assert.equal(at({ pressureTokens: 64000, contextWindow: 0 }), null, 'no window means no honest percentage');
  assert.equal(dsh.deriveDshFuel({ rows: {} }), null);
});

// WorkBuddy numbers its task files 1.json, 2.json inside a per-task folder.
// Naming the session after the file would merge every task into one session.
test('task files borrow their folder name so sessions do not collide', () => {
  assert.equal(logWatch.fallbackId('C:/x/tasks/abc-123/1.json'), 'abc-123');
  assert.equal(logWatch.fallbackId('C:/x/tasks/def-456/1.json'), 'def-456');
  assert.equal(logWatch.fallbackId('C:/x/rollout-2026-11-09.jsonl'), 'rollout-2026-11-09');
});

// A task board says "in progress" rather than "task_started"; the same
// vocabulary has to cover both spellings.
test('status fields map like events', () => {
  assert.equal(logWatch.classify('in_progress'), 'busy');
  assert.equal(logWatch.classify('completed'), 'done');
  assert.equal(logWatch.classify('failed'), 'error');
  assert.equal(logWatch.classify('pending'), null, 'a pending task is not work');
});

// WorkBuddy's board is coarse on purpose: an in-progress item is work, a fully
// completed list is done, and a list nobody has touched has nothing to say.
const tasks = require('../src/adapters/task-watch');

test('the workbuddy task board reports only what it can prove', () => {
  assert.equal(tasks.deriveTaskState([{ status: 'completed' }, { status: 'in_progress' }]), 'busy');
  // 全部完成 = done（紫），不是 idle：完成值得被看见一次，也才有「已完成」通知。
  assert.equal(tasks.deriveTaskState([{ status: 'completed' }, { status: 'done' }]), 'done');
  assert.equal(tasks.deriveTaskState([{ status: 'failed' }, { status: 'completed' }]), 'error');
  assert.equal(tasks.deriveTaskState([{ status: 'blocked' }, { status: 'completed' }]), 'waiting');
  assert.equal(tasks.deriveTaskState([{ status: 'pending' }, { status: 'pending' }]), null);
  assert.equal(tasks.deriveTaskState([]), null);
  assert.equal(tasks.deriveTaskState([{ status: 'cancelled' }]), 'idle');
});
