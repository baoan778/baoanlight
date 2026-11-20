# 适配器开发规范

想让 baoanlight 盯上一个新的 AI agent？按这份规范来。核心原则只有一条：

> **宁可不知道，也不乱亮红灯。** 映射不出来的事件一律返回 null（环境噪音），
> 绝不猜。一个把「未知」硬译成「运行」的适配器是在撒谎。

## 四种接法（按精度排序）

| 接法 | 精度 | 适用 | 入口 |
|---|---|---|---|
| 生命周期钩子 | ★★★★★ 五态 | agent 有 hook 机制 | `src/hooks/*.js` |
| 结构化日志 | ★★★★☆ 五态+额度 | agent 写 JSONL 会话日志 | `src/adapters/*-watch.js` |
| 通用命令 | ★★★☆☆ 任意态 | agent 能执行命令 | `bao hook --agent X` |
| 伪终端 | ★★☆☆☆ 三态猜测 | 只有终端界面 | `bao wrap -- X` |

## 1. 事件词表（钩子/日志共用）

`src/adapters/log-watch.js` 的 `classify()` 是日志与通用钩子的事件→状态映射
（`hooks/event.js` 也 require 同一个函数）。`hooks/codex.js` 的 notify 词汇另有一套
（只认 complete / approval），但两边对同一个词必须给出同一种颜色：
complete→done（紫）、approval→waiting（黄）。`patterns.js` 只管伪终端包装器用的
屏幕正则，别把事件名加错地方：

- **busy**：`task_started` `turn_started` `run_started` `step_started` `tool_call_start` `message_start` `reasoning_started` `generating` `thinking` `working` `in_progress`
- **done**（紫）：`task_complete(d)` `turn_complete(d)` `run_complete(d)` `finished` `success` `succeeded`
- **error**（红）：`task_failed` `run_failed` `error` `failed` `crashed` `exception` `fatal`
- **idle**（白）：`task_aborted` `turn_aborted` `turn_cancelled` `turn_end` `agent_end` `stop` `cancelled`（中性收尾/用户取消）
- **waiting**（黄）：`*approval*` `*permission*` `needs_input` `blocked`
- **offline**：`session_end` `exit` `quit`
- **null（环境噪音）**：token 计数、流式 delta、心跳、工具结果回执……这些不改变状态

新 agent 的事件名先对照这张表；对不上的**加进对应的 Set**，不要在适配器里私映射。

## 2. 加一个日志型适配器

1. `src/adapters/agents.js` 注册 profile（名字、日志目录候选、label）。
2. 新建 `src/adapters/xxx-watch.js`：复用 `log-watch.js` 的扫描骨架，
   只实现「从一行 JSON 里认出 session id / cwd / 事件类型」。
3. `src/cli.js` 的 `watch` 命令挂上它。
4. `test/adapters.test.js` 至少覆盖：每个状态至少一个真实事件名 + 环境噪音返回 null。

## 3. 加一个钩子型适配器

1. `src/hooks/` 新建脚本（参考 `claude.js`）：读 stdin JSON → `classify` → `setState`。
2. `src/adapters/install.js` 加安装/卸载（写 agent 自己的配置文件，**必须先备份**）。
3. 钩子脚本必须**绝不抛错、绝不卡住** agent——try/catch 包住一切，超时自退出。

## 4. 测试底线

- 纯函数（`classify` / `deriveTaskState`）必须有单测，覆盖五态 + 噪音。
- e2e 至少跑通「一次 busy → done」的完整生命周期。
- 所有测试不依赖目标 agent 真的装在本机（用夹具数据）。

## 5. 提交前

```bash
npm test          # 逻辑全绿
npm run test:ui   # UI 全绿
bao doctor        # 本机体检通过
```
