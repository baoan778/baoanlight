# baoanlight 部署说明（可直接交给 AI 执行）

这份文档写给「替用户部署软件的人或 AI」。目标是在用户自己的电脑上安装并启动
baoanlight，让桌面机器人正常显示 AI 代理状态。每一步都给出判断条件、命令和
预期结果；**遇到失败先停止并汇报，不要猜着继续。**

项目地址：<https://github.com/baoan778/baoanlight>
作者 / 维护者：baoan778

---

## 0. 给用户：直接复制这段给 AI

> 请阅读并严格执行 baoanlight 仓库根目录的 `DEPLOY.md`，帮我在这台电脑上部署
> baoanlight。先检查环境，按文档选择安装方式；每一步汇报命令和结果。遇到错误
> 立即停止并告诉我原因，不要删除 `~/.baoanlight` 里的数据，也不要把 token
> 发到聊天或日志里。部署完成后按文档里的验收清单逐项确认。

如果用户有偏好，在提示词里补一句即可：

- 「我要开机自启」→ 执行文档第 6 节。
- 「我没有桌面环境 / 我在服务器上」→ 只部署服务端和浏览器模式。
- 「我不想全局安装」→ 使用源码安装。

---

## 1. 先确认目标

部署完成后，用户应该得到：

1. 一个本机后台服务（默认 `127.0.0.1:4747`），保存各 AI 代理的实时状态。
2. 一个常驻桌面的 3D 机器人窗口（Electron）。
3. 已经接入的代理：Claude Code、Codex、DeepSeek Harness、WorkBuddy、
   CodeBuddy 等（按用户实际安装的软件来）。
4. `bao status` / `bao doctor` 能给出正确结果。

需要的最低条件：

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 10 / 11 |
| Node.js | 20 或更新版本 |
| npm | 随 Node 安装 |
| Git | 仅源码安装需要 |
| 磁盘 | 至少 300 MB 空闲（Electron 运行时约 140 MB） |
| 网络 | 首次安装需要能访问 GitHub（以及 Electron 下载源） |

---

## 2. 选择安装方式

默认使用「GitHub Release 安装」：这是官方分发方式，不需要 npm 账号，
也不需要登录任何服务。只有在需要改代码时才用「源码安装」。

两种方式任选一种，不要同时装两套。

---

## 3. 环境检查

### Windows（PowerShell）

```powershell
node --version
npm --version
git --version
```

判断：

- `node --version` 必须是 `v20.x` 或更高；低于 20 先安装/切换 Node，再继续。
- `npm` 能输出版本号。
- 只有源码安装才要求 `git`。

如果 Node 版本过低，优先建议用户用 nvm-windows / fnm 管理版本，
不要直接覆盖系统 Node。

---

## 4. 安装

### 4.1 GitHub Release 安装（推荐）

不需要 npm 账号，直接安装官方构建好的发布包：

```powershell
$ver = "2.0.2"
$base = "https://github.com/baoan778/baoanlight/releases/download/v$ver"
$tgz = "$env:TEMP\baoanlight-$ver.tgz"
Invoke-WebRequest "$base/baoanlight-$ver.tgz" -OutFile $tgz
Invoke-WebRequest "$base/baoanlight-$ver.tgz.sha256" -OutFile "$tgz.sha256"

# 校验（输出的哈希必须与 .sha256 文件里的一致）
(Get-FileHash $tgz -Algorithm SHA256).Hash.ToLower()
Get-Content "$tgz.sha256"

npm install -g $tgz
bao setup
```

如果只想一条命令装完，可以省略校验步骤：

```bash
npm install -g https://github.com/baoan778/baoanlight/releases/download/v2.0.2/baoanlight-2.0.2.tgz
bao setup
```

- `bao setup` 会下载 Electron 运行时，约 140 MB；失败时按第 9 节处理。
- Windows 不需要管理员权限；如果报 `EACCES`，先看第 9 节。

### 4.2 源码安装

选择一个用户可写的目录，例如：

```bash
git clone https://github.com/baoan778/baoanlight
cd baoanlight
npm install
npm run setup
```

源码模式下，文档里的 `bao xxx` 等价于：

```bash
node src/cli.js xxx
```

如果希望源码目录也有全局 `bao` 命令，可以额外执行 `npm link`；
不执行也不影响使用。

---

## 5. 首次启动与接入代理

### 5.1 启动

全局安装：

```bash
bao start
```

源码安装：

```bash
node src/cli.js start
```

预期输出包含：

- `baoanlight is running in the background.`
- 自检没有 FAIL 项（没装的代理/可选组件只会显示 WARN，不影响运行）
- 已连接代理的提示

`bao start` 默认脱离终端，关掉终端不会停掉机器人；用 `bao stop` 停止。

如果只想先在浏览器里看效果：

```bash
bao start --browser
```

然后打开 `http://127.0.0.1:4747/`。默认端口是 4747；如果用户改过配置，
用 `bao status --json` 或 `bao token` 确认。

### 5.2 查看能接入什么

```bash
bao agents
```

输出会列出每个代理、它的接入方式和对应的命令。

### 5.3 接入代理

按用户实际安装的软件执行，不需要全部接入：

```bash
bao connect claude     # Claude Code 钩子，立即生效
bao connect codex      # Codex notify
bao watch all          # DeepSeek / WorkBuddy / CodeBuddy 的日志观察器
```

说明：

- `bao start` 默认已经会启动日志观察器；`bao watch all` 用于单独确认或手动补跑。
- `bao onboard` 是交互式引导，适合用户自己操作；AI 自动部署时优先用
  `bao agents` + 上面的 `connect` 命令，避免卡在交互提问上。
- 接入新的、文档里没列的代理，看 `docs/connecting.md`。

---

## 6. 可选：开机自启

用户明确要求「开机自动出现」时才执行：

```bash
bao autostart on
bao autostart status
```

预期 `status` 显示已启用。不要额外再往系统启动目录里手工塞一份，
否则会出现两个机器人抢同一个端口。

关闭：

```bash
bao autostart off
```

---

## 7. 验收清单（必须逐项确认）

以下命令全部在安装方式对应的 shell 里执行。

### 7.1 服务在跑

```bash
bao status
```

预期：第一行是 `● busy` / `● idle` / `◉ done` 等状态，随后列出会话。
如果显示 `○ server not running`，回到第 9 节。

也可以要 JSON：

```bash
bao status --json
```

预期包含 `"running": true`、`"sessions": [...]`、`"slots": [...]`。

### 7.2 自检通过

```bash
bao doctor
```

预期：各项为 pass，没有 fail。警告（warn）可以接受，但要向用户说明。

### 7.3 窗口确实出现

- 用户能看到屏幕时：确认桌面角落出现机器人窗口，并且悬停能看到工具栏。
- AI 看不到屏幕时：`Get-Process electron` 能查到进程即可认为窗口进程已启动；
  界面是否可见仍要让用户确认。
- 没有桌面环境：改用 `bao start --browser`，用浏览器验证
  `http://127.0.0.1:4747/` 能打开并且有机器人。

### 7.4 状态链路真的通了

发一条测试状态：

```bash
bao set waiting --agent deploy --session deploy-check --detail "部署验收"
bao status
```

预期：`deploy` 显示 waiting（黄色「需要你」），列表出现这一行。

清理测试会话：

```bash
bao set offline --agent deploy --session deploy-check
```

预期：测试行消失，用户真实代理的状态不受影响。

### 7.5 代理状态来自真实软件

让用户打开一个已经接入的代理并随便发一条消息，然后：

```bash
bao status
```

预期：对应软件从 idle/offline 变成 busy，结束后回到 idle 或 done。
如果完全没有变化，按第 9 节「代理没反应」处理。

---

## 8. 升级与卸载

### 升级（全局）

先查最新版本：<https://github.com/baoan778/baoanlight/releases/latest>

```powershell
bao stop
$ver = "2.0.2"   # 换成目标版本
$tgz = "$env:TEMP\baoanlight-$ver.tgz"
Invoke-WebRequest "https://github.com/baoan778/baoanlight/releases/download/v$ver/baoanlight-$ver.tgz" -OutFile $tgz
npm install -g $tgz
bao setup
bao start
```

### 升级（源码）

```bash
bao stop
git pull
npm install
npm run setup
bao start
```

### 卸载

先停止并关掉自启：

```bash
bao autostart off
bao stop
```

全局安装：

```bash
npm uninstall -g baoanlight
```

源码安装：删除克隆目录即可（先确认用户同意）。

**不要默认删除 `~/.baoanlight/`**，里面有用户的配置、桌面便签、统计和 token。
只有用户明确要求「彻底清除数据」时才删除，并先备份：
`~/.baoanlight/notes.json`、`config.json`、`stats.json`。

---

## 9. 常见失败与处理

### `node: command not found` / Node 版本低于 20

安装 Node 20+，或让用户用 nvm-windows / fnm 切换版本。不要用系统包管理器强装旧版本。

### `npm install -g` 报 EACCES / 权限错误

- 确认 Node 是用户级安装；必要时用 nvm-windows。
- 不要为了装一个桌面工具去改系统目录权限。

### `bao setup` 下载 Electron 失败

1. 重试一次 `bao setup`。
2. 检查代理/防火墙是否拦截 Electron 下载源。国内网络可以先切到镜像再重试
   （Electron 官方包在 GitHub，下载源经常不可达）：
   PowerShell：`$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"`，
   然后再执行 `bao setup`。
3. 清缓存后再试（执行前告诉用户）。PowerShell 里：
   `Remove-Item -Recurse -Force "$env:LOCALAPPDATA\electron\Cache"`
   （cmd 里是 `rmdir /s /q "%LOCALAPPDATA%\electron\Cache"`）
4. 仍然失败时，可以先 `bao start --browser` 让功能可用，再继续排查。

### 窗口没出现，但 `bao status` 正常

1. `bao doctor` 看「机器人窗口（Electron）」一项。
2. 确认不是被最小化/藏到托盘：托盘图标点一下可切换显示。
3. Windows SmartScreen 可能拦截未签名程序：让用户在系统提示里选择
   「仍要打开」，不要建议关闭系统安全功能。
4. 仍然不行：`bao start --browser` 先可用，再收集错误给用户。

### `server not running`

1. `bao status` 再试一次。
2. 确认没有另一个机器人占着端口：`bao stop` 后再 `bao start`。
3. 检查 `~/.baoanlight/server.log`（存在时）末尾的报错。
4. 临时换端口验证：`bao start --port 4788`，成功后再查默认端口被谁占用。

### 代理没反应

```bash
bao agents
bao doctor
```

- Claude Code：`bao connect claude` 后新开一轮对话才会触发钩子。
- Codex：`bao connect codex`，有的版本需要重启 Codex。
- DeepSeek / WorkBuddy / CodeBuddy：确认日志目录被探测到（`bao doctor` 会列）。
- 仍无反应：查看 `~/.baoanlight/hook-events.log`，区分「代理没发」还是
  「事件没被识别」。

### 端口/跨源报错

服务只监听本机 loopback，并校验 `Host` 与 `Origin`。不要建议用户把服务暴露到
公网或关闭 token 校验；需要远程访问时应使用 SSH 隧道。

---

## 10. AI 完成后向用户汇报的模板

```text
部署完成情况
- 系统：<Windows 版本>
- 安装方式：<全局 npm / 源码>
- Node 版本：<vX.Y.Z>
- bao setup：<成功/失败及处理>
- bao start：<成功/失败>
- bao doctor：<pass 数量，是否有 warn/fail>
- 机器人窗口：<用户已确认可见 / 仅确认进程 / 浏览器模式>
- 已接入代理：<列表>
- 开机自启：<已开启/未开启/用户未要求>
- 遗留问题：<无 / 具体错误与下一步>
```

---

## 11. 安全边界（AI 必须遵守）

- 不把 `~/.baoanlight/token` 打印到聊天、日志或提交到仓库。
- 不删除用户的 `~/.baoanlight/`、便签、统计数据；除非用户明确要求并已备份。
- 不关闭防火墙、不把服务绑定到 `0.0.0.0`、不改 hosts。
- 不执行来源不明的脚本；所有命令都应来自本仓库文档。
- 部署失败时保留现场：记录命令、完整报错和 `bao doctor` 输出，再停止。
