# Task 7 报告 — MessageBubble 增强 + 流式→持久化替换

**状态：** ✅ 已完成并提交
**分支：** main
**Commit：** `363443b` — feat(v1.4): MessageBubble 增强 + 流式→持久化替换 — 历史消息渲染 thinking/工具卡片 + Matrix 最终消息替换临时流式状态

## 实施概要

### Step 1: MessageBubble 增强（renderer/src/components/im/MessageBubble.tsx）

增强 MessageBubble 以渲染 Matrix 历史消息中的 agent 持久化字段。

- 新增 `extractAgentMeta(content)` 辅助函数，从 `message.content` 安全提取 `io.momo-studio.thinking`（string）和 `io.momo-studio.tool_calls`（数组）。逐字段做类型收窄（typeof / Array.isArray / 非空对象检查），脏数据安全降级。
- 当检测到非空 thinking 或非空 tool_calls 数组时，渲染增强气泡（走 MessageFrame）：
  - `ThinkingSection`（默认折叠，同 AgentStreamBubble 完成态）
  - `ToolCallChip` 列表（`defaultExpanded={false}`）
  - 正文（ReactMarkdown，与普通气泡一致的 className）
  - bubbleClassName 用 `bg-bg-tertiary text-neutral-100 border border-border-subtle`（与 AgentStreamBubble 一致）
- 字段缺失时走原有普通气泡路径（行为完全不变）。

**与计划的偏差：** 计划示例代码用 `<MessageFrame message={message} ...>`，但 Task 6 已把 MessageFrame 重构为 `sender` prop（不是 `message`）。实际实现用 `sender={message.sender}`，与当前 MessageBubble 代码一致。

### Step 2: 流式→持久化替换（renderer/src/stores/im.store.ts）

在 `receiveMessage` 中实现流式临时态清理。

- `receiveMessage` 收到带 `io.momo-studio.stream_session_id` 的消息时，调用 `useStreamStore.getState().clearCompleted(sessionId)` 移除对应的临时流式气泡。
- 用闭包变量 `wasNew` 跟踪消息是否为新（非重复回放）。仅新消息触发 clearCompleted——重复回放的消息其流式态早已清理，无需重复触发。
- `im.store.ts` 新增 `import { useStreamStore } from './stream.store'`（无循环依赖：stream.store 不反向引用 im.store）。
- 提取 `STREAM_SESSION_ID_KEY` 常量，避免 magic string。

**Race condition 处理：** 若 end chunk 在 Matrix 消息之后到达（流式态被 race 重建），重复的 Matrix 消息（同 eventId）不会再次触发 clearCompleted——但实际场景中 end chunk 总是先于或同时于 Matrix 消息到达，clearCompleted 在第一次就完成清理。

### Step 3: 测试

**MessageBubble.test.tsx（+6 用例，共 11）：**
- content 含 thinking → 渲染 ThinkingSection（toggle 可见 + 正文）
- ThinkingSection 展开后显示 thinking 内容（验证 content 正确透传）
- content 含 tool_calls → 渲染 ToolCallChip（工具名可见）
- thinking + tool_calls 同时存在 → 两者都渲染（2 个工具卡片）
- content 仅含 stream_session_id（无 thinking/tools）→ 普通气泡
- tool_calls 格式非法（非数组）→ 安全降级为普通气泡

**im.store.test.ts（+3 用例，共 14）：**
- 收到带 stream_session_id 的消息 → 清理对应临时流式状态 + 消息写入列表
- 重复回放的消息（同 eventId）不重复触发 clearCompleted（验证幂等性）
- 不含 stream_session_id 的消息不影响流式状态

测试策略：MessageBubble 测试不 mock ThinkingSection/ToolCallChip（测真实集成），仅 mock DispatchCard/TaskReplyCard（路由隔离）。im.store 测试直接用 `useStreamStore.setState` 预置流式态，无需 mock window.api.agent。

## 验证结果

```
Typecheck（electron + renderer）：✅ 双 clean
Renderer 全量测试：✅ 175/175 passed（+9 新增，0 回归）
  - MessageBubble.test.tsx: 11/11
  - im.store.test.ts: 14/14
  - stream.store.test.ts: 11/11（未受影响）
  - AgentStreamBubble.test.tsx: 10/10（未受影响）
```

## 改动文件

| 文件 | 改动 |
|---|---|
| renderer/src/components/im/MessageBubble.tsx | +101 行：extractAgentMeta + 增强气泡渲染路径 |
| renderer/src/components/im/MessageBubble.test.tsx | +101 行：6 个增强气泡测试用例 |
| renderer/src/stores/im.store.ts | +18 行：receiveMessage 流式→持久化替换逻辑 |
| renderer/src/stores/im.store.test.ts | +132 行：3 个流式替换测试用例 |

## 未尽事项 / 后续

- 无 deferred minors。
- Task 8（配置 UI）为后续独立任务，本任务不涉及。
