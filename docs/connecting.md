# 接入代理指南

机器人自己不创造状态，它只如实显示「谁在干什么」。接得越准，灯就越可信。
下面按「越靠前越准」排序，四种主流代理 + 兜底方式，Windows 优先。

> 不确定本机装了哪些、该先接哪个？直接跑 **`bao onboard`**，它会探测并引导。

## 一览

| 代理 | 精度 | 接入方式 | 命令 |
|---|---|---|---|
| Claude Code | ★★★★★ 五态、按会话 | 生命周期钩子 | `bao connect claude` |
| Codex | ★★★★☆ 五态 + 套餐额度 | 读会话日志 | `bao watch codex` |
| DeepSeek Harness | ★★★★☆ 三态 + 上下文电量 | 读会话投影 | `bao watch deepseek` |
| WorkBuddy | ★★★☆☆ 四态（任务板）/ ★★★★★（钩子） | 任务板 / 钩子 | `bao watch workbuddy` 或 `bao hook --agent workbuddy` |
| Gemini / Aider / 其他 CLI | ★★★☆☆（猜） | 伪终端包装 | `bao wrap -- <命令>` |
| 任意能执行命令的工具 | ★★★★★ | 通用钩子 | `bao hook --agent <name>` |
| 任意能发 HTTP 的工具 | ★★★★★ | HTTP（写入带 token） | `curl -H "x-bao-token: $(bao token)" http://127.0.0.1:4747/set/busy?...` |

---

## 1. Claude Code（钩子，最准）

```bash
bao connect claude
```

写入 `~/.claude/settings.json` 的 9 个生命周期钩子，**立即生效、无需重启**。

- 只写当前仓库、不碰全局：`bao connect claude --scope project`
- 撤销：`bao disconnect claude`
- 钩子 1.5 秒硬超时、任何异常都静默退出 0 —— **绝不会因为指示灯卡住你的代理**

## 2. Codex（日志）

Codex 的 `notify` 只有一个槽位，且只给两态（回合结束 / 审批）；读日志更全，还带套餐额度。

```bash
bao watch codex              # 读 ~/.codex/sessions/**/*.jsonl，五态 + 额度
bao watch codex --fuel context  # 电量条改成「上下文窗口占用」
```

- 五态 = 运行 / 等待审批 / **完成** / **失败** / 空闲：`task_failed` 亮红、`task_completed` 亮紫，不再笼统归成「空闲」。

- watcher 是独立进程，关终端就停。想一直开：`bao watch all` + `bao autostart on`

## 3. DeepSeek Harness（投影）

dsh 的原始会话是 zstd 压缩，但它给每个会话留了一份明文 JSON 投影，正好是三个信号
（有未答问题 = 黄、开回合/开步骤 = 绿、回合关闭 = 白），还有 `contextPressure` 能换算成
「上下文还剩多少」驱动电量条。

```bash
bao watch deepseek
bao watch deepseek --dir "D:/path/to/session_projcache/sessions"   # 装别处时指过去
```

## 4. WorkBuddy（任务板 / 钩子）

任务板能读出**四态**：`in_progress` 绿、`failed` 红、`blocked`/`needs_approval` 黄、全部 `completed` 白。仍是「任务粒度」的粗读；要精确到「某一轮在等你」，用通用钩子：

```bash
bao watch workbuddy                     # 任务板（粗，四态）
bao hook --agent workbuddy --state waiting --detail "approve plan?"   # 精确
```

## 5. 其他 CLI（包装器）

只有终端界面、没有结构化输出时，用伪终端跑它、按正则读屏幕：

```bash
bao wrap -- gemini
bao wrap -- aider --model sonnet
```

输出在流动 = 黄；停在确认提示上 = 红；停下来但没提示 = 绿。**这是很好的猜测，不是事实。**

### 长尾 agent 速查

| Agent | 推荐接法 | 说明 |
|---|---|---|
| Cursor（CLI 版） | `bao wrap -- cursor-agent` | 桌面版不写 `~/.cursor` 结构化日志，用包装器最省事 |
| Gemini CLI | `bao wrap -- gemini` | 官方 CLI，无 hook，包装器读屏幕 |
| Aider | `bao wrap -- aider` 或 `bao hook` | Aider 有 `--message` 非交互模式，可脚本化上报 |
| Windsurf / opencode | `bao hook`（能执行命令）或 `bao wrap` | 有 hook/命令能力就用 `bao hook`，精度更高 |
| Copilot CLI | `bao wrap -- copilot` | 无公开 hook |
| 自研 / 任意脚本 | `bao mcp` 或 `bao hook` | 推荐 `bao mcp` 暴露 `report_status`，任何 MCP 客户端都能调 |

**选型原则**：有生命周期钩子 → 精确五态；有结构化日志 → `bao watch`；只能跑命令 → `bao hook`；啥都没有只有终端 → `bao wrap`。优先顺序：钩子 > 日志 > 命令 hook > 伪终端。

## 6. 通用兜底

能执行命令 → 让它把事件打到 stdin：

```bash
bao hook --agent my-bot        # {"state":"busy"} 或 {"event":"task_complete"}
```

能发 HTTP → 一行（写入要带本机 token，它只存在 `~/.baoanlight/token`，`bao token` 打印）：

```bash
curl -s -H "x-bao-token: $(bao token)" \
  "http://127.0.0.1:4747/set/busy?agent=my-bot&detail=thinking"
```

> 为什么不是随便发？任何网页都能往 `127.0.0.1` 发请求，没有 token 的话，
> 一个 `<img src="http://127.0.0.1:4747/set/busy">` 就能替你点灯。
> 读接口（`/state`、`/events`、`/health`）仍然免 token。

---

## 接完之后

```bash
bao start          # 启动机器人（还没启动的话）
bao status         # 看它现在说什么
bao demo           # 依次播放四种状态，检查动效
bao doctor         # 体检本机接线对不对
bao autostart on   # 开机自启（机器人 + watch all）
```

每个事件都会写进 `~/.baoanlight/hook-events.log`——区分「代理没发」和「我们映射错了」
最直接的方式。
