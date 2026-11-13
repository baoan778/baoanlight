# baoanlight

一个常驻桌面角落的小机器人，替你盯着所有正在跑的 AI 编码代理。

```
● 绿色   代理正在干活（亮 = 运行中）
● 黄色   代理停下来了，在等你（权限、提问、选择题）
● 红色   这一轮出错了，或者被卡住
● 紫色   这一轮刚刚成功完成（瞬态，30 秒后回到白色）
● 白色暗  代理还开着，但没在干活
● 熄灭   没有代理在运行 / 未安装
```

绿色只属于「真的在干活」。空闲和未知都不借用红黄绿——否则同一个颜色会同时表示
「在忙」和「没忙」，而这个工具存在的意义就是不撒这种谎。

![baoanlight 桌面机器人](docs/robot.png)

它是一台黄色履带机器人（造型致敬经典履带机器人，与 Disney/Pixar 无任何关联）：干活时履带滚动、
爪子摆动、眼睛左右扫视；需要你时抬起双爪、胸口警示灯急促闪烁；完成后原地转一圈再连跳两下；
空闲时会自己找事做——张望、伸懒腰、抛接小球、抖擞、抬手端详手爪、转身巡视、点头致意。

机器人是**真正的 3D 模型**（three.js + WebGL），所有零件在加载时由代码建模，没有 .glb、没有贴图包、
不联网：它有体积、有高光、会在桌面上投下阴影，状态色是照在它身上的光而不是涂上去的颜色。
为了不给桌面常驻窗口添负担，动画帧率随状态降档（干活 60fps、待机 30fps、离线静止 15fps），
窗口隐藏即停，掉帧会自动降画质。

支持 **macOS / Windows / Linux**，支持 **Claude Code、Codex、DeepSeek Harness、WorkBuddy、
Gemini CLI、Aider、Cursor、opencode、Copilot、Cline、Windsurf、Qwen Code、Kimi**，
以及任何能执行一条命令或发一个 HTTP 请求的工具。

**能做什么**（全部本地，无遥测）：

- **状态灯**：绿=运行、黄=需要你、红=失败、紫=刚完成（瞬态）、白=空闲，语义严格、绝不撒谎（见 [docs/state-design.md](docs/state-design.md)）
- **多代理同时盯**：胸口 8 段槽位灯 + 底座 16 段灯环，谁在跑、谁在拖后腿一眼可见
- **cc-switch 联动**：被接管后显示真实模型/供应商（「Claude Code 用 deepseek-v4.1-flash」）
- **情绪表情**：出错头顶冒火焰 + 虹膜发红，等待含泪跺脚，未知瞳孔放大，完成喷金色星星
- **自主动作**：空闲时自己张望、伸懒腰、抛接、抖擞、看手爪、巡视、点头，不再呆坐
- **互动**：拖拽会挣扎、连点三下悬空转圈、指针停手臂会张手爪，右键开设置、双击打招呼
- **自定义外观**：11 皮肤 / 8 瞳色 / 7 履带 / 8 配件 / 5 手爪 / 3 头型 / 4 镜筒 / 14 场景 / 36 灯效，一键随机换装、命名方案、配色主题
- **桌面拆解**：设置菜单里点一下，**就在桌面浮层里**把机器人拆开——不跳网页、不开第二个窗口。
  整机 → 依次拆解 → 全部零件 → 装回，49 个命名零件，悬停看零件名与说明，滑块控制拆解程度
- **本机资源**：机器人下方一条 CPU / 内存占用（中性色，不借用状态色），设置里可以关掉
- **今日时长广告牌**：机器人旁一块金边招牌显示今天谁忙了多久（最多/合计/轮播/关闭可选），另有「最近动态」时间线
- **MCP**：`bao mcp` 让任何支持 MCP 的代理自己上报 `report_status`
- **开机自启 + 一键盯全部**：`bao autostart on`、`bao watch all`
- **可选语音/提示音**（默认关闭）

本项目是 [signalhead](https://github.com/deepak-hp/signalhead)（MIT）的二次开发版本：
核心状态机与「安静不等于完成」等设计沿用并继续演进，界面与代理接入层已重写。
由 [baoan778](https://github.com/baoan778) 维护。

---

## 安装

```bash
npm install -g baoanlight
bao setup        # 首次运行：下载 Electron 运行时（约 140 MB）
bao start
```

从源码跑：

```bash
git clone https://github.com/<you>/baoanlight
cd baoanlight
npm install
npm run setup
node src/cli.js start
```

不需要桌面窗口也可以：

```bash
bao start --browser      # 在浏览器标签里显示同一个机器人
```

> `setup` 单独一步，是因为 npm 11 默认拦截安装脚本，而 Electron 的二进制正是由那个脚本下载的。
> 升级会替换 `node_modules`，运行时随之丢失——`bao start` 发现后会自己重新拉取（有缓存，很快）。

---

## 快速上手

```bash
bao onboard            # 首次运行：探测装了哪些代理，引导接入
bao start              # 后台运行，立刻把终端还给你
bao connect claude     # 接入 Claude Code，立即生效，无需重启
```

`bao start` 默认脱离终端；关掉终端不会带走机器人。用 `bao stop` 停止，或
`bao start --foreground` 自己盯着它（Ctrl+C 干净退出）。

拖动机器人到任何位置，它会记住。鼠标悬停出现小工具栏：切换大/小尺寸、缩成小机器人、退出。
窗口默认点击穿透——除了机器人本身，鼠标点击都会落到下面的窗口上。

```bash
bao status             # 现在各个代理是什么状态
bao status --json      # 同一份数据，给脚本/直播/第二屏用
bao agents             # 支持哪些代理、各自怎么接
bao clear              # 清掉崩溃代理留下的僵尸会话
bao doctor             # 体检：本机接线是否正确
bao demo               # 依次播放五种状态，检查动效
bao stop               # 全部关闭
```

设置菜单里的「在桌面上拆解机器人」会**就地拆解**：浮层临时变大，相机自动后退，
零件飞散后悬停即可看名字；`Esc` 或 ✕ 收起，机器人回到原位与原来的机位。

仓库里仍保留一个独立的拆解页（`http://127.0.0.1:4747/teardown/`），它只用于录制/演示，
不再是菜单里的入口。想把它录成影片：

```bash
npm run capture:teardown -- --fps 30 --seconds 18   # 出 PNG 帧 + timeline.json；有 ffmpeg 自动合成 mp4
```

---

## 接入代理

> 完整的分步接入指南见 **[docs/connecting.md](docs/connecting.md)**；不确定先接哪个，直接跑 `bao onboard`。

三层，越靠前越准。

### 1. 代理自己的钩子 —— 精确

```bash
bao connect claude     # 写 ~/.claude/settings.json（--scope project 只写当前仓库）
```

| 代理 | 状态 | 方式 |
|---|---|---|
| Claude Code | 全部三种，按会话 | 八个生命周期钩子 |
| Codex | 全部三种 | `bao watch codex` 读取会话日志 |

Claude Code 的钩子不需要重启即可生效。钩子脚本 1.5 秒硬超时、任何异常都静默退出 0——
**永远不会因为指示灯坏了而卡住你的代理**。

### 2. 会话日志 —— 精确，且不用改代理配置

```bash
bao watch codex         # ~/.codex/sessions/YYYY/MM/DD/*.jsonl
bao watch deepseek      # dsh 的会话投影（JSON），或别名 bao watch dsh
bao watch workbuddy     # WorkBuddy 的任务板
```

各自读的是：

- **Codex**：自己的 rollout JSONL，能给出忙碌/等待/完成，以及套餐额度。
- **DeepSeek Harness（dsh）**：`dsh` 的原始会话是 zstd 压缩的，但它会为每个会话维护一份
  明文 JSON 投影（`%APPDATA%\dsh-desktop\...\session_projcache\sessions`，设了 `DSH_HOME`
  则在 `$DSH_HOME\storages\...`）。观察器只读三行：`userQuestions` 有未答问题 → 黄灯，
  `turnBoundary.openTurnStartSeq` / `sessionStats.openStep` 非空 → 绿灯，回合已关闭 → 空闲（白灯）。
  它还会把 `contextPressure` 换算成「上下文还剩多少」，直接驱动电量条（这是唯一一个真实的
  剩余量，不是猜测）。
- **WorkBuddy**：读它的任务板（`~/.workbuddy/tasks`）——有任务 `in_progress` 即绿灯。
  **这是粗粒度信息**；要精确到「某一轮在等你」，用 `bao hook --agent workbuddy`。

如果它装在别处，直接指过去（`--dir` 仍按同一格式解析）：

```bash
bao watch deepseek --dir "$DSH_HOME/storages/session_projcache/sessions"
bao watch workbuddy --dir "D:/WorkBuddy/tasks"
```

如果 dsh 的目录里放的是别的 JSONL 日志，用 `--jsonl` 强制走通用读取器。

也可以写进配置，之后就不用每次带参数：

```json
{ "agents": { "workbuddy": { "dir": "D:/WorkBuddy/logs" } } }
```

日志解析是**宽容**的：`task_started` / `turn_complete` / `approval_request` / `needs_input`
以及 `{"state":"busy"}` 这类字段都能识别；token 数、思考增量、工具输出属于「环境噪声」，
只会给忙碌会话续命，**不会改变状态**——否则一条迟到的环境事件就能把刚变绿的机器人重新点亮。

### 3. 通用钩子 / 包装器 / 一行命令

如果某个工具能执行命令（但没有已知适配器），让它把事件打到 stdin：

```bash
bao hook --agent deepseek          # {"state":"busy"} / {"event":"task_complete"}
bao hook --agent workbuddy --state waiting --detail "approve plan?"
```

如果它只有终端界面：

```bash
bao wrap -- gemini
bao wrap -- aider --model sonnet
bao wrap --agent my-bot -- ./my-agent.sh
```

包装器用伪终端运行代理，字节原样透传，通过 `src/adapters/patterns.js` 里的正则读屏幕。
输出在流动 = 黄；输出停在一个确认提示上 = 红；停下来但没有提示 = 绿。
**这是很好的猜测，不是事实**——有钩子就用钩子。

如果以上都不行，还有一行 shell：

```bash
bao set busy    --agent deploy --detail "building"
bao set waiting --agent deploy --detail "approve prod push?"
bao set idle    --agent deploy
```

或从任何语言发 HTTP（写入要带本机 token，读不用，见「本地安全」）：

```bash
curl -s -H "x-bao-token: $(bao token)" \
  "http://127.0.0.1:4747/set/busy?agent=my-bot&session=$$&detail=thinking"
```

---

## 电量表

机器人右侧有一条竖直电量条，表示你还能用多久——套餐额度、上下文窗口、余额，随你定义。
从底部填充，满格到顶。填充色是中性石板灰：红/黄/绿在这个部件上已经代表
**代理状态**，不能再被电量复用。只有「快用完了」才变色：低于 25% 琥珀、低于 10% 红色。

Codex 会自己上报真实数字：

```bash
bao watch codex                 # 跟随套餐额度
bao watch codex --fuel context  # 或跟随上下文窗口占用
```

其他工具一行搞定：

```bash
bao fuel 63 --agent claude --label "plan quota"
bao fuel 12 --used --agent ci --label "build minutes"   # --used 表示「已用掉」
```

电量永远表示**剩余**，0–100。多个代理同时上报时，显示最空的那个——最先让你停摆的那个。
电量走独立通道，更新额度不会扰动指示灯。

---

## 同时观察多个代理

胸口的仪表板上有 **8 段固定槽位灯**，一个软件一段，左右顺序永远不变：

```
槽位:   deepseek  claude   codex   workbuddy   [4 个空位，给以后新增的]
          ●         ●        ●         ○
         红        绿       黄        熄灭
```

顺序就是 `src/store.js` 的 `AGENT_ORDER`（也是 `shared/palette.mjs` 的 `AGENT_SLOTS`，
测试盯着两者不许分叉）。同级时排在前面的那个拿走主灯，所以 DeepSeek Harness 是默认的
「主」软件——位置是契约的一部分，不要按心情重排。

- **段灯**常亮，任何一个软件的状态都不会被别的软件盖住——不用切换、不用轮播。
- **主灯**（大灯 + 地面溢光 + 全身姿态）只显示最要紧的那一个：
  **红 > 黄 > 绿 > 紫 > 灰白 > 白暗 > 熄灭**。
- **同级冲突**：按上面的固定顺序取靠前的那个，永远一致。谁后上报不影响结果，
  否则两个同优先级的软件会让主灯来回跳。
- **同一软件多开**：合成一段，显示最坏的那个，标签写 `×N`。
- 仪表板下方还有一行文字标签（颜色 + 名字），色觉障碍也能读。
- **桌面灯环**：底座一圈 16 段灯按软件分区，谁最要紧，谁的那一段就在跑马/呼吸/频闪，
  其余段常亮——「谁在拖后腿」和「还有谁在跑」能同时看到，不用切换。
- **槽位表由服务端下发**（`src/store.js` 的 `AGENT_ORDER`）：多接一个软件只需在那里
  加一个名字，界面自动多一行、灯环多一段，前端不用改；用户在设置里排过的顺序优先，
  服务端新增的软件追加在末尾。
- 窗口宽度固定、只向下生长，所以机器人永远钉在屏幕的同一个像素上。

手上能做的事：

| 操作 | 结果 |
|---|---|
| 右键机器人 | 弹出设置菜单（尺寸、外观、动作、系统、导入导出…） |
| 双击机器人 | 双臂抬起挥手两秒 |
| 单击机器人 | 抬头、眨眼、跳一下 |
| 连点三下 | 抓狂彩蛋：原地转两圈 + 抖动 + 悬空 |
| 拖动机器人 | 手臂乱摆、眼睛睁大（挣扎） |
| 指针停在眼睛上 | 只转头，身体不动——真的在看你 |
| 指针停在身上 | 整机转身，能看到侧面和背面 |
| 指针停在手臂上 | 手爪张开回应 |

「最近动态」在设置菜单里：本次运行期间谁完成了、谁需要你、谁出错，逐条带时间记录。

---

## 自定义系统

右键 → 设置里可以改的东西，全部写入 `~/.baoanlight/config.json`，重启不丢：

| 类别 | 选项 |
|---|---|
| 体型 / 尺寸 | Q版·标准·修长；70%–170% 缩放 |
| 皮肤 | 11 种（做旧黄 / 军绿 / 金属银 / 碳纤黑 / 樱花粉…） |
| 瞳色 / 镜筒 | 8 种瞳色；圆·方·六边形·三角镜筒 |
| 履带 / 配件 | 7 种履带配色 + 3 种履带形状；8 种配件配色 |
| 手爪 / 胳膊 / 头型 | 5 种手爪、3 种胳膊、双筒·单眼·三眼 |
| 场景 | 14 种：无 / 雪地 / 草原 / 沙漠 / 星空 / 岩浆 / 樱花 / 海洋 / 森林 / 雨夜 / 工厂 / 雪夜 / 黄昏 / 极光 |
| 灯光 | 36 种底座灯效、光环样式、灯光亮度 |
| 动作 | 5 个状态各配一种手势、待机频率、动效强度（省电/标准/华丽） |
| 配色主题 | 8 套一键套用；另有「随机换装」和命名「外观方案」 |
| 今日招牌 | 最多 / 合计 / 轮播 / 关闭（机器人旁的时长广告牌） |
| 系统 | 提示音+语音播报、点击穿透、显示未运行软件、显示模型、CPU/内存面板、列表行数、铭牌、软件顺序 |

导入/导出：设置里的「导出配置」把以上全部打包成 JSON，「导入配置」一键恢复（`bao onboard` 负责首次接入引导）。

---

## 平台支持

| | 逻辑 | 悬浮窗口 |
|---|---|---|
| Windows | 已验证 | 已验证 |
| Linux | 已验证 | 需要合成窗口管理器才能透明；否则用 `bao start --browser` |
| macOS | CI 验证 | 未肉眼确认 |

核心是纯 Node，无运行时依赖；窗口是 Electron（可选），透明/穿透/置顶在不同平台行为略有差异。

---

## 本机接线对不对

```bash
npm test         # 153 个逻辑测试：状态机、适配器、钩子、安装器、电量、鉴权、资源采样、调色板、事件契约、HTTP 请求体与配置落盘、启动自检
npm run test:ui  # 67 个渲染测试：机器人、桌面拆解、系统面板、标签、电量条、CSP、XSS、朗读文本、键盘路径、帧率/降级预算，以及落地页对比度
npm run lint     # 未定义的变量、声明了没用的变量、重复键、走不到的代码
bao doctor       # 本机：二进制、配置路径、日志目录、服务器
```

`npm test` 证明逻辑对；`doctor` 证明**这台机器**接线对——两者是不同的失败。

---

## 配置与本地文件

全部在 `~/.baoanlight/`（可用 `BAOANLIGHT_HOME` 覆盖）：

- `config.json` —— 端口、窗口位置、尺寸（`full`/`mini`）、是否折叠、`clickThrough`、
  是否显示标签、四个超时（`sessionTtlMs` / `idleTtlMs` / `quietAfterMs` / `unusedTtlMs`）、
  各代理日志目录 `agents`
- `hook-events.log` —— 每个钩子事件 → 状态映射的流水账（`BAOANLIGHT_LOG=0` 关闭）
- `token` —— 本机写入令牌（POSIX 下 0600；Windows 继承用户目录 ACL，首次启动自动生成）。`bao token` 打印它；
  钩子、CLI、MCP 自己读，不需要你抄到任何地方
- `port`、`server.log`

从旧版本升级时，第一次运行会把 `~/.signalhead/config.json` 复制过来，旧目录不删除。

---

## 本地安全

服务只绑 `127.0.0.1`，但「只绑回环」不等于「只有你」——浏览器允许任何网页往本机端口
发请求，一个 `<img src="http://127.0.0.1:4747/set/busy">` 就能让机器人替别人的网站
举手，而这个工具唯一的承诺就是灯不说谎。所以：

- **写入要 token。** `/set/*`、`POST /state`、`/clear`、`/quit` 都必须带
  `x-bao-token`（也接受 `?token=` 或 `Authorization: Bearer`）。`bao set`、
  `bao fuel`、各代理钩子、MCP 都已经自己读 `~/.baoanlight/token`，接线不用改。
- **读不设卡。** `/state`、`/events`、`/health` 免 token：`bao status`、机器人窗口、
  OBS 浏览器源照旧。
- **Host 和 Origin 都必须是本机。** 前者挡 DNS rebinding（`evil.com` 解析到
  127.0.0.1 时 Host 还是 `evil.com`），后者挡跨源读写；不再回显
  `Access-Control-Allow-Origin: *`，别的网页连你的工作目录都读不到。
- **渲染进程是沙箱。** 页面自带 CSP（`script-src 'self'`，没有内联脚本），Electron
  窗口 `sandbox: true` 且禁止跳转到别的地址；服务端来的字符串（软件名、detail、
  模型名）一律按文本渲染，不拼 HTML。

---

## 为什么有时候看起来「不对」

- **未知事件不动灯，但会说出来。** 早期版本把无法识别的事件当成 busy，结果一个意外 payload
  就把灯钉死，且无从排查。现在灯不动，仪表板会显示 `?` 并要求你去看 `hook-events.log`。
- **只报过到、没干过活的会话 2 分钟后清除。** 有些代理会打开会话然后默默消失，不发结束事件。
- **90 秒没上报的会话会变暗**，表示「这是我上次听到的，有一会儿了」，而不是「现在就是这样」。
- **空闲（白灯）30 分钟没人碰就遗忘**；崩溃或强杀不会发结束事件，否则它会在那里假装「随时可以开工」。
  **黄灯和红灯都不会自动消失**，等多久都在。
- **忙着的会话沉默不会变成空闲。** 它在深度思考、没有工具调用时可以几分钟不输出；沉默不是完成的证据。
  超过空闲窗口就直接丢弃，而不是改灯。
- **窗口断线时全部熄灭。** 断线不是代理的状态，是我们不知道；冻结的绿色会骗你去查看。
- **只报额度的上报不会凭空造出一个软件。** 一条迟到的 `token_count` / quota 事件属于某个
  已经在报状态的会话；如果那个会话已经不在了，它只更新电量条，不会在仪表板上点亮一格
  「就绪」。人手敲的 `bao fuel 63 --agent x` 是例外——那是你明确说「x 存在」。
- 每次事件都写进 `~/.baoanlight/hook-events.log`，这是区分「代理没发」和「我们映射错了」最快的方式。
  无法识别的事件只记录字段名与长度，**不记录内容**——这些载荷里常带 prompt 与工具输入。

---

## 已知限制

- 包装器的红色是正则匹配；某个 CLI 用奇怪措辞时你会看到绿色而不是红色，加一条正则即可。
- **dsh** 的状态来自它的投影文件，只有「开回合 / 开步骤 / 待回答问题」三个信号。如果 dsh
  被强杀，投影里会留下一个永远打开的回合，机器人会保持忙碌——会话超过上限（默认 6 小时）
  后自动清除，也可以 `bao clear`。
- **WorkBuddy** 的任务板是计划状态，不是逐 token 状态；没有 `in_progress` 任务时它可能显示
  绿灯而实际仍在思考。要精确请用 `bao hook --agent workbuddy`。
- 其他代理的日志格式没有公开规范，解析是宽容匹配；改 `src/adapters/log-watch.js` 一处即可。
- 机器人的动效遵循 `prefers-reduced-motion`：系统开启「减少动态效果」后动作幅度归零，
  整场帧率降到 8fps（灯效本身不变，状态仍然可读）。

---

## 开发

```
src/server.js           HTTP + SSE，只绑 127.0.0.1
src/auth.js             本机写入 token + Host/Origin 校验（见「本地安全」）
src/store.js            会话、七种状态、电量、优先级
src/overlay/            机器人窗口（index.html 结构样式，ui.js 界面逻辑，robot3d.js 建模与动效）
  shared/palette.mjs    外观色值的唯一真源（界面色块与 3D 材质同读一份）
  scene/geometry.js     纯几何：尺寸进、BufferGeometry 出
  scene/surfaces.js     程序化纹理：锈迹、掉漆、地表、铭牌，全部现画
src/hooks/              claude.js / codex.js / event.js（通用）
src/adapters/
  agents.js             支持哪些代理、各自怎么接入、日志在哪
  log-watch.js          通用 JSONL 会话日志观察器（Codex 等）
  dsh-watch.js          DeepSeek Harness 会话投影观察器
  task-watch.js         WorkBuddy 任务板观察器
  watchdog.js           三个观察器共用的一条规矩：机器人退了就收摊
  install.js            写 Claude/Codex 配置
  wrap.js + patterns.js 伪终端包装器与输出正则
src/doctor.js           本机诊断
```

加一个「有日志的代理」只需在 `agents.js` 加条目、在 `log-watch.js` 补关键词；
加一个「只有终端的代理」只需在 `patterns.js` 加一组正则。

拆解模型就在仓库里（`src/overlay/teardown/`：`spec.js` 是尺寸与阶段的真源，`model.js`
建模；`inline.js` 把它接进桌面浮层，`live.js` 是独立拆解页的巡游）。要把它录成影片，
用上面的 `npm run capture:teardown`。

落地页（`docs/index.html`）里的机器人是**同一份 3D 代码**，不是另画的一张图：GitHub Pages
只发布 `docs/`，所以 `npm run build:pages` 把渲染代码复制到 `docs/demo/`。改完
`src/overlay/robot3d.js` 记得跑一次 —— `test/contracts.test.js` 会逐字节比对，忘了会红。

---

## 授权

MIT。原始项目 signalhead 亦为 MIT，版权归其贡献者。
