'use strict';
// Universal adapter: run any CLI agent inside a pseudo-terminal, pass every byte
// through untouched, and infer the lamp from what it prints.
//
//   bao wrap -- gemini
//   bao wrap --agent aider -- aider --model sonnet
//
// This is the fallback for agents with no hook API. Agents that do have one
// (Claude Code, Codex) should use `bao connect` instead — it is exact, this is
// a very good guess.

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { profileFor, stripAnsi } = require('./patterns');
const { setState } = require('../client');

// How much recent output to keep, and how far back each kind of rule may look.
// A confirmation prompt is always the last thing on screen, so `waiting` gets a
// short window — otherwise an answered prompt keeps matching and the lamp sticks
// on red for the rest of the session.
const TAIL_MAX = 3000;
const WAITING_WINDOW = 600;
const BUSY_WINDOW = 1500;

function loadPty() {
  try {
    return require('node-pty');
  } catch {
    return null;
  }
}

// A pty spawns through CreateProcess, which — unlike a shell — will not search
// PATH for a bare name, and cannot execute a .cmd shim at all. Most agent CLIs
// are installed as exactly such a shim.
function which(cmd) {
  if (cmd.includes('/') || cmd.includes('\\')) return path.resolve(cmd);
  const exts = ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
    }
  }
  return cmd;
}

function resolveSpawn(command, args) {
  const file = which(command);
  if (/\.(cmd|bat)$/i.test(file)) {
    // cmd.exe /c 会把 & | < > ^ ( ) 当命令分隔/重定向解析：参数里带这些字符
    // （模型名、带 & 的提示词）会被截断，甚至执行不该执行的片段。用 ^ 转义成
    // 字面量；file 路径也一样处理（路径里可能有括号）。
    const esc = (a) => String(a).replace(/([&|<>^()])/g, '^$1');
    return [process.env.COMSPEC || 'cmd.exe', ['/c', esc(file), ...args.map(esc)]];
  }
  return [file, args];
}

function run(argv, opts = {}) {
  const pty = loadPty();
  if (!pty) {
    console.error(
      [
        'bao wrap needs a pseudo-terminal so the agent keeps its full interactive UI.',
        '',
        '  npm install node-pty        (inside ' + path.resolve(__dirname, '..', '..') + ')',
        '',
        'Agents with a hook API do not need this at all:',
        '  bao connect claude',
        '  bao watch codex',
      ].join('\n')
    );
    process.exit(1);
  }

  const [command, ...args] = argv;
  const profile = profileFor(opts.agent || command);
  const agent = opts.agent || profile.name;
  const session = `wrap:${agent}:${crypto.randomBytes(4).toString('hex')}`;
  const cwd = process.cwd();

  let tail = '';
  let current = null;
  let quietTimer = null;

  const push = (state, detail = '') => {
    if (state === current) return;
    current = state;
    setState({ session, agent, state, detail, cwd });
  };

  const matches = (rules, window) => {
    const text = tail.slice(-window);
    return rules.some((re) => re.test(text));
  };
  // 提示永远在屏幕的最后一行。拿整段尾巴去匹配，会把 agent 打印的 diff、
  // 文档正文里出现的一句 "[y/N]" 当成在等你；而 push 按「状态变化」去重，
  // 一旦误点成黄灯，就会一直黄到那句被新输出挤出窗口为止。
  const lastLine = () => {
    const lines = tail.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line) return line;
    }
    return '';
  };
  const isWaiting = () => {
    const line = lastLine().slice(-WAITING_WINDOW);
    return !!line && profile.waiting.some((re) => re.test(line));
  };

  const settle = () => {
    // Output stopped. Decide what the silence means. 只有静默之后才可能是「在等你」：
    // 输出还在流的时候它一定在干活。
    if (isWaiting()) push('waiting', 'needs your confirmation');
    else if (matches(profile.busy, BUSY_WINDOW)) push('busy', 'thinking');
    else push('idle');
  };

  const onOutput = (data) => {
    tail = (tail + stripAnsi(data)).slice(-TAIL_MAX);
    // 输出还在流 = 正在干活。waiting 的判定挪进 settle()，否则流式输出里任何
    // 一句 "continue?" 都会把灯提前点黄 —— 对一次长工具调用来说，就是整段时间
    // 都在说「需要你」，这个工具唯一的核心承诺因此被打破。
    push('busy', 'working');
    clearTimeout(quietTimer);
    quietTimer = setTimeout(settle, profile.idleAfterMs);
  };

  const [file, fileArgs] = resolveSpawn(command, args);
  const child = pty.spawn(file, fileArgs, {
    name: process.env.TERM || 'xterm-256color',
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 30,
    cwd,
    env: { ...process.env, BAOANLIGHT_SESSION: session, BAOANLIGHT_AGENT: agent },
    useConpty: undefined,
  });

  push('busy', 'starting');

  child.onData((d) => {
    process.stdout.write(d);
    onOutput(d);
  });

  // Keystrokes go straight to the agent; typing also means the user is present,
  // so a red light clears the moment they answer.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  // raw mode 下 Node 的读分块不保证字符对齐：一个多字节字符的字节序列可能被拆进
  // 两个 data 事件，各自 toString('utf8') 会把半个序列解成 �。StringDecoder 会
  // 把不完整的尾字节攒到下一次，中文/emoji 才不会被敲成乱码。
  const stdinDecoder = new StringDecoder('utf8');
  process.stdin.on('data', (d) => {
    child.write(stdinDecoder.write(d));
    if (current === 'waiting') {
      // The question has been answered, so drop the prompt from the tail before
      // the agent's next output is matched against it.
      tail = '';
      push('busy', 'working');
    }
  });

  const onResize = () => {
    try { child.resize(process.stdout.columns || 120, process.stdout.rows || 30); } catch {}
  };
  process.stdout.on('resize', onResize);

  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(quietTimer);
    process.stdout.removeListener('resize', onResize);
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} }
    process.stdin.pause();
    setState({ session, agent, state: 'offline' }).finally(() => process.exit(code || 0));
  };

  // Windows 上 pty 的「子进程」其实是 `cmd.exe /c <shim>`，真正的 agent 是
  // 它的孙进程。只 kill cmd.exe 会把 agent 留成孤儿：终端关了，代理还在跑，
  // 灯却已经下线。/T 才会连整棵树一起收掉。
  const killTree = () => {
    if (child.pid) {
      try {
        require('child_process').execFileSync(
          'taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        return;
      } catch { /* 没 taskkill 或被拒绝：退回 child.kill */ }
    }
    try { child.kill(); } catch { /* 已经退出 */ }
  };

  // 任何异常退出路径也要把终端还回去：留着 raw mode 的终端不再回显回车，
  // 用户只会以为自己的 shell 坏了。
  process.on('exit', () => {
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch { /* 已经关了 */ } }
  });

  child.onExit(({ exitCode }) => finish(exitCode));

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      killTree();
      // pty 的退出事件不保证会回来（被强杀的 conhost、卡住的 shell）。
      // 一秒后无论如都把终端还回去，别让用户对着一个不回显的 shell。
      setTimeout(() => finish(0), 1000).unref?.();
    });
  }
}

module.exports = { run };
