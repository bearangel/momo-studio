# 设计：abort 贯穿在途工具——停止按钮让回合确定性终局

- 日期：2026-11-19
- 状态：已立项（未排期）
- 上游输入：2026-11-19 用户桌面导出库实证（state.db + main.log，三起现场）

## 1. 问题（实证）

用户在 Windows 多仓 workspace 上点击停止按钮，回合不死、UI 悬转，只能重启应用：

| 现场 | 事实（日志/DB） |
|---|---|
| grep 卡死（09:15:03） | `grep {pattern:"db-pro|db_pro", path:"."}` 起跑后主进程静默 5 分钟；09:19:57–09:20:09 用户连点停止，**13 次 `abortTurn 完成` 日志**，回合不终局；09:20:14 重启（RouterService 销毁）才解脱 |
| bash 悬空 ×2（09:37:40 / 09:39:25） | message_events 中 `tool_call_start` 无对应 `tool_call_result`——abort 时刻工具在途，结果永不落库 |
| 历史 grep 失败（11-17） | 72–79s 才失败返回（success=0）——无预算时代的慢路径 |

**根因**：`abortTurn` 只中止 LLM 流（`stoppedStream: true`）；runner 子进程内**在途的工具 Promise 无中断通道**——工具不返回，回合无法收尾，`tool_call_result` 永不产生。abort 的「完成」日志只表示请求受理，不表示回合终局。

> 注：2026-11-19 已落地 grep/glob 预算（60s 墙钟 + 候选上限 + target/logs 忽略）与插件工具清单暴露（resource_list type=pluginTools）——本 spec 处理的是**通用中断语义**，不依赖任何单个工具自觉。

## 2. 目标与非目标

**目标**
1. 停止按钮在确定时间内（目标 ≤5s，硬上限 10s）让回合终局——无论工具多慢。
2. 在途工具的 `tool_call_result` **确定性落库**（标记 aborted），UI 不悬转、账本无悬空。
3. agent runner 中止后可继续服务下一回合（进程可复用或确定性重建）。

**非目标**
- 不做工具级精细回滚（半写的文件不回滚——既有变更账本语义不变）。
- 不改 UI 停止按钮交互（用户感知面不变，只是真的会停）。

## 3. 方案：signal 快速路径 + 强杀保底（组合）

### 3.1 快速路径：AbortSignal 贯穿 ToolContext

- `RuntimeConfig` 不动；runner 主循环（runTaskChatLoop）每回合建 `AbortController`，`ToolContext` 增可选 `signal?: AbortSignal`（跨 AGENT_CONFIG 之外的回合级通道，主进程→子进程经既有 IPC 指令下发 `turn:abort`）。
- 主进程 `abortTurn`：先停 LLM 流（现状），**再向 runner 发 `turn:abort`**；runner 收到即 `controller.abort()` 并：
  - 在途 `execute` 的 Promise.race(signal)——reject 为 `ToolAbortedError`；
  - 工具内部协作检查点（grep 批循环 / bash kill 子进程树 / browser 停止加载）尽力快退，不做强制要求。
- 工具结果以 `aborted` 态落 `tool_call_result`（payload 带 `error: '用户停止'`），回合以 `final{status:'aborted'}` 收尾（既有状态）。

### 3.2 保底路径：限时强杀 + 重建

- abort 发出后 **5s** 仍未见该回合 `final` → 主进程 kill 该 runner 子进程（`pool.release` + `evict`），合成 `tool_call_result(aborted)` 与 `final{status:'aborted'}` 落库，随后按既有 respawn-on-idle / ensure 链路拉起替代进程。
- 强杀路径不依赖任何工具配合——**这是确定性的来源**；signal 只是让多数情况优雅且快。

### 3.3 落账语义

- `tool_calls` 表：success=0 + output_summary='用户停止'（审计面完整）。
- `message_events`：补合成 result 事件（id 唯一性按 event-buffer 既有纪律）。
- WarmPool：被杀条目经既有 `evict` 清理；池自动 replenish。

## 4. 影响面（预估）

| 层 | 文件 | 改动 |
|---|---|---|
| 主进程 | `agent-runner.ts`（abortTurn）、`runtime-spawner.ts`（消息路由）、`stream-relay` | abort 二段化 + 保底计时器 + 合成事件 |
| 子进程 | `runtime-entry.ts`（runTaskChatLoop）、`tools/types.ts`（ToolContext.signal）、`tools/shared/` | 回合级 controller、race 包装、检查点 |
| 工具 | grep / glob / bash / browser 优先接检查点；其余靠 race 兜底 | 渐进 |
| 测试 | fork 级（真子进程 + 慢工具 fixture） | 锁「abort ≤Ns 终局 + result 落库 + 下一回合可用」 |

## 5. 风险与取舍

- **杀进程的代价**：子进程冷启 ~200-500ms（WarmPool 摊销）；比「用户重启应用」小两个数量级。
- **signal 漏网工具**：由 5s 保底覆盖——不追求全工具优雅。
- **半写状态**：bash/apply_patch 的中断一致性沿用变更账本既有语义（不在本 spec 扩展）。
- **误杀窗口**：若工具恰在 5s 边界完成——race 先到者胜，保底计时器需校验回合仍未终局才杀（幂等检查）。

## 6. 验收锚点

1. 复刻现场：Windows 大目录 grep（或注入慢工具）→ 点击停止 → ≤5s 回合终局、UI 恢复、无悬空 start。
2. 停止后同会话继续对话（新回合正常 spawn/复用）。
3. bash 在途（子进程树）停止 → 子进程树被回收（无孤儿）。
4. 既有 abort 语义回归：LLM 流中停止（无工具在途）行为不变。
