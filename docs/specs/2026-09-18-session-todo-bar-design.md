# 会话底部常驻任务条（SessionTodoBar）设计

- 日期：2026-09-18
- 状态：已定稿（视觉方案经视觉伴侣 mockup 三轮确认）
- 范围：renderer `im` 视图；不改数据模型 / IPC / 主进程

## 1. 背景与问题

agent 执行 `todowrite` 产生的待办列表（`TodoSection`：可折叠列表 + 进度百分比）目前渲染在两处：

- 顶层 agent 气泡顶部（`AgentStreamBubble` L141-143）
- 子 agent 嵌套工作区顶部（`SubAgentSection` L35-37，位于 dispatch chip 展开区内）

问题：

1. 列表埋在消息流中间——agent 干活时进度不可见，需回滚消息查找
2. 并行子 agent 各自的待办分散在各 dispatch chip 里，没有任何汇总视图

## 2. 目标 / 非目标

**目标：**

1. 待办列表完全移出气泡，在会话底部（消息区与输入区之间）常驻显示
2. 多 agent 并行（含子 agent）各自有待办时，按 agent 分页签切换，自动跟随流式中的 agent
3. 「最新快照」生命周期：完成保留、新 todowrite 替换、会话隔离

**非目标：**

- 不改 `stream-aggregator` / IPC / 主进程（todos 数据链路零改动）
- 不做跨会话聚合视图
- 不与 tasks 视图（任务看板）打通——本特性只消费 `stream.todos` 快照

## 3. 方案定稿与备选否决记录

| 决策点 | 定稿 | 否决的备选及理由 |
|---|---|---|
| 底部样式 | **A 常驻条**：消息区与输入区之间常驻，可折叠展开 | B 气泡留快照——两处出现、规则复杂；C 细条抽屉——流式中默认看不到条目，需多一次点击 |
| 并行呈现 | **1 分页签**：每个有待办的 agent 一个页签（名字 + 各自进度），高度恒定 | 2 全部堆叠——agent 多时面板高、视觉重；3 只放顶层——不解决并行子 agent 可见性问题 |
| 生命周期 | **最新快照**：完成保留折叠态、新候选替换、✕ 后增员才重现 | 回合绑定清空——A 方案下气泡已无列表，清空即历史无处可看；纯手动清理——容易积灰 |

## 4. 布局与组件

```
im 视图（MiddlePanel）
├─ 会话头部
├─ MessageList（消息流）
├─ SessionTodoBar  ← 新增，常驻
│   ├─ 页签行（仅多候选时出现）：[coder 2/5 ●] [tester 1/3] …
│   ├─ TodoSection（复用现有组件，按激活页签渲染）
│   └─ ✕ 手动关闭
├─ InputToolbar
└─ MentionInput
```

**改动文件（renderer，4 处）：**

| 文件 | 改动 |
|---|---|
| `components/im/SessionTodoBar.tsx` | **新增**——候选推导 + 页签 + 生命周期状态 |
| `components/im/AgentStreamBubble.tsx` | 移除气泡内 `TodoSection` 渲染（L141-143）及 import |
| `components/im/SubAgentSection.tsx` | 移除嵌套区 `TodoSection` 渲染（L35-37）及 import |
| `components/layout/MiddlePanel.tsx` | im 分支在 `<MessageList />` 与 `<InputToolbar />` 之间插入 `<SessionTodoBar />` |

`TodoSection.tsx` 本身不动——列表渲染器原样复用（流式自动展开、结束自动折叠、进度百分比、完成态可回看）。

## 5. 数据推导（无新 store、无 IPC）

todos 已存在于 `stream.store`（`streams: Map<messageId, StreamState>`，`stream-aggregator` 聚合 + message_events 重建，持久数据），按消息反查即可：

- **候选集**：当前会话 `messagesBySession` 中满足 `streams.get(msg.id)?.todos.length > 0` 的消息，按数组顺序（即时间序）。**含子 agent 消息**——它们带 `parentStreamSessionId` 不进顶层消息列表，但保留在 `messagesBySession` 与 streams Map 中，直接可用
- **agent 名**：`msg.sender` → `useBotNameMap()`（现成映射）
- **激活页签**：
  - 自动跟随 = 最后一个 `stream.status === 'streaming'` 的候选；无流式候选则取最后一个候选（最新快照）
  - 用户点击页签 → 固定（pinned）该候选；该候选流转入终态（非 streaming）→ 自动解除固定，恢复自动跟随
  - 单候选时不渲染页签行，直接展示列表
- **页签内容**：agent 名 + `完成数/总数`；流式中的页签带高亮标识

## 6. 生命周期（最新快照语义）

| 时机 | 行为 |
|---|---|
| agent 执行中 | 实时更新当前流式列表，TodoSection 自动展开 |
| 回合结束 | 保留不删，自动折叠为完成态「✓ 5/5（100%）」，可点开回看 |
| 同回合内 todowrite 更新 | 实时刷新 |
| 新候选出现（新回合 / 新子 agent 产出 todos） | 替换为最新 / 加入页签 |
| 纯问答回合（无 todowrite） | 不替换，仍显示上一份 |
| ✕ 手动关闭 | 隐藏；**仅当候选集增员**（新消息的流获得 todos）才重新出现——流式中途关闭不会被同一条流的更新顶回 |
| 切换会话 | pinned / dismissed 状态重置，条跟随新会话各自候选集 |

数据层事实：todos 是每条 agent 消息各自的快照，落库持久（message_events 重建），**从不存在删除**——底部条只决定「显示哪份」。

## 7. 边界情况

- 无激活会话 / 无 todos 候选：不渲染（零占位）
- 页签超过 4 个：`flex-wrap` 横向换行（不滚动）
- 历史消息流缺失 streams 条目（异常数据）：跳过该候选，不崩
- MembersPanel 浮层：SessionTodoBar 在文档流内，浮层覆盖不影响
- 流式重渲染成本：SessionTodoBar 订阅 streams Map，组件体积小，无长列表负担

## 8. 设计系统合规

- 语义 token（`bg-surface-*` / `text-secondary` / `border-subtle` 等），无标准 Tailwind 色阶、无 inline 硬编码颜色
- lucide-react 图标（ListTodo / X），16px / stroke 1.75 基准
- 无 emoji 图标

## 9. 测试计划（renderer 贴源 colocated，`Foo.test.tsx` 与组件同目录）

**`SessionTodoBar.test.tsx`（新增）：**

1. 无 todos 候选 → 不渲染
2. 单候选 → 无页签行，直接渲染 TodoSection
3. 多候选 → 页签行出现，激活 = 最后一个流式候选（自动跟随）
4. 点击其他页签 → 固定显示该候选，即使另一候选开始流式
5. 固定候选的流转入终态 → 解除固定，恢复自动跟随
6. ✕ 关闭 → 隐藏；同候选流继续更新不重现；新候选增员才重现
7. 切换会话 → pinned / dismissed 重置

**既有测试更新：**

- `AgentStreamBubble.test.tsx`：断言不再渲染 TodoSection（原有相关用例改为反向断言）
- `SubAgentSection.test.tsx`：同上
- `TodoSection.test.tsx`：不动（组件未改）

## 10. 验收口径

- `npx pnpm@9.0.0 --filter momo-studio-renderer test` 全绿
- `npx pnpm@9.0.0 typecheck` 双 workspace 通过
- 手工验收（dev 模式）：单 agent 流式产生 todos → 底部条实时更新、结束折叠；leader 并行 dispatch 多个跑 todowrite 的子 agent → 页签切换与自动跟随符合 §5/§6
