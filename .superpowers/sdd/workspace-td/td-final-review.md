# Task-Driven Runtime 完整切换 — Final Whole-Branch Review

> **评审范围**：`d49632d..HEAD`（9 commits，T1-T10，24 files，+2207 / -60）
> **评审日期**：2026-08-14
> **测试验证**：electron 829/829 + renderer 407/407 + typecheck 双 clean（全部重跑确认）

---

## 整体判定：⚠️ NEEDS FIXES

1 个 Critical 阻塞合并——task-driven 模式下用户消息路由断裂（agent 不响应聊天）。架构设计合理、代码质量高、测试全覆盖，但 e2e 测试验证的是数据层而非 dispatch 链路，导致核心功能缺口未被捕获。修复 C1 后可合入。

---

## 设计目标达成度

| # | 设计目标 | 达成度 | 说明 |
|---|---|---|---|
| 1 | 完全切换（task_driven=1 默认） | ✅ 达成 | Migration v22 `DEFAULT 1`；AgentDefinition 类型 + crud.ts 读写；parseConfig 缺省 true；5 处 IPC handler 全部切换到 `startAgentRuntime(opts, def.taskDriven !== false)` |
| 2 | task-driven：每 task 独立 runtime 生命周期 | ✅ 架构达成 | spawnForAgent fork → AgentRunner.executeTask 注入 task-config → runTaskChatLoop → process.exit(0)；WarmPool.replenish 接管。运行时未做真实 fork 验证（e2e 用 mock chunk） |
| 3 | dispatch 走 task-driven（RouterService 拦截） | ⚠️ 部分达成 | dispatch 自解析 ✅；task_reply 广播 ✅；**m.room.message 路由断裂 ❌**（见 C1） |
| 4 | v1 fallback 保留（task_driven=0） | ✅ 达成 | auto-start.ts `def.taskDriven !== false → continue` 守卫；runtime-entry 保留 else 分支 handleEvent；runtime-manager.ts @deprecated 但代码保留 |

---

## Findings

### Critical

#### C1: 用户消息路由断裂——task-driven 模式下 agent 不响应用户消息

**位置**：`sync-manager.ts:212-214` + `router-service.ts:79-80`

**问题**：sync-manager 调用 `routeMatrixEvent(event, localUserId ?? '', null)`，第 4 参数 `directTargetAssignmentId=null`。RouterService.routeUserMessage 的守卫 `if (directTargetAssignmentId)` 为 falsy，**直接跳过用户消息派发**：

```typescript
// router-service.ts:79
case 'm.room.message':
  if (directTargetAssignmentId) {        // null → false → 不派发
    await this.routeUserMessage(event, directTargetAssignmentId);
  }
  break;
```

**根因**：`decideResponse`（B6 房间→agent 路由判定）未在 sync-manager 内调用，也没有任何模块计算 `directTargetAssignmentId`。代码注释明确承认（sync-manager.ts:210-211）：

> "directTargetAssignmentId 未传（null）→ 仅 task_reply 广播生效；m.room.message / dispatch 的 room→agent 解析在后续 task 实现。"

**影响**：migration v22 后所有 agent 默认 `task_driven=1`。task-driven 模式下 runtime-entry **不注册** Matrix event 监听（`isTaskDriven=true` 跳过 `client.on(ClientEvent.Event, handleEvent)`）。因此用户发消息后：
- v1 runtime 不存在（task_driven=1 不走 spawnAgent）
- v2 RouterService 不派发（directTarget=null）
- **没有任何 agent 响应**

这是产品的核心功能（用户与 agent 对话），合并到 main 后会静默失效。

**为什么测试没发现**：e2e 测试（task-driven-e2e.test.ts 场景 1）手动 `insertMessage` agent 消息 + 手动 append chunk 到 buffer，验证的是 SQLite 落盘 + 聚合正确性，**没有验证 Matrix event → RouterService → AgentRunner → runtime 的真实 dispatch 链路**。

**修复方案**（well-scoped）：在 sync-manager 的 event handler 内，对 `m.room.message` 调用 `decideResponse`（B6）解析目标 assignmentId，然后传给 `routeMatrixEvent` 的第 4 参数。或在 RouterService.routeUserMessage 内部注入 decideResponse。

---

### Important

#### I1: providerBuckets 永远为空——TaskDispatcher 限流失效

**位置**：`index.ts` initTaskDrivenRuntime + `runtime-registry.ts:25`

`providerBuckets = new Map()` 创建后从未从 `model_providers.max_rpm/max_tpm` 填充。TaskDispatcher 收到空 buckets，provider 级 RPM/TPM 限流完全 inactive。功能不阻塞（只是无限流），但与 D 子系统设计意图不符。

#### I2: routeTaskReply 广播给所有 runner

**位置**：`router-service.ts:196-200`

task_reply event content 不含 PM 的 botUserId（只有 task_id），无法反查目标 runner。当前广播给所有 runner，各自按 `activeTasks.taskId` 匹配。n 通常 < 10 可接受，但每次 task_reply 都遍历全部 runner 的 activeTasks。建议未来在 task_reply content 加 `reply_to` 字段精确路由。

#### I3: process.exit(0) 与 IPC flush 潜在竞态

**位置**：`runtime-entry.ts:1316-1318`

```typescript
process.send?.({ type: 'task-end', streamSessionId, taskId, toolCallsUsed });
process.exit(0);  // 紧接其后
```

`process.send` 是异步 IPC 写。理论上 exit 可能在 task-end flush 前触发。实测中小消息（< 64KB）因 pipe buffer 足够表现为同步，风险低。若 T10 真实 fork 测试发现 task-end 丢失，可加 `process.disconnect?.()` 延迟退出。

#### I4: e2e 测试不验证真实 dispatch 链路（测试设计缺陷）

**位置**：`task-driven-e2e.test.ts` 全文

4 个场景全部是"数据层验证"：手动 INSERT message + append chunk → 验证聚合。**没有任何场景**验证 `Matrix event → sync-manager → RouterService → AgentRunner.executeTask → runtime-entry task-config → chat loop`。这是 C1 未被捕获的直接原因。spec 完成标准要求"4 个场景 e2e 通过"，但当前测试不满足 e2e 语义。

---

### Minor

| # | 位置 | 说明 |
|---|---|---|
| M1 | router-service.ts:230 | routeAbortDispatch 仍为 stub（仅 logger.info + TODO），abort_dispatch event 不中断子 agent task |
| M2 | router-service.ts:73-75 | routeMatrixEvent 有 2 个未使用参数（`_ownerUserId` / `_targetAssignmentId`），下划线前缀但仍在签名中，预留 T8 |
| M3 | runtime-spawner.ts EOF | 文件末尾无换行符（`\ No newline at end of file`） |
| M4 | runtime-registry.ts | `createTaskDrivenRuntime` 与 `ensureTaskDrivenRuntime` 的 spawn 闭包代码重复（~20 行），可提取共享工厂 |
| M5 | runtime-registry.ts:58,92 | WarmPool `poolSize: 2` 硬编码，未读 `global_settings.warm_pool_size`（v21 migration 已建该列） |

---

## 跨 Task 集成验证

### T2 spawner ↔ T3 runtime-entry ↔ T4 RouterService ↔ T5 main 链路

| 链路环节 | 状态 | 验证方式 |
|---|---|---|
| spawnForAgent fork runtime-entry.js + AGENT_CONFIG env | ✅ | runtime-spawner.test.ts（mock fork） |
| runtime-entry task-config IPC handler → runTaskChatLoop | ✅ | runtime-task-driven.test.ts（9 用例） |
| runTaskChatLoop → runChatLoop（复用 chat loop 核心） | ✅ | runChatLoop 现有 20+ 测试无回归 |
| AgentRunner.executeTask → child.send(task-config) | ✅ | agent-runner.test.ts |
| RouterService.routeDispatch → 自解析 dispatch_to → executeTask | ✅ | router-service.test.ts（5 用例） |
| RouterService.routeUserMessage → executeTask | ❌ 断裂 | directTargetAssignmentId 永远 null（C1） |
| main/index.ts initTaskDrivenRuntime → WarmPool + RouterService | ⚠️ | 无单测（涉及 fork + keychain + Matrix 登录），仅 typecheck |

### 关键 grep 不变量

| 不变量 | 结果 |
|---|---|
| spawnAgent 仅在 task_driven=0 路径调用 | ✅ auto-start.ts:137（有 `taskDriven !== false → continue` 守卫）+ runtime-registry.ts:58（startAgentRuntime false 分支） |
| task-config IPC 真在 runtime-entry 注册 | ✅ runtime-entry.ts:412（isTaskDriven 分支内） |
| RouterService 真在 sync-manager 调用 | ✅ sync-manager.ts:214（但 directTarget=null，见 C1） |
| 5 处 IPC handler 全部切换到 startAgentRuntime | ✅ agent/ipc.handlers.ts ×4 + workspace/ipc.handlers.ts ×1 |
| runtime-entry task-driven 模式不监听 Matrix event | ✅ isTaskDriven=true 跳过 `client.on(ClientEvent.Event)` |

### runtime-registry.ts 共享模块设计评估

设计合理：全局 `agentRunners` / `agentWarmPools` / `providerBuckets` 三个 Map 提取到独立模块，避免 main/index.ts ↔ ipc.handlers.ts 循环依赖。RouterService 构造时持有 `agentRunners` 的**引用**（by-reference Map），动态新增的 runner 自动可见。`startAgentRuntime(opts, taskDriven)` 作为统一入口，IPC handler 调用简洁。幂等性正确（createTaskDrivenRuntime / ensureTaskDrivenRuntime 都有 `has(instanceId)` 守卫）。

---

## 残留风险评估

| 风险 | 严重度 | 状态 | 说明 |
|---|---|---|---|
| routeAbortDispatch stub | 低 | 已知 TODO | abort_dispatch 是边缘场景（PM 主动中断子 agent），不阻塞主流程 |
| routeTaskReply 广播 | 低 | 已知 | O(n)，n<10 可接受 |
| providerBuckets 未注入 | 中 | 已知 | 限流失效但不影响功能正确性 |
| process.exit IPC 竞态 | 低 | 已知 | 小消息 pipe buffer 足够，实测无丢失 |
| **m.room.message 路由断裂** | **Critical** | **见 C1** | **阻塞合并** |

---

## 一句话总结

架构设计扎实、代码质量高、测试数量充足，但 **e2e 测试验证错了层级（数据层而非 dispatch 链路）**，导致一个 Critical 功能缺口（task-driven 模式下用户消息不触发 agent 响应）未被捕获——修复 C1（在 sync-manager 接入 decideResponse 计算 directTargetAssignmentId）后即可合入 main。

---

## 是否可以合入 main

**否（当前状态）**。需先修复 C1。

C1 修复范围明确且小（sync-manager event handler 内加 decideResponse 调用 + 传 directTargetAssignmentId），不涉及架构调整。修复后建议补 1 个验证真实 dispatch 链路的集成测试（mock RouterService + AgentRunner，验证 m.room.message → executeTask 被调用）。

修复 C1 + 补测试后，本分支可合入 main。

---

## Fix（2026-08-14）

> Commit: `d93bb2a` — `fix(agent): task-driven final review 修复（1 Critical + 4 Important）`
> 14 files changed, +778 / -17
> 测试：electron 851/851 + renderer 407/407 + typecheck 双 clean

### C1 ✅ 已修复：用户消息路由断裂

**根因**：sync-manager 调用 `routeMatrixEvent(event, localUserId, null)` 传 `directTargetAssignmentId=null`，RouterService.routeUserMessage 守卫 `if (directTargetAssignmentId)` 为 falsy → 跳过派发。

**修复方案**：
1. 新增 `electron/src/main/agent/message-target-resolver.ts` — 纯函数 `resolveMessageTarget(params, workspace)`，遍历 room 中的 task-driven candidate bot，对每个调用 `decideResponse` 判定，返回第一个 'respond' 的 assignmentId。
2. sync-manager 新增 `resolveDirectTargetAssignmentId(event)` — 主进程有 Matrix client + DB 直连，从 `agentRunners` 收集 room 中的 candidate（按 botUserId 匹配 room 成员），查 workspace 补齐 isCoordinator / hasCoordinator / isDirectChat，调用 `resolveMessageTarget`。
3. event handler 对 `m.room.message` 调用此函数，将结果作为第 4 参数传给 `routeMatrixEvent`。dispatch / task_reply 不需预解析（由 event content 自解析）。
4. AgentRunner 新增 3 个 getter（`assignmentId` / `botUserId` / `workspaceId`）供 sync-manager 构建 candidate 列表。

**新增测试**：
- `message-target-resolver.test.ts` — 12 个用例覆盖场景 1.1（@响应 / PM 自动接待）、1.2（不响应）、1.3（单聊自动响应）+ m.mentions 边界。
- `task-driven-dispatch-chain.test.ts` — 5 个用例验证 Matrix event → RouterService → AgentRunner.executeTask 完整链路（同时验证 C1 guard：directTarget=null 时不派发）。

### I1 ✅ 已修复：providerBuckets 从 model_providers 填充

**修复**：`runtime-registry.ts` 新增 `populateProviderBuckets()` — 查 `model_providers` 表，为 max_rpm 或 max_tpm 非空的 provider 创建 `ProviderTokenBucket`（幂等：已存在的不覆盖）。`index.ts initTaskDrivenRuntime` 在创建 TaskDispatcher 前调用。

**新增测试**：`runtime-registry.test.ts` 加 3 个用例（有 limit 的创建桶 / 无 limit 的跳过 / 幂等不覆盖）。

### I2 ✅ 已修复：task_reply 添加 reply_to 精确路由

**修复**：
- `dispatch.ts`：`TaskReplyContent` 加 `reply_to?: string`；`buildTaskReply` 加 `replyTo` 参数；`parseTaskReply` 提取 `reply_to`。
- `router-service.ts`：`routeTaskReply` 新增 3 级路由优先级：① `reply_to` → `findAssignmentByBotUserId` 精确反查 → ② `assignmentId` 参数 → ③ 广播（向后兼容旧 event）。
- `runtime-entry.ts`：`handleDispatch` 中 3 处 `buildTaskReply`（in_progress / completed / failed）均传入 `replyTo: dispatch.dispatch_from`（PM 的 botUserId）。

**新增测试**：`router-service.test.ts` 加 2 个用例（reply_to 精确路由不广播 / 无 reply_to 广播兼容）。

### I3 ✅ 已修复：process.exit 与 IPC flush 竞态

**修复**：`runtime-entry.ts` 新增 `sendTaskEndAndExit(msg, exitCode)` helper：
- `process.send(msg, callback)` — callback 在 IPC flush 后触发，内含 `process.exit`。
- 2 秒兜底 `setTimeout` 防 callback 永不触发（IPC channel 已断等极端情况）。
- `process.send` 不存在（非 fork 模式）时直接 exit。
- `runTaskChatLoop` 成功路径（exit 0）和 catch 路径（exit 1）均使用此 helper。

**测试适配**：`runtime-task-driven.test.ts` 的 `process.send` mock 更新为支持 callback 形式（同步触发 callback）。原有 9 个用例全绿。

### M3 ✅ 已修复：runtime-spawner.ts 尾部换行

补 `\n`。

### 验证结果

| 验证项 | 结果 |
|---|---|
| typecheck（electron + renderer） | ✅ 双 clean |
| electron 测试 | ✅ 851/851 passed（129 files） |
| renderer 测试 | ✅ 407/407 passed（50 files） |
| 新增测试 | +22 tests（resolver 12 + dispatch-chain 5 + providerBuckets 3 + router-service reply_to 2） |

### 结论

所有 final review findings（1 Critical + 4 Important + 1 Minor）均已修复并通过验证。本分支可合入 main。
