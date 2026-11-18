'use strict';
// 回归：不经过 /quit、直接 process.exit（Ctrl+C / 托盘退出 / 进程自行退出）
// 也要把「退出时仍在忙」的今日时长落盘，否则重启后今日累计会像被清零。
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');

test('today\'s running time survives a direct process.exit', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-exit-'));

  // 子进程：起一个 port 0 的 server，报一条 busy，等一会儿后直接 exit(0)。
  const code = `
    const { start } = require(${JSON.stringify(SERVER)});
    start({ port: 0 }).then(({ port, token }) => {
      fetch('http://127.0.0.1:' + port + '/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bao-token': token },
        body: JSON.stringify({ session: 'a', agent: 'exitagent', state: 'busy' }),
      }).then(() => setTimeout(() => process.exit(0), 900));
    });
  `;
  const child = spawn(process.execPath, ['-e', code], {
    env: { ...process.env, BAOANLIGHT_HOME: home },
    stdio: 'ignore',
    windowsHide: true,
  });
  // 不让一个卡住的子进程把整个测试进程一起挂死。
  const killer = setTimeout(() => { try { child.kill(); } catch { /* 已经退了 */ } }, 15_000);
  const [code_] = await once(child, 'exit');
  clearTimeout(killer);
  assert.equal(code_, 0, 'the child exits cleanly');

  const file = path.join(home, 'stats.json');
  assert.ok(fs.existsSync(file), 'stats.json is written on exit');
  const stats = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok((stats.byAgent.exitagent || 0) >= 300,
    `the stretch that was still running is credited (got ${stats.byAgent.exitagent || 0}ms)`);
});
