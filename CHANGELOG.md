# 更新记录

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)，版本号格式为
`MAJOR.MINOR.PATCH`。每个版本的「用户可见变化」和「升级注意」都记在这里。

## [2.0.0] - 2026-11-17

首个以 **baoanlight** 名义发布的版本，基于 signalhead 的核心状态机重写了界面与
代理接入层。本版本只支持 **Windows 10 / 11**。

### 新增

- 真正的 3D 履带机器人窗口：three.js 程序化建模、状态色光照、情绪表情、
  自主动作、拖拽/点击/连点/悬停互动。
- 同时观察多个 AI 软件：胸口 8 段槽位灯、底座 16 段灯环、软件列表与多会话展开。
- 支持 Claude Code、Codex、DeepSeek Harness、WorkBuddy、CodeBuddy，以及
  Gemini CLI、Aider、Cursor、opencode、Copilot、Cline、Windsurf、Qwen、Kimi。
- 桌面便签：新增/完成/编辑/置顶/撤销删除/稍后提醒/导出 Markdown，支持快捷键。
- 今日信息牌、电量条、CPU/内存面板、托盘常驻、开机自启、全局快捷键。
- 自定义外观：皮肤、瞳色、履带、配件、手爪、头型、场景、灯效、动作、人格、
  配色主题、命名外观方案、配置导入/导出。
- MCP 服务：`bao mcp` 让任何 MCP 客户端上报 `report_status`、读取
  `get_agents_status`。
- 整机守护：崩溃按 5s → 10s → 30s → 60s 重启，主动退出不复活。

### 变更

- 状态色契约固定为：绿=运行、黄=需要你、红=失败、紫=一次完成（瞬态）、
  白=空闲、灰=未知、暗=未运行。绿色不再表示「空闲」。
- 今日统计持久化：退出/重启时正在忙的时长也会结算落盘。
- `bao stop` 只有在服务真正停止后才报告 `stopped`。

### 修复

- 从机器人会话行打开终端时，不再把工作目录拼进 shell 命令；目录只作为
  spawn 的 `cwd` 传递，并补上了异步 spawn 错误处理。
- `bao start --no-watch` 现在真的不会启动日志观察器。
- 修复 `bao stop && bao start` 时旧监听未释放导致的启动竞态。
- 跨午夜仍在忙的会话，昨天那一段时长会归档到昨天，不再从历史里消失。
- 完成超过 30 天的便签在读取时就不再显示和计数，不必等下一次写入。
- 修复 WorkBuddy 会话被误归属为 CodeBuddy 的问题。
- 修复长时间运行任务被误判为静默、等待用户输入却显示运行状态的问题。
- 修复 CLI 帮助图例、文档中的旧配色描述与软件槽位数量。

### 测试

- 逻辑测试、Playwright 渲染测试、Electron 主进程烟测；详见 README 的
  「本机接线对不对」。
