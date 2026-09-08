# Task 5 Report — 运行时接线（runtime-init 装配 + 写通道埋点 + 终态钩子）

**Status**: DONE
**Branch**: feat/task-execution-runtime
**Commit**: `e7a33a6` — `feat: 执行运行时接线——boot 装配 + task/settings 写通道埋点 + 终态续期钩子`

## 1. 实现概览

按 brief 五步严格执行 TDD。Task 4 交付的 `taskExecutor`（队列放行）与 Task 2 的 `spawnNextInstanceIfRecurring`（循环续期）在本任务完成全线接线：boot 装配（runtime-init）、task/settings 全部写通道埋点（notifyExecutor）、agent 终态转换钩子（续期 + 释放槽位）。

**逐文件变更**：

| 文件 | 变更 |
|---|---|
| `electron/src/main/task/runtime-init.ts` | 按 brief verbatim 重写：`InitTaskRuntimeOpts` 增 `kickoff?` / `getGlobalMax?`；`initTaskRuntime` 同时装配 TaskScheduler（scanPickup 从 no-op 改为 `taskExecutor.notify(); return true`）+ TaskExecutor（kickoff 缺省包装 `sendUserMessage`，依赖注入点在本文件——唯一允许同时 import executor 与 session-service 的 wiring 层）；boot 时 `taskExecutor.notify()` 立即评估 assigned 池。导出名 `initTaskRuntime` / `stopTaskRuntime` 与幂等语义保持 |
| `electron/src/main/task/ipc.handlers.ts` | import `notifyExecutor`；4 处 `void broadcastLocalTaskSnapshot();` 后各加一行 `notifyExecutor();`（create L80 / transition L119 / cancel L127 / start L139）；头注释补 Task 5 埋点说明 |
| `electron/src/main/settings/ipc.handlers.ts` | import `notifyExecutor`（`../task/executor`）；`settings:updateGlobal` 中 `updateGlobalSettings(patch)` 后加 `hasOwnProperty(patch, 'maxConcurrentTasks')` 门控的 `notifyExecutor()` |
| `electron/src/main/agent/agent-runner.ts` | import recurrence + executor；`transitionTaskTerminal`（即 brief 所指 finalize 链的 transition try 块，L309-314）在 `transitionTaskStatus` 成功后加 `if (to === 'completed') spawnNextInstanceIfRecurring(taskId); notifyExecutor();`；`failTaskOnCrash`（L377）在 transition 后 try 内加 `notifyExecutor()` |
| `electron/src/main/agent/tools/task-tools.ts` | import 同上；`completeTask` 加 `spawnNextInstanceIfRecurring(taskId); notifyExecutor();`；`failTask` 加 `notifyExecutor()` |
| `electron/tests/task/runtime-init.test.ts` | 重写（见 §2） |

## 2. TDD 证据

**Step 1 — 测试先行**：既有 runtime-init.test.ts 是模块级 mock `storage/db` 的骨架测试（无 DB seed）。按 brief 指引「若无 DB seed 则按 Task 4 测试的 beforeEach 模式补」，整体切换为 executor.test.ts 的真实 DB 模式（tmpdir + `AP_USER_DATA_DIR` + `runMigrations` + ws1 seed），保留全部 4 个既有用例原语义。新增 brief 用例「initTaskRuntime 后 executor 在位：assigned 任务在 boot 即被放行」，两处必要适配：

- **seed DDL 修正**（task 指示明确要求）：brief 片段的 `created_at/updated_at` / `added_at` 列不存在——按现行 DDL 补 NOT NULL 列（`agent_definitions` 要 version/system_prompt/model_name；`workspace_agent_members` 要 agent_user_id），与 executor.test.ts 的 `seedAgentMember` 同款
- **kickoff 注入函数加 `async`**：brief 片段 `(input) => { kickoffs.push(input); }` 返回 void，不满足 `ExecutorDeps['sendKickoff']: (...) => Promise<void>` 的 strict 类型；`async (input) => {...}` 语义等价且 typecheck clean
- 新用例开头 `vi.useRealTimers()`：describe 的 beforeEach 开了 fake timers，而 `vi.waitFor` 轮询与 executor 100ms notify 去抖需要真实时钟

**mock 收窄**（momo-test-rules）：只 mock 进程/网络边界——`vi.mock('electron')`（import 图经 executor → starter → agent 域触达 stream-relay 的运行时 electron import，形状沿用 stream-relay.test.ts 惯例）+ `vi.mock('../../src/main/p2p')`（session-service → p2p 网络栈，沿用 session-service.test.ts 惯例）。scheduler 走的 `p2p/task-broadcast` 叶子模块不受影响。

**Step 2 — RED**：
```
❯ tests/task/runtime-init.test.ts (5 tests | 1 failed)
   → expected 'assigned' to be 'in_progress'
   ❯ await vi.waitFor(() => expect(getTask('T-001')!.status).toBe('in_progress'))
Tests  1 failed | 4 passed (5)
```
失败原因正确：`initTaskRuntime` 尚无 kickoff 入参、executor 未装配——boot 无放行。既有 4 用例在新 DB 模式下仍绿（重构未破坏）。

**Step 3 — 实现后 GREEN**：
```
✓ tests/task/runtime-init.test.ts (5 tests) 290ms
stdout: executor 已放行任务 { taskId: 'T-001', executionSessionId: '631d907a-...' }
```
日志证明放行走了真实 executor → startTask → 注入 kickoff 全链。

## 3. 验证结果

| 验证 | 命令 | 结果 |
|---|---|---|
| 目标测试 | `cd electron && npx pnpm@9.0.0 vitest run tests/task/runtime-init.test.ts` | 5/5 passed |
| task 域全套 | `npx pnpm@9.0.0 vitest run tests/task/` | 12 files / 65 tests 全绿 |
| electron 全量回归 | `npx pnpm@9.0.0 vitest run` | **178 files / 1487 tests 全绿零 flake**（含 agent-runner / task-tools / session 敏感链路） |
| 双 workspace typecheck | `npx pnpm@9.0.0 typecheck`（根） | electron + renderer 双 clean |
| ESLint | `npx eslint <6 个变更文件>` | exit 0 |

## 4. 自审（brief 指定三项）

1. **import 环红线**：`grep session-service electron/src/main/task/executor.ts` 仅命中头注释（说明避环设计），无实际 import——executor 的 kickoff 依赖只在 runtime-init.ts（wiring 层）注入 ✅
2. **notify 恰好在指定位置**：全仓 `notifyExecutor()` 调用点共 9 处——task/ipc.handlers 4（create/transition/cancel/start）+ settings 1（maxConcurrentTasks 门控）+ agent-runner 2（transitionTaskTerminal try 内 / failTaskOnCrash try 内）+ task-tools 2（completeTask / failTask）✅
3. **spawn 仅 completed**：agent-runner 有 `if (to === 'completed')` 外门 + recurrence 内部 status==='completed' 守卫双保险；task-tools 只在 completeTask 调用 ✅

**已知环（非新增风险，说明留档）**：agent-runner → task/executor → starter → agent/team → crud → runtime-registry → agent-runner 是 CJS require 环。全链均为调用时取值（无模块顶层执行），且既有代码已存在同构环（agent-runner → memory/extraction → crud → runtime-registry → agent-runner）——1487 测试全绿为实证。方向性符合计划约束：task 域（activation，Task 6）→ executor 单向。

## 5. 遗留 / 风险

- 无阻塞遗留。macOS 主机冒烟（真实 GUI 里 boot 后 assigned 任务自动放行 + kickoff 消息出现在执行会话）属计划统一验收项，不在本 task 范围
- `main/index.ts` 的 `initTaskRuntime()` 调用无需改动——新签名 opts 全可选，默认即生产装配（sendUserMessage 包装），已由 typecheck + 现有调用证明兼容
