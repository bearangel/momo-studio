# Task 13 报告：删除 v1 双轨 + runtime-entry 瘦身收尾 + task_reply 回传链线

> 注：本文件此前是 v1.6 周期同名 Task 13（RegisterMcpDialog）的报告，已归档至
> `task-13-report-v1.6-archived.md`。现为本 v2.0 Task 13 报告。

**Commit**: `65915ce` `refactor(agent)!: 删除 v1 长存进程双轨 + task_reply 回传链接线（BREAKING）`
**Branch**: `feat/v2.0.0-p1-session-core`（未 push）
**日期**: 2026-08-23

---

## 一、A 线：task_reply 回传链线（最高优先级，TDD 先行）

### 修复前链路的三处断裂

1. **Sub 侧不发回执**：`runTaskChatLoop` 完成 dispatch 任务后只发 `task-end` + `exit(0)`，
   `sendTaskReplyEvent`（internal-event.ts）零调用方。
2. **Runner 转发逻辑错误**：`AgentRunner.notifyTaskReply` 按 `active.taskId === reply.taskId`
   匹配——但 dispatch 的 task_id 由 PM 子进程内 `buildDispatchMessage` 生成（randomUUID），
   runner 无法感知；PM 的活跃 task 是 ephemeral chat（taskId=null），旧匹配**永不命中**，
   回执被静默丢弃。
3. **PM 侧不消费**：runtime-entry `taskMessageListener` 只处理 `task-config`/`shutdown`，
   `handleTaskReply` 是孤儿函数（导出但无调用方）。

### 修复内容（全链路）

| 环节 | 文件 | 变更 |
|---|---|---|
| Sub 回执 | `runtime-entry.ts` `runTaskChatLoop` | dispatchContext 设置时：成功 → `buildTaskReply(completed + reply_to + tool_calls_used)` → `sendTaskReplyEvent`；失败（catch 分支）→ `failed` 回执（body=错误信息），先回执再 task-end/exit |
| Runner 转发 | `agent-runner.ts` `notifyTaskReply` | 改为转发给**全部活跃子进程**；精确匹配由子进程 `pendingReplies` 按 task_id 完成（找不到仅记日志，安全） |
| PM 消费 | `dispatch-wait.ts` `handleTaskReplyIpc`（新导出） | camelCase `TaskReplyNotification` → snake_case content → `handleTaskReply` → resolve/reject pending dispatch promise；`taskMessageListener` 新增 `m.type === 'task-reply'` 分支 |

回执路由：`sendTaskReplyEvent` → child IPC（`momo-internal-event`）→ `internal-event-bridge.handleChildMessage`
→ `RouterService.routeEvent` → `routeTaskReply`（`reply_to` = PM assignmentId 精确路由）
→ `pmRunner.notifyTaskReply` → PM 子进程 `handleTaskReplyIpc` → dispatch promise resolve。

### TDD 证据

- **RED**（6 个新测试先行失败，原因均为"功能缺失"）：
  - `tests/integration/task-reply-return-chain.test.ts`：全链路集成——dispatch promise 2 秒内不 resolve（waitFor 超时）；
  - `tests/agent/runtime-task-driven.test.ts`：3 个回执发射测试失败（无 task_reply 内部事件）+ 2 个 `handleTaskReplyIpc` 测试失败（`is not a function`）；
  - `tests/agent/agent-runner.test.ts`：notifyTaskReply 转发测试失败（child.send 无 task-reply 调用）。
- **GREEN**：接线后全部通过；集成测试中 dispatch promise 在 sub 完成后 **56ms** resolve
  （旧路径为 3+6 分钟渐进式超时后 reject——主子调度生产不可用）。
- 回归：`task-driven-dispatch-chain.test.ts`、`router-service.test.ts` 全部保持绿色。

---

## 二、B 线：v1 双轨删除

### runtime-manager.ts 导出 re-homing 对照表（661 行，整体删除）

| 旧导出 | 去向 | 说明 |
|---|---|---|
| `AgentRuntimeOpts`（类型） | → `runtime-config.ts`（新） | 与 `RuntimeConfig`/`TaskConfig`/`parseConfig`/两个类型守卫合并同住；importer：spawn-helpers / agent-runner / runtime-spawner / runtime-registry + 相关测试 |
| `isAgentRunning` | → `runtime-status.ts`（新） | 纯 DB 读（last_running）；调用方：agent ipc.handlers / crud / workspace ipc.handlers |
| `stopAgent` | → 调用方改用 `stopAgentRuntime`（runtime-registry，单轨：destroyTaskDrivenRuntime + last_running=0） | crud.deleteDefinition / stopRunningInstancesByDefinition（改 async）/ agent ipc.handlers removeAgentAssignment + updateAssignmentRole |
| `spawnAgent` | 删除 | 唯一调用方是 runtime-registry v1 分支 + auto-start（均删） |
| `isV1SubprocessAlive` | 删除 | 唯一调用方 auto-start（删） |
| `stopAllAgents` | 删除 | src 零调用方（index.ts 走 destroyAllTaskDrivenRuntimes） |
| `abortStream(roomId)` + activeStreams/streamChildren | 删除 | stream-relay `abortStreamBySessionId`（按 streamSessionId 精确中断）是唯一活路径，停止按钮行为不变 |
| `setRuntimeEntryOverride` / 重启机器（`setRestartDelaysOverride`/`getRestartCount`/`hasPendingRestart`/`resetRestartCount`/`__resetRestartState`） | 删除 | 仅崩溃重启测试使用；task-driven 架构下 WarmPool 按需重拉，无崩溃自动重启概念 |
| `__getStreamChildren`/`__getActiveStreams`/`__resetStreamState` | 删除 | v1 嵌套中断测试钩子 |

### 删除文件

- src：`runtime-manager.ts`(661) / `auto-start.ts`(145) / `message-target-resolver.ts`(103) / `decide-response.ts`(78)
- tests：`runtime-manager.test.ts` / `runtime-manager-restart.test.ts` / `runtime-manager-last-running.test.ts` /
  `runtime-stream-abort.test.ts` / `auto-start-last-running.test.ts` / `message-target-resolver.test.ts` /
  `decide-response.test.ts` / `fake-runtime.ts` / `fake-runtime-stream.ts` / `fake-runtime-crash.ts`
  （T12 review 的注释卫生问题随文件消亡）

### 单轨化改造

- `runtime-registry.startAgentRuntime(opts)`：删 `taskDriven` 参数与 v1 spawnAgent 分支；
  `stopAgentRuntime`：删 runtime-manager 动态 import，单轨销毁 + DB 写 0。
- `agent/ipc.handlers.ts`：删 `def.taskDriven !== false` 传参（4 处）；停止路径全部 `stopAgentRuntime`。
- `workspace/ipc.handlers.ts`：协调 agent 重启的 startAgentRuntime 单参化。
- `init-runtime.ts`：删 `def.taskDriven === false` 跳过守卫（单轨世界全部恢复）；
  `crud.ts` 写 `task_driven: 1` 恒值（DB 列保留做历史兼容，类型注释已标 legacy）。
- `router-service.ts`：删零引用的 `RoutedEvent` 别名；头注释去 sync-manager/decideResponse/Matrix 表述。

### runtime-entry.ts 瘦身：**1571 → 899 行**（目标 <900 ✓）

删：`LegacyMatrixClient` 接口、`runChatLoop`/`executeTool`/`doExecuteTool`/`executeDispatch`/
`sendFinalMessage` 的 client 参数与 Matrix 发送分支、`RuntimeConfig.taskDriven` 字段 + parseConfig
解析 + main() 守卫、~line 325 陈旧注释块、全文件 v1/runtime-manager 历史注释。

拆（内聚模块化，非删功能）：

| 新模块 | 行数 | 内容 |
|---|---|---|
| `runtime-config.ts` | 256 | AgentRuntimeOpts + RuntimeConfig + TaskConfig + parseConfig + 类型守卫 |
| `dispatch-wait.ts` | 219 | executeDispatch / handleTaskReply / handleTaskReplyIpc / pendingReplies / 渐进式超时 |
| `mcp-bridge.ts` | 112 | requestMcpListTools / requestMcpCall / discoverMcpTools |
| `prompt-hints.ts` | 67 | formatBudgetHint / formatDispatchHint / formatTaskHint |
| `runtime-status.ts` | 19 | isAgentRunning |

`builtin-tools.ts` 顺带收编 `getBuiltinLoopToolDefs()`（task_complete/compact 工具声明）。

### 行为等价性要点

- **停止按钮**：`agent:abortStream` IPC → stream-relay `abortStreamBySessionId` → runner.abortStream
  → child abort IPC —— 全链路未动，`stream-relay.test.ts` 绿。
- **agent:stop**：`stopAgentRuntime` 单轨销毁 runner/pool + last_running=0（ipc-stop-start.test.ts 断言迁移后覆盖）。
- **最终消息持久化**：v2 由 chunk 路径（routeChunkToBuffer → messages 表）承载，Matrix sendEvent
  分支本就是死代码；分段（task_complete）由 segment_boundary chunk 落盘，行为不变。

---

## 三、门禁

| 门禁 | 结果 |
|---|---|
| electron 全测 | **128 files / 858 tests 全绿**（删 10 个 v1 测试文件，新增 task-reply-return-chain 集成 + 6 个回执单元用例） |
| renderer 全测 | 49 files / 409 tests 全绿 |
| typecheck | 双 workspace clean（strict，无 any/@ts-ignore） |
| `wc -l runtime-entry.ts` | **899**（before 1571） |

---

## 四、Concerns / 遗留

1. **`AgentDefinition.taskDriven` 字段保留**（types.ts + crud 读）：DB 列 `task_driven` 保留（migration
   022 历史，删列需新 migration，超出本任务范围）；写入恒 1，注释已标 legacy。后续版本可加 migration 清列。
2. **崩溃自动重启机器随 v1 删除**：task-driven 架构下 task 失败由上层（RouterService/用户重发）
   兜底；WarmPool acquire 时按需重拉子进程。若产品要"agent 级崩溃重启"需在 runner 层重新设计。
3. **`notifyTaskReply` 广播语义**：无 `reply_to` 的旧格式回执会广播到所有 runner 的活跃子进程，
   子进程找不到 pending 仅记一条 warn 日志（每子进程一条），可接受。
4. **router-service 的 `routeAbortDispatch` 仍是 TODO(T8)**：abort_dispatch 事件目前只记日志；
   PM 中断传播走的是 abortSignal → sendAbortDispatchEvent 兜底 + stream-relay abortStreamBySessionId
   主路径，不影响停止功能，但"子 agent 未启动时的迟到 abort"依赖事件桥路由（T8 待完整实现）。
5. 预先存在的未提交改动（`.superpowers/sdd/task-{1,5,7,11}-report.md`、`docs/2026-08-14-system-feature-inventory.md`）
   未纳入本 commit，保持工作区原状。
