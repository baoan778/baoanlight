# baoanlight

[![test](https://github.com/baoan778/baoanlight/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/baoan778/baoanlight/actions/workflows/test.yml)
[![release](https://github.com/baoan778/baoanlight/actions/workflows/release.yml/badge.svg)](https://github.com/baoan778/baoanlight/actions/workflows/release.yml)
[![license](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)

一个常驻 Windows 桌面角落的小机器人，替你盯着所有正在跑的 AI 编码代理。

作者 / 维护者：**[baoan778](https://github.com/baoan778)** · 项目地址：**[github.com/baoan778/baoanlight](https://github.com/baoan778/baoanlight)** · 落地页：**[baoan778.github.io/baoanlight](https://baoan778.github.io/baoanlight/)**

```
● 绿  代理正在干活         ● 黄  停下来在等你（权限 / 提问 / 选择）
● 红  这一轮失败或被卡住   ● 紫  刚刚完成（30 秒后回到白色）
● 白  开着但没干活         ● 灰  在运行，但拿不到可读状态
○ 灭  没有代理在运行
```

绿色只属于「真的在干活」——空闲和未知都不借用红黄绿，否则同一个颜色会同时表示
「在忙」和「没忙」，而这个工具存在的意义就是不撒这种谎（细节见
[docs/state-design.md](docs/state-design.md)）。

![baoanlight 桌面机器人](docs/robot.png)

机器人是原创的卡通履带机器人（与任何影视角色、公司或商标无关），**真正的 3D 模型**
（three.js + WebGL）：零件由代码建模，无贴图包、不联网；状态色是照在它身上的光。
干活时履带滚动、爪子摆动，需要你时抬爪警示，完成后转圈连跳，空闲时会自己张望、
伸懒腰、抛接小球。帧率随状态降档，窗口隐藏即停。

支持 **Windows 10 / 11** 与 **Claude Code、Codex、DeepSeek Harness、WorkBuddy、
CodeBuddy、Gemini CLI、Aider、Cursor、opencode、Copilot、Cline、Windsurf、Qwen Code、
Kimi**，以及任何能执行一条命令或发一个 HTTP 请求的工具。

---

## 安装

从 GitHub Release 安装（官方方式，不需要 npm 账号）：

```bash
npm install -g https://github.com/baoan778/baoanlight/releases/latest/download/baoanlight.tgz
bao setup        # 首次运行：下载 Electron 运行时（约 140 MB）
bao start
```

需要校验安装包，或把这台机器交给 AI 部署：把 [DEPLOY.md](DEPLOY.md) 发给它，里面有
SHA-256 校验、逐步执行、验收和失败处理。

从源码运行：

```bash
git clone https://github.com/baoan778/baoanlight
cd baoanlight
npm install && npm run setup
node src/cli.js start
```

没有桌面窗口也能用：`bao start --browser`。

> `setup` 单独一步，是因为 npm 11 默认拦截安装脚本，而 Electron 二进制正是由它下载的。

## 快速上手

```bash
bao onboard            # 首次：探测装了哪些代理，引导接入
bao start              # 后台运行，立刻把终端还给你
bao connect claude     # 接入 Claude Code，立即生效，无需重启
bao status             # 现在是什么状态（--watch 每秒刷新，--json 给脚本）
bao doctor             # 体检：本机接线是否正确
bao stop               # 全部关闭
```

`bao start` 默认脱离终端，关掉终端不会带走机器人；`--foreground` 可留在前台。
拖动机器人可换位置，悬停出现工具栏（大小切换、缩成小机器人、退出）。窗口默认点击穿透，
只有机器人本身接收鼠标。

## 接入代理

> 分步指南见 [docs/connecting.md](docs/connecting.md)；不确定先接哪个就跑 `bao onboard`。  
> 越靠前越准确：钩子 > 日志 > 终端屏幕。

| 软件 | 命令 | 能显示 |
|---|---|---|
| Claude Code | `bao connect claude` | 忙碌 / 等待 / 出错 / 空闲（按会话） |
| Codex | `bao watch codex` | 忙碌 / 等待 / 完成 + 套餐额度 |
| DeepSeek Harness | `bao watch deepseek` | 忙碌 / 等待 / 空闲 + 上下文剩余 |
| WorkBuddy | `bao connect workbuddy` | 忙碌 / 等待 / 完成 / 出错（任务板） |
| CodeBuddy / WorkBuddy CLI | `bao connect codebuddy` | 忙碌 / 等待 / 完成（逐轮记录） |
| Gemini / Aider / Cursor / opencode / Copilot / Cline / Windsurf / Qwen / Kimi | `bao wrap -- <命令>` | 三态猜测（读终端屏幕） |
| 任何工具 | `bao hook --agent X` · HTTP `/state` · `bao mcp` | 由上报方决定 |

数据源本身没有错误信号时，机器人不会亮红灯——这是刻意设计，不是漏报。要精确的失败状态，
用对应软件的钩子。钩子脚本 1.5 秒硬超时、异常一律静默退出 0，**不会因为指示灯坏了而卡住你的代理**。

## 功能

- **多代理同屏**：胸口 8 段槽位灯 + 底座 16 段灯环，谁在跑、谁拖后腿一眼可见；同一软件多开折叠为 `×N`。
- **状态证据**：展开一个软件能看到驱动当前状态的最近事件、静默时长和保守的卡住提示（阈值可调）。
- **cc-switch 联动**：显示真实模型 / 供应商。
- **电量表**：Codex 自动跟随套餐额度，其他工具 `bao fuel 63 --agent x` 一行上报；永远表示剩余。
- **今日信息牌**：时长、需要你几个、完成数、时钟、今日目标等；可拖动、可换色、可关闭。
- **桌面便签**：置顶 / 分组 / 撤销删除 / 稍后提醒 / 导出 Markdown；Ctrl+Shift+M 打开，Ctrl+Shift+N 快速记一条。
- **托盘常驻 + 全局快捷键**（默认 `Ctrl+Alt+B`）、开机自启。
- **整机自愈**：崩溃按 5s → 10s → 30s → 60s 重开；主动退出或 `bao stop` 不会复活。
- **MCP**：`bao mcp` 让任何 MCP 客户端上报 `report_status`。

## 自定义

右键机器人打开设置，全部写入 `~/.baoanlight/config.json`，重启不丢：

- 体型与尺寸：3 种体型、70%–170% 缩放
- 外观：13 皮肤 / 10 瞳色 / 9 履带配色 + 3 履带形状 / 10 配件 / 5 手爪 / 3 头型 / 4 镜筒
- 头部装饰 12 种、场景 14 种（无 / 雪地 / 草原 / 沙漠 / 星空 / 岩浆 / 樱花 / 海洋 /
  森林 / 雨夜 / 工厂 / 雪夜 / 黄昏 / 极光，可按时间自动切换昼 / 夜）、灯效 36 种
- 动作：每个状态一种手势、待机频率、动效强度、人格（活泼 / 沉稳 / 话痨 / 害羞）
- 8 套配色主题、一键随机换装、命名外观方案；配置可整体导出 / 导入
- 每个软件的顺序、改名、展示色、通知与提示音；信息牌、便签、系统项均可调

## 安全与隐私

- 服务只绑 `127.0.0.1`；**写入要本机 token**（`~/.baoanlight/token`，CLI / 钩子 / MCP 自动读取），读不设卡。
- 校验 `Host` 与 `Origin`，挡住 DNS rebinding 和跨源读写；渲染进程带 CSP 且沙箱化，字符串一律按文本渲染。
- 无遥测。状态、日志、便签、统计都留在本机；仅启动时向 GitHub Releases 查一次版本号（24 小时缓存、失败静默）。
- 状态、配置、便签、统计全在 `~/.baoanlight/`（可用 `BAOANLIGHT_HOME` 覆盖）。

## 常见问题

**灯一直熄灭？** 先 `bao doctor`；Claude Code 需 `bao connect claude` 并**新开一轮对话**，其他软件需让对应观察器找到日志目录。

**出错了为什么没变红？** 红灯只来自可验证的失败信号（工具结果 `is_error`、日志 error、任务板 failed）。没有错误信号的来源宁可不知道，也不猜。

**窗口不见了？** 点托盘图标或按 `Ctrl+Alt+B`；拖到屏幕外会自动搬回。

**端口 4747 被占用？** `bao start --port 4788`，或先 `bao stop` 旧实例。

**怎么彻底卸载？** `bao autostart off && bao stop`，再卸载包；是否删除 `~/.baoanlight/` 由你决定（见 [DEPLOY.md](DEPLOY.md#8-升级与卸载)）。

## 开发与测试

```bash
npm test               # 259 个逻辑测试（状态机、适配器、鉴权、安装器、自愈…）
npx playwright test    # 138 个渲染测试（真实浏览器里的界面与落地页）
npm run test:electron  # Electron 主进程烟测（需先 npm run setup）
npm run lint           # 未定义 / 未使用的变量、重复键、死代码
npm run check:pack     # 发布包内容：运行文件齐全、测试与密钥不会被打包
```

`npm test` 证明逻辑对，`bao doctor` 证明**这台机器**接线对——两者是不同的失败。

代码入口：`src/server.js`（HTTP + SSE）、`src/store.js`（状态与优先级）、`src/overlay/`
（窗口与 3D）、`src/adapters/`（各代理接入）、`src/hooks/`、`src/doctor.js`。
加一个「有日志的代理」只需改 `agents.js` + `log-watch.js`；「只有终端的代理」只需在
`patterns.js` 加正则。约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档

- [部署说明（可交给 AI 执行）](DEPLOY.md)：环境检查、安装、验收、升级与卸载
- [状态与灯效设计](docs/state-design.md)：每种颜色、动作、聚合规则的验收清单
- [接入 AI 代理](docs/connecting.md)：钩子、日志、包装器、HTTP、MCP
- [新增适配器](docs/adapters.md) · [更新记录](CHANGELOG.md) · [安全策略](SECURITY.md)

## 授权

MIT，版权归 [baoan778](https://github.com/baoan778/baoanlight) 所有，完整许可见 [LICENSE](LICENSE)
（[中文参考](LICENSE.zh-CN.md)）。内置 three.js（MIT），第三方版权文本见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

Claude、Codex、DeepSeek、WorkBuddy、CodeBuddy、Cursor、GitHub Copilot、Gemini、Aider、
Qwen、Kimi 等名称与商标归其各自所有者；本项目仅用于描述兼容性，与上述公司或产品无隶属、
赞助或背书关系。
