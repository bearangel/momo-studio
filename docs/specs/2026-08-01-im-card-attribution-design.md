# IM 卡片归属与对话化视觉 — 设计文档

- **日期**: 2026-08-01
- **里程碑**: v1.2 后续优化（里程碑 1：卡片归属）
- **状态**: 已确认，待编写实施计划
- **关联**: 后续里程碑 2「opencode 式过程可见性」将单独 brainstorm

## 背景与问题

当前 IM 会话里，任务生命周期产生三类卡片消息，依次出现在时间线上：

1. **DispatchCard**（`io.momo-studio.dispatch`，紫色）— 主 agent 向子 agent 调度任务
2. **TaskReplyCard in_progress**（`io.momo-studio.task_reply`，蓝色）— 子 agent 回报"开始处理"
3. **TaskReplyCard completed/failed**（绿/红色）— 子 agent 回报最终结果

用户反馈两个核心痛点：

- **归属不明**：发布任务后看到调度卡、进行中卡、已完成卡，但"完全无法知道这些消息是哪个 agent 发送，还是系统通知"。因为这是 IM 会话，直接出现这种无主卡片让用户非常困惑。
- **过程不可见**：agent 接收消息后直到大模型回复才响应，中间思考、调用哪些工具用户都无法实时知道。（此项归入里程碑 2，本文档不涉及）

本设计仅解决**归属问题**（里程碑 1）。

## 现状分析

### 数据层面：归属信息已完整存在

- 每个 agent 实例是独立的 Matrix bot（`AgentAssignment.botMatrixUserId`），`client.sendEvent` 用各自 access token 发送，`event.getSender()` = 该 bot 的 userId
- `MatrixMessagePayload.sender` 经 `sync-manager.ts` 完整透传到 renderer 的 `ImMessage.sender`
- `useBotNameMap()`（`renderer/src/lib/useBotNames.ts`）提供 `Map<botUserId, agentDefinition.name>`

**结论**：归属数据在管道里全程无损，问题纯粹在渲染层。

### 渲染层面：三类消息视觉外壳不一致

| 消息类型 | 头像 | 名字 | 左右对齐 | 宽度 | 归属完整度 |
|---|---|---|---|---|---|
| 普通文本气泡（`MessageBubble`） | ✅ emoji 圆 | ✅ 名字（!isSelf 时） | ✅ isSelf 决定 | max-w-70% | ✅ 完整 |
| DispatchCard | ❌ 无 | ⚠️ 仅 from→to 大行内 | ❌ 全宽居中 | full-width | ⚠️ 有但冗余 |
| TaskReplyCard | ❌ 无 | ❌ 完全无 | ❌ 全宽居中 | full-width | ❌ 零归属 |

`TaskReplyCard.tsx`（115 行）中没有任何 `message.sender` 或 `useBotNameMap` 引用——这是归属缺失的根因。

`DispatchCard.tsx` 显示 `dispatch_from → dispatch_to` 双 bot，但 `event.getSender()` 恒等于 `dispatch_from`（都是主 agent bot），所以 from 信息是冗余的。

## 设计目标

1. 三类消息共享统一的"头像 + 名字 + 左右对齐"视觉外壳，卡片不再像系统通知
2. TaskReplyCard 补齐 agent 归属（核心收益：多子 agent 并行回报时可区分）
3. DispatchCard 去除冗余 from 信息，紧凑化
4. 纯前端改动，不引入新事件类型、不动 Matrix 协议
5. 保持三张独立卡片（不合并为状态更新卡）

## 方案：对话化重构

### 核心重构 — 抽取 `MessageFrame` 共享组件

普通气泡的外壳结构（`MessageBubble.tsx:32-51`）是所有消息的通用容器：头像 + 名字 + 左右对齐的气泡列。抽成共享组件，三种消息类型复用：

```
MessageFrame({ message, isSelf, senderName, bubbleClassName, children })
  ├─ MessageBubble（普通文本）  bubbleClassName: bg-accent-blue / bg-bg-tertiary
  ├─ DispatchCard（调度）       bubbleClassName: border-accent-purple/40 bg-accent-purple/10
  └─ TaskReplyCard（任务回执）  bubbleClassName: border-status-*/40 bg-status-*/10
```

收益：视觉外壳收口一处，三种消息天然一致；归属逻辑（头像/名字/对齐）单点维护。

### 数据流改动

`MessageList` 已计算 `isSelf`（`msg.sender === currentUserId`）和 `senderName`（`botNameByUserId.get(msg.sender)`）并传给 `MessageBubble`。现在 `MessageBubble` 路由时需**透传给卡片**（当前卡片只接 `message`）：

```tsx
// MessageBubble.tsx 路由
if (message.eventType === 'io.momo-studio.dispatch') {
  return <DispatchCard message={message} isSelf={isSelf} senderName={senderName} />;
}
if (message.eventType === 'io.momo-studio.task_reply') {
  return <TaskReplyCard message={message} isSelf={isSelf} senderName={senderName} />;
}
// 普通气泡走 MessageFrame
```

### TaskReplyCard 新结构（重点改动）

```
🦁 coder                                      ← MessageFrame 头（sub agent 头像 + 配置名）
┌─ rounded-lg border(状态色/40) bg(状态色/10) max-w-[70%] ─┐
│ [已完成] #abc12345                                    │  ← 状态徽章 pill + task_id
│ <body markdown>                                        │
│ ━━━━━━━━━━━━━━━ 60%                                    │  ← 进度条（progressPct 有值时）
└────────────────────────────────────────────────────────┘
```

改动点：
1. 整个组件包进 `<MessageFrame>`，自动获得头像 + 名字 + 左对齐
2. 名字由 `senderName` prop 传入（`MessageFrame` 渲染），卡片本身**不调用** `useBotNameMap`（当前无、重构后也无）
3. 删掉外层 `mx-4 my-2`（frame 已含 `px-4 py-1`）
4. 状态 label 从"大标题"降为气泡内的小 pill（紧凑徽章）
5. Props 增加 `isSelf: boolean` + `senderName?: string`

### DispatchCard 新结构

`event.getSender()` 恒等于 `dispatch_from`，frame 头已是 from，卡片内**只保留 target**：

```
🦊 coordinator                                ← MessageFrame 头（主 agent = dispatch_from）
┌─ rounded-lg border(紫/40) bg(紫/10) max-w-[70%] ─┐
│ [调度] #abc12345  → 🐱 coder                   │  ← 紧凑：徽章 + task_id + 箭头 + 目标
│ <body markdown>                                  │
│ 截止：2026-08-01 14:00（可选）                    │
└──────────────────────────────────────────────────┘
```

改动点：
1. 包进 `<MessageFrame>`
2. 删掉冗余的 from bot 显示（frame 头已表达 from），保留 `→ 🐱 target` 单行紧凑后缀
3. 从→to 大行降为标题行的紧凑后缀
4. **保留** `useBotNameMap()` 内部调用（用于解析 target `dispatch_to` 的配置名），但 from 解析移除（frame 头已替代）
5. Props 增加 `isSelf` + `senderName`

### 对齐逻辑（关键洞察）

- **团队群**里：dispatch 由主 agent 发（bot）→ 左对齐；task_reply 由子 agent 发（bot）→ 左对齐；用户自己的文本消息 → 右对齐
- 这正是期望效果：**所有卡片都像"别人发的消息"，不再是悬浮的系统通知**
- `isSelf` 对卡片恒为 false（用户不直接发 dispatch/task_reply），保留逻辑保持代码一致

## 边界情况

| 情况 | 处理 |
|---|---|
| **botNameMap 为空**（定义未加载 / sender 不在任何 workspace 分配里） | `senderName` 回退到 `shortName(message.sender)`（从 `@coder:local` 提取 `coder`）。头像始终可用（userId 哈希）。与普通气泡现有回退行为一致，无新逻辑 |
| **content 解析失败**（缺 task_id / status 非法 / 缺 dispatch_from） | 当前两卡片回退成纯灰底 div。重构后回退也走 `MessageFrame`（保留归属 + 灰色气泡 + 纯文本 body），避免畸形事件也丢归属 |
| **max-w-70% 容纳长内容** | 调度 body 长 → `break-words` + markdown 换行；进度条按气泡宽度自适应；代码块 `[&_pre]:overflow-x-auto` 横滚。桌面 IM 栏 ~600-800px，70%≈420-560px，够用 |
| **isSelf 对卡片恒 false** | 用户不直接发 dispatch/task_reply，sender 永远是 bot。逻辑保留保持代码一致，不特判 |
| **needs_input 状态** | 类型允许但运行时从未生成。卡片已有琥珀样式，未来启用即生效，无需改 |
| **多子 agent 并行回报**（团队群） | 每条 task_reply 显示各自 sender 头像 + 名，本次改动的核心收益 |
| **DM 私聊** | dispatch/task_reply 只在团队群发生（主↔子 agent 协议），DM 不出现。代码本身房间无关，无需特判 |

## 测试计划

当前 IM 组件零测试，本次全部新建。遵循仓库 vitest + @testing-library/react 模式。`useBotNameMap` 读 agent/workspace store，测试用 `vi.mock` 注入预置映射。

| 测试文件 | 覆盖点 |
|---|---|
| **MessageFrame.test.tsx**（新组件，基础） | 头像渲染自 sender；senderName 提供时显示；senderName 缺失回退 shortName；isSelf 隐藏名字 + 反转布局；bubbleClassName 应用到内层气泡；children 渲染 |
| **TaskReplyCard.test.tsx**（归属修复核心） | 从 message.sender 经 botNameMap 渲染子 agent 名；四种 status 徽章 label 正确；task_id 短形；body markdown；progressPct 有值显进度条/无值隐藏；progressPct 钳到 0-100；解析失败回退普通气泡 |
| **DispatchCard.test.tsx** | 从 message.sender 渲染主 agent 名；紧凑显示 target（→ 🐱）；task_id；body；deadlineMs 有值显截止/无值隐藏；解析失败回退 |
| **MessageBubble.test.tsx**（路由） | dispatch→DispatchCard；task_reply→TaskReplyCard；m.room.message→普通气泡；isSelf + senderName 正确透传给卡片 |

## 改动文件清单

```
新增:
  renderer/src/components/im/MessageFrame.tsx          (~30 行，共享消息外壳)
  renderer/src/components/im/MessageFrame.test.tsx
  renderer/src/components/im/TaskReplyCard.test.tsx
  renderer/src/components/im/DispatchCard.test.tsx
  renderer/src/components/im/MessageBubble.test.tsx
修改:
  renderer/src/components/im/MessageBubble.tsx         (普通气泡走 frame；路由透传 isSelf/senderName)
  renderer/src/components/im/DispatchCard.tsx          (走 frame；删冗余 from，紧凑 target)
  renderer/src/components/im/TaskReplyCard.tsx         (走 frame；props 加 isSelf + senderName)
```

## 明确不做（YAGNI）

- ❌ 里程碑 2 的过程可见性（typing 指示 / 工具调用流 / LLM 流式输出）— 独立里程碑，单独 brainstorm
- ❌ 合并三卡片为一张状态更新卡 — 用户已选保持三张独立
- ❌ 改 Matrix 事件类型 / 协议 — 纯前端，归属数据已存在于 `message.sender`
- ❌ DM 私聊特判 — dispatch/task_reply 只在团队群发生
- ❌ 进度条 / deadline 字段语义变更 — 仅视觉外壳重构，卡片内信息字段保持

## 验收标准

1. 团队群中，task_reply（进行中/已完成/失败）卡片**显示子 agent 头像 + 配置名**，多子 agent 并行回报时可视觉区分
2. dispatch 卡片显示主 agent 头像 + 名（frame 头），卡片内紧凑显示目标 agent
3. 三类消息（普通文本 / dispatch / task_reply）视觉外壳一致：头像 + 名字 + 左右对齐气泡
4. 解析失败时仍保留归属（灰色气泡 + 纯文本）
5. `npx pnpm@9.0.0 typecheck` 双 workspace 通过
6. `npx pnpm@9.0.0 --filter momo-studio-renderer test` 全部通过（含新增 4 个测试文件）
