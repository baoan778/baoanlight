'use strict';
// cc-switch awareness.
//
// cc-switch is a provider switcher for Claude Code / Codex: it rewrites their
// configs so, say, "Claude Code" actually runs on a DeepSeek model through a
// local proxy. The robot's job is to say what an agent *is*, so when an agent
// is no longer what its name claims, that has to be visible.
//
// This module only reads. It never writes cc-switch's files — those belong to
// cc-switch, and a status light that edits your provider config is a bug.
//
//   ~/.cc-switch/live-state.json   → attached / mode / proxy_route per app
//   ~/.cc-switch/settings.json     → current provider id per app
//   ~/.claude/settings.json        → the model it is actually using (env)
//   ~/.codex/config.toml           → codex model
//
// Every read is best-effort: a missing file means "no answer", never an error.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();

// Alternate home for tests and exotic installs: cc-switch's files normally
// live in the real home directory, but the overlay tests must not depend on
// whatever provider happens to be selected on the machine running them.
function ccSwitchHome() {
  return process.env.BAOANLIGHT_CCSWITCH_HOME || HOME;
}

function appData() {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

// The model Claude Code is really talking to. cc-switch writes the provider's
// model into these env vars; the *_NAME variants hold the plain model id.
function claudeModel(home = ccSwitchHome()) {
  const s = readJson(path.join(home, '.claude', 'settings.json'));
  const env = s && s.env;
  if (!env) return null;
  // `ANTHROPIC_MODEL` 是主模型的显式覆盖（cc-switch 常写它）。三个 *_DEFAULT_*
  // 是档位别名：供应商把 opus/sonnet/haiku 全映射到同一个模型时取哪个都对，但
  // 用户手动切到 sonnet 档时只有 ANTHROPIC_MODEL 说得准，所以先读它。
  return env.ANTHROPIC_MODEL
    || env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME
    || env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME
    || env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME
    || env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME
    || null;
}

// Codex keeps `model = "…"` in config.toml. A one-line regex is enough and
// avoids pulling a TOML parser in for a single field.
// 显式传 home 时（测试、或调用方指定了别的目录）不能被 CODEX_HOME 顶掉：
// 否则「读我给你的那个 home」变成「读开发机上真实的那份」，测试会串味。
function codexModel(home) {
  const dir = home
    ? path.join(home, '.codex')
    : (process.env.CODEX_HOME || path.join(ccSwitchHome(), '.codex'));
  const toml = readText(path.join(dir, 'config.toml'));
  const m = toml.match(/^\s*model\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

// Read the whole picture. Returns `{ claude: {...}, codex: {...} }` where each
// entry may be `{}` when cc-switch is absent.
function readCcSwitch({ home } = {}) {
  // 没有显式指定时才落到默认家目录；同时把「有没有指定」这件事继续传给
  // codexModel —— 那里靠它决定要不要看 CODEX_HOME。
  const root = home || ccSwitchHome();
  const live = readJson(path.join(root, '.cc-switch', 'live-state.json')) || {};
  const settings = readJson(path.join(root, '.cc-switch', 'settings.json')) || {};
  const apps = live.apps || {};

  const entry = (agent, providerKey) => {
    const a = apps[agent] || {};
    return {
      attached: !!a.attached,
      mode: a.mode || null,
      provider: settings[providerKey] || null,
    };
  };

  const out = {};
  // 明确写了 attached:false = cc-switch 已经 detach 这个 agent。此时 settings.json
  // 里残留的 provider 如果还算数，我们就会把「其实走官方 API」的 Claude Code 说成
  // 「用 DeepSeek」—— 这正是这个产品最不能撒的谎。老版 cc-switch 没有这个字段
  // （undefined），不能当成「没接管」，否则升级前的用户会整行消失。
  const managed = (agent) => !(apps[agent] && apps[agent].attached === false);
  if (managed('claude')) {
    const claude = entry('claude', 'currentProviderClaude');
    if (Object.keys(claude).some((k) => claude[k])) out.claude = { ...claude, model: claudeModel(root) };
  }
  if (managed('codex')) {
    const codex = entry('codex', 'currentProviderCodex');
    if (Object.keys(codex).some((k) => codex[k])) out.codex = { ...codex, model: codexModel(home) };
  }
  return out;
}

// Cached snapshot for the frame path: the server rebuilds a frame on every
// state change and every HTTP read, and reading cc-switch's files each time is
// wasted I/O — they only change when the user actually flips a provider. Read
// once at start, then on a short interval; the frame reads the cached copy.
let cache = { at: 0, value: {} };

function refresh() {
  cache = { at: Date.now(), value: readCcSwitch() };
  return cache.value;
}

function lastValue() {
  return cache.value;
}

function reset() {
  cache = { at: 0, value: {} };
}

module.exports = { readCcSwitch, claudeModel, codexModel, appData, refresh, lastValue, reset };
