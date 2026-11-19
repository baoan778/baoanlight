'use strict';
// 发布前的打包契约：npm 包必须带上运行所需文件，且绝不能带上测试、本机数据或 token。
const { execFileSync } = require('child_process');

const REQUIRED = [
  'src/cli.js',
  'src/server.js',
  'src/store.js',
  'src/notes.js',
  'src/supervisor.js',
  'src/overlay/index.html',
  'src/overlay/main.js',
  'src/overlay/preload.js',
  'src/overlay/terminal.js',
  // 页面真正加载的脚本。少了任何一个，窗口会打开但机器人不出现 —— 而
  // `files` 一旦被改动，这类「整个 src 子目录被漏掉」是最容易发生的事故。
  'src/overlay/ui.js',
  'src/overlay/robot3d.js',
  'src/overlay/scene/geometry.js',
  'src/overlay/scene/surfaces.js',
  'src/overlay/shared/palette.mjs',
  // 钩子脚本的路径会被写进用户的 settings.json；`bao mcp` 直接 require 它。
  'src/hooks/claude.js',
  'src/mcp-server.js',
  'src/overlay/vendor/three.module.js',
  'src/overlay/vendor/three.core.js',
  'docs/index.html',
  'docs/demo/robot3d.js',
  'docs/demo/shared/palette.mjs',
  'docs/demo/vendor/three.module.js',
  'docs/robot.png',
  'README.md',
  'CHANGELOG.md',
  'DEPLOY.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
];

const FORBIDDEN = [
  /^test\//,
  /^test-ui\//,
  /^test-electron\//,
  /node_modules/,
  /^test-results\//,
  /(^|\/)\.env($|\.)/,
  /(^|\/)token$/,
  /(^|\/)\.screenshots\//,
  /(^|\/)\.trae-/,
];

const npmCli = process.env.npm_execpath;
const args = ['pack', '--dry-run', '--json'];
const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const raw = npmCli
  ? execFileSync(process.execPath, [npmCli, ...args], opts)
  // npm.cmd 必须由 cmd 解析；不经 shell: true 是为了不触发 Node 24 的 DEP0190。
  : execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'npm.cmd', ...args], opts);
const pack = JSON.parse(raw)[0];
const files = pack.files.map((f) => f.path);

const missing = REQUIRED.filter((f) => !files.includes(f));
const bad = files.filter((f) => FORBIDDEN.some((re) => re.test(f)));

if (missing.length) console.error(`missing from package:\n  ${missing.join('\n  ')}`);
if (bad.length) console.error(`must not be published:\n  ${bad.join('\n  ')}`);
if (missing.length || bad.length) process.exit(1);

console.log(`package check ok: ${files.length} files, ${(pack.size / 1024).toFixed(0)} KB tarball`);
