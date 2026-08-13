# 平台重构总览 — v2.0 架构演进（A/B/C/D 四子系统）

> **状态**：设计完成，待 writing-plans 拆分实施计划
> **范围**：v1.7.4 → v2.0 的完整架构演进路线
> **依赖关系**：A（消息源统一）→ B（任务模型）→ D（看板/并发）→ C（联网）

## 背景

v1.7.4 之后系统已能稳定运行，但会话功能存在两类根本性问题：

1. **重启前后显示不一致**：经审视，根因是**消息源有 5 个互相竞争的源**（实时 stream chunks、Matrix event 实时 push、Matrix event 历史拉取、SQLite `agent_meta`、SQLite `tool_calls` 审计表）。v1.5.6 引入分层持久化、v1.7.4 修了 5 个 segment 重建 bug，都是症状治疗，根本性的"多源 + 重建"模型没变。
2. **任务/会话模型不清晰**：当前架构里"用户发消息 = 触发 agent chat loop"，没有任务概念，无法支撑看板、定时、跨节点协作等需求。

同时，系统需要演进到支持：
- 单机三种会话场景（单聊、群组有/无 PM agent）的清晰路由
- 任务看板 + 并发控制（agent 抢任务模式）
- 联网 P2P 协作（局域网优先 + 互联网 hub 中转）

本 spec 覆盖上述 4 个相互关联的子系统设计，作为后续 4 个独立 plan（A/B/D/C）的总入口。

## 整体架构演进

### 决策清单（与用户确认）

| 子系统 | 关键决策 | 选择 |
|---|---|---|
| **A 消息源统一** | Matrix 角色 | b. 退为传输层（仅 bot 注册 + room 概念 + 联网传输） |
| | Tuwunel 去留 | 保留（不再做主存储） |
| | 持久化粒度 | A1. 事件溯源（所有 stream chunk 落盘） |
| | 历史迁移 | c. 不迁移（无正式用户，破釜沉舟） |
| **B 任务模型** | 任务定义 | Chat（对话）+ Task（任务）双模型 |
| | 任务与会话关系 | b + 执行锁定（可在 A 创建、B 执行，执行过程不跨会话） |
| | 创建路径 | 看板 / 会话内 UI 按钮（A）/ agent inline 建议（D） |
| | Mention 语法 | X1：`@agent` 触发；`#T-XXX` 引用任务 |
| | 启动机制 | a 看板按钮 + b 会话 # mention + c 定时启动 + d agent pickup |
| | 冲突策略存储 | room_settings 字段，创建会话时配置，可改 |
| | 上下文恢复 | Fresh LLM context + 工具主动恢复（task 不可重启） |
| | 记忆模块 | MemoryProvider 抽象，v1 最简 SQLite 实现，v2+ 完整 |
| **D 看板/并发** | 看板形态 | Linear 风格列表，顶层独立视图 |
| | runtime 架构 | 方案 4 task-driven runtime（重大重构） |
| | per-agent 并发 | v1 强制 1（schema 留字段为 v2 真并发铺路） |
| | 三层并发上限 | 全局 + per-agent + per-provider（令牌桶） |
| | Provider 显示 | 看板不显示 RPM（多 provider 全局统计无意义） |
| **C 联网 P2P** | 网络拓扑 | 方案 e 三层联网（本地/局域网/互联网 hub） |
| | 局域网模式 | mDNS 自动发现 + TCP 直连，零配置 |
| | 互联网模式 | hub 中转 + E2E 加密（hub 不存用户数据） |
| | 用户运维 | 个人用户零运维（团队提供轻量公共 hub） |

### 演进顺序（依赖关系）

```
v1.7.4 (现状)
   ↓
[A] 消息源统一          ← 持久化层重构（其他子系统的地基）
   ↓
[B] 任务模型 + 路由      ← 依赖 A 的 messages 表（加 task_id 字段）
   ↓
[D] 看板 + 并发控制      ← 依赖 B 的 tasks 表；runtime 架构重写
   ↓
[C] 联网 P2P            ← 独立模块，A/B/D 完成后增量加入
```

**关键原则**：
- A 必须先做（B/D 都依赖 messages 表）
- B 和 D 有耦合（D 的并发调度需要 B 的任务状态机）但可同阶段做
- C 完全独立，A/B/D 完成后任何时候都可以开始

---

# 子系统 A：消息源统一

## 设计目标

消除"实时显示 vs 重启显示"不一致，把 SQLite 升为**唯一真相源**，Matrix 退为传输层。

## 数据模型

### 新增表

```sql
-- 所有 IM 消息统一表（user / agent / dispatch / task_reply）
CREATE TABLE messages (
  id                       TEXT PRIMARY KEY,         -- UUID v4
  room_id                  TEXT NOT NULL,            -- Matrix room id
  sender                   TEXT NOT NULL,            -- Matrix user id
  event_type               TEXT NOT NULL,            -- 'm.room.message' | 'io.momo-studio.dispatch' | 'io.momo-studio.task_reply'
  body                     TEXT NOT NULL DEFAULT '',
  stream_session_id        TEXT,                     -- agent 流式会话 id（user 消息为 NULL）
  parent_stream_session_id TEXT,                     -- 子 agent dispatch 时回链父 stream
  segment_of               TEXT,                     -- 多段消息：归属的原始 stream_session_id
  segment_index            INTEGER,
  status                   TEXT NOT NULL DEFAULT 'done', -- 'streaming' | 'done' | 'failed' | 'aborted'
  source                   TEXT NOT NULL DEFAULT 'local', -- 'local' | 'lan' | 'hub' | 'matrix'（C 阶段扩展）
  matrix_event_id          TEXT,                     -- 对应 Matrix event（仅当也发到 Matrix）
  workspace_id             TEXT,
  task_id                  TEXT,                     -- B 子系统：消息关联的 task
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);
CREATE INDEX idx_messages_room_created ON messages(room_id, created_at);
CREATE INDEX idx_messages_stream       ON messages(stream_session_id);
CREATE INDEX idx_messages_parent       ON messages(parent_stream_session_id);
CREATE INDEX idx_messages_task         ON messages(task_id);

-- 事件溯源表：所有 stream chunk 落一行——真相源
CREATE TABLE message_events (
  id           TEXT PRIMARY KEY,             -- UUID v4
  message_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,             -- 同 message 内自增
  event_type   TEXT NOT NULL,                -- 'thinking_delta' | 'text_delta' | 'tool_call_start' | 'tool_call_result' | 'todo_update' | 'dispatch_start' | 'dispatch_result' | 'segment_boundary' | 'status_change' | 'final'
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  UNIQUE(message_id, seq)
);
CREATE INDEX idx_events_msg_seq ON message_events(message_id, seq);
```

### 核心不变量

- `messages` 是消息元信息，`message_events` 是真相源
- 任何 StreamState 由 `SELECT * FROM message_events WHERE message_id=? ORDER BY seq` 聚合而成
- 实时显示与重启显示用**同一份 SQLite 数据 + 同一套聚合函数**——这是重启一致性的根本保证

### 废弃

- `agent_meta` 表（v1.5.6 引入的分层持久化机制废弃）
- Matrix event content 的 `io.momo-studio.*` 富字段（thinking/tool_calls/todos/dispatches/segment_*/agent_meta_id/tool_calls_offset）
- runtime-entry 的 `loadRecentHistory` 函数（被 MemoryProvider 替代）

## 写路径

| 触发 | 主进程动作 |
|---|---|
| User → `im:send` | INSERT messages row → 发 Matrix m.room.message（仅 body）→ 回填 matrix_event_id → push `im:message` 到 renderer |
| Agent 启动 chat loop | INSERT messages row（status='streaming', stream_session_id=X）|
| 每个 stream chunk | MessageEventBuffer.append → 50ms flush → 单事务 INSERT batch + push `im:message_event_batch` 到 renderer |
| task_complete（最终态） | UPDATE messages（body, status='done'）→ INSERT message_events(event_type='final'）→ 发 Matrix m.room.message（仅 body）|
| 多段 task_complete | 每段 INSERT messages row（segment_of=parent, segment_index=N）|
| Dispatch / Task Reply | 主进程监听 Matrix event → INSERT messages row → push `im:message` |

## 读路径

| 场景 | 实现 |
|---|---|
| 实时显示 | renderer 订阅 `im:message` + `im:message_event_batch`，store 用 stream-aggregator 聚合 |
| 重启后 | `im:getMessages(roomId)` SELECT messages + SELECT events → 同一聚合函数 |
| 翻页 | `im:loadOlderMessages(roomId, before_ts, count)` SELECT messages WHERE created_at < ?（不再依赖 matrix-js-sdk paginateEventTimeline）|

## 性能保障

| 优化 | 效果 |
|---|---|
| better-sqlite3 + WAL 模式 | 读写并发不阻塞（项目默认） |
| MessageEventBuffer 批量事务 | 30 条/批，50ms flush 窗口 → ~1μs/条 INSERT |
| IPC 批量推送 | `im:message_event_batch` 每 50ms 一批，减少 IPC 内核切换 |
| 复杂任务估算 | 200 chunks → < 1ms 落盘 → 用户无感 |
| 并发估算 | 5 task 并发 1000 chunks → < 5ms 总耗时 |

## Matrix 降级角色

**仍发送的 Matrix event**：
- `m.room.message`（user/agent 最终态，仅 body）
- `io.momo-studio.dispatch` / `task_reply` / `abort_dispatch`（PM ↔ 子 agent 协议握手）

**不再发送的 Matrix event content 字段**：
- 所有 `io.momo-studio.thinking/tool_calls/todos/dispatches/segment_*/parent_stream_session_id/agent_meta_id/tool_calls_offset`

**renderer 不再读 Matrix event content 的 `io.momo-studio.*`** —— MessageBubble / DispatchCard / TaskReplyCard 只消费 SQLite row + events。

## 过渡策略（c 方案）

无正式用户，直接重构，不做兼容层：
- 新版本首次启动跑 migration（v17）：建 messages + message_events 表
- renderer 完全从 SQLite 读，旧 Matrix event 仍在 Tuuwunel 但不可见
- 用户视觉上"清空"，从空白开始

## 影响范围

**新增**：
- `electron/src/main/storage/messages/repo.ts`、`event-buffer.ts`
- `renderer/src/lib/stream-aggregator.ts`（共用聚合函数）

**重写**：
- `renderer/src/stores/im.store.ts`、`stream.store.ts`、`MessageBubble.tsx`、`MessageList.tsx`

**改造**：
- `electron/src/main/matrix/sync-manager.ts`（仅作触发器）
- `electron/src/main/agent/runtime-entry.ts`（stream chunk → IPC → 主进程 buffer；最终态仅发 body 到 Matrix）
- `electron/src/main/im/ipc.handlers.ts`（读 SQLite，新增 `im:message_event_batch` 通道）

---

# 子系统 B：任务模型 + 三种会话路由

## 设计目标

明确"任务 vs 对话"边界，支持三种会话场景路由，定义任务生命周期。

## 数据模型

### 新增 tasks 表

```sql
CREATE TABLE tasks (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'draft',
  -- draft | pending | assigned | in_progress | paused | completed | failed | cancelled

  -- 创建上下文（可空）
  source_room_id        TEXT,
  source_message_id     TEXT,
  creator_user_id       TEXT NOT NULL,

  -- 执行上下文（任务启动时锁定）
  execution_room_id     TEXT,         -- NULL = 未启动；非 NULL = 已锁定
  assignee_agent_id     TEXT,         -- 指派的 agent bot user id

  -- 调度
  priority              INTEGER NOT NULL DEFAULT 0,
  scheduled_at          INTEGER,      -- 计划开始时间
  recurrence_rule       TEXT,         -- cron 表达式；NULL=一次性
  deadline_at           INTEGER,

  -- D 子系统扩展字段
  queue_position        INTEGER,
  runtime_instance_id   TEXT,
  estimated_tokens      INTEGER,
  actual_tokens         INTEGER,
  tool_calls_used       INTEGER DEFAULT 0,
  error_message         TEXT,

  -- C 子系统扩展字段
  source_node_id        TEXT,         -- 任务来源节点（本机=NULL，跨节点=对端 node_id）

  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  started_at            INTEGER,
  completed_at          INTEGER
);
CREATE INDEX idx_tasks_ws_status   ON tasks(workspace_id, status);
CREATE INDEX idx_tasks_exec_room   ON tasks(execution_room_id);
CREATE INDEX idx_tasks_assignee    ON tasks(assignee_agent_id, status);
CREATE INDEX idx_tasks_scheduled   ON tasks(scheduled_at) WHERE scheduled_at IS NOT NULL;
```

### messages 表扩展（A 已含）

- `task_id` 字段：消息关联的 task

### room_settings 扩展

```sql
ALTER TABLE room_settings ADD COLUMN conflict_strategy TEXT DEFAULT 'ask';
-- ask | queue | preempt | fork | reject
```

### agent_definitions 扩展（v2 用，v1 强制 max=1）

```sql
ALTER TABLE agent_definitions ADD COLUMN max_concurrent_tasks INTEGER DEFAULT 1;
ALTER TABLE agent_definitions ADD COLUMN default_conflict_strategy TEXT DEFAULT 'ask';
```

## 任务状态机

```
draft (新建)
  ↓ [指派 agent + 设置 schedule]
pending (已指派，未到时间)
  ↓ [scheduled_at 到达]
assigned (待 agent pickup)
  ↓ [agent pickup 或 用户启动，execution_room 锁定]
in_progress (执行中)
  ⇄ [preempt 冲突] ⇄ paused (暂停)
  ↓ [完成 / 失败 / 取消]
completed / failed / cancelled (终态，不可重启)
```

**核心不变量**：
1. 任务一旦进入 in_progress，execution_room_id 锁定
2. 任务跨会话创建（source_room=A）→ 可在 B 会话启动执行（execution_room=B）
3. 任务终态后不可重启；用户继续追问 = 普通 chat（task_id=NULL）
4. paused 状态：runtime 进程被杀（释放内存），元数据保留，可恢复

## 任务创建路径（3 种）

| 路径 | UX |
|---|---|
| 看板创建 | "+ 新建任务" → 填表 → status='pending' 或 'draft' |
| 会话内 UI 按钮（A） | 消息输入框旁 📌 按钮 → 弹窗预填 source_room → 填表 |
| agent inline 建议（D） | agent 在回复里嵌"创建任务"按钮（被 system prompt 指示在识别到明确工作单元时建议） |

**agent 自主 create_task 工具**（v1 默认禁用）：可在 settings 里开启，仅高级用户。

## Mention 语法（X1：@ + # 双语法）

| 输入 | 含义 |
|---|---|
| `@PM-agent` | 触发 PM-agent 响应 |
| `#T-001` | 仅引用任务（消息标记 task_id），不触发 agent |
| `@PM-agent #T-001 开始吧` | 触发 PM + 任务上下文注入 |
| `@T-001` | 不合法（@ 只触发 agent/人） |

**菜单**：输入 `@` 弹出成员 + agent 列表；输入 `#` 弹出任务列表。

**# 菜单过滤**：仅显示**待处理任务**（draft/pending/assigned），不显示 in_progress/completed。

**手输 `#T-XXX`**：全量允许（in_progress 仅作引用不启动；completed 仅作引用）。

## 任务执行启动（4 种机制）

### a. 看板启动按钮
看板任务详情 → "启动" → 弹窗选择会话（默认创建新任务会话 `#T-XXX-标题前缀`）→ in_progress + execution_room 锁定。

### b. 会话内 # mention
用户在会话内 @agent + #T-XXX：
- 若 T-XXX status='assigned' 或 'pending' → 自动启动 + execution_room 锁定为当前会话
- 若 T-XXX status='in_progress' 且 execution_room != 当前会话 → 拒绝（执行锁定）
- 若 T-XXX status='completed' → 仅作引用（消息 task_id=T-XXX，但不重启）

### c. 定时自动启动
scheduled_at 到达 → 系统按优先级选 execution_room：
1. 用户预设的 execution_room_id
2. source_room_id（任务诞生会话）
3. assignee 与 owner 的 1-on-1 私聊会话
4. 创建新任务会话

### d. agent 自主 pickup
assignee_agent 看到队列中有 status='assigned' 的任务 → 满足并发条件时 pickup → 按 c 的优先级决策树选 execution_room。

## 消息 task_id 决定规则（统一）

```
发送消息时按优先级判定 task_id：
  1. 用户显式 #T-XXX mention            → task_id = T-XXX
  2. 当前会话是某 in_progress task 的 execution_room → task_id = 该 task
  3. 否则                                → task_id = NULL（普通 chat）
```

## 三种会话路由（更新 decideResponse）

```typescript
export function decideResponse(opts: {
  mentioned: boolean;
  hasAnyMention: boolean;
  isTeamRoom: boolean;
  isCoordinator: boolean;
  isOwnerMessage: boolean;
  isDirectChat: boolean;       // 新增：成员只有 1 user + 1 agent
  hasCoordinator: boolean;     // 新增：群组是否有协调 agent
}): ResponseDecision {
  // 场景 1.3：单聊无需 @ 自动响应
  if (opts.isDirectChat) return 'respond';
  // 场景 1.1：被 @ 直接响应
  if (opts.mentioned) return 'respond';
  // 场景 1.1：群组有 PM agent，无任何 @ → PM 自动接待
  if (opts.hasCoordinator && opts.isCoordinator && opts.isTeamRoom
      && opts.isOwnerMessage && !opts.hasAnyMention) {
    return 'respond';
  }
  // 场景 1.2：群组无 PM agent，未 @ → 不响应
  return 'skip';
}
```

## 冲突处理（用户在 execution_room 内 @agent #T-new 时）

### 决策流程

```
检测：当前会话是某 in_progress task 的 execution_room
       AND 用户 #mention 了一个不同的 task
  ↓
读 room_settings.conflict_strategy
  ↓
switch(strategy):
  'ask':    弹窗 4 选项 + "本会话记住"复选框
  'queue':  T-new 排队（status='assigned'），等当前 task 完成后 pickup
  'preempt': 当前 task → status='paused'，runtime 杀掉；立即开始 T-new
  'fork':   T-new 创建新会话执行，当前会话保持原 task
  'reject': 拒绝 T-new，提示用户去别处
```

### 配置层级

- `room_settings.conflict_strategy`（每会话配置）
- 创建会话时让用户选（默认 'ask'）
- 会话头部 settings 面板可随时修改

## 记忆模块（MemoryProvider 抽象）

为 v2+ 完整记忆系统留接口，v1 仅做最简 SQLite 实现。

```typescript
// electron/src/main/memory/types.ts
export interface MemoryProvider {
  getTaskContext(taskId: string): Promise<TaskContext>;
  getConversationContext(roomId: string, opts?: { limit?: number; beforeTs?: number }): Promise<ConversationContext>;
  getAgentContext(agentBotId: string): Promise<AgentContext>;       // v1 stub
  getUserContext(userId: string): Promise<UserContext>;              // v1 stub
  getWorkspaceContext(workspaceId: string): Promise<WorkspaceContext>; // v1 基础
}
```

**v1 实现**：`SQLiteMemoryProvider`
- getTaskContext：读 tasks + message_events 关键事件（tool_call/dispatch/final）
- getConversationContext：替代 runtime-entry 的 loadRecentHistory
- 其他：stub 占位

**runtime-entry 集成**：

```typescript
const memory = getMemoryProvider();
const [taskCtx, convCtx] = await Promise.all([
  currentTaskId ? memory.getTaskContext(currentTaskId) : null,
  parentStreamSessionId  // 子 agent fresh session（v1.7.4 行为保留）
    ? { messages: [] }
    : await memory.getConversationContext(roomId, { limit: 20 }),
]);

const messages: LLMMessage[] = [
  { role: 'system', content: systemContent },
  ...convCtx.messages,
  ...(taskCtx ? [{ role: 'system', content: `[任务上下文] ${taskCtx.task.title}\n...` }] : []),
  { role: 'user', content: currentBody },
];
```

**模块边界**：`electron/src/main/memory/`（独立模块，被 agent/task 依赖，自身不依赖它们）。

## 任务相关工具（暴露给 agent）

| 工具 | 实现 |
|---|---|
| `read_task(task_id)` | `memory.getTaskContext()` 薄包装 |
| `read_task_history(task_id)` | 读 messages 表 |
| `read_task_progress(task_id)` | 读 message_events |
| `create_task(...)` | INSERT tasks row（v1 默认禁用） |
| `complete_task(task_id)` | UPDATE status='completed'（已有 task_complete 改名） |
| `fail_task(task_id, reason)` | UPDATE status='failed' |
| `list_tasks(filter)` | SELECT tasks（按 status/assignee 过滤） |

---

# 子系统 D：任务看板 + 并发控制

## 设计目标

提供 Linear 风格任务看板 + 三层并发控制 + task-driven runtime 架构（重大重构）。

## task-driven runtime 架构（v1 重大重构）

### 核心理念

runtime 是 task 的资源（不再长期运行）。task 来 → spawn/取 warm runtime → 处理 → 销毁。

```
AgentRunner（每个 agent_assignment 一个）
  ├ warm pool (size K=2): [runtime_1, runtime_2]   ← 预启动 runtime 待命
  ├ active runtimes: Map<taskId, runtime>           ← 正在执行 task 的 runtime
  └ coordinator: 接收 task/chat → acquire → 注入 task config → 监控
```

### 普通消息也走 task-driven

用户发普通消息（无 #）→ 视为 ephemeral task（不显示在看板）→ spawn runtime → 处理完销毁。**架构统一**。

### warm pool（消除 spawn 延迟）

```typescript
class AgentWarmPool {
  private pools = new Map<string /* agentId */, Set<ChildProcess>>();
  private readonly POOL_SIZE = 2;
  
  async acquire(agentId: string): Promise<ChildProcess> {
    const pool = this.pools.get(agentId);
    if (!pool || pool.size === 0) {
      return this.spawnNewRuntime(agentId);  // 池空，spawn 新（无延迟优化）
    }
    const runtime = pool.values().next().value;
    pool.delete(runtime);
    this.replenish(agentId);  // 异步补充
    return runtime;
  }
  
  release(agentId: string, runtime: ChildProcess): void {
    runtime.kill();  // v1 简单：销毁
    this.replenish(agentId);
  }
}
```

**warm runtime**：注入 agent_def 基础 config（systemPrompt/model/tools/skills），等待 IPC 派发 task-specific 数据。

### 解决的技术债

- 移除"长期运行 agent runtime"概念（README 已记录的状态累积问题）
- runtime 完成 task 即销毁，无累积
- 多任务并发天然隔离
- C 阶段跨节点 task 天然适配（远端 task = 独立 runtime）

## 三层并发上限

| 层 | 默认 | 配置 |
|---|---|---|
| 全局 | 3 | `global_settings.max_concurrent_tasks` |
| per-agent | 1（v1 强制，schema 保留为 v2 真并发铺路） | `agent_definitions.max_concurrent_tasks` |
| per-provider | 不限（用户配） | `model_providers.max_rpm` / `max_tpm` |

### pickup 决策算法

```typescript
async function tryPickupNextTask(agent: Agent): Promise<void> {
  if (countInProgressByAgent(agent.id) >= agent.maxConcurrentTasks) return;
  if (countAllInProgress() >= globalSettings.maxConcurrentTasks) return;
  
  const provider = getProvider(agent.modelProviderId);
  if (!tokenBuckets[provider.id].canConsume()) {
    scheduleRetry(60_000);
    return;
  }
  
  // 选最高优先级任务
  const nextTask = findNextAssignedTaskForAgent(agent.id);
  // ORDER BY priority DESC, scheduled_at ASC NULLS LAST, created_at ASC
  
  if (nextTask) await startTaskExecution(nextTask);
}
```

### Provider 令牌桶

```typescript
class ProviderTokenBucket {
  private requestTimestamps: number[] = [];
  private tokenLog: Array<{ ts: number; tokens: number }> = [];
  
  canConsume(estimatedTokens: number = 1000): boolean {
    const now = Date.now();
    const windowMs = 60_000;
    this.requestTimestamps = this.requestTimestamps.filter(t => now - t < windowMs);
    this.tokenLog = this.tokenLog.filter(t => now - t.ts < windowMs);
    const rpmOk = !this.maxRpm || this.requestTimestamps.length < this.maxRpm;
    const tpmOk = !this.maxTpm || this.sumTokens() + estimatedTokens < this.maxTpm;
    return rpmOk && tpmOk;
  }
  
  record(actualTokens: number): void {
    this.requestTimestamps.push(Date.now());
    this.tokenLog.push({ ts: Date.now(), tokens: actualTokens });
  }
}
```

### 触发时机

| 事件 | 动作 |
|---|---|
| 任务进入 'assigned' | 触发对应 assignee 的 tryPickup |
| 任务终态 | 释放槽位 + 触发相关 agent tryPickup |
| agent runtime 启动 | 触发 tryPickup |
| Provider 配额恢复 | 触发 retry 队列 |
| 用户点"重试队列" | 全队列扫描 |

## 看板 UI（Linear 风格）

```
┌─ 任务看板 [workspace: 默认 ▼] [+ 新建任务] ──────────────┐
│ [全部] [Backlog] [待启动] [进行中] [已完成]   筛选 ▼  排序 ▼│
│ 并发: 2/3   排队: 5                       [⟳ 重试队列]    │
├──────────────────────────────────────────────────────────┤
│ #T-003 高 · 实现登录页                                     │
│   📅 8/15 · ⏰ 22:00 · 🤖 Programmer · 📌 产品讨论        │
│   [in_progress] 已用 23 min · 8 工具调用                  │
├──────────────────────────────────────────────────────────┤
│ #T-002 中 · 写单元测试                                     │
│   📅 8/16 · 🤖 QA-agent · 排队中（前面 2 个）             │
├──────────────────────────────────────────────────────────┤
│ #T-001 高 · 实现任务看板功能                               │
│   📅 8/14 · 🤖 PM · ✅ 已完成 · 用时 1h 23min             │
└──────────────────────────────────────────────────────────┘
```

### 任务详情侧滑面板

字段：标题/描述/状态/assignee/source_room（可跳转）/execution_room（可跳转）/调度（scheduled_at/recurrence/deadline）/操作（启动/暂停/取消/编辑/删除/转会话）/执行历史折叠面板（messages + events 流）。

### 交互

- 单击 → 详情侧滑面板
- 双击 → 跳到 execution_room
- 右键 → 上下文菜单（启动/暂停/取消/编辑/删除/转会话）
- 拖拽 → 改 status 或 assignee
- 多选 + 批量操作
- 搜索 + 筛选（status/assignee/priority/source_room/workspace）

## 影响范围（D 子系统）

**新增**：
- `electron/src/main/agent/agent-runner.ts`、`warm-pool.ts`、`task-dispatcher.ts`
- `electron/src/main/agent/llm/token-bucket.ts`
- `renderer/src/components/task-board/`（TaskBoard/TaskList/TaskCard/TaskDetail/CreateTaskDialog 等）

**重写**：
- `electron/src/main/agent/runtime-manager.ts` → `runtime-spawner.ts`
- `electron/src/main/agent/runtime-entry.ts`（接受 IPC 派发 task，而非监听 Matrix room）
- `electron/src/main/agent/auto-start.ts`（不再恢复长期 runtime）

**改造**：
- `electron/src/main/ipc/agent.handlers.ts`（spawn 接口改造）
- `electron/src/main/matrix/sync-manager.ts`（main 接收 Matrix event → 派发到 task）

**保留**：
- runtime-entry 内部 chat loop 逻辑（thinking/tools/dispatch）
- ToolModule / SkillRegistry / McpHostManager
- LLM provider 抽象
- dispatch / task_reply Matrix event 协议

---

# 子系统 C：联网 P2P 协作

## 设计目标

提供三层联网模式（本地/局域网/互联网），个人用户零运维，数据始终在本地。

## 三层联网模式

### 1. 本地模式（默认，零配置）

v1 完全不变（单机 Tuuwunel + SQLite）。

### 2. 局域网模式（自动检测，零配置）

mDNS 自动发现同网段其他 Momo 节点，TCP/WebSocket 直连（< 10ms）。

**用户感知**：开机 → 自动看到同 WiFi 内其他在线节点 → 直接通信。

### 3. 互联网模式（可选启用，hub 中转）

连接 hub（hub.momostudio.io 公共服务 或 自建），WebSocket 中转消息，E2E 加密保护。

**用户感知**：注册 hub 账号 → 登录 → 自动连接异地节点。

## 统一 TransportLayer 抽象

```typescript
// electron/src/main/p2p/transport.ts
interface TransportLayer {
  type: 'local' | 'lan' | 'hub';
  send(targetNodeId: string, payload: MessagePayload): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => void): void;
  discoverNodes(): NodeInfo[];
  connect(nodeId: string): Promise<void>;
  disconnect(nodeId: string): Promise<void>;
}

class LocalTransport implements TransportLayer { ... }
class LanTransport implements TransportLayer { ... }    // mDNS + TCP
class HubTransport implements TransportLayer { ... }    // WSS + E2E
```

**消息路由**：
- 同节点 → 直接 SQLite 写入
- 目标节点在局域网 → LanTransport
- 目标节点在互联网 → HubTransport
- 路由层自动选择（用户无感）

## Hub 设计（中转模式，非中心化）

| 维度 | 设计 |
|---|---|
| 角色 | 路由 + 在线列表 + 临时离线消息缓存（TTL 7 天） |
| 数据存储 | **不持久化用户数据**（仅密文中转） |
| 加密 | E2E 加密（hub 仅看到密文） |
| 账号 | 用户注册防滥用；可匿名试用 |
| 路由协议 | 按 node_id 路由（WebSocket + JSON） |

**与"中心化 hub"的区别**：hub 仅作"邮递员"，不是存储中心。Hub 关了，Alice 和 Bob 各自的数据还在本地。

## 节点身份与信任

- 每节点首次启动生成 Ed25519 密钥对
- 节点 ID = 公钥指纹（如 `node_a1b2c3...`）
- 用户显示名（"Alice 的 Mac"）
- 首次跨节点连接：扫码/PIN 确认信任关系（防 MITM）
- 已信任节点列表持久化

## 安全模型

| 层 | 机制 |
|---|---|
| 节点身份 | Ed25519 签名 |
| 传输加密 | TLS（局域网）/ WSS + E2E（hub） |
| 信任模型 | 首次连接扫码/PIN 确认 |
| 消息可见性 | 任务/会话级 ACL |
| Hub 防滥用 | 账号注册 + rate limit |

## C 与 A/B/D 的接口（已预留）

- A 的 messages.source 字段：v1 'local' → C 阶段加 'lan' / 'hub'
- B 的 tasks 表 `source_node_id` 字段：标识任务来自哪个节点
- D 的 task-driven runtime 天然支持跨节点（远端 task 到达 = spawn runtime 处理）

## C 分阶段实施（v2.0 系列）

| 阶段 | 范围 |
|---|---|
| v2.0-alpha | 局域网 mDNS + TCP 直连 + 跨节点 messages 同步 |
| v2.0-beta | Hub 服务部署 + HubTransport + 跨节点 messages 同步 |
| v2.0-rc | 跨节点 tasks 同步 + agent 调度（@ 远端 agent） + E2E 加密 + 信任模型 |
| v2.0 | 完整发布 |

## 独立项目：momo-hub

Hub 服务器作为独立开源项目，用户可自建：
- 轻量 Node.js + ws（WebSocket）+ Redis（在线节点 + 离线缓存）
- 部署成本低（~$30-100/月服务数千用户）
- 不依赖 momo-studio 主仓库

---

# 数据模型总览（所有新增 + 扩展）

## 新增表

| 表 | 子系统 | 用途 |
|---|---|---|
| `messages` | A | 统一所有 IM 消息（user/agent/dispatch/task_reply） |
| `message_events` | A | 事件溯源（所有 stream chunk） |
| `tasks` | B/D | 任务元数据 + 调度 + 执行状态 |

## 扩展字段

| 表 | 字段 | 子系统 |
|---|---|---|
| `messages` | `task_id`, `source`, `status` | A/B/C |
| `room_settings` | `conflict_strategy` | B |
| `agent_definitions` | `max_concurrent_tasks`, `default_conflict_strategy` | B/D |
| `global_settings` | `max_concurrent_tasks` | D |
| `model_providers` | `max_rpm`, `max_tpm` | D |
| `tasks` | `queue_position`, `runtime_instance_id`, `estimated_tokens`, `actual_tokens`, `tool_calls_used`, `error_message`, `source_node_id` | D/C |

## 废弃

| 表/字段 | 替代 |
|---|---|
| `agent_meta` 表（v1.5.6） | `message_events`（事件溯源） |
| Matrix event content 的 `io.momo-studio.*` 富字段 | `message_events` |
| `runtime-entry.loadRecentHistory` 函数 | `MemoryProvider.getConversationContext` |

---

# 实施顺序与依赖

```
v1.7.4 (现状)
   ↓
[阶段 1：A 子系统]
   - Migration v17：建 messages + message_events 表
   - 写 messages repo + event-buffer
   - 改造 sync-manager、runtime-entry、ipc.handlers
   - 重写 im.store、stream.store
   - 删除 agent_meta 表 + Matrix 富字段
   - 测试：重启一致性 e2e（核心回归测试）
   ↓
[阶段 2：B 子系统]
   - Migration v18：建 tasks 表 + 扩展字段
   - 实现 MemoryProvider + SQLiteMemoryProvider
   - 任务 CRUD + 状态机
   - @ + # Mention 解析器
   - decideResponse 更新（isDirectChat/hasCoordinator）
   - 冲突处理器 + ConflictDialog
   - 工具：read_task/create_task/complete_task 等
   ↓
[阶段 3：D 子系统]
   - task-driven runtime 重构（AgentRunner + warm pool）
   - TaskDispatcher + 三层并发
   - ProviderTokenBucket
   - 看板 UI（Linear 风格）
   - 测试：并发 + 调度 + 看板交互
   ↓
[阶段 4：C 子系统]（v2.0 系列，可独立启动）
   - TransportLayer 接口
   - LocalTransport（已有，封装）
   - LanTransport（mDNS + TCP）
   - HubTransport（WSS + E2E）
   - 节点身份 + 信任管理
   - momo-hub 独立项目
   - 跨节点 messages/tasks 同步
   - 跨节点 agent 调度
```

## 风险与开放问题

| 风险 | 缓解 |
|---|---|
| A 的 migration 失败导致数据丢失 | c 方案接受清空，但提供 ExportChatButton 备份 |
| D 的 task-driven 重构影响范围大 | 分小步：先实现 warm pool → 切换 chat → 切换 task |
| warm pool 内存占用 | 每节点维持 K=2 个 warm runtime × N agent，可配置 |
| B 的 # mention 解析复杂度 | 参考 remark/Markdown-it 的 lexer 实现 |
| C 的 mDNS 跨平台差异 | 使用 `bonjour-service` 跨平台库；提供手动 IP 输入 fallback |
| C 的 E2E 加密性能 | 仅对跨节点消息加密；本地消息不加密 |
| C 的 hub 服务运维成本 | 公共 hub 起步用 1 台 VPS，按用户增长扩容 |

## 未覆盖（已知限制）

- **C 阶段跨节点 agent 调度的 UX 细节**（@ 远端 agent 的 mention 语法、跨节点 execution_room 锁定）—— v2.0-rc 阶段单独 spec
- **task 评论 / 子任务**（Linear 风格）—— v2.1 任务
- **task 依赖关系**（task_dependencies 表预留，未实现）—— v2.1 任务
- **workspace 跨节点同步**（共享文件）—— v2.5 通过 git remote 或 CRDT 实现
- **task 的 SLA / 提醒**（deadline_at 仅警告，不自动 escalate）—— v2.1 任务
- **per-agent 真并发 > 1**（v2 任务，schema 已预留）—— task-driven 架构天然支持

---

# 附录：决策记录（与用户对话提炼）

## A 子系统

| # | 问题 | 选择 | 理由 |
|---|---|---|---|
| A.1 | 痛点边界 | 全场景不一致（4 类） | 问题不是 v1.7.4 segment bug，而是底层架构 |
| A.2 | Matrix 角色 | b. 退为传输层 | 多源 + PDU 截断 + SDK timeline 异步 |
| A.3 | Tuuwunel 去留 | 保留 | bot 注册 + room 概念 + 联网传输仍需要 |
| A.4 | 持久化粒度 | A1. 事件溯源 | 最干净 + 为 C 阶段铺路 |
| A.5 | 历史迁移 | c. 不迁移 | 无正式用户，破釜沉舟 |
| A.6 | 写入性能担忧 | 批量事务 + 50ms flush + WAL | < 1% CPU |

## B 子系统

| # | 问题 | 选择 | 理由 |
|---|---|---|---|
| B.1 | 任务定义 | Chat + Task 双模型 | 用户描述：会话讨论产出 PRD，看板跟踪任务 |
| B.2 | 任务与会话关系 | b + 执行锁定 | 任务可在 A 创建、B 执行；执行过程不跨会话 |
| B.3 | 创建路径 | 看板 + UI 按钮 + agent inline | 不选命令式（学习成本）/ 右键（移动不友好）/ agent 自主（默认禁用） |
| B.4 | Mention 语法 | X1. @ + # 双语法 | 与 Slack/Discord/Linear 一致 |
| B.5 | # 菜单过滤 | 仅待处理 + 手输全量 | 常用快捷启动 vs 全量引用分离 |
| B.6 | 启动机制 | 4 种全要 | 看板按钮 + 会话 # + 定时 + agent pickup |
| B.7 | pickup 会话归属 | 预设 > 创建新会话 | 用户主动控制 |
| B.8 | 任务不可重启 | 完成即冻结 | 用户明确要求 |
| B.9 | 冲突策略范围 | room_settings 字段 | 用户希望"创建会话时配置，可改" |
| B.10 | 上下文恢复 | Fresh LLM + 工具 | 与 v1.7.4 子 agent fresh session 一致 |
| B.11 | 记忆模块 | 抽象接口 + v1 最简 | 为 v2+ 完整记忆铺路 |

## D 子系统

| # | 问题 | 选择 | 理由 |
|---|---|---|---|
| D.1 | 看板与会话关系 | a. 顶层独立视图 | 任务看板作为一级导航 |
| D.2 | 看板形态 | b. Linear 列表 | 桌面端友好，信息密度高 |
| D.3 | per-agent 并发实现 | 方案 4 task-driven runtime | 长期最优；C 阶段天然适配 |
| D.4 | Provider RPM 显示 | 移除 | 多 provider 全局统计无意义 |

## C 子系统

| # | 问题 | 选择 | 理由 |
|---|---|---|---|
| C.1 | 系统定位 | 个人用户 + 局域网优先 + 互联网 | 用户明确 |
| C.2 | 网络拓扑 | 方案 e. 三层联网 | 局域网零配置 + 互联网 hub 中转 |
| C.3 | 互联网方案 | hub 中转 + E2E | 个人用户零运维；与本地优先兼容 |
| C.4 | Federation 否决 | 不适合个人用户 | 需要公网 IP + 域名 + 证书 |
| C.5 | 纯 P2P 否决 | 风险高 + 与 v1 投资冲突 | NAT 穿透不靠谱，libp2p 重写代价大 |
