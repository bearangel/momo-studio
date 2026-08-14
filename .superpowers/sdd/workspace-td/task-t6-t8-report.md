# Task T6-T8 Report: IPC handler 切换 + auto-start 改造 + dispatch 路由

## Status: ✅ COMPLETE

## Commit
`feat(agent): IPC handler 切换 + auto-start 改造 + dispatch 路由`

## 测试摘要
- Electron: 825/825 passed (126 test files)
- Renderer: 407/407 passed (50 test files)
- Typecheck: 双 workspace clean

## 改动文件

### 新增
- `electron/src/main/agent/runtime-registry.ts` — task-driven runtime 全局注册中心
- `electron/tests/agent/runtime-registry.test.ts` — 8 个新测试

### 修改
- `electron/src/main/index.ts` — 从 runtime-registry 导入全局 maps + createTaskDrivenRuntime
- `electron/src/main/agent/ipc.handlers.ts` — 4 处 spawnAgent → startAgentRuntime
- `electron/src/main/workspace/ipc.handlers.ts` — 1 处 spawnAgent → startAgentRuntime
- `electron/src/main/agent/auto-start.ts` — task_driven=1 跳过（initTaskDrivenRuntime 接管），仅 v1 fallback
- `electron/src/main/agent/router-service.ts` — routeDispatch 从 dispatch_to 自解析 assignmentId
- `electron/src/main/agent/crud.ts` — saveAgentDefinition 写入 task_driven 列
- 3 个测试文件适配（mock 新增 runtime-registry / taskDriven=false）

## 关键设计决策

### 1. runtime-registry.ts 共享模块
全局 `agentRunners` / `agentWarmPools` / `providerBuckets` 从 main/index.ts 提取到独立模块。
`startAgentRuntime(opts, taskDriven)` 作为 IPC handler 的统一入口：
- taskDriven=true → ensureTaskDrivenRuntime（创建 WarmPool + AgentRunner + 注册 + warm）
- taskDriven=false → v1 spawnAgent

RouterService 构造时持有 `agentRunners` 的引用（by-reference Map），动态新增的 runner 自动可见。

### 2. auto-start v1 fallback
autoStartAgents 新增 `def.taskDriven !== false → continue` 守卫。
task_driven=1 的 agent 由 initTaskDrivenRuntime 接管；task_driven=0 的 agent 走 v1 spawn。
auth 登录流程调 autoStartAgents 时，task_driven=1 已在 agentRunners 中，不会被重复启动。

### 3. RouterService dispatch 自解析
routeDispatch 不再强制要求 directTargetAssignmentId。
缺失时从 `content.dispatch_to` 调 `findAssignmentByBotUserId(botUserId)` 反查 assignmentId。
通过 `RouterServiceOpts.findAssignmentByBotUserId` 可选注入实现测试隔离。

### 4. saveAgentDefinition 修复
之前 `saveAgentDefinition` 的 INSERT 未包含 `task_driven` 列，导致新保存的 agent 定义总是走 DB DEFAULT（=1 task-driven）。现已修正，使 `taskDriven: false` 的定义正确写入 `task_driven=0`。

## 顾虑

1. **routeTaskReply 仍用广播**：task_reply event 不含 PM 的 botUserId（只有 task_id），无法反查目标 runner。当前广播给所有 runner，各自按 activeTasks.taskId 匹配。O(n) 但 n 通常 < 10，可接受。未来可在 task_reply content 加 `reply_to` 字段优化。

2. **routeAbortDispatch 仍为 stub**：abort_dispatch event 的完整实现（按 task_id 反查 runner + abortStream）不在本 task 范围，保留 TODO。

3. **saveAgentDefinition 修复影响范围**：之前所有通过 IPC 创建的自定义 agent 都是 task_driven=1（DB DEFAULT），修复后会按 `def.taskDriven` 写入。现有 builtin YAML 的 taskDriven 字段需确认一致（builtin loader 默认 taskDriven=true）。
