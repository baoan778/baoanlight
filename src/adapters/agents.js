'use strict';
// What we know about each agent, in one place.
//
// Three tiers, best first:
//
//   hooks  the agent (or its harness) can run a command at lifecycle points
//   log    the agent appends a machine-readable session log we can tail
//   pty    nothing structured — run it under `bao wrap` and read the screen
//
// Adding an agent should mean adding an entry here (and, for the pty tier, a
// profile in patterns.js). The CLI, the doctor and the overlay all read this.

const fs = require('fs');
const os = require('os');
const path = require('path');

const home = () => os.homedir();
const firstEnv = (...names) => {
  for (const n of names) if (process.env[n]) return process.env[n];
  return null;
};

// Where desktop apps keep per-user data on this platform.
const appData = () => {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(home(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(home(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(home(), '.config');
};

// Directories are functions because HOME / env can differ per process (tests
// spawn the CLI with a fake HOME; users set CODEX_HOME or DEEPSEEK_HOME).
const LOG_DIRS = {
  codex: () => {
    const root = firstEnv('CODEX_HOME') || path.join(home(), '.codex');
    return [path.join(root, 'sessions')];
  },
  deepseek: () => {
    // DeepSeek Harness (`dsh`) keeps a plain-JSON projection per session; that
    // is what dsh-watch reads. The raw session is zstd-compressed JSONL.
    const roots = [
      firstEnv('DSH_HOME', 'DSH_DESKTOP_HOME'),
      path.join(appData(), 'dsh-desktop'),
      path.join(appData(), 'dsh-tauri'),
    ].filter(Boolean);
    return roots.flatMap((root) => [
      path.join(root, 'harness', 'storages', 'session_projcache', 'sessions'),
      path.join(root, 'storages', 'session_projcache', 'sessions'),
      // Older/self-hosted layouts put the raw sessions here; the generic JSONL
      // reader still works if someone points --dir at them.
      path.join(root, 'harness', 'sessions'),
      path.join(root, 'sessions'),
    ]);
  },
  workbuddy: () => {
    const root = firstEnv('WORKBUDDY_HOME') || path.join(home(), '.workbuddy');
    const appDataRoot = path.join(appData(), 'WorkBuddy');
    return [
      // Its task board is the only machine-readable state WorkBuddy leaves on
      // disk; `hooks` is the exact route.
      path.join(root, 'tasks'),
      path.join(root, 'sessions'),
      path.join(root, 'logs'),
      path.join(appDataRoot, 'tasks'),
      path.join(appDataRoot, 'logs'),
    ];
  },
  claude: () => {
    // Claude Code's transcripts are a bonus, not a requirement: the hook tier
    // is what we use. Kept here so `bao watch claude` can still work offline.
    return [
      path.join(home(), '.claude', 'projects'),
      path.join(home(), '.config', 'claude', 'projects'),
    ];
  },
  codebuddy: () => {
    // CodeBuddy / WorkBuddy 的 CLI 与 IDE 都把每轮对话写成
    //   ~/.workbuddy/projects/<项目>/<sessionId>.jsonl
    // 这是它唯一实时更新的结构化来源（任务板只在你建任务时才有内容）。
    const root = firstEnv('CODEBUDDY_HOME', 'WORKBUDDY_HOME') || path.join(home(), '.workbuddy');
    return [
      path.join(root, 'projects'),
      // 新版可能把 transcript 挪到自己的目录下（这台机器上该目录已存在，暂时是空的）。
      path.join(home(), '.codebuddy', 'projects'),
      path.join(appData(), 'WorkBuddy', 'projects'),
      path.join(appData(), 'CodeBuddy', 'projects'),
    ];
  },
};

const AGENTS = {
  claude: {
    label: 'Claude Code',
    tier: 'hooks',
    accent: '#d97757',
    how: 'eight lifecycle hooks',
    detail: 'exact, per session — `bao connect claude`',
    hooks: 'claude',
    logs: LOG_DIRS.claude,
  },
  codex: {
    label: 'Codex',
    tier: 'log',
    accent: '#9aa3b2',
    how: 'its own session rollout log',
    detail: 'all three states plus plan quota — `bao watch codex`',
    hooks: 'codex',
    logs: LOG_DIRS.codex,
  },
  deepseek: {
    label: 'DeepSeek Harness',
    tier: 'log',
    accent: '#4d7cff',
    how: 'its own session projection',
    detail: 'all three states — `bao watch deepseek`, or `bao hook --agent deepseek` for exact hooks',
    logs: LOG_DIRS.deepseek,
  },
  workbuddy: {
    label: 'WorkBuddy',
    tier: 'log',
    accent: '#ff7a59',
    how: 'its task board',
    detail: '`bao watch workbuddy` (coarse) — or exact via `bao hook --agent workbuddy`',
    logs: LOG_DIRS.workbuddy,
  },
  codebuddy: {
    label: 'CodeBuddy',
    tier: 'log',
    accent: '#2f9cf4',
    how: 'its session transcript',
    detail: 'exact, per turn — `bao watch codebuddy`（CodeBuddy / WorkBuddy CLI 共用）',
    logs: LOG_DIRS.codebuddy,
  },
  gemini: {
    label: 'Gemini CLI',
    tier: 'pty',
    accent: '#4c8bf5',
    how: 'a watched terminal',
    detail: '`bao wrap -- gemini`',
  },
  aider: {
    label: 'Aider',
    tier: 'pty',
    accent: '#2ea043',
    how: 'a watched terminal',
    detail: '`bao wrap -- aider --model sonnet`',
  },
  cursor: {
    label: 'Cursor',
    tier: 'pty',
    accent: '#7d8590',
    how: 'a watched terminal',
    detail: '`bao wrap --agent cursor -- cursor-agent`',
  },
  opencode: {
    label: 'opencode',
    tier: 'pty',
    accent: '#e0a80c',
    how: 'a watched terminal',
    detail: '`bao wrap -- opencode`',
  },
  copilot: {
    label: 'GitHub Copilot',
    tier: 'pty',
    accent: '#8b949e',
    how: 'a watched terminal',
    detail: '`bao wrap --agent copilot -- copilot`',
  },
  cline: {
    label: 'Cline',
    tier: 'pty',
    accent: '#00b4d8',
    how: 'a watched terminal',
    detail: '`bao wrap --agent cline -- cline`',
  },
  windsurf: {
    label: 'Windsurf',
    tier: 'pty',
    accent: '#09b6a2',
    how: 'a watched terminal',
    detail: '`bao wrap --agent windsurf -- windsurf`',
  },
  qwen: {
    label: 'Qwen Code',
    tier: 'pty',
    accent: '#615ced',
    how: 'a watched terminal',
    detail: '`bao wrap -- qwen`',
  },
  kimi: {
    label: 'Kimi CLI',
    tier: 'pty',
    accent: '#1f6feb',
    how: 'a watched terminal',
    detail: '`bao wrap -- kimi`',
  },
};

const names = () => Object.keys(AGENTS);

function find(name) {
  const key = String(name || '').toLowerCase();
  // `dsh` is what the DeepSeek Harness binary is called; accept the name people
  // actually type as well as the product name.
  if (key === 'dsh') return { name: 'deepseek', ...AGENTS.deepseek };
  if (AGENTS[key]) return { name: key, ...AGENTS[key] };
  // `workspace/agents/deepseek-harness` should still resolve.
  for (const key2 of names()) {
    if (key.includes(key2)) return { name: key2, ...AGENTS[key2] };
  }
  return null;
}

// Where an agent's logs actually are on *this* machine. A configured override
// in ~/.baoanlight/config.json wins over the defaults, because every harness
// eventually puts its home somewhere its author did not expect.
function logDir(name, { config = {}, explicit = null } = {}) {
  if (explicit) return explicit;
  const configured = config.agents?.[name]?.dir;
  if (configured) return configured;
  const candidates = typeof AGENTS[name]?.logs === 'function' ? AGENTS[name].logs() : [];
  for (const dir of candidates) {
    try { if (dir && fs.existsSync(dir)) return dir; } catch { /* keep looking */ }
  }
  return candidates[0] || null;
}

function candidates(name) {
  const entry = AGENTS[name];
  if (!entry || typeof entry.logs !== 'function') return [];
  return entry.logs();
}

module.exports = { AGENTS, names, find, logDir, candidates };
