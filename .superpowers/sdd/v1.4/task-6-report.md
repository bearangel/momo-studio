# Task 6 报告 — Stream Store + AgentStreamBubble + MessageList 集成

**状态：** ✅ 完成
**Commit：** `7b80001 feat(v1.4): stream store + AgentStreamBubble — 流式 chunk 状态管理 + 集成气泡 UI + MessageList 集成`

## 概述

实现流式回复的 renderer 端状态管理与 UI 集成：zustand store 聚合 IPC 推送的 StreamChunk，AgentStreamBubble 把 thinking + 工具调用 + 正文渲染成单个流式气泡，MessageList 在消息列表底部追加当前房间的活跃流式气泡。

## 交付内容

### 新建文件

| 文件 | 职责 |
|---|---|
| `renderer/src/stores/stream.store.ts` | zustand store，`Map<streamSessionId, StreamState>`；`init()` 注册 `ipc.agent.onStream` 回调，按 chunk.type 聚合 start/thinking/text/tool_call/tool_result/end；`clearCompleted()` 删除已完成的 session |
| `renderer/src/stores/stream.store.test.ts` | 12 个测试：start 创建、text/thinking 拼接、tool_call 追加、tool_result 匹配最后一个执行中同名工具、end 各 finishReason 映射 status、未知 session 忽略、init 返回 unsubscribe、clearCompleted |
| `renderer/src/components/im/AgentStreamBubble.tsx` | 流式气泡：MessageFrame 外壳 + ThinkingSection + ToolCallChip 列表 + 流式正文（闪烁光标）+ 底部状态栏（status 文案 + 停止按钮→`ipc.agent.abortStream`） |
| `renderer/src/components/im/AgentStreamBubble.test.tsx` | 10 个测试：4 种 status 文案、thinking/toolCalls 渲染分支、停止按钮触发 abortStream、流式光标存在、senderName 传递、空正文不崩溃 |

### 修改文件

| 文件 | 改动 |
|---|---|
| `renderer/src/components/im/MessageFrame.tsx` | **重构**：`message: ImMessage` → `sender: string`。MessageFrame 只用 `message.sender`（头像 emoji + 短名回退），改为直接接受 sender 字符串，解耦 ImMessage，避免 AgentStreamBubble 伪造 eventId/timestamp 或使用 `as never` |
| `renderer/src/components/im/MessageBubble.tsx` | 传递 `sender={message.sender}` |
| `renderer/src/components/im/DispatchCard.tsx` | 两处 MessageFrame 调用改为 `sender={message.sender}` |
| `renderer/src/components/im/TaskReplyCard.tsx` | 两处 MessageFrame 调用改为 `sender={message.sender}` |
| `renderer/src/components/im/MessageFrame.test.tsx` | 适配 `sender` prop（移除 ImMessage 构造） |
| `renderer/src/components/im/MessageList.tsx` | 订阅 `useStreamStore`，在消息列表底部追加当前房间 `status==='streaming'` 的 AgentStreamBubble；空消息但有活跃流式时也渲染（不显示"暂无消息"占位）；滚动依赖加入 activeRoomStreams |
| `renderer/src/App.tsx` | `useEffect` 注册 `useStreamStore.getState().init()`，返回 unsubscribe 在卸载时取消订阅 |

## 关键设计决策

### MessageFrame 重构（message → sender）

计划原文用 `as never` 把 StreamState 伪装成 ImMessage 传给 MessageFrame。这违反项目硬约束（禁止 `as any`/`as never`）。分析 MessageFrame 源码发现它只读取 `message.sender`（用于头像 emoji 哈希与短名回退），不依赖 eventId/roomId/body/eventType/content/timestamp。

两种合规方案：
1. 伪造完整 ImMessage（fabricate eventId/timestamp）——语义错误，stream 没有真实 eventId
2. 重构 MessageFrame 接受 `sender: string`——干净、诚实

选择方案 2。重构是机械式的：MessageFrame + 3 个调用方（MessageBubble/DispatchCard/TaskReplyCard）+ MessageFrame 测试，共 5 文件。所有现有测试零修改通过（29 IM 测试全绿）。

### tool_result 匹配策略

流式生命周期内可能多次同名工具调用（如两次 grep）。tool_result chunk 只带 toolName 不带调用 ID。采用"从后往前匹配最后一个同名且仍在执行中的工具"策略，符合 FIFO 完成语义。测试覆盖了这个边界（两次 grep，tool_result 命中第二个）。

### 测试环境 mock 模式

stream.store 测试用 `vi.stubGlobal('window', {api:{...}})`（无 React 渲染，可整体替换 window）。
AgentStreamBubble 组件测试必须保留 jsdom 的 window（React DOM 依赖 document/navigator），因此用 `(globalThis as ...).window.api = mockApi` 仅注入 api 字段——与 CreateWorkspaceDialog/FileTree/MainLayout 测试一致。

## 验证结果

```
typecheck: electron ✅ renderer ✅（双 workspace 零错误）
vitest 相关: 8 文件 64 测试 ✅
vitest 全量 renderer: 21 文件 166 测试 ✅（无回归）
```

新增测试明细：
- stream.store.test.ts: 12 passed
- AgentStreamBubble.test.tsx: 10 passed

回归验证（MessageFrame 重构未破坏调用方）：
- MessageFrame.test.tsx: 5 ✅
- MessageBubble.test.tsx: 5 ✅
- DispatchCard.test.tsx: 7 ✅
- TaskReplyCard.test.tsx: 12 ✅

## 遗留 / 下游

- **Task 7** 将在 MessageBubble 中渲染 Matrix 历史消息的 thinking/tool_calls 字段（`io.momo-studio.thinking` / `io.momo-studio.tool_calls`），并在收到含 `stream_session_id` 的最终 Matrix 消息时调 `clearCompleted` 移除临时流式气泡——本任务的 `clearCompleted` 已就绪。
- MessageFrame 重构不影响 Task 7（MessageBubble 增强只读 `message.content`，不经 MessageFrame 的 message prop）。
