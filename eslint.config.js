'use strict';
// 只开「说得出后果」的规则。
//
// 这个仓库的风格是重注释、手工调参，任何一条风格类规则（缩进、引号、逗号）
// 都会产出几百条与正确性无关的告警，然后所有人学会忽略这个命令。所以这里只留
// 真正会变成 bug 的：未定义的变量、声明了没用的变量、重复的键、走不到的代码、
// 给常量赋值。风格交给 review。
const globals = require('globals');

const RULES = {
  'no-undef': 'error',
  // 未使用的参数常常是为了对齐签名，不算问题；catch 里也常故意不写变量名。
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-unreachable': 'error',
  'no-const-assign': 'error',
  'no-self-assign': 'error',
  'no-cond-assign': 'error',
  'no-empty': ['error', { allowEmptyCatch: true }],
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'src/overlay/vendor/**',
      'test-results/**',
      'playwright-report/**',
      'blob-report/**',
      'docs/**',
    ],
  },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: RULES,
  },
  {
    // Playwright 用例本身跑在 Node 里，但 page.evaluate() 的回调会被序列化到
    // 浏览器里执行，所以这块同时需要两套全局变量。
    files: ['test-ui/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: RULES,
  },
  {
    // 这几块是浏览器里的 ES module，不是 CommonJS。注意 main.js / preload.js
    // 虽然是同目录，仍然是 CommonJS（Electron 主进程），不能一起加进来。
    files: ['src/overlay/ui.js', 'src/overlay/robot3d.js', 'src/overlay/scene/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.browser } },
    rules: RULES,
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    rules: RULES,
  },
];
