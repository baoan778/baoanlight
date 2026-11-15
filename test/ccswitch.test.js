'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 隔离：本文件有测试在 port 0 上起 server，别把临时端口写进用户真实的端口文件。
process.env.BAOANLIGHT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-ccs-'));

const { readCcSwitch, claudeModel, codexModel, refresh, lastValue, reset } = require('../src/adapters/ccswitch');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-'));

// A cc-switch install that is absent must read as "no answer", never an error —
// the status light must not break because a file it peeks at is missing.
test('no cc-switch files means no answer, not an error', () => {
  const dir = tmp();
  try {
    assert.deepEqual(readCcSwitch({ home: dir }), {});
    assert.equal(claudeModel(dir), null);
    assert.equal(codexModel(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cc-switch state is read for claude and codex together', () => {
  const dir = tmp();
  const prev = process.env.CODEX_HOME;
  try {
    delete process.env.CODEX_HOME;
    fs.mkdirSync(path.join(dir, '.cc-switch'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });

    fs.writeFileSync(path.join(dir, '.cc-switch', 'live-state.json'), JSON.stringify({
      apps: {
        claude: { attached: true, mode: 'proxy' },
        codex: { attached: true, mode: 'proxy' },
      },
    }));
    fs.writeFileSync(path.join(dir, '.cc-switch', 'settings.json'), JSON.stringify({
      currentProviderClaude: 'DeepSeek',
      currentProviderCodex: 'OpenAI',
    }));
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'deepseek-v4.1-flash' },
    }));
    fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), 'model = "gpt-5.1-codex"\n');

    const out = readCcSwitch({ home: dir });
    assert.deepEqual(out.claude, {
      attached: true, mode: 'proxy', provider: 'DeepSeek', model: 'deepseek-v4.1-flash',
    });
    assert.deepEqual(out.codex, {
      attached: true, mode: 'proxy', provider: 'OpenAI', model: 'gpt-5.1-codex',
    });
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// cc-switch only claims an agent when it actually manages it. A Claude entry
// with nothing but a model env on disk is NOT cc-switch taking over — that env
// could be the user's own default, and presenting it as "switched" would lie.
test('an agent cc-switch does not manage is left out', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, '.cc-switch'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cc-switch', 'live-state.json'), JSON.stringify({
      apps: { claude: { attached: false }, codex: {} },
    }));
    fs.writeFileSync(path.join(dir, '.cc-switch', 'settings.json'), JSON.stringify({}));

    assert.deepEqual(readCcSwitch({ home: dir }), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// detach 之后 settings.json 里残留的 provider 不能算数：用户明明已经把 Claude Code
// 切回官方 API，机器人还写「用 deepseek-v4.1-flash」就是在撒谎。
test('a detached agent is left out even if a provider name is still on disk', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, '.cc-switch'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cc-switch', 'live-state.json'), JSON.stringify({
      apps: { claude: { attached: false, mode: 'proxy' } },
    }));
    fs.writeFileSync(path.join(dir, '.cc-switch', 'settings.json'), JSON.stringify({
      currentProviderClaude: 'DeepSeek',
    }));
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'deepseek-v4.1-flash' },
    }));

    assert.deepEqual(readCcSwitch({ home: dir }), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 老版本 cc-switch 没有 attached 字段：不能当成「没接管」，否则升级前的用户整行消失。
test('an entry without an attached field still counts', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, '.cc-switch'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cc-switch', 'live-state.json'), JSON.stringify({
      apps: { codex: { mode: 'proxy' } },
    }));
    fs.writeFileSync(path.join(dir, '.cc-switch', 'settings.json'), JSON.stringify({
      currentProviderCodex: 'OpenAI',
    }));
    fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), 'model = "gpt-5.1-codex"\n');

    const out = readCcSwitch({ home: dir });
    assert.equal(out.codex.provider, 'OpenAI');
    assert.equal(out.codex.model, 'gpt-5.1-codex');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ANTHROPIC_MODEL 是主模型的显式覆盖，优先于三个档位别名。
test('the explicit ANTHROPIC_MODEL wins over the tier aliases', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_MODEL: 'deepseek-v4.1-flash', ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'claude-opus-4' },
    }));
    assert.equal(claudeModel(dir), 'deepseek-v4.1-flash');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A malformed JSON file is the same as no file: best-effort, never a throw.
test('a malformed cc-switch file degrades to no answer', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, '.cc-switch'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cc-switch', 'live-state.json'), 'not json {');
    fs.writeFileSync(path.join(dir, '.cc-switch', 'settings.json'), 'also not json');

    assert.deepEqual(readCcSwitch({ home: dir }), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The cached snapshot used by the server frame starts empty and is reset-able.
test('the cached snapshot starts empty and refresh replaces it', () => {
  reset();
  assert.deepEqual(lastValue(), {});
  refresh();
  assert.deepEqual(lastValue(), readCcSwitch());
});

// The server frame must carry cc-switch's picture so the overlay can show which
// model a "Claude Code" is really running on.
test('the server frame includes cc-switch context', async () => {
  const dir = tmp();
  const prev = process.env.BAOANLIGHT_CCSWITCH_HOME;
  process.env.BAOANLIGHT_CCSWITCH_HOME = dir;
  fs.mkdirSync(path.join(dir, '.cc-switch'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.cc-switch', 'live-state.json'), JSON.stringify({
    apps: { claude: { attached: true, mode: 'proxy' } },
  }));
  fs.writeFileSync(path.join(dir, '.cc-switch', 'settings.json'), JSON.stringify({
    currentProviderClaude: 'DeepSeek',
  }));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'deepseek-v4.1-flash' },
  }));

  const { start } = require('../src/server');
  let srv;
  try {
    ({ server: srv } = await start({ port: 0 }));
    const port = srv.address().port;
    const snap = await (await fetch(`http://127.0.0.1:${port}/state`)).json();
    assert.equal(snap.ccSwitch.claude.model, 'deepseek-v4.1-flash');
    assert.equal(snap.ccSwitch.claude.provider, 'DeepSeek');
    assert.equal(snap.ccSwitch.claude.attached, true);
  } finally {
    srv && srv.close();
    if (prev === undefined) delete process.env.BAOANLIGHT_CCSWITCH_HOME;
    else process.env.BAOANLIGHT_CCSWITCH_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
