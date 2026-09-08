# Task 3 实施报告：车道接线 + executor 放行 gate

**日期**：2026-09-08
**状态**：✅ 已完成
**依赖**：T1 (`4fd891b` session_queued 状态机) + T2 (`721d6b4` session-lane 模块) 已交付
**commit hash**：`a413436`

---

## 1. 交付摘要

按 brief 6 步 TDD 流程落地 v2.3 spec §4.3 + §4.4：executor 启动时检查会话车道 gate
（占道→`session_queued` 排队，不占全局槽），空闲时按序放行；并打通 kickoff taskId
五层透传链（ExecutorDeps.sendKickoff → runtime-init 包装 → sendUserMessage →
router.routeUserChat → registerLane）。

| 步骤 | 行为 | 验证 |
|---|---|---|
| Step 1+2 | 写失败测试（红） | 2/3 FAIL（v29 修复后），预期 B 转 in_progress、session_queued 候选不被 peekNextAssigned 选中 |
| Step 3 | `starter.ts` 起点白名单扩 `session_queued` | — |
| Step 4 | `executor.ts` 4 处编辑：interface / import / launch gate / sendKickoff taskId / peekNextAssigned 扩状态 | 3/3 PASS |
| Step 5 | `runtime-init` + `session-service` + `router-service` 透传与注册 | — |
| Step 6 | `agent-runner.ts` 4 处收尾清车道 | — |
| Step 7 | 跨 18 文件 139 tests 全绿 | 0 regression |
| Step 8 | typecheck 双 clean | electron + renderer done |

---

## 2. commit 信息

- **Hash**：`a413436`
- **Subject**：`feat: executor 会话车道放行 gate 与 kickoff taskId 透传链`
- **Files**（6 改 1 增）：
  - `electron/src/main/task/starter.ts`（+11/-5）起点白名单扩 `session_queued`
  - `electron/src/main/task/executor.ts`（+26/-9）ExecutorDeps.sendKickoff 入参加 taskId / 车道 gate / peekNextAssigned 扩状态
  - `electron/src/main/task/runtime-init.ts`（+1/-0）sendKickoff 包装透传 sourceTaskId
  - `electron/src/main/im/session-service.ts`（+20/-4）SessionRouter + sendUserMessage 入参扩 `sourceTaskId`，路由调用透传
  - `electron/src/main/agent/router-service.ts`（+14/-0）RouteUserChatInput 扩两字段 + 末尾 `registerLane`
  - `electron/src/main/agent/agent-runner.ts`（+10/-0）四处收尾清车道 + 必要处 `notifyExecutor`
  - `electron/tests/task/executor-lane.test.ts`（+88 新建）3 用例覆盖车道 gate 双态行为

---

## 3. 测试结果

### 3.1 新增测试（executor-lane.test.ts）

| 用例 | 结果 |
|---|---|
| 同会话双任务：第一个 in_progress，第二个转 session_queued 且不占全局槽 | ✅ PASS |
| 车道空闲（in_progress 行已终态化）后放行 session_queued 队首 | ✅ PASS |
| 无目标会话任务（startTask 新建会话路径）不受车道影响 | ✅ PASS |

### 3.2 回归测试

`vitest run tests/task tests/agent/router-service.test.ts tests/agent/agent-runner.test.ts` — **18 文件 / 139 tests / 0 fail**。
关键回归锁：
- `executor.test.ts` 8 用例（含 startTask 抛错不死循环）全绿
- `router-service.test.ts` 全套（routeUserChat / routeEvent / routeDispatch / routeAbortDispatch）无回归
- `agent-runner.test.ts`（C1/C3 task-driven 生命周期 + C2 child exit 清理链）全绿
- `session-lane.test.ts` 注册/清除/占道/精确中止全绿

### 3.3 typecheck

`pnpm -r typecheck` — **electron + renderer 双 clean**。

---

## 4. brief 偏离与判定

### 4.1 必要偏离：test 1 + test 2 的 `assigneeAgentId` 字段删除

**brief 原文**（Step 1 的 test 1 + test 2）：

```typescript
insertTask({ workspaceId: 'ws1', title: 'A', creatorUserId: 'o', assigneeAgentId: 'inst1', targetSessionId: session.id, status: 'assigned', priority: 10 });
insertTask({ workspaceId: 'ws1', title: 'B', creatorUserId: 'o', assigneeAgentId: 'inst1', targetSessionId: session.id, status: 'assigned', priority: 5 });
```

**问题**：migration v29（`electron/src/main/storage/migrations/index.ts:831-847`）的 `trg_tasks_target_exclusive_insert` / `trg_tasks_target_exclusive_update` 触发器强制「委派目标三列（agent/team/session）最多一个非空」。同时设 `assigneeAgentId` 与 `targetSessionId` 直接抛 `SQLITE_CONSTRAINT_TRIGGER` 错。

**修复**：删除两个 insertTask 的 `assigneeAgentId` 字段。会话已通过 `addSessionMember(session.id, 'inst1', true)` 注册 leader 实例，kickoff 路由目标由会话成员表提供（`session-service.ts` 的 `resolveTarget` 走 `pickRoutingTarget` → leader 接待）。删后测试断言不受影响（brief 断言只校验 `status` 与 `kickoff.mock.calls[0][0].taskId`，不校验 `mentionedInstanceIds`）。

**判定理由**：
- brief 的「编辑以 brief 内文为准逐字采用」与 brief test 实际触发的 v29 约束冲突；
- 不修则 red step 跑不出「B 转 in_progress」的预期失败模式，只看到 SQL 触发器报错，**TDD 红/绿循环失真**；
- 删除 `assigneeAgentId` 是测试意图最小保真修复（v29 schema 是当前代码库事实，brief 写于其前），且 test 1 / test 2 的 `addSessionMember(... isLeader=true)` 已确保 kickoff 有可路由目标；
- 已加 2 行注释（v29 trigger 解释），未来读者 review diff vs brief 时不会困惑。

### 4.2 严格遵循：未做 brief 之外的事

- 未给 `session-lane.ts` 加新方法（仅消费六个 export）
- 未实现 steer 分流（Task 4 范围）
- 未顺手改其他模块的命名/格式
- commit 严格按 brief Step 9 的 `git add` 清单（7 文件）

---

## 5. 关键接线点

### 5.1 taskId 透传链（spec §4.4）

```
ExecutorDeps.sendKickoff.taskId        (executor.ts:32)
  ↓
runtime-init sendKickoff 包装          (runtime-init.ts:36-43)
  → sourceTaskId: input.taskId
  ↓
sendUserMessage.sourceTaskId           (session-service.ts:113-127)
  ↓
SessionRouter.routeUserChat.sourceTaskId  (session-service.ts:30-39)
  ↓
RouteUserChatInput.sourceTaskId        (router-service.ts:50-63)
  ↓
registerLane(sourceTaskId ?? null)     (router-service.ts:113-122)
```

### 5.2 executor 放行顺序（spec §4.3）

```
admitOnce 循环
  └─ launch(candidate)
       ├─ validateTarget            → 失败 failQuietly
       ├─ 车道 gate（NEW）           → 占用 transitionTaskStatus→session_queued, return false
       ├─ startTask                 → 接受 assigned / pending / session_queued 起点
       └─ sendKickoff({taskId})     → 携带 taskId 走五层透传
```

### 5.3 流收尾清车道（spec §4.5）

四处统一按 `clearLaneIfMatch(executionSessionId, streamSessionId)`（streamSessionId 匹配防迟到收尾误清）：

| 位置 | 触发点 | notifyExecutor |
|---|---|---|
| ephemeral end | 顶层 ephemeral 流 end 即回收 | ✅ |
| finalizeActiveTask | task-end / safety-timer 收尾 | ✅ |
| handleChildExit | child 崩溃收尾 | ✅（for 循环外） |
| destroy | runner 销毁（无 notify） | — |

---

## 6. 已知边界（与 spec §7 一致）

- `kickoff` 极端竞态：手输流恰好先注册车道时，executor 放行的 kickoff 覆盖注册 + warn 退化为并行（spec §7 接受此窄窗口）。
- `peekNextAssigned` 排序与 assigned 同构（`priority DESC, COALESCE(scheduled_at, created_at) ASC, created_at ASC`）。
- `session_queued` 任务被用户取消：`session_queued → cancelled` 合法（state-machine 已含）。
- DB 兜底占道：`isLaneOccupied` 在内存空但 DB 有 in_progress 行时仍返回 true（spec §4.2）。
- abort 收尾（`transitionTaskTerminal` 内 notifyExecutor）保留——100ms 去抖合并，与本任务新增的 finalizeActiveTask 通知幂等。
- 本任务**未消费** `abortTaskStreamByLane`（T2 已交付），仅在 spec §6 K7-3 修复路径使用（属 Task 5 范围）。

---

## 7. 后续任务

- **Task 4 (steer 链路)**：依赖本任务的 `systemKickoff` + `sourceTaskId` 字段、registerLane 行为，routeUserChat 内按「systemKickoff → 无条件派发 / 用户手输 + 车道命中 → steer 注入 / 车道空闲 → 正常派发」分流。本任务已就位 Task 4 入口。
- **Task 5 (K7-3 修复)**：依赖 T2 的 `abortTaskStreamByLane` ——按 taskId 精确中止取代按 executionSessionId 广播。
- **Task 6 (验收门禁)**：typecheck/test 全绿、macOS 主机冒烟三项（同会话双任务、用户手输 steer、暂停 A 不杀 dispatch 子流）。

---

## 8. 回归修复补记（T3 双轮遗漏回归面）

**日期**：2026-09-08
**commit hash**：（本节追加后见 `git log` 确认）
**状态**：✅ 已修复（fix commit 单 commit，2 文件 +18/-0 + 报告追加）

### 8.1 现象

T3 在 `sendUserMessage` 调用 `router.routeUserChat` 处新增两字段（spec §4.4 车道透传链）：
`systemKickoff: input.systemKickoff === true`、`sourceTaskId: input.sourceTaskId ?? null`。
手输消息两字段默认 `false` / `null`。
两个既有测试文件里 5 处 `toHaveBeenCalledWith({...})` 严格全等断言因此破裂——断言只期望旧 3 字段（sessionId/assignmentId/body），received 多出 `+ "sourceTaskId": null` 与 `+ "systemKickoff": false`。

### 8.2 失败定位（已实证）

| # | 文件 | 行 | 用例 |
|---|---|---|---|
| 1 | `electron/tests/im/session-service.test.ts` | 252 | sendUserMessage 全链 > 完整链路（leader 接待） |
| 2 | `electron/tests/im/session-service.test.ts` | 275 | sendUserMessage 全链 > mention 命中（leader 不插嘴） |
| 3 | `electron/tests/agent/router-leader.test.ts` | 192 | 契约① > 多成员会话 leader 接待 |
| 4 | `electron/tests/agent/router-leader.test.ts` | 246 | 契约② > @ 指定非 leader 成员 |
| 5 | `electron/tests/agent/router-leader.test.ts` | 354 | 契约④ > 失效成员回退 leader |

第 5 处（契约④相关）的具体位置由实际失败运行定位，与 task 描述一致。

### 8.3 修复

判定生产行为正确（两字段为 spec §4.4 必要扩展，T3 已审查确认）——修复面在测试侧。
5 处 `toHaveBeenCalledWith({...})` 期望对象补上 `systemKickoff: false` 与 `sourceTaskId: null`（保持严格全等契约锁，不放宽为 `objectContaining`）。
每处补一行注释 `// v2.3 车道透传链（spec §4.4）：手输消息两字段取默认值`——回归锁文档化，防未来误删。

### 8.4 修复纪律

- **未改 `src/` 生产代码**：回归是测试断言过时，生产行为正确且经 T3 审查确认
- **未放宽断言语义**：保持 `toHaveBeenCalledWith` 严格全等（momo-test-rules 回归锁标准）
- **未改其他测试文件**：仅 `session-service.test.ts` + `router-leader.test.ts` 两个文件
- **sessionId 沿用 `s.id` 实值**（该测试既有写法，不引入 `expect.any(String)`）
- **字段顺序对齐生产**：期望对象按 `sessionId → assignmentId → body → systemKickoff → sourceTaskId`（与 `session-service.ts:206-212` 生产调用一致，便于 diff vs 调用点核对）

### 8.5 验证

`vitest run tests/im/session-service.test.ts tests/agent/router-leader.test.ts tests/agent/router-service.test.ts tests/agent/router-steer.test.ts` — **4 文件 / 53 tests / 全绿**。

- `session-service.test.ts` 19/19 ✅（含本次 2 处断言修复）
- `router-leader.test.ts` 14/14 ✅（含本次 3 处断言修复）
- `router-service.test.ts` ✅ 无连带回归（T3 已自测，本文件不在回归面）
- `router-steer.test.ts` ✅ 无连带回归（T4 自测，本文件不在回归面）

### 8.6 教训沉淀

- **跨契约扩展必查所有消费方测试断言**：T3 审查轮次虽覆盖了 `executor.test.ts` / `router-service.test.ts` / `agent-runner.test.ts` / `session-lane.test.ts` 等核心模块测试（4 文件 139 tests 全绿），但 `sendUserMessage` 的下游测试（`session-service.test.ts` + `router-leader.test.ts`）未在回归矩阵中——这两文件不在 T3 的修改清单内，但被 T3 间接影响的契约面（routeUserChat 入参扩展）落到了它们身上。
- **后续任务（Task 4/5/6）开工前应跑全量 electron 单测作为基线核对**：任何「契约面扩展」类提交都应在 merge 前至少 `cd electron && npx pnpm@9.0.0 vitest run` 一遍全量，而非仅回归清单。
- **回归锁补注释是必要纪律**：本次 5 处加注释「v2.3 车道透传链（spec §4.4）：手输消息两字段取默认值」，未来若有人 review 时看到这两个字段「看起来是噪声」想删，注释能让其溯源到 T3 透传链设计，避免回归复发。
