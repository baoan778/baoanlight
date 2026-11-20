'use strict';
// `bao doctor` 是本机唯一能自查的工具 —— 它自己崩掉，用户就只剩猜。
// 这里跑真实的子进程，隔离到临时 HOME，避免依赖开发机上的真实接线与 cc-switch。
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// 退出码 1 是 doctor 的正常输出（有 FAIL 时它就该是 1），所以用 spawnSync 收下
// 输出而不是让 execFileSync 抛异常 —— 这条测试要断言的是「没有崩」，不是「全绿」。
function runDoctor(home) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli.js'), 'doctor'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      USERPROFILE: home,   // Windows: os.homedir()
      HOME: home,          // POSIX
      BAOANLIGHT_HOME: path.join(home, '.baoanlight'),
      // 隔离 APPDATA：否则 doctor 会读到开发机上真实的 WorkBuddy / cc-switch 目录，
      // 测试结果就取决于跑测试的这台机器装了什么。
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    },
  });
  return { out: `${r.stdout || ''}${r.stderr || ''}`, code: r.status };
}

// 手写的钩子命令常常没有引号（`node /opt/bao/hooks/claude.js`）。解析不出 script
// 时，doctor 以前会在 startsWith 上抛 TypeError —— 一个自带堆栈的诊断工具，比没有
// 更让人怀疑是自己装坏了。
test('doctor survives a hook command without quotes instead of crashing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-doc-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: '*',
          hooks: [{ type: 'command', command: 'node /opt/bao/hooks/claude.js', timeout: 5 }],
        }],
      },
    }));

    const { out } = runDoctor(home);
    assert.doesNotMatch(out, /TypeError|Cannot read properties|at Object\./,
      'doctor must never die with a Node stack trace');
    // 解析不出来时应该说「未解析」，而不是假装检查通过。
    assert.match(out, /\(unparsed\)/, 'an unparsable hook command is reported as such');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// 写 token 以前走 auth.token()：文件缺失会自动生成、读不出来会返回临时值，于是
// 这条检查恒为 PASS —— 恰好漏掉「所有写入 401、灯一动不动」这类故障。
test('the write-token check looks at the file instead of inventing one', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-doc-'));
  try {
    const { out } = runDoctor(home);
    assert.match(out, /no token file yet/i, 'a missing token file is reported honestly');
    assert.equal(fs.existsSync(path.join(home, '.baoanlight', 'token')), false,
      'doctor must not create a token as a side effect');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// 记事本保存的 settings.json 会带 BOM。`bao connect` 已经能读它，doctor 若不剥
// BOM，会把一份完全正常的钩子配置报成「不是合法 JSON」的 FAIL。
test('a hook settings file saved with a BOM is not reported as broken', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-doc-'));
  try {
    const script = path.join(ROOT, 'src', 'hooks', 'claude.js').replace(/\\/g, '/');
    const command = `"${process.execPath.replace(/\\/g, '/')}" "${script}"`;
    const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
      'Notification', 'Stop', 'PreCompact', 'SessionEnd'];
    const hooks = {};
    for (const evt of events) hooks[evt] = [{ hooks: [{ type: 'command', command }] }];
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
      '\uFEFF' + JSON.stringify({ hooks }));

    const { out } = runDoctor(home);
    assert.doesNotMatch(out, /is not valid JSON/i, 'a BOM is an encoding marker, not corruption');
    assert.match(out, /PASS\s+Claude Code hooks \(user\)/, 'the live hooks are recognised');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// WorkBuddy 的 sessions/ 只是应用日志，`bao watch workbuddy` 读的是 tasks/ 任务板。
// 只凭 sessions/ 存在就报 PASS，会让用户照着提示去跑一条注定失败的命令。
test('a WorkBuddy transcript folder is not mistaken for its task board', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-doc-'));
  try {
    fs.mkdirSync(path.join(home, '.workbuddy', 'sessions'), { recursive: true });
    let { out } = runDoctor(home);
    assert.doesNotMatch(out, /PASS\s+WorkBuddy logs/,
      'sessions/ is not watched by `bao watch workbuddy`');
    assert.match(out, /WARN\s+WorkBuddy logs/, 'a missing task board is reported as a warning');

    fs.mkdirSync(path.join(home, '.workbuddy', 'tasks'), { recursive: true });
    ({ out } = runDoctor(home));
    assert.match(out, /PASS\s+WorkBuddy logs/, 'the real task board is detected');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
