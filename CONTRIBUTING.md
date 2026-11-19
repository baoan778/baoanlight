# 参与贡献

baoanlight 由 [baoan778](https://github.com/baoan778) 创建并维护。欢迎 Issue、
Pull Request、文档修正和新的代理接入。

## 开发环境

需要 Node.js 20 或更新版本。

```bash
git clone https://github.com/baoan778/baoanlight
cd baoanlight
npm install
npm run setup          # 可选：下载 Electron 运行时（约 140 MB）
node src/cli.js start  # 从源码启动
```

不需要桌面窗口时可以用 `node src/cli.js start --browser`。

## 提交前检查

```bash
npm run lint
npm test               # 逻辑测试
npm run test:electron  # Electron 主进程烟测（需要先 npm run setup）
npx playwright install chromium   # 首次运行渲染测试前安装浏览器
npx playwright test    # 渲染测试
npm run check:pack     # 改了 package.json 的 files 后
npm run build:pages    # 改了 src/overlay/ 下的渲染代码时必须跑
npm run shot:hero      # 机器人外观/光照有可见变化时，重新生成 README 展示图
```

`docs/demo/` 是 `src/overlay/` 的构建产物。`test/contracts.test.js` 会逐字节比对，
忘记重新生成会让测试失败。

`docs/robot.png` 是 3D 渲染器的截图，**不会被测试自动比对**（二进制没有“正确值”）。
改了默认外观、体型、材质或状态光照后，跑一次 `npm run shot:hero`。

## 设计约束

这些不是风格偏好，改动前请先确认不会破坏它们：

- **颜色即事实**：绿色只表示「正在运行」；黄色表示「需要你」；红色表示「失败」；
  紫色表示「刚完成」；白色表示「空闲」；灰色表示「未知」；暗色表示「未运行」。
  不要把状态色借给氛围灯、统计图或提示信息。
- **不猜测**：没有证据时显示未知或未运行，不能为了让界面好看而假装一个状态。
- **本地优先**：状态、便签、统计都只存在本机；不引入遥测、不上传会话内容。
- **写入要鉴权**：所有改动状态的 HTTP 写入都必须带本机 token。
- **服务端字符串一律按文本渲染**：`innerHTML` 只用于静态骨架，不拼接来自代理/用户的字符串。
- **文档与实现同步**：改了状态语义、快捷键、配置项或测试数量，同步更新 README 与 `docs/`。

## 代码风格

- 使用现有 ESLint 配置，提交前跑 `npm run lint`。
- 注释解释「为什么」，而不是复述代码在做什么。
- 新增行为要配测试：逻辑放 `test/`，渲染放 `test-ui/`。

## Pull Request

- 一个 PR 解决一件事，说明动机、用户可见变化和验证方式。
- 不要提交 `node_modules/`、`test-results/`、本机配置或 token。
- 如果是新代理接入，请同时更新 `docs/adapters.md` 或 `docs/connecting.md`。

## 安全

发现安全问题时不要公开提 Issue，请按 [SECURITY.md](SECURITY.md) 私下报告。

参与讨论和提交请遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。版本变化见
[CHANGELOG.md](CHANGELOG.md)。

## 授权

提交代码即表示你同意以本项目的 MIT 许可证发布你的贡献。
