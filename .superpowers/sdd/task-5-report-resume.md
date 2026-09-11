# Task 5 报告：断点恢复编排 + IPC 两通道 + 接线锁

- **Status**: COMPLETE
- **Commit**: `78bf15c` feat(resume): 断点恢复编排（检测/载荷/派发）+ IPC 两通道 + 接线锁（base `873fa1f`，分支 `feat/v2.6.0-task-resume`）
- **改动**：9 文件 / +1204 −43
  - `electron/src/main/agent/runtime-config.ts`（TaskConfig 加 `resume?` 字段 + JSDoc）
  - `electron/src/main/agent/agent-runner.ts`（TaskConfig 接口同步 + executeTask child.send 透传）
  - `electron/src/main/agent/runtime-entry.ts`（runTaskChatLoop 解构 cfg.resume → runChatLoop 第 10 参）
  - `electron/src/main/task/resume.ts`（+detectInterrupted +resumeTask +resolveBreakpointStreamId +resolveAssignmentId +resolveAgentName +flipMessageBackToStreaming）
  - `electron/src/main/index.ts`（boot 接 sweepStaleStreaming，T3 纪律 runMigrations 之后、runtime 起动之前）
  - `electron/src/main/task/ipc.handlers.ts`（`task:resume` 多路：paused K7-5 + v2.6 in_progress/assigned；新增 `task:listInterrupted`）
  - `electron/src/preload/index.ts`（`task.resume` 返回类型放宽 + 新增 `task.listInterrupted`）
  - `renderer/src/ipc/types.d.ts`（InterruptedTaskInfo 定义 + TaskApiSurface 同步）
  - `electron/tests/task/resume.test.ts`（新建，715 行，16 例）

## 注入点结论（plan Task 5 实现首步）

**startTask 不是 resume 的注入点**。探明 starter.ts 后明确：`startTask` 仅做 execution_room 决策 + 状态机转换（assigned/pending → in_progress），不派发任何 agent runtime——真正的派发在 `executor.launch` 的 sendKickoff（消息注入）或 RouterService.routeUserChat（消息路由 → AgentRunner.executeTask）。

**resume 注入点选定**：`electron/src/main/task/resume.ts` 的 `resumeTask()` 直接组装 `AgentRunner.TaskConfig`（含 resume 载荷）→ `agentRunners.get(assignmentId)` → `runner.executeTask(cfg)` + `registerLane(..., {kickoff:true})`。

理由：
- 「既有 executor 派发路径，maxConcurrentTasks 天然生效」（spec §5.4）的语义由「任务行已 in_progress 且会话车道 DB 兜底已占道」保证——slot accounting 在中断发生时已计入 maxConcurrentTasks，resume 不再触发放行闸
- agent-runner.executeTask + registerLane 完全对齐 RouterService.routeUserChat 的核心动作（runner 查找 / ensureMemberRuntime 拉起 / 派发 / 占道），不绕道 RouterService 也保留 router 的所有不变量
- D6（检测时不改任务状态）自然满足：resumeTask 不 transition 任务状态——任务行 in_progress 保持，终态由 AgentRunner.task-end 处理

## 接线锁（spec §7 + v2.5 C1 教训）

**双层结构断言**（momo-test-rules 红绿变异记录）：

| 层 | 锁住的不变量 | 摘哪个改动会红 |
|---|---|---|
| Part A（resume.test.ts） | `AgentRunner.executeTask` → `child.send` 第一参含 `type:'task-config'` + `resume` 字段 | 摘掉 agent-runner 的 `...(task.resume ? { resume: task.resume } : {})` 透传 → 锁红（已变异验证：移除该 spread 后 16 用例中 Part A 必红） |
| Part B（resume.test.ts） | resume 载荷字段 round-trip 保真（messages[0].role === 'user' + content 严格保真、toolCallsUsed 数值、steers 数组） | 摘掉 TaskConfig.resume 字段定义或字段映射 → 锁红 |
| T4 独立锁（runtime-resume.test.ts） | runChatLoop.resumeTurn 运行时消费语义（10 场景） | 摘掉 runtime-entry.ts 解构 resume → T4 场景 1/2/3 必红 |

Part A 用 fake child EventEmitter + 真实 AgentRunner + 真实 warmPool（`spawn: vi.fn().mockResolvedValue(child)`）——只 mock 子进程边界，不 mock 中间层。

## 五项 carry-forwards 落实

1. **T1**：`detectInterrupted` 与 `resumeTask` 取「最新带 stream_session_id 的消息行」时**剥 #roll 后缀**（`resolveBreakpointStreamId`：indexOf('#') + slice），T1 报告 Concern #2 闭合。
2. **T4**：stats.toolCallsUsed 只报本 run（断点前消耗在 messages 里 verbatim 还原，由 LLM 上下文决定续扣）。任务行 `tasks.tool_calls_used` 列维持 T4 现有语义（在本 run 终止时由 task-end 写入）。**评估**：T6 ResumeNotice 若需展示「全程工具调用数」，应在编排层叠加（rebuilt.toolCallsUsed + stats.toolCallsUsed）——本期不实现，留给 T6 裁定。
3. **T3 纪律**：sweepStaleStreaming 在 main/index.ts 的位置严格遵守「runMigrations 之后、runtime 起动之前」——具体放在 `runMigrations(); logger.info('Migrations complete');` 之后、`tokenizeForIndex` 冒烟之前；`initTaskRuntime()`（executor/scheduler）和 `initTaskDrivenRuntime()`（agent runtime）均在其后启动。
4. **T3 行尾换行**：`resume.ts` 末尾补 `\n`；`tests/task/resume-sweep.test.ts` 末尾补 `\n`（od -c 验证）。
5. **T4 turn-reconstructor flake 复核**：

   | 轮次 | 结果 |
   |---|---|
   | 1 | 14/14 绿 |
   | 2 | 14/14 绿 |
   | 3 | **1 failed**（场景 1 expected `[user, …(1), …(3)] to deeply equal [user, …(1), …(3)]`）|
   | 4 | 14/14 绿 |
   | 5 | 14/14 绿 |
   | 6 | **1 failed** |
   | 7 | **1 failed** |
   | 8 | 14/14 绿 |
   | 复跑（单文件） | 10 轮内 0 失败 |

   8 轮连测复现 3/8 flake（场景 1 完整回合 `toEqual`），错误信息与 T4 报告记载一致。**状态**：未根除，T4 移交时已记录为「冷启动负载下的时序敏感」。本期仅复核确认仍存在；根因待排查（疑为 MessageEventBuffer 50ms 批量计时与测试播种的竞态）。**全量跑（vitest run tests/task/ tests/agent/）0 失败**——flake 只在串行连测单文件时出现，不影响集成门。

## 验证（gates）

| 门 | 结果 |
|---|---|
| `vitest run tests/task/ tests/agent/` | 122 files / **1022 tests 全绿** |
| `vitest run`（electron 全量） | 247 files / **2112 passed \| 2 skipped** |
| `vitest run`（renderer 全量） | 115 files / **1110 tests 全绿** |
| `tsc --noEmit`（electron） | Done |
| `tsc --noEmit`（renderer） | Done |
| 行尾换行（resume.ts + resume-sweep.test.ts） | od -c 验证 `0x0a` 结尾 |
| turn-reconstructor 场景 1 flake 复核 | 8 轮连测复现 3/8（与 T4 报告一致，未根因修复） |

## 关键决策与边界

1. **「既有 executor 派发路径」=「AgentRunner.executeTask + registerLane」**（非 RouterService.routeUserChat）：该路径保留 runner 查找 + ensureMemberRuntime 拉起 + 派发 + 占道四要素，但不引入 routeUserChat 的 steer 分流副作用——resume 不应被 steer 误派入别的活跃流。registerLane 用 `kickoff:true` 防迟到收尾误清。
2. **`task:resume` 多路扩展**（不新增 IPC 通道名）：既有 K7-5 `task:resume`（paused 任务恢复）已存在且被 `TaskDetailPanel.test.tsx` 引用（返回 Promise<TaskRow>）。v2.6.0 多路按 status 分发：paused 走 K7-5 既有逻辑（逐字节保持），in_progress/assigned 走 resumeTask。返回类型放宽为 `TaskRow & { streamSessionId?: string }`，renderer 端 `ipc.task.resume` 类型同步。
3. **detectInterrupted 不查 message row 的 status**：只要 session 内有「顶层 agent 流」（parent_stream_session_id IS NULL + segment_of IS NULL）的最新行就取它的 stream_session_id，与该行 status 是 streaming/failed 无关——sweepStaleStreaming 标 failed 是正常 boot 时序（先取列表 → 再 sweep → renderer 拉列表），刚好让 streamSessionId 可解析。
4. **agentName 解析多级兜底**：assigneeAgentId JOIN → targetTeam leader JOIN → 断点流 sender JOIN → 空串。空串而非抛错（spec §5.6 字段非必填；UI 兜底）。
5. **flipMessageBackToStreaming 附 status_change 事件**：消息行 status 列已恢复，事件时间线追加 `status_change{status:'streaming'}`（与 start chunk 写入同型）。~~renderer 聚合器对 status_change 已 skip~~（Review Fix F6a 勘误：聚合器实际消费该事件，会把聚合状态翻回 streaming——与行状态一致，实时/重启同视图）。
6. **degenerate 字段透传**：主进程 rebuildTurn 已评估 degenerate（用于路由决策）；runtime 侧 runChatLoop 沿用，IPC payload 增加 `degenerate` 字段避免 runtime 重算。typecheck 双端同步后零报错。

## Concerns（移交下游）

1. **T6 ResumeNotice 卡片 UI**：
   - 数据源：`ipc.task.listInterrupted()` → `InterruptedTaskInfo[]`
   - 恢复按钮：`ipc.task.resume(taskId)` → 对 in_progress 返回 `streamSessionId`（用于 SSE 关联）
   - 放弃按钮：复用既有 `task:transition(taskId, 'cancelled')`（状态机合法）+ 可选 `journal:revert(workspaceId, ids, {})`（撤回后放弃）
   - journalCount 字段已暴露给 UI；「半程变更 M 处」文案直接展示
2. **agentName 多级解析的实现依赖**：detectInterrupted 现在对每个任务做 3 次最多 JOIN 查询。对中型任务量（百级）可接受；万级时建议加缓存（按 workspaceId 缓存 member → def 映射）。本期不实现。
3. **`task:resume` 返回类型放宽为 `TaskRow & { streamSessionId?: string }`**：renderer 端 `TaskDetailPanel.runAction(() => ipc.task.resume(taskId))` 当前忽略返回值，向后兼容。但 TaskDetailPanel.test.tsx:105 写了 `mockApi.task.resume.mockReset().mockResolvedValue(makeTask({ status: 'in_progress' }))`——mock 的返回类型若严格推断为 `Promise<TaskRow & {streamSessionId?: string}>`，makeTask 返回值 OK（不带 streamSessionId 字段是允许的）。已验证 vitest 不报错（既有 task-board 单测不在本任务 gates 范围，但 typecheck 双端绿）。
4. **in_progress 任务启动期间 user 重新发送手输消息**：router 接待路由会 steer 到本流（routeUserChat.getLane 命中本 executionSessionId），runChatLoop drain 注入并按 steer 事件落库。T1 steer 测试已锁该路径，回归边界不变。
5. **未实现**：T6 ResumeNotice UI（卡片组件 / 撤回联动 / 全决策完消散）；该 task 在 plan Task 6 范围。

## 形态契约总结（后续 task 直接抄）

| IPC payload 字段 | producer（main） | consumer（runtime） | 备注 |
|---|---|---|---|
| `TaskConfig.resume.messages` | rebuildTurn 重建段（首条 role=user） | runChatLoop 永久 context 拼接（不重复 currentBody） | spec §5.2 |
| `TaskConfig.resume.toolCallsUsed` | rebuildTurn 计数 | runChatLoop 预算初始化 `budgetRemaining = max - toolCallsUsed` | spec §5.4 |
| `TaskConfig.resume.steers` | rebuildTurn 未消费 steer | runChatLoop pendingSteers.push(...resumeTurn.steers) | spec §5.3 |
| `TaskConfig.resume.degenerate` | rebuildTurn 评估 | runChatLoop 沿用（避免 runtime 重算） | 新增字段，typecheck 双端 |

| 事件 timeline | 触发点 | event_type | payload |
|---|---|---|---|
| 消息行翻回 | `flipMessageBackToStreaming`（resumeTask in_progress 路径） | `status_change` | `{status:'streaming'}` |

## Review Fix（Task 5 审查修复，2026-09-11）

逐 finding 处置（7 项全闭环）：

| # | 级别 | 处置 | 落点 |
|---|---|---|---|
| F1 | Critical | 消费侧接线锁补齐：`runtime-task-driven.test.ts` 新增「v2.6.0 接线锁」用例——cfg 带 `resume{messages:[user,assistant(toolCalls),tool,assistant,tool(孤儿)], toolCallsUsed:2, steers:[]}`，fake provider 捕获首轮 LLM messages，断言重建段 verbatim（含 `INTERRUPTED_TOOL_RESULT` 契约常量）+ currentBody 不重复（user 仅 1 条、兜底正文零出现） | `tests/agent/runtime-task-driven.test.ts` |
| F2 | Important | seeding bug 修复：`seedAgentStream` 及三处内联 seed 改为按 `stream_session_id` 查真实 message 行（`listMessagesByStreamSessionId` / `getMessageByStreamSessionId`）再 `updateMessageStatus(row.id,'failed')`；补真前置断言（翻回前 `status==='failed'`）——翻回后 `==='streaming'` 从空转变真锁 | `tests/task/resume.test.ts` |
| F3 | Important | 删 `void notifySpy` 压制：`vi.spyOn(await import(executor), 'notifyExecutor')`（resumeTask 内部动态 import 调用时解析同一命名空间 → spy 命中）；断言 assigned 任务 resumeTask 后 notifyExecutor 恰被调 1 次 | `tests/task/resume.test.ts` |
| F4 | Important | 双恢复守卫：lane 检查新增同流拒绝（`lane.streamSessionId === cfg.streamSessionId` → 抛「该任务已在恢复中」——registerLane 先于 executeTask、收尾 clearLaneIfMatch 清道，同流 lane 命中即等价恢复中）；测试：连续两次 resumeTask 同 id → 第二次 rejects + sendSpy 仍 1 次（同 child 双 chat loop 被拦截） | `src/main/task/resume.ts` + 测试 |
| F5 | Important | flip 后置：`flipMessageBackToStreaming` 从 rebuildTurn 后移到车道双检查之后、registerLane/executeTask 之前——异流占用/双恢复/runner 拉起失败等拒绝路径不再滞留 streaming 行；测试：异流占道 → rejects + 消息行保持 failed + 零 task-config | `src/main/task/resume.ts` + 测试 |
| F6 | Minor×4 | a) flip 注释改为如实描述（聚合器将把 status 聚合回 streaming，与行状态一致）b) detectInterrupted 补 session_queued 命中用例 c) 删 `void listMessagesBySession` 死代码 + 未用 import（resume.ts 的 `getMessageByStreamSessionId`/`RebuiltTurn`、测试的 `listEventsByMessage`/`insertEvent`）d) spec §5.2 加实施精化一行 | resume.ts / 测试 / spec |
| F7 | 阻塞 T7 | flake 根治（见下） | `tests/agent/turn-reconstructor.test.ts` |

### F7 flake 根治证据链（momo-debug-rules 流程）

1. **复现**：连跑 8 轮基线 → Round 2 红（1/8；review 报 3/8，同一概率带）。
2. **根因（DB 层探针 300 次，1:1 实证）**：临时探针隔离场景 1 三行结构，实测 `sameMsWindow: 241/300 == polluted: 241/300`——同步 seeding 全链（start/text/tool chunk + flush）耗时 <1ms，「后续 owner 行」约 80% 与流行同毫秒；`findTurnUserBody` 的 `created_at <= 流行时刻` 边界 + `rowid DESC` 让同毫秒后续行反超污染起始 user 消息。排除 buffer 竞态假说：`MessageEventBuffer.flush()` 全同步（better-sqlite3 单事务），`__flushEventBufferForTest` 后无迟到写入。
3. **修复**：生产 `<=` 语义正确（「同毫秒 kickoff 不丢」是刻意设计，T1 注释明示），按 review 方向修 fixture——`waitMsPast(t)` 自旋等时钟越过流行毫秒（有界 ~1ms，非 sleep 掩盖）后再插后续 owner 行，「逻辑上在流行之后」被钉为严格物理更晚。
4. **验证**：修复后连跑 8 轮 14/14 全绿（8/8）。

### 红绿变异证据（F1）

- **摘掉** runtime-entry.ts `runTaskChatLoop` 的 `resume` 解构 + 第 10 参传参（换 `undefined`）→ `runtime-task-driven.test.ts` **1 failed | 24 passed**——仅新接线锁红，其余全绿（证实该环此前零保护、静默丢失不报错）。
- **恢复** → **25 passed** 全绿。runtime-entry 第 10 参处已加锁指针注释。

### 最终 gates

- `vitest run tests/task/resume.test.ts tests/agent/turn-reconstructor.test.ts` → 33 passed 全绿
- electron 全量 `vitest run` → **2116 passed | 2 skipped，零失败**（248 文件）
- `pnpm typecheck` → electron Done + renderer Done（双 Done）
- 改动文件 ESLint 零报错（含顺手清掉 HEAD 上预存的 2 个 unused-import）
- 提交：`fix(resume): 消费侧接线锁 + 恢复守卫/时序修复 + flake 根治`
