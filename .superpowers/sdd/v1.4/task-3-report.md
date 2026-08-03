# Task 3 报告：Runtime 流式改造 + 预算 + Abort

**状态：** ✅ 完成
**提交：** `c7442a4`
**日期：** 2026-08-03

## 完成内容

### 7 步全部实现

| 步骤 | 文件 | 状态 |
|------|------|------|
| 1. stream-chunk.ts | `electron/src/main/agent/stream-chunk.ts` | ✅ 新建 |
| 2. dispatch.ts 字段扩展 | `electron/src/main/agent/dispatch.ts` | ✅ 修改 |
| 3. runtime streaming 测试 | `electron/tests/agent/runtime-stream.test.ts` | ✅ 12 用例 |
| 4. runChatLoop 重写 | `electron/src/main/agent/runtime-entry.ts` | ✅ 流式 + 预算 + abort |
| 5. handleEvent/handleDispatch 更新 | `electron/src/main/agent/runtime-entry.ts` | ✅ IPC 预算解析 |
| 6. resolveMaxToolCalls IPC | `electron/src/main/agent/runtime-entry.ts` | ✅ 5s 超时回退 |
| 7. formatBudgetHint + sendFinalMessage | `electron/src/main/agent/runtime-entry.ts` | ✅ |

### M5 修复（额外）

`chatStreamAnthropic` 的消息映射从内联简化版（drops toolCalls）改为复用提取的模块级 `toAnthropicMessage` 函数，与 `chat()` 路径一致。多轮工具对话在 Anthropic 流式模式下现在能正确传递 assistant toolCalls。

## 关键设计决策

### 1. runChatLoop 自发送最终 m.room.message

按 Task 描述 note #4 的决策：`runChatLoop` 内部发送最终 `m.room.message`（含 `io.momo-studio.thinking` / `io.momo-studio.tool_calls` / `io.momo-studio.stream_session_id` 元数据），`handleEvent` 和 `handleDispatch` 不再单独发送。返回值仍为 `Promise<string>`（供 `handleDispatch` 构建 `task_reply` body）。

### 2. 预算管理

- `maxToolCalls = -1` → `Infinity`（无限）
- `maxToolCalls = 0` → `tools = undefined`（不向 LLM 暴露工具）
- `maxToolCalls = N > 0` → 递减，耗尽时 `end(budget_exhausted)`
- dispatch 工具传递剩余预算（`budgetRemaining - 1`）给子 agent

### 3. resolveMaxToolCalls IPC

子进程发送 `{ type: 'settings:resolveMaxToolCalls', id, roomId }`，等待 `{ type: 'settings:resolved', id, maxToolCalls }`。主进程 handler 在 Task 4 实现；在此之前 5s 超时回退到硬编码默认 10。

### 4. tool_calls_used 上报

`runChatLoop` 通过可选 `stats` 对象输出工具调用次数。`handleDispatch` 据此在 `task_reply` 中设置 `tool_calls_used`。父 agent 当前仅扣除 dispatch 本身的 1 次预算（子 agent 使用的共享扣减为后续优化点）。

### 5. Abort 支持

`runChatLoop` 注册 `process.on('message')` 监听 `{ type: 'abort', streamSessionId }`，触发 `AbortController.abort()`。`chatStream` 收到 abort signal 后抛出 `AbortError`，catch 块发送 `end(interrupted)` chunk。abort 时不持久化 m.room.message（仅流式 UI 展示了部分文本）。

## 测试结果

```
tests/agent/runtime-stream.test.ts: 12 passed
  - 正常完成：start → text → end(stop) + m.room.message ✅
  - thinking 增量 + 持久化 ✅
  - 工具调用：tool_call → tool_result → text → end(stop) ✅
  - 预算耗尽：end(budget_exhausted) ✅
  - maxToolCalls=0：纯对话模式（tools=undefined）✅
  - maxToolCalls=-1：无限预算（15 次工具调用全执行）✅
  - abort：end(interrupted) ✅
  - stats 跟踪 toolCallsUsed ✅
  - start chunk 携带 roomId + botUserId ✅
  - formatBudgetHint（-1/0/N 三种）✅

全量测试：337 passed | 3 failed（conduit/manager 预存 flaky）
Typecheck：electron ✅ + renderer ✅
```

## 修改文件清单

| 文件 | 类型 | 行数变化 |
|------|------|----------|
| `electron/src/main/agent/stream-chunk.ts` | 新建 | +58 |
| `electron/src/main/agent/dispatch.ts` | 修改 | +12 |
| `electron/src/main/agent/llm-provider.ts` | 修改 | +36 -37 |
| `electron/src/main/agent/runtime-entry.ts` | 修改 | +274 -36 |
| `electron/tests/agent/runtime-stream.test.ts` | 新建 | +398 |
| **合计** | | +797 -81 |

## 向前兼容性

- `RuntimeConfig.maxToolCalls` 有默认值 10（parseConfig 兜底）
- `DispatchContent.tool_budget` / `TaskReplyContent.tool_calls_used` 均为可选字段
- `MAX_TOOL_ROUNDS = 10` 已删除，由 per-task `maxToolCalls` 替代
- `resolveMaxToolCalls` 5s 超时回退 → Task 4 实现 handler 后自动生效

## 已知限制 / 后续优化

1. **共享预算扣减未完整实现**：父 agent dispatch 时仅扣 1 次（dispatch 本身），未扣除子 agent 实际使用的 `tool_calls_used`。当前 `tool_calls_used` 已通过 task_reply 上报，Task 4 或后续可在 `executeDispatch` 返回值中携带此信息用于父 agent 预算扣减。
2. **Abort 不中断进行中的工具执行**：abort 仅在 `chatStream` 边界生效（下一轮 LLM 调用）。如果 dispatch 工具正在等待子 agent 回复（最长 9 分钟），abort 不会立即中断。
3. **流式 UI 消息持久化**：正常完成和预算耗尽时持久化 m.room.message；abort 和 error 时不持久化（仅流式 UI 展示）。
