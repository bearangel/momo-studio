# Task-Driven Runtime 完整切换设计

> **状态**：设计完成，待 writing-plans 拆分实施计划
> **范围**：v2.0 alpha 后的架构收尾——把 v1 runtime-manager（长期运行进程）完全切换为 v2 task-driven runtime（task 临时资源）
> **依赖**：Plan A/B/C/D 已完成；D 子系统的 AgentRunner + WarmPool + Dispatcher + Scheduler 已就绪

## 背景

### v1 架构（现状）

```
agent.start → fork 一个 runtime 子进程
runtime 持续运行，监听 Matrix room
收到消息 → 跑 chat loop → 等下一条
runtime 永不退出（直到 agent.stop）
```

**问题**：
1. 状态累积：runtime 长期运行，thinking / toolCallHistory 等内存态越积越多
2. 任务隔离差：一个 task 崩溃影响整个 runtime
3. 跨节点不天然：C 阶段远端 task 到达时，本地 agent 已有任务在跑

### v2 task-driven 架构（目标）

```
任务到达 → acquire warm runtime（预启动的）
       → 注入 task config via IPC
       → runtime 跑 chat loop（处理这一个 task）
       → task_complete → runtime 销毁 + WarmPool.replenish
```

每个 task（含普通聊天消息）都是独立的 runtime 生命周期。

### 决策清单（与用户确认）

| # | 决策点 | 选择 | 理由 |
|---|---|---|---|
| 1 | 迁移策略 | **完全切换** | 干净单模式，无需维护双引擎；接受高风险换取架构清晰 |
| 2 | dispatch/task_reply 处理 | **走 task-driven** | 主进程监听 dispatch event → 创建 ephemeral task → acquire 子 runtime；与 v1.7.4 fresh session 一致 |

## 整体架构

### 核心理念

**主进程成为消息路由中心，runtime 是 task 的临时资源**。

```
[Matrix event 到达主进程 sync-manager]
        ↓
   主进程路由层（RouterService，按 event 类型分流）
        ↓
┌───────┴────────┬───────────────┬──────────────┐
│ m.room.message │ dispatch      │ task_reply   │
│ (user 消息)    │ (PM→子agent)  │ (子agent→PM) │
└───┬────────────┴───┬───────────┴──────┬───────┘
    ↓                ↓                  ↓
ephemeral task    ephemeral task     通知正在执行的 PM task
(chat 模式)       (dispatch 模式)    (通过 IPC 推送)
    ↓                ↓
acquire warm runtime（per-agent）
    ↓
注入 task-config via IPC
    ↓
runtime 跑 chat loop（处理这一个 task）
    ↓
task_complete / dispatch 完成
    ↓
runtime 销毁 + WarmPool.replenish
```

### 三层架构

| 层 | 职责 | 状态 |
|---|---|---|
| **主进程路由层** | 监听 Matrix + 路由到 agent + 创建 task | 新建 RouterService |
| **调度层** | WarmPool + AgentRunner + Dispatcher + Scheduler | D 子系统已建好（库就绪） |
| **执行层** | runtime-entry chat loop（仅处理一个 task） | 改造：删 Matrix 监听 + 加 task-config IPC |

## 数据流（4 种场景）

### 场景 1：用户发普通消息（无 #task）

```
user → sync-manager 收到 m.room.message
     → RouterService.routeMatrixEvent
     → decideResponse 判断路由（B6 已实现）
     → 目标 agent → 创建 ephemeral task（task_type='chat', task_id=null）
     → AgentRunner.executeTask({taskId:null, roomId, body, mentions})
     → acquire warm runtime → 注入 task-config via IPC
     → runtime chat loop
     → task_complete → process.send({type:'task-end'})
     → 主进程更新 message status='done' → runtime 销毁 → WarmPool.replenish
```

### 场景 2：用户 @agent #T-001

```
user → sync-manager 收到 m.room.message（含 #T-001）
     → RouterService 解析 mentions → 找到 T-001
     → 检查冲突（B9 conflict-detector）
     → 启动 task T-001（B8 startTask）
     → AgentRunner.executeTask({taskId:'T-001', executionRoomId, body})
     → runtime chat loop（MemoryProvider 注入 task 上下文）
     → complete_task → task 状态机更新 → runtime 销毁
```

### 场景 3：PM dispatch 子 agent

```
PM runtime 调 dispatch:programmer 工具
     → 主进程 IPC 接收（runtime → main via child.on('message')）
     → 主进程发 Matrix dispatch event（A 子系统协议）
     → sync-manager 监听 dispatch event
     → RouterService 找到子 agent（programmer）
     → 创建 ephemeral task（task_type='dispatch', task_id=dispatch_event.task_id）
     → 子 AgentRunner.executeTask({taskId:dispatch_id, body:task_description, dispatchContext})
     → 子 runtime chat loop
     → complete → 主进程发 Matrix task_reply event
     → RouterService 通知 PM runtime（通过 IPC 推送 task_reply）
```

### 场景 4：TaskDispatcher pickup（看板 assigned 任务）

```
TaskScheduler 扫描 pending → assigned（已有）
     → TaskDispatcher.tryPickup（已有）
     → AgentRunner.executeTask({taskId, executionRoomId, body:''})
     → runtime chat loop（从 MemoryProvider 拉 task 上下文）
     → complete_task → task 状态机 → runtime 销毁
```

## 组件改造细节

### runtime-entry.ts 改造（核心）

**删除**：
- `client.startClient()` + `client.on(ClientEvent.Event)` Matrix 监听
- `client.on(RoomEvent.MyMembership)` 成员变更监听
- `waitForPrepared()` 等待 Matrix sync 逻辑
- `main()` 内的 Matrix client 初始化（client 仍用于发 m.room.message，但不监听）

**新增 task-config IPC handler**：

```typescript
process.on('message', async (msg: unknown) => {
  if (typeof msg !== 'object' || msg === null) return;
  const m = msg as { type?: string };
  
  if (m.type === 'task-config') {
    const cfg = msg as TaskConfig;
    await runTaskChatLoop(cfg);
  }
});

async function runTaskChatLoop(cfg: TaskConfig): Promise<void> {
  // 1. 注入 system prompt（task 上下文 / dispatch 模式 hint）
  // 2. 构造 LLM messages（MemoryProvider.getTaskContext / getConversationContext）
  // 3. chat loop（沿用现有 LLM 调用 + 工具执行）
  // 4. task_complete → process.send({type:'task-end', streamSessionId, taskId})
  // 5. process.exit(0)  // runtime 销毁
}
```

**TaskConfig 接口**：

```typescript
interface TaskConfig {
  type: 'task-config';
  taskId: string | null;          // null = ephemeral chat
  executionRoomId: string;
  body: string;
  streamSessionId: string;
  mentions?: string[];
  /** dispatch 模式：父 agent 派来的任务上下文 */
  dispatchContext?: {
    fromBotUserId: string;
    task_id: string;
    tool_budget?: number;
    tool_stream_session_id?: string;
  };
}
```

**保留**：
- chat loop 内部逻辑（LLM 调用 + 工具执行 + dispatch 协议 + MemoryProvider）
- process.on('message') 的 abort / MCP 调用 handler
- task_complete / sendFinalMessage 函数

### runtime-spawner.ts 完整实现

```typescript
export async function spawnForAgent(opts: {
  assignmentId: string;
  runtimeConfig: AgentRuntimeOpts;
}): Promise<ChildProcess> {
  // 1. fork runtime-entry.js（传递 AGENT_CONFIG 环境变量）
  // 2. 注册全局 chunk 转发 handler（child.on('message') → main → renderer）
  // 3. 注册 task-end handler（child 退出 → AgentRunner.release）
  // 4. 返回 ChildProcess 给 WarmPool
}

export async function stopRuntime(child: ChildProcess): Promise<void> {
  child.send({ type: 'shutdown' });
  // 等待 5s + force kill
}
```

### 主进程 RouterService（新模块）

```typescript
// electron/src/main/agent/router-service.ts（新）
export class RouterService {
  constructor(opts: {
    runners: Map<string, AgentRunner>;  // assignmentId → runner
    dispatcher: TaskDispatcher;
  });
  
  /** Matrix event 到达时调用（替代当前 runtime 自己监听） */
  async routeMatrixEvent(event: MatrixEvent): Promise<void> {
    const eventType = event.getType();
    if (eventType === 'm.room.message') {
      await this.routeUserMessage(event);
    } else if (eventType === DISPATCH_EVENT_TYPE) {
      await this.routeDispatch(event);
    } else if (eventType === TASK_REPLY_EVENT_TYPE) {
      await this.routeTaskReply(event);
    } else if (eventType === ABORT_DISPATCH_EVENT_TYPE) {
      await this.routeAbortDispatch(event);
    }
  }
  
  private async routeUserMessage(event: MatrixEvent): Promise<void> {
    // 1. 解析消息内容 + mentions
    // 2. decideResponse 判断路由（B6）
    // 3. 创建 ephemeral task 或触发 #T-XXX 启动
    // 4. AgentRunner.executeTask
  }
  
  private async routeDispatch(event: MatrixEvent): Promise<void> {
    // 1. 解析 dispatch_to（目标子 agent）
    // 2. 创建 ephemeral task（task_type='dispatch'）
    // 3. AgentRunner.executeTask
  }
  
  private async routeTaskReply(event: MatrixEvent): Promise<void> {
    // 1. 找到正在执行 PM task 的 runtime
    // 2. 通过 IPC 推送 task_reply
  }
  
  /** 启动：sync-manager 注册监听 */
  start(): void {
    // sync-manager 收到 event → this.routeMatrixEvent
  }
}
```

### IPC handler 切换（6 处）

| 调用点 | v1（spawnAgent） | v2（新流程） |
|---|---|---|
| `workspace/ipc.handlers:110` | 添加 agent 到 workspace | 不变（仅注册，不 spawn） |
| `auto-start:111` | app 启动恢复 agent | 改：调 WarmPool.warm（预热不 spawn） |
| `agent/ipc.handlers:166,279,380,628` | 用户手动启动 agent | 改：调 WarmPool.warm（预热） |

**关键变化**：用户"启动 agent"不再是"spawn 一个长期 runtime"，而是"预热 warm pool"（K 个 runtime 待命）。实际执行在 task 到达时由 RouterService 触发。

### abort / error 恢复

| 场景 | 机制 |
|---|---|
| 用户点"停止" | 主进程 → AgentRunner.abortStream(streamSessionId) → runtime 收到 abort IPC → AbortController |
| runtime 崩溃 | child.on('exit') → AgentRunner.release → WarmPool.replenish + 主进程更新 task/message 状态 |
| LLM API 错误 | runtime 内 chat loop 捕获 → task_complete(failed) → process.exit(1) → 主进程标记 task failed |
| Matrix event 派发失败 | RouterService try/catch → 记录日志，不阻塞其他 event |

### WarmPool 启动时机

| 时机 | 动作 |
|---|---|
| App 启动（autoRestoreSession） | 遍历 assignments → 每个 agent WarmPool.warm（K=2 个 runtime 待命） |
| 用户新增 agent | WarmPool.warm(newAssignmentId) |
| 用户停止 agent | WarmPool.destroyAll(assignmentId) |
| App 退出 | 所有 WarmPool.destroyAll |

## 迁移步骤（10 个 task）

```
1. migration v22: agent_definitions.task_driven 字段（默认 true）
2. runtime-spawner.ts 完整实现（spawnForAgent + stopRuntime）
3. runtime-entry.ts 改造（删 Matrix 监听 + 加 task-config IPC）
4. RouterService 实现（Matrix event 路由 + task 创建）
5. main/index.ts 启动链路（WarmPool 初始化 + RouterService.start）
6. IPC handler 切换（6 处 spawnAgent → WarmPool.warm）
7. auto-start.ts 改造（预热 warm pool 而非 spawn）
8. dispatch/task_reply 路由（主进程拦截 + ephemeral task）
9. runtime-manager.ts 标记 deprecated（保留代码但不调用，留 1 版本后删）
10. e2e 集成测试（4 个场景端到端验证）
```

## 测试策略

| 层级 | 测试 |
|---|---|
| **单元** | runtime-spawner.spawnForAgent / RouterService.routeMatrixEvent / runtime-entry task-config handler |
| **集成** | 主进程 + fork 真实 runtime-entry（不 mock child process） |
| **e2e** | 场景 1 普通消息 / 场景 2 #task mention / 场景 3 dispatch / 场景 4 看板 pickup |
| **回归** | 现有 1207 测试全部不退化 |

**关键 e2e 测试**（必须覆盖）：
1. 用户消息 → runtime spawn → chat loop → task_complete → runtime 销毁
2. dispatch → 子 runtime spawn → 处理 → task_reply → 父 runtime 收到
3. abort → runtime 内 AbortController 触发 → runtime 退出
4. runtime 崩溃 → WarmPool 补充新 runtime → 后续 task 正常

## 风险 + 缓解

| 风险 | 概率 | 缓解 |
|---|---|---|
| runtime-entry 改造破坏现有 chat loop | 高 | 保留 chat loop 核心逻辑（LLM 调用 / 工具执行 / dispatch），仅改入口 |
| Matrix 监听删除后 dispatch 协议失效 | 中 | 主进程 RouterService 拦截 dispatch event → 创建 ephemeral task |
| WarmPool 内存爆炸（多 agent × K） | 低 | K=2 默认 + global_settings.warm_pool_size 可配 |
| runtime 崩溃后 task 状态不一致 | 中 | child.on('exit') → 主进程更新 task 状态为 failed |
| migration v22 后旧 agent 不工作 | 低 | task_driven 默认 true，但保留 v1 代码路径作为 fallback（runtime-manager 标记 deprecated 但不删） |

## 数据模型变更（migration v22）

```sql
-- agent_definitions 加 task_driven 字段
-- 默认 1（v2.0 起所有 agent 走 task-driven）
-- 0 = 走 v1 runtime-manager（回退用，留 1 版本）
ALTER TABLE agent_definitions ADD COLUMN task_driven INTEGER NOT NULL DEFAULT 1;
```

## 影响范围

**新增**：
- `electron/src/main/agent/router-service.ts`（RouterService）
- 完善 `electron/src/main/agent/runtime-spawner.ts`（spawnForAgent 完整实现）
- `electron/tests/agent/router-service.test.ts`
- `electron/tests/agent/runtime-spawner.test.ts`
- `electron/tests/integration/task-driven-e2e.test.ts`

**改造**：
- `electron/src/main/agent/runtime-entry.ts`（删 Matrix 监听 + 加 task-config IPC）
- `electron/src/main/agent/runtime-manager.ts`（标记 deprecated）
- `electron/src/main/agent/ipc.handlers.ts`（6 处 spawnAgent → WarmPool.warm）
- `electron/src/main/agent/auto-start.ts`（预热而非 spawn）
- `electron/src/main/index.ts`（启动 WarmPool + RouterService）
- `electron/src/main/matrix/sync-manager.ts`（注册 RouterService 路由）

**保留**：
- `electron/src/main/agent/agent-runner.ts`（D4，已就绪）
- `electron/src/main/agent/warm-pool.ts`（D3，已就绪）
- `electron/src/main/task/dispatcher.ts`（D5，已就绪）
- `electron/src/main/task/scheduler.ts`（D6，已就绪）

## 完成标准

- ✅ 所有 4 个场景 e2e 测试通过
- ✅ 现有 1207 测试无回归
- ✅ typecheck 双 clean
- ✅ runtime 完成即销毁（无长期运行进程）
- ✅ per-agent 并发受 max_concurrent_tasks 控制
- ✅ v1 runtime-manager 标记 deprecated（保留代码但不调用）

## 未覆盖（已知限制）

- **runtime-manager.ts 删除**：本 spec 仅标记 deprecated，保留代码作为回退。1 版本后删除
- **per-agent 真并发 > 1**：本切换仍维持 per-agent max=1（schema 留字段为 v2 真并发铺路）。多 task 并发通过多 agent 实现
- **runtime warm pool 持久化**：runtime 进程不持久化（重启后 warm pool 重建）。持久化 task 队列已在 D 子系统 SQLite 内
