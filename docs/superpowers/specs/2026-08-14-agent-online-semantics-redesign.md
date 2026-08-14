# Agent 在线状态语义重新设计

**日期**：2026-08-14
**类型**：bug 修复 + 语义重新定义
**影响范围**：12 个文件（8 electron + 4 renderer）
**前置**：v2.0 平台重构（task-driven runtime 切换已完成）

---

## 1. 背景与问题

### 1.1 用户报告

> App 启动后所有 agent 全部下线。切换到会话界面，成员列表中所有 agent 还是离线状态；切换到 agent 界面发现 agent 全部都是下线。无论重启多少次都一样。

### 1.2 根因（双 层失效）

**表层 bug**：T9 task-driven 切换的 final review 漏改 `isAgentRunning` IPC handler——仍只查 v1 `runtimes` Map，对 task-driven agent（在 `agentRunners` Map）永远返回 `false`。

数据流：
```
[Renderer]
MembersPanel.tsx:14-18 isAgentOnline(userId)
  → assignments + running[instanceId]
  → agent.store.ts:101 syncRunningStates()
  → Promise.all(ipc.agent.isRunning(instanceId))
[Main]
ipc.handlers.ts:39 import { isAgentRunning } from './runtime-manager'  ← 仍 v1
runtime-manager.ts:853-856 isAgentRunning(id) → runtimes.has(id)  ← v1 Map
                              ↓
task-driven agent 永远不在 runtimes → 返回 false → running[id]=false → 显示离线
```

**深层隐藏问题**：
- `AgentAssignmentRow` schema（crud.ts:90-100）**没有 `last_running` 字段**——尽管 DB 列存在（v1.5.8 加的）
- `AgentAssignment` 接口（types.ts:81-96）**没有 `lastRunning` 字段**
- `rowToAssignment` 没映射——所有 callers 拿不到这个字段
- `agent:stop` IPC handler 也漏了双轨改造（仅调 v1 `stopAgent`，task-driven agent 路径无效）

### 1.3 task-driven 架构的语义冲突

v1 语义：agent 在线 = 子进程在跑 = bot Matrix client 在线
v2 task-driven 设计意图：bot 不长期驻 Matrix client（task 来 spawn，结束 release）

直接套用 v1 语义会让所有 task-driven agent 永远"离线"。需要重新定义"在线"。

---

## 2. 用户语义（设计目标）

**核心定义**：「agent 在线」=「用户启动过这个 agent」= DB 字段 `last_running=1`。

**用户视角**：
- 用户在某 workspace 创建 10 个 agent
- 用户主动「启动」需要的 agent（`last_running=1`）
- 用户主动「下线」不需要的 agent（`last_running=0`），原因可能是提示词未设计好、暂时不用等
- 下线的 agent：
  - 会话界面无法 @ 提及（菜单不显示）
  - PM 无法通过 dispatch 工具调用（工具列表不出现）
  - 成员列表显示"离线"
  - Agent 管理界面显示"已停止"

**与子进程状态的关系**：子进程在不在跑是实现细节，不暴露给 UI / 路由层。即使 task-driven agent 的子进程在 task 间隙被 WarmPool release，agent 仍视为"在线"（用户启动意图未变）。

---

## 3. 五个核心设计决策

| # | 决策点 | 选择 | 理由 |
|---|---|---|---|
| 1 | 用户启动后运行时行为 | **预热待命** | WarmPool 预热 K=2 子进程待命；bot Matrix presence 离线但 owner client 代发；保留 task-driven 弹性 |
| 2 | PM 调度未启动 sub 行为 | **隐藏**（dispatch 工具列表过滤） | LLM 看不到工具就不会调用；保持 dispatch 工具列表干净 |
| 3 | @ 提及未启动 agent 行为 | **菜单过滤** | 与 PM dispatch 行为一致；用户根本输入不到 |
| 4 | 修复范围 | **最小修复** | 不动协调 agent 离线场景；不重设计状态机；专注本次报告的 bug |
| 5 | 状态权威源 | **DB `last_running` 字段** | 单一数据源；与用户语义直接对应；与现有 autoStartAgents 完美兼容 |

---

## 4. 详细设计

### 4.1 类型补全（前提）

#### `electron/src/main/agent/types.ts`

```typescript
export interface AgentAssignment {
  // ...existing fields
  /** v2 修复：用户最近运行意图。这是"agent 在线"的唯一权威源。
   *  - true = 用户启动过（在线）
   *  - false = 用户主动停止或从未启动（离线）
   */
  lastRunning: boolean;
}
```

#### `renderer/src/ipc/types.d.ts`

同步加 `lastRunning: boolean` 字段。

#### `electron/src/main/agent/crud.ts`

```typescript
interface AgentAssignmentRow {
  // ...existing
  last_running: number;  // ← 新增映射
}

function rowToAssignment(row: AgentAssignmentRow): AgentAssignment {
  return {
    // ...existing
    lastRunning: row.last_running === 1,  // ← 新增
  };
}
```

### 4.2 IPC 接口改造

#### `agent:isRunning` 改为查 DB

`runtime-manager.ts:853-856`：

```typescript
export function isAgentRunning(instanceId: string): boolean {
  const row = getDb()
    .prepare('SELECT last_running FROM agent_assignments WHERE instance_id = ?')
    .get(instanceId) as { last_running: number } | undefined;
  return row?.last_running === 1;
}
```

**语义变化**：函数从「子进程在不在」改为「用户标记为运行」。所有 12 个 callers（ipc.handlers.ts / auto-start.ts / workspace/ipc.handlers.ts / crud.ts）的行为均符合新语义。

#### `agent:stop` 双轨改造

`runtime-registry.ts` 新增 helper：

```typescript
/** 销毁单个 task-driven runtime（runner + WarmPool），从全局 Map 移除 */
export function destroyTaskDrivenRuntime(instanceId: string): void {
  const runner = agentRunners.get(instanceId);
  if (runner) {
    runner.destroy();
    agentRunners.delete(instanceId);
  }
  const pool = agentWarmPools.get(instanceId);
  if (pool) {
    pool.destroyAll();
    agentWarmPools.delete(instanceId);
  }
}

/** 统一的停止入口：v1 + v2 双轨销毁 + DB 同步 */
export async function stopAgentRuntime(instanceId: string): Promise<void> {
  // 1. v1 子进程（如有）
  stopAgent(instanceId);  // 已 UPDATE last_running=0
  // 2. v2 task-driven runtime（如有）
  destroyTaskDrivenRuntime(instanceId);
  // 3. 幂等再写一次（v1 stopAgent 已做，task-driven 路径需要）
  getDb()
    .prepare('UPDATE agent_assignments SET last_running = 0 WHERE instance_id = ?')
    .run(instanceId);
}
```

`ipc.handlers.ts:522`：

```typescript
ipcMain.handle('agent:stop', async (_evt, instanceId: string) => {
  await stopAgentRuntime(instanceId);
  await maybeRestartMainForSubChange(instanceId);  // § 4.4
});
```

#### `agent:start` 微调

T9 已实现双轨（`startAgentRuntime(opts, def.taskDriven !== false)`）。仅确认：
- task-driven 路径走 `ensureTaskDrivenRuntime` → 注册 runner + WarmPool warm
- v1 路径走 `spawnAgent`（已 `UPDATE last_running=1`）

末尾加 `maybeRestartMainForSubChange(instanceId)`（§ 4.4）。

### 4.3 App 启动恢复

#### `initTaskDrivenRuntime` 修复（index.ts:107-183）

**当前 bug**：仅过滤 `enabled=1`，未过滤 `last_running=1`。

```typescript
for (const assignment of listAssignments(ws.id)) {
  if (agentRunners.has(assignment.instanceId)) continue;
  if (!assignment.enabled) continue;
  if (!assignment.lastRunning) continue;  // ← 新增关键过滤
  // ...rest unchanged
}
```

#### `autoStartAgents`（auto-start.ts）

已正确（行 57 已查 `enabled=1 AND last_running=1`），无需改。

### 4.4 PM Dispatch 工具列表过滤

#### `rebuildSubAgents` 过滤（spawn-helpers.ts:38-54）

```typescript
export function rebuildSubAgents(
  workspaceId: string,
  mainInstanceId: string,
): SubAgentRef[] {
  const subAssignments = listSubAssignments(workspaceId, mainInstanceId);
  const subs: SubAgentRef[] = [];
  for (const sub of subAssignments) {
    if (!sub.lastRunning) continue;  // ← 新增：仅启动的 sub
    const subDef = getAgentDefinition(sub.agentDefinitionId);
    if (!subDef) continue;
    subs.push({
      slug: subDef.slug,
      botUserId: sub.botMatrixUserId,
      description: subDef.description,
    });
  }
  return subs;
}
```

#### sub 状态变化触发 main 重启

subAgents 列表是 main agent spawn 时一次性注入 `AGENT_CONFIG`，子进程不会动态发现。当 sub 启动/停止状态变化时，必须重启 parent main 让它看到新的 dispatch 工具列表。

**现有机制**：`restartMainForSubChange(workspaceId, mainInstanceId)`（ipc.handlers.ts:259）已实现，被 `assignMainAgent` / `addToWorkspace` / `updateAssignmentRole` 调用。

**新增触发点**：`agent:start` / `agent:stop` 末尾。

```typescript
/** 若 instanceId 是 sub，重启其 parent main（让 main 看到更新后的 dispatch 列表） */
async function maybeRestartMainForSubChange(instanceId: string): Promise<void> {
  const row = getDb()
    .prepare('SELECT workspace_id, role, parent_instance_id FROM agent_assignments WHERE instance_id = ?')
    .get(instanceId) as
      | { workspace_id: string; role: string; parent_instance_id: string | null }
      | undefined;
  if (row?.role === 'sub' && row.parent_instance_id) {
    await restartMainForSubChange(row.workspace_id, row.parent_instance_id);
  }
}
```

### 4.5 MentionInput + MembersPanel + WorkspaceAgentsPanel 改造

数据源统一改为 `assignment.lastRunning`，删除 `running` Map 依赖。

#### `MentionInput.tsx:68-75`

```typescript
const filteredAgents = useMemo(() => {
  if (menuType !== 'agent') return [];
  const q = query.toLowerCase();
  return assignments.filter((a) => {
    if (!a.lastRunning) return false;  // ← 新增：仅在线 agent
    const name = a.agentName ?? a.botMatrixUserId;
    return !q || name.toLowerCase().includes(q);
  });
}, [assignments, menuType, query]);
```

#### `MembersPanel.tsx:14-18`

```typescript
const isAgentOnline = (userId: string): boolean | null => {
  const a = assignments.find((item) => item.botMatrixUserId === userId);
  if (!a) return null;
  return a.lastRunning;  // ← 替代 running[a.instanceId] === true
};
```

`useAgentStore()` 调用改为同时取 `assignments`（已在线的）即可，不再需要 `running`。

#### `WorkspaceAgentsPanel.tsx:210` (AssignmentRow)

```typescript
const isRunning = a.lastRunning;  // ← 替代 !!running[a.instanceId]
```

`WorkspaceAgentsPanel` 不再需要从 store 取 `running`。

#### `agent.store.ts` 删除冗余

```typescript
// 删除：running: Record<string, boolean>;
// 删除：syncRunningStates() 方法
// 删除：loadAssignments 内的 await get().syncRunningStates();
// 删除：stopAgent / startAgent 内的 set running 更新
// 删除：reset() 内的 running: {}
```

所有依赖 `running` 的组件改为读 `assignment.lastRunning`。

### 4.6 错误处理 + 边缘场景

| 场景 | 处理 |
|---|---|
| 子进程崩溃但 last_running=1 | v1: circuit breaker 重启；v2: WarmPool 自动 replenish。崩溃不改 last_running（保留用户意图） |
| 用户停止正在执行 task 的 agent | destroy runner → active tasks 子进程 SIGTERM → RouterService 路由前再查 runner，找不到则 log + 丢弃消息（不报错给用户） |
| task-driven runner 注册失败（keychain 缺失） | log + 继续；last_running 保持 1（下次启动重试）；当前会话期内消息路由时 runner 缺失 → 丢弃 |
| Conduwuit 未就绪 | `autoRestoreSession` 已有 try/catch；RouterService 未初始化时 sync-manager 丢弃消息 |
| v1 fallback agent（taskDriven=false） | 保留 v1 路径，行为不变 |

**已知 spec 范围外**：
- 协调 agent 被停止 → 团队群无 @ 消息无人接待（用户选最小修复）
- 多个 owner 同时操作 last_running 写竞争（SQLite 单写锁，不构成问题）

---

## 5. 测试策略

### 5.1 单元测试（新增 / 更新）

1. **`isAgentRunning` 行为变更**（runtime-manager.test.ts）
   - last_running=1 → true
   - last_running=0 → false
   - instance 不存在 → false

2. **`stopAgentRuntime` 双轨**（runtime-registry.test.ts）
   - v1 agent（runtimes.has）→ v1 stopAgent + last_running=0
   - v2 agent（agentRunners.has）→ destroy runner + WarmPool + last_running=0

3. **`destroyTaskDrivenRuntime`**（runtime-registry.test.ts）
   - runner + pool 从 Map 移除
   - 不存在的 instanceId → no-op

4. **`rebuildSubAgents` 过滤**（spawn-helpers.test.ts）
   - 3 subs，2 last_running=1 → 返回 2 个 SubAgentRef
   - 全部 last_running=0 → 返回 []

5. **`rowToAssignment` 映射 lastRunning**（crud.test.ts）
   - row.last_running=1 → assignment.lastRunning=true
   - row.last_running=0 → assignment.lastRunning=false

6. **`maybeRestartMainForSubChange`**（ipc.handlers.test.ts）
   - 停止 sub → parent main 重启
   - 停止 standalone → 不触发重启
   - 停止 main → 不触发重启

### 5.2 集成测试（新增）

7. **`initTaskDrivenRuntime` 仅注册 last_running=1**（integration: agent-online-bootstrap.test.ts）
   - 准备 2 个 enabled=1 + task_driven=1 的 agent，1 个 last_running=0
   - 调 initTaskDrivenRuntime → agentRunners.size === 1（仅 last_running=1 的）

8. **`agent:start` + `agent:stop` 双轨 + DB 同步**（integration: agent-start-stop.test.ts）
   - 调 start → runner 注册 + last_running=1
   - 调 stop → runner 销毁 + last_running=0
   - 调 start → 重新注册

### 5.3 UI 测试

9. **MembersPanel 显示在线/离线**（MembersPanel.test.tsx）
   - lastRunning=true → 显示"在线"
   - lastRunning=false → 显示"离线"

10. **MentionInput 菜单过滤**（MentionInput.test.tsx）
    - 3 assignments，1 lastRunning=false → 菜单只显示 2 个

### 5.4 既有测试影响

- **`runtime-manager-restart.test.ts` / `runtime-manager-last-running.test.ts`**：依赖 `isAgentRunning`，需更新断言（从「子进程在」改为「last_running=1」）
- **`agent-runner.test.ts`**：不受影响
- **`auto-start-last-running.test.ts`**：不受影响

---

## 6. 文件改动清单

### Electron（8 个）

| 文件 | 改动 |
|---|---|
| `electron/src/main/agent/types.ts` | `AgentAssignment` 新增 `lastRunning: boolean` |
| `electron/src/main/agent/crud.ts` | `AgentAssignmentRow` + `rowToAssignment` 加 `last_running` 映射 |
| `electron/src/main/agent/runtime-manager.ts` | `isAgentRunning` 改为查 DB |
| `electron/src/main/agent/runtime-registry.ts` | 新增 `destroyTaskDrivenRuntime(id)` + `stopAgentRuntime(id)` |
| `electron/src/main/agent/ipc.handlers.ts` | `agent:stop` 用 `stopAgentRuntime`；start/stop 末尾调 `maybeRestartMainForSubChange` |
| `electron/src/main/index.ts` | `initTaskDrivenRuntime` 加 `lastRunning` 过滤 |
| `electron/src/main/agent/spawn-helpers.ts` | `rebuildSubAgents` 过滤 `!sub.lastRunning` |
| `electron/src/main/agent/auto-start.ts` | 文档注释更新（task-driven 由 initTaskDrivenRuntime 接管，行为不变） |

### Renderer（4 个）

| 文件 | 改动 |
|---|---|
| `renderer/src/ipc/types.d.ts` | `AgentAssignment` 加 `lastRunning: boolean` |
| `renderer/src/components/im/MentionInput.tsx` | 菜单过滤 `!a.lastRunning` |
| `renderer/src/components/im/MembersPanel.tsx` | `isAgentOnline` 改查 `a.lastRunning` |
| `renderer/src/components/agent/WorkspaceAgentsPanel.tsx` | `AssignmentRow` 用 `a.lastRunning` |
| `renderer/src/stores/agent.store.ts` | 删除 `running` state + `syncRunningStates` |

### 类型共享

`electron/src/preload/index.ts` 通过 `../../../renderer/src/ipc/types.d.ts` 引用——renderer 端类型变化自动反映到 electron preload。

---

## 7. 验证标准

修复完成后，以下行为必须成立：

1. ✅ App 启动后，`last_running=1` 的 agent 在 MembersPanel 显示"在线"
2. ✅ App 启动后，`last_running=1` 的 agent 在 WorkspaceAgentsPanel 显示"▶ 运行中"
3. ✅ App 启动后，`last_running=0` 的 agent 在两个界面显示"离线 / 已停止"
4. ✅ 用户点击"启动"按钮 → agent 立即变在线（runner 注册 + WarmPool warm）
5. ✅ 用户点击"停止"按钮 → agent 立即变离线（runner 销毁 + WarmPool destroy）
6. ✅ @ 提及菜单仅显示在线 agent
7. ✅ PM 的 dispatch 工具列表仅含在线 sub（启动/停止 sub 后 main 自动重启刷新列表）
8. ✅ 全部既有测试通过（更新 runtime-manager 相关测试断言）
9. ✅ typecheck 双 workspace clean

---

## 8. 不在本次修复范围

- 协调 agent 被停止后团队群消息路由（无 @ 消息无人接待）
- agent 状态机重设计（启动中/在跑/空闲/下线 四态）
- bot Matrix presence 上报（task-driven 设计使然，bot Conduwuit presence 离线）
- 多 owner 写竞争保护（SQLite 单写锁已足够）

这些项目可在后续单独 brainstorm + spec。
