'use strict';
// 启动自检：每次 `bao start`（server 启动）都跑一遍，检查这台机器接线对不对。
//
// 和 `bao doctor` 共用同一批判断，但这里：
//   * 全同步、只读文件系统，跑得快、绝不会卡住启动
//   * 不打印、不联网、不退出进程 —— 只是把结果挂到快照里，让机器人窗口能显示
//   * 只报「硬错误」当 fail，缺可选项一律 warn（不吓人）
//
// 结果进 `/state` 的 selfcheck 字段 + `/selfcheck` 端点，机器人窗口据此在
// 底部提示「自检发现问题」，CLI 也在启动后打印摘要。

const fs = require('fs');
const path = require('path');
const config = require('./config');
const install = require('./adapters/install');
const agents = require('./adapters/agents');

function exists(p) {
  try { return !!p && fs.existsSync(p); } catch { return false; }
}

function run() {
  const checks = [];
  const check = (name, status, detail = '', fix = '') => checks.push({ name, status, detail, fix });

  // ---- 运行时
  const major = Number(process.versions.node.split('.')[0]);
  check('Node 版本', major >= 20 ? 'pass' : 'fail', `node ${process.version}`, '安装 Node 20 或更新');

  // ---- 状态目录可写（stats.json / hook-events.log 都写这里）
  try {
    config.ensureDir();
    const probe = path.join(config.DIR, '.probe');
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    check('状态目录可写', 'pass', config.DIR);
  } catch (e) {
    check('状态目录可写', 'fail', `${config.DIR}: ${e.message}`, '检查用户主目录权限');
  }

  // ---- 机器人窗口运行时
  let electronPath = null;
  try {
    const p = require('electron');
    electronPath = typeof p === 'string' && exists(p) ? p : null;
  } catch { /* 未安装 */ }
  check('机器人窗口（Electron）', electronPath ? 'pass' : 'warn',
    electronPath || '未安装 — 桌面机器人不可用', 'npm run setup');

  // ---- Claude Code 钩子（跨机器最常见失败：钩子指向的脚本/node 不存在）
  //
  // 两个作用域都看：`bao connect claude --scope project` 装好的钩子照样工作，只认
  // user 级会把一个正常接线报成「未安装」，而它给出的修法是再装一份 —— 双份触发。
  const cfg = config.load();
  const inspectHooks = (scope) => {
    const file = install.claudeSettingsPath(scope);
    if (!exists(file)) return null;                 // 这个作用域没装，不算失败
    let settings = null;
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return { status: 'fail', detail: `${file} 不是合法 JSON`, fix: '修复或从 baoanlight-backup-* 恢复' };
    }
    const ours = Object.entries(settings.hooks || {})
      .flatMap(([evt, groups]) => (groups || []).flatMap((g) => (g.hooks || []).map((h) => ({ evt, cmd: h.command || '' }))))
      .filter((h) => /hooks[\\/]claude\.js/.test(h.cmd));
    if (!ours.length) return { status: 'warn', detail: `未安装（${scope}）`, fix: 'bao connect claude' };
    const quoted = (ours[0].cmd.match(/"([^"]+)"/g) || []).map((q) => q.slice(1, -1));
    const [bin, script] = quoted;
    if (!exists(bin) || !exists(script)) {
      return {
        status: 'fail',
        detail: `${script || '(未解析)'} 不存在（${scope}）`,
        fix: 'bao connect claude（为本机重写路径）',
      };
    }
    return { status: 'pass', detail: `${ours.length} 个事件已接（${scope === 'project' ? '项目' : '用户'}级）` };
  };
  // 任一作用域接通就算接通；都没有时才报「未安装」。
  const verdicts = ['user', 'project'].map(inspectHooks).filter(Boolean);
  const hook = verdicts.find((v) => v.status === 'pass')
    || verdicts.find((v) => v.status === 'fail')
    || verdicts[0]
    || { status: 'warn', detail: '未安装', fix: 'bao connect claude' };
  check('Claude Code 钩子', hook.status, hook.detail, hook.fix);

  // ---- 日志类代理的日志目录
  //
  // 名单从 agents 表里来，不在这里另写一份：`bao doctor` 用的是同一张表，而
  // 硬编码的副本在新增一个代理时不会跟着变 —— 也不会报错，只是那个代理在自检
  // 里永远缺席。
  for (const name of agents.names()) {
    const entry = agents.find(name);
    if (!entry || entry.tier !== 'log') continue;
    const dir = agents.logDir(name, { config: cfg });
    if (dir && exists(dir)) check(`${entry.label} 日志`, 'pass', dir);
    else check(`${entry.label} 日志`, 'warn', '未找到', `bao watch ${name} --dir <路径>`);
  }

  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  return { at: Date.now(), checks, fails, warns };
}

module.exports = { run };
