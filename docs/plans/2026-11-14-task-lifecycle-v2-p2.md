# 任务生命周期 v2 · P2 跨节点（hub 1.11）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec §8/§14 P2——momo-hub 协议 1.11.0（`submitted` 账本态 + `task.intervene/answer/accept/reject/interventions` + `delegation_interventions` 表）、studio 双侧桥接（worker 上报干预/提交、发起方跟踪会话代答/验收/打回）、断线对账、P1 降级守卫移除。

**Architecture:** hub 侧复用 `handleAnswer`（delegations.ts:464-576）的「pending-Map 转发 + 超时注入 + res 对账」模板实现四个新 RPC；worker 侧把 lifecycle-runs 的人工请求/提交事件桥到 `task.intervene`/`task.report(submitted)`；发起方以**本地委派跟踪会话**为唯一交互面（镜像请求行 + 代答路由），验收经 `task.accept/reject` 下发；断线靠 `task.interventions` 拉取幂等收敛。

**Tech Stack:** 双仓——`/Users/stbearangel/dev/AiProject/momo-hub`（协议包根 + packages/hub，TypeScript + better-sqlite3 + ws + vitest forks 池）与 `/Users/stbearangel/dev/AiProject/moo-studio`（P1 既有栈）。

**Spec:** `docs/specs/2026-11-13-task-human-loop-lifecycle-design.md` §8（协议）、§7.3（跟踪会话）、§8.4（离线）、§8.6（授权）、§12（兼容）、§14 P2 行。**P1 plan:** `docs/plans/2026-11-13-task-lifecycle-v2-p1.md`。

## Global Constraints

- **双仓双分支**：hub 仓分支 `feat/protocol-1-11-interventions`、studio 仓分支 `feat/task-lifecycle-v2-p2`，均不直接写各自 main
- **协议纪律（hub 仓惯例）**：只增不改义；`src/version.ts:1-55` 版本注释块 bump 时补 1.11.0 条目；`METHOD_REQUIRED_MINOR` 新方法登记 =11；载荷能力门沿 `TEAM/PEER_DELEGATION_REQUIRED_MINOR`（src/delegation.ts:70/:78）先例——新常量 `TASK_HITL_REQUIRED_MINOR = 11`
- **hub 测试命令**：`cd /Users/stbearangel/dev/AiProject/momo-hub && npx pnpm@9.0.0 test`（级联 packages/hub vitest forks）；单文件 `cd packages/hub && npx pnpm@9.0.0 vitest run tests/<file>`；新测试只放 `packages/hub/tests/`
- **studio 约束沿用 P1**：Node 24 / strict TS / 中文注释 / Conventional Commits / electron 测试走 `cd electron && node scripts/test.mjs <path>` / 全量裸跑 `npx pnpm@9.0.0 test` / 版本号只在收尾任务 alpha+1
- **studio 协议 pin 纪律**：正式 pin `github:bearangel/momo-hub#v0.7.0` 只在 H9 打 tag 后由 S1 提交；S2-S9 开发期用本地覆盖（`npx pnpm@9.0.0 install --save file:../momo-hub` 后**不提交 package.json 此行变更**，S1 正式提交时改回 git pin；或临时改用 pnpm.overrides 后还原）——两种方式任选，收尾 diff 必须干净
- **hub 发版纪律**：H9 才 bump 根版本 0.6.1→0.7.0 + tag `v0.7.0` + 补 CHANGELOG（**0.6.0/0.6.1 漏账一并补**）
- **studio UI 预览门禁**：SP 任务产出静态预览并**停下等用户确认**（P2 无夜间授权预设；用户届时可再次授权跳过）
- spec 命名口径：协议里的 `taskId` 恒为 hub 委派 id（studio 侧 `tasks.delegation_id`）；镜像行答复用 `remote_id`

## Review Focus

1. **双端版本不对称**：1.11 studio ↔ 1.10 hub/worker → intervene/accept 被拒后**人话降级**（task 未挂死、面板给出「对端版本过低，任务按旧语义完成」）→ H8 用例 + S8 用例
2. **跨节点双答竞态**：worker 本地答 + 发起方代答几乎同时到 hub → first_wins；后到者 `stale` 且两侧终态收敛一致（interventions 行 answered_once）→ H5 用例
3. **断线窗口丢事件**：worker 离线期间 origin 已 accept/reject → 重连 `task.interventions` 对账幂等（不重复建 run、不重复里程碑、终态为准）→ H7 + S7 用例
4. **peer 组发起方越权代答**：hub 返回 forbidden 且 UI 无入口（双层防线）→ H5 + S9 用例
5. **旧 hub 收到 submitted 状态**：task.report 携带 `status:'submitted'` 打到 1.10 hub → 整包拒 + worker 降级报 done（旧行为），不留半套语义 → H7 用例 + S2 降级分支用例

---

# A 部分 · momo-hub 仓（分支 feat/protocol-1-11-interventions）

### Task H1: 协议 1.11.0 类型层与门槛登记

**Files:**
- Modify: `/Users/stbearangel/dev/AiProject/momo-hub/src/delegation.ts`（DelegationStatus :17-18、DelegationTask :21-50、TaskRecord :97-114、TASK_RPC :5-10、TaskAnswerReq/Res :120-128）
- Modify: `/Users/stbearangel/dev/AiProject/momo-hub/src/events.ts`（EVT :6-25 + 新载荷接口）
- Modify: `/Users/stbearangel/dev/AiProject/momo-hub/src/methods.ts`（METHOD_REQUIRED_MINOR 登记）
- Modify: `/Users/stbearangel/dev/AiProject/momo-hub/src/version.ts`（PROTOCOL_VERSION :56 + 头注释块补条目）
- Modify: `/Users/stbearangel/dev/AiProject/momo-hub/src/error.ts`（新错误码）
- Test: `packages/hub/tests/protocol-m2.test.ts`（版本线 :68-108 + 新类型键集锁）

**Interfaces:**
- Produces（studio S 侧全程消费）:

```ts
export type DelegationStatus = 'pending' | 'running' | 'waiting' | 'submitted' | 'done' | 'failed' | 'interrupted' | 'cancelled';
// DelegationTask += runNo?: number（1 起，缺省 1）
// TaskReportPayload.status += 'submitted'; += runNo?: number
// TaskRecord += runNo?: number; submittedAt?: number; acceptedAt?: number
export type InterventionKind = 'tool_gate' | 'question' | 'manual_action';
export type InterventionStatus = 'pending' | 'answered' | 'expired' | 'cancelled' | 'superseded';
export interface InterventionAnswer { decision?: 'approve' | 'deny'; text?: string; selected?: string[]; completed?: boolean; }
export interface InterventionRequest {
  interventionId: string; runNo: number; kind: InterventionKind;
  title: string; prompt: string;
  payload?: Record<string, unknown>; options?: Array<{ id: string; label: string; description?: string }>;
  deadlineAt?: number;
}
export interface InterventionRecord extends InterventionRequest {
  status: InterventionStatus; answer?: InterventionAnswer;
  answeredBy?: string; answeredAt?: number; createdAt: number;
}
// TASK_RPC += 'task.intervene' | 'task.accept' | 'task.reject' | 'task.interventions'
// EVT += 'task.intervention' | 'task.interventionAnswered' | 'task.submitted' | 'task.accepted' | 'task.rejected'
// TaskAnswerReq 扩展：interventionId?: string; answer?: InterventionAnswer（旧 decision approve/deny 保留兼容）
// TaskAnswerRes.disposition += 'answered'
// METHOD_REQUIRED_MINOR: 四新方法 = 11
// 常量 TASK_HITL_REQUIRED_MINOR = 11（载荷门，沿 :70/:78 先例）
// 新错误码：'not_submitted' | 'intervention_not_found' | 'intervention_stale' | 'forbidden_responder'
```

- [ ] **Step 1 失败测试**：protocol-m2.test.ts——`PROTOCOL_VERSION === '1.11.0'`、兼容线含 1.10.0、新类型 round-trip（InterventionRecord 全字段）、METHOD_REQUIRED_MINOR 四新键 === 11、TaskAnswerReq 新旧两种载荷都能构造
- [ ] **Step 2 确认红** → **Step 3 实现类型层**（只增不改义；version.ts 头注释补「1.11.0：任务生命周期 v2——submitted 账本态/干预四 RPC/五事件」条目）→ **Step 4 绿** → **Step 5 Commit** `feat: 协议 1.11.0 类型层（submitted 态/干预四 RPC/五事件/结构化答复）`

### Task H2: hub db v10（delegations 三列 + delegation_interventions 表）

**Files:**
- Modify: `packages/hub/src/db.ts`（MIGRATIONS :8-98 尾部追加 v10）
- Modify: `packages/hub/src/delegations.ts`（DelegationRow :238-255、toRecord :257-273）
- Test: `packages/hub/tests/delegations.test.ts`（行映射断言追加）

**Interfaces:**
- Produces: `delegations.run_no INTEGER`（缺省 1）、`submitted_at INTEGER`、`accepted_at INTEGER`；`delegation_interventions` 表（spec §8.1 SQL 逐字）+ `(delegation_id, status)` 索引；DelegationRow/toRecord 同步 runNo/submittedAt/acceptedAt

- [ ] **Step 1 失败测试**（v10 后 schema 断言 + interventions 行可插/幂等键）→ **Step 2 红** → **Step 3 实现**（沿 v6 四 ALTER 单迁移纪律；`PRAGMA table_info` 断言新列）→ **Step 4 绿** → **Step 5 Commit** `feat: hub 迁移 v10（run_no/submitted_at/accepted_at + delegation_interventions 表）`

### Task H3: 账本状态机 +submitted（转换表/枚举/矩阵）

**Files:**
- Modify: `packages/hub/src/delegations.ts`（DELEGATION_TRANSITIONS :53-61、DELEGATION_STATUSES :70-72）
- Test: `packages/hub/tests/delegations.test.ts`（状态机矩阵 :176-201 扩行列）

**Interfaces:**
- Produces: 转换边 `running→submitted`、`waiting→submitted`、`submitted→done|running|cancelled|failed`（spec §8.1）；矩阵从 49 对扩至含 submitted 的全对（64 对量级）

- [ ] **Step 1** 矩阵测试加 submitted 行列（合法五边 + 非法边全断言）→ **Step 2 红** → **Step 3 实现转换表** → **Step 4 绿** → **Step 5 Commit** `feat: 账本状态机新增 submitted 态（spec §8.1 转换边）`

### Task H4: task.intervene RPC + task.intervention 事件 + 提取器

**Files:**
- Modify: `packages/hub/src/delegations.ts`（新增 `handleIntervene`/`forwardIntervene`——**复用 handleAnswer :464-576 的 pending-Map 转发模式**，但目标是定向**事件**而非 res 转发）
- Modify: `packages/hub/src/server.ts`（RPC_HANDLERS :108-126 注册）
- Modify: `packages/hub/src/groups.ts`（LEADER_ONLY_METHODS 提取器 :126-156 加 `task.intervene`——taskId 反查 group_id 同款）
- Test: `packages/hub/tests/interventions.test.ts`（**新建**，harness 复制 delegations.test.ts :28-170 模式）

**Interfaces:**
- Produces（S2/S5 消费）:

```ts
// 语义：worker → hub。载荷 TaskInterveneReq { taskId: string; intervention: InterventionRequest }
// res：{ interventionId }（落行幂等：同 (delegation_id, interventionId) 二次调用返回既有）
// hub 行为：载荷校验 → 来源必须 = row.target_node_id → 账本非终态（pending/running/waiting/interrupted）→
//   delegation_interventions 落行(pending) → 账本 →waiting（canTransition 守卫）→
//   组模式分流：lf → sendTo(row.by_node_id, task.intervention 事件 {taskId, intervention})；
//   peer → 不转发内容，仅 sendTo(row.by_node_id, task.progress {kind:'waiting-input' 中性, excerpt:'执行方等待人工处理'})
//   （peer 中性进度沿 TaskReportProgress :179-183 kind 枚举，复用 waiting-input）
// handler 内 worker peerProtoVer 门：by_node_id 侧 < 1.11 时同样只发中性进度（老发起方读不懂新事件）
```

- [ ] **Step 1** 失败测试（lf 全链：worker intervene → leader 收 task.intervention 事件 + 账本 waiting + interventions 行 pending；peer：只中性进度零内容泄漏；来源校验 forbidden；幂等二次调用）
- [ ] **Step 2 红** → **Step 3 实现** → **Step 4 绿** → **Step 5 Commit** `feat: task.intervene——worker 干预上报与发起方定向通知（peer 组中性进度）`

### Task H5: task.answer 双向结构化 + 权威校验 + interventionAnswered

**Files:**
- Modify: `packages/hub/src/delegations.ts`（handleAnswer :464-519 扩展 + forwardAnswer :523-541 复用 + settle 决策列 :572-576 旁挂 interventions 行关闭）
- Test: `packages/hub/tests/interventions.test.ts`（扩展）

**Interfaces:**
- Produces:

```ts
// 语义：任意授权节点 → hub（发起方代答 或 worker 本地答回传）。
// 载荷 TaskAnswerReq { taskId, interventionId?, decision?, answer?, message? }
// 权威判定（hub 是权威，本地 authority_json 仅提示）：
//   interventionId 在场 → 定位 interventions 行：
//     · 行不存在 → intervention_not_found
//     · 行已非 pending → intervention_stale（Review Focus #2 first_wins）
//     · by_node_id 发起（lf）：组=lf 放行（leader 已过 checkGroupRole）；组=peer → forbidden_responder（Review Focus #4）
//     · target worker 发起：放行
//   interventionId 缺席 → 旧 approve/deny 写授权语义原样保留（1.10 兼容，不触 interventions）
// 答复落地：interventions 行 answered(+answer/answeredBy/answeredAt) →
//   对端事件 task.interventionAnswered { taskId, interventionId, answer, answeredBy } 定向到「另一侧」
//   （答方=origin 则发 worker；答方=worker 则发 origin）→ 账本 waiting→running
```

- [ ] **Step 1** 失败测试（发起方代答 approve/deny/结构化 answer 三态；worker 答回传；双答竞态 second→stale；peer 发起方→forbidden_responder；旧无 interventionId 路径回归零变化；answeredBy 事件两侧各收到一次）
- [ ] **Step 2 红** → **Step 3 实现** → **Step 4 绿** → **Step 5 Commit** `feat: task.answer 双向结构化答复（干预行原子关闭 + first-wins + peer 越权拒）`

### Task H6: task.accept / task.reject + 账本迁移 + 终态事件

**Files:**
- Modify: `packages/hub/src/delegations.ts`（handleAccept/handleReject + 转换）
- Modify: `packages/hub/src/groups.ts`（提取器加两方法；发起方权威在 handler 内：`ctx.nodeId !== row.by_node_id → forbidden`——沿 handleCancel :437-439 模板）
- Test: `packages/hub/tests/interventions.test.ts`（扩展）

**Interfaces:**
- Produces:

```ts
// task.accept { taskId }：账本 submitted→done（accepted_at）→ task.accepted { taskId, runNo } 定向 worker
// task.reject { taskId, reason }：账本 submitted→running + run_no+=1（打回新 run）→
//   task.rejected { taskId, runNo: 新, reason } 定向 worker
// 校验：非 submitted → not_submitted；reason 空白 → invalid_params；来源非 by_node_id → forbidden
// 幂等：accept 二次 → not_submitted（已 done）
```

- [ ] **Step 1** 失败测试（accept 全链+账本 done+accepted_at+事件；reject 全链+run_no 递增+事件含 reason；错误三态；peer/lf 均发起方权威）→ **Step 2 红** → **Step 3 实现** → **Step 4 绿** → **Step 5 Commit** `feat: task.accept/reject——发起方验收闭环（submitted 终态迁移与打回 run 递增）`

### Task H7: task.interventions 对账 + report submitted 接入

**Files:**
- Modify: `packages/hub/src/delegations.ts`（handleListInterventions + acceptReport :624-727 扩展）
- Modify: `packages/hub/src/server.ts`（注册）
- Test: `packages/hub/tests/interventions.test.ts`（扩展；断线重连用例）

**Interfaces:**
- Produces:

```ts
// task.interventions { taskId? } → { interventions: InterventionRecord[] }
//   权限：taskId 在场=该委派两端节点可查；缺省=本节点相关的全部（spec §8.2）
// acceptReport 扩展：status='submitted' 分支（Review Focus #5）——
//   账本 canTransition(running|waiting → submitted) → UPDATE + submitted_at + runNo 落账 →
//   task.submitted { taskId, runNo } 定向 by_node_id；runNo 透传自载荷（缺省沿用行值）
//   peer 组：task.submitted 照发（spec §3 裁定 #9：提交/验收跨节点，仅人工请求不转发）
```

- [ ] **Step 1** 失败测试（report submitted 全链+定向事件+runNo 透传；interventions 对账两端视图；断线重连：origin 离线期 worker 干预+答复+提交 → 重连拉取 interventions/task.list 收敛（Review Focus #3 断言不重复行））→ **Step 2 红** → **Step 3 实现** → **Step 4 绿** → **Step 5 Commit** `feat: task.interventions 对账与 report submitted 接入（断线收敛）`

### Task H8: 版本门三态 + hub 全量回归

**Files:**
- Test: `packages/hub/tests/interventions.test.ts`（版本门组）、`packages/hub/tests/server.integration.test.ts`（unsupported_method 版本串断言同步）

**Interfaces:**
- Consumes: H1-H7 全部
- Produces: 版本门降级矩阵证据（Review Focus #1/#5）

- [ ] **Step 1** 版本门用例（照 team 门 :501-566 模板）：1.10 worker intervene → 整包拒 node_unsupported + 账本零变化；1.10 origin 收不到新事件（仅中性）；1.11 双端全通
- [ ] **Step 2** hub 全量 `npx pnpm@9.0.0 test` 绿 + typecheck + lint
- [ ] **Step 3** Commit `test: 干预链版本门三态矩阵与 hub 全量回归`

### Task H9: 0.7.0 发版（CHANGELOG 补账 + tag）

**Files:**
- Modify: 根 `package.json`（0.6.1→0.7.0）、`packages/hub/package.json`（顺手对齐 0.7.0）、`CHANGELOG.md`（补 0.6.0/0.6.1 漏账 + 0.7.0 条目）

- [ ] **Step 1** CHANGELOG 三条目（0.6.0 peer-mode、0.6.1 补丁、0.7.0 本期——写明协议 1.10.0→1.11.0 对齐惯例）→ **Step 2** 版本双 bump → **Step 3** 合并到 hub main（`--no-ff`，循 hub 仓单 feat commit 惯例可 squash）→ tag `v0.7.0` → **Step 4** 验证 tag 可安装：临时目录 `pnpm add github:bearangel/momo-hub#v0.7.0` 成功 → **Step 5** Commit/Tag（**不 push，等用户**）

---

# B 部分 · momo-studio 仓（分支 feat/task-lifecycle-v2-p2）

### Task M1: P2 消费面矩阵（双仓）

**Files:**
- Create: `.omo/feature-matrices/2026-11-14-task-lifecycle-v2-p2.md`

- [ ] **Step 1** 锚 grep 双仓：①studio 侧 `task.report`/`TASK_RPC.answer`/`DelegationStatus` 消费点（delegation-runner/sync/wire/ipc.handlers/DelegatedTaskCard 等）；②hub 侧 `DELEGATION_STATUSES`/`TaskRecord` 消费面（tests 矩阵/投影/UI 镜像）③studio delegation-* 35 文件中与本 P2 相关的手术面清单
- [ ] **Step 2** 矩阵主体（行=消费点，列=协议新增面 submitted/intervene/answer 扩展/accept/reject/interventions）+ 空格写理由
- [ ] **Step 3** 反查 + 门禁八问（重点：DelegatedTaskCard 六态→八态渲染、RemoteViewPane status 值域）

### Task S1: 协议 pin 升 v0.7.0 + 编译面适配

**Files:**
- Modify: `electron/package.json:108`（`#v0.6.1`→`#v0.7.0`）
- Modify: P2 触达的 studio 编译面（以 M1 矩阵为准——预期：DelegatedTaskCard 状态样式扩 submitted、hub wire 类型引用处）

**Interfaces:**
- Consumes: H9 tag
- Produces: studio 可编译可测试的新协议底座

- [ ] **Step 1**（前置说明进 dispatch：开发期本地覆盖纪律——若 H9 尚未 push 导致 git pin 安装失败，允许 S2-S9 用 `file:../momo-hub` 本地链跑测试，**但本任务提交的必须是 git pin**）pin 升级 + `npx pnpm@9.0.0 install`
- [ ] **Step 2** typecheck 双 workspace + 修编译面（DelegatedTaskCard 等对 DelegationStatus 的穷举消费——submitted 落「等待发起方验收」中性展示）
- [ ] **Step 3** 全量 `npx pnpm@9.0.0 test` 绿 → **Step 4** Commit `feat: 协议 pin 升 v0.7.0（1.11.0 类型底座 + 消费面适配）`

### Task S2: worker 桥——request_human/tool_gate → task.intervene；submit_task → report submitted

**Files:**
- Modify: `electron/src/main/hub/delegation-runner.ts`（执行态挂钩）
- Modify: `electron/src/main/task/lifecycle-runs.ts`（新增桥接 sink：`setRemoteInterveneSink(fn)`——沿 setToolGateHandler 注入器先例，避免 hub 模块反向依赖）
- Test: `electron/tests/hub/worker-intervene-bridge.test.ts`（新建）

**Interfaces:**
- Consumes: H4/H7 协议；lifecycle-runs 既有 requestHuman/submitRun/tool_gate 双写
- Produces:

```ts
// 桥接语义（worker 节点，delegation-bound 任务）：
// request_human / tool_gate 持久化行创建时（lifecycle-runs emit 点）→ 若任务 delegation_id 非空 →
//   经 sink 调 hub client task.intervene（interventionId=本地 human_requests.id，runNo=活动 run.run_no，
//   payload/options 从行序列化；deadlineAt=deadline_at）→ 失败（对端 <1.11 或离线）：
//   question/manual_action 降级为「本地等待」（节点所有者自答，P1 行为）+ 里程碑记录降级原因（Review Focus #1）
// submitRun 成功且 delegation_id 非空 → task.report { status:'submitted', runNo, deliverable 摘要 } →
//   失败降级：报 done（P1 旧行为）+ auto_accept 兜底完成（版本门内 S8 之前保留）
// 转发触发点复用 P1 的 emit sink 容器（emitRunChanged/emitHumanChanged 旁新增 remote sink 或复用同容器第三通道）
```

- [ ] **Step 1** 失败测试（intervene 桥全链 mock hub client；delegation_id 空→零桥接；降级两分支；submit→report submitted 载荷精确性；runNo 透传）→ **Step 2 红** → **Step 3 实现** → **Step 4 绿** → **Step 5 Commit** `feat: worker 干预/提交桥（lifecycle 事件 → task.intervene/report submitted + 旧版本降级）`

### Task S3: worker 答复消费——answer 结构化路由

**Files:**
- Modify: `electron/src/main/hub/delegation-runner.ts` 或 `hub/wire` 消费层（task.interventionAnswered 事件订阅点）
- Modify: `electron/src/main/task/lifecycle-runs.ts`（answerHuman 已有 remote_id 支撑——补「按 remote_id 定位本地行」入口）
- Test: `electron/tests/hub/worker-answer-consume.test.ts`（新建）

**Interfaces:**
- Produces: worker 收 `task.interventionAnswered { taskId, interventionId, answer, answeredBy }` → 按 interventionId（=本地行 id）调本地 answerHuman 路由（question 注入唤醒 / tool_gate 授权回调）→ 幂等（行已答→stale 静默）；answeredBy 记远端节点

- [ ] **Step 1** 失败测试（结构化 answer 三 kind 路由；幂等；tool_gate approve→授权回调触发）→ **Step 2 红** → **Step 3 实现** → **Step 4 绿** → **Step 5 Commit** `feat: worker 消费远端代答（interventionAnswered → 本地答复路由）`

### Task S4: worker 终态消费——accepted/rejected

**Files:**
- Modify: worker 事件消费层（同 S3 文件族）
- Test: `electron/tests/hub/worker-terminal-consume.test.ts`

**Interfaces:**
- Produces: `task.accepted` → 本地任务 complete（accepted_at，经 lifecycle 服务投影）；`task.rejected { runNo, reason }` → 本地 rejectTask 语义（run rejected + 任务 assigned + 新 run 于下次放行 trigger='rework'）→ 幂等（终态跳过）

- [ ] **Step 1** 失败测试 → **Step 2 红** → **Step 3 实现** → **Step 4 绿** → **Step 5 Commit** `feat: worker 消费远端验收/打回（accepted/rejected → 本地终态与返工）`

### Task S5: 发起方镜像——submitted 映射 + run 懒建 + 里程碑

**Files:**
- Modify: `electron/src/main/hub/delegation-sync.ts`（done 拍旧映射退役位）
- Test: `electron/tests/hub/origin-submitted-mirror.test.ts`（新建）

**Interfaces:**
- Produces:

```ts
// 收 task.submitted { taskId(=delegation_id), runNo, deliverable } →
//   本地任务（delegation_role='out'）→ submitted 态（经 lifecycle 服务适配器：run 懒建 (task, runNo) submitted——P1 spec §8.4 已定）
//   + 镜像 acceptance 请求行（session_id=跟踪会话, kind=acceptance, payload=deliverable, remote 语义）→ 面板/详情待验收
// 收 task.intervention（lf）→ 镜像请求行（origin_node_id=worker, remote_id=interventionId, session_id=跟踪会话,
//   kind/payload/options/deadline 逐字段复制）→ 跟踪会话面板可代答
// 里程碑：submitted/intervention/answered/accepted/rejected 五类 → messages 行（sender='system',
//   event_type='delegation_milestone', meta_json 结构化）写入跟踪会话（幂等键：delegation_id+事件 id+runNo）
// 旧映射退役：done 拍→completed 直写删除（S8 版本门内完成——本 task 先并存，S8 收口）
```

- [ ] **Step 1** 失败测试（submitted 镜像全链含 run 懒建/acceptance 行/徽标；intervention 镜像行字段完整性；里程碑幂等）→ **Step 2 红** → **Step 3 实现** → **Step 4 绿** → **Step 5 Commit** `feat: 发起方 submitted/intervention 镜像与跟踪会话里程碑（幂等）`

### Task SP: 静态预览——跟踪会话与远端代答【STOP 门禁】

**Files:**
- Create: `.omo/previews/2026-11-14-task-lifecycle-p2-tracking.html`

- [ ] **Step 1** 预览四节（明暗并排，token 纪律同 P1）：①跟踪会话全景（标题 `#T-xxx · → 节点B` 副标、里程碑时间线五类卡、composer 禁用占位、请求面板含远端来源徽标「来自 节点B · 研发工作站」）②代答卡（lf：面板可答+「代答后节点原地继续」提示；peer：同位仅中性进度卡「执行方等待人工处理 · 无需你操作」）③验收卡远端变体（交付物+发起方操作）④中断/重连态徽标（账本 interrupted → 「节点离线，恢复后自动续跑」）
- [ ] **Step 2** `open` 展示 → **Step 3【STOP】等用户确认**（P2 未预设夜间授权；若用户再授权全自主则降级为 P1 同款裁定并记录）→ **Step 4** 定值清单

### Task S6: 跟踪会话创建 + 服务端只读闸 + 代答路由 + 权限 UI

**Files:**
- Modify: `electron/src/main/hub/dispatch-submit.ts`（submitRoutedTask 成功→创建跟踪会话 + execution_session_id 指向 + delegation_role='out'〔P1 已有〕+ 移除 autoAccept 强制〔S8 联动，本 task 先版本门内保留〕）
- Modify: `electron/src/main/im/session.ipc.handlers.ts` 或 router 入口（**服务端只读闸**：sendUserMessage 对 delegation_role='out' 会话拒绝人话——终审 Finding #4 清偿）
- Modify: `electron/src/main/hub/ipc.handlers.ts`（代答路由：human:answer 命中镜像行 → hub client task.answer(interventionId=remote_id)；task:accept/reject 命中 delegation_role='out' → hub client task.accept/reject）
- Modify: renderer `HumanRequestPanel.tsx`/`RoomList.tsx`（远端来源徽标 + peer 无代答入口——按 SP 定值）
- Test: `electron/tests/hub/tracking-session.test.ts` + renderer colocated 更新

**Interfaces:**
- Consumes: H5/H6 RPC、S5 镜像行、SP 定值
- Produces: 跨节点 HITL 完整发起方体验（spec §7.3/§8.6）

- [ ] **Step 1** 失败测试（跟踪会话创建/复用 retryDispatch；只读闸拒绝直发；代答路由载荷 interventionId=remote_id；peer 镜像行 answer→拒绝〔UI 无入口+主进程兜底〕；lf 先答生效）→ **Step 2 红** → **Step 3 实现** → **Step 4 绿** → **Step 5 Commit** `feat: 委派跟踪会话与跨节点代答/验收路由（服务端只读闸 + peer 双层防线）`

### Task S7: 重连对账 + tool_gate 单入口化 + write-blocked emit 补发

**Files:**
- Modify: `electron/src/main/hub/delegation-sync.ts`（`handleOnline` 重连钩子扩：`task.interventions` 拉取 → 幂等应用未消费答复/终态 + 里程碑补写）
- Modify: `electron/src/main/sandbox/write-blocked-emit.ts`（emit 补发：registerToolGateRequest 落行时经注入 sink 发 human:changed——终审 Finding #1 清偿）
- Modify: renderer `App.tsx`（**SandboxNotice 全局卡退役**——tool_gate 唯一入口=请求面板，终审 Finding #2 清偿；保底：面板已含 tool_gate 卡）
- Test: `electron/tests/hub/reconnect-reconcile.test.ts`（新建）+ sandbox 套件回归 + App 相关测试更新

**Interfaces:**
- Consumes: H7 interventions 对账
- Produces: 断线幂等收敛（Review Focus #3）+ tool_gate 单入口

- [ ] **Step 1** 失败测试（重连对账：离线期 answered/accepted 事件补应用不重复建行；SandboxNotice 退役后 tool_gate 全经面板；write-blocked emit 后面板实时性）→ **Step 2 红** → **Step 3 实现** → **Step 4 绿** → **Step 5 Commit** `feat: 断线对账幂等收敛 + tool_gate 单入口化（终审遗留清偿）`

### Task S8: P1 降级守卫移除（版本门内两段式全量）

**Files:**
- Modify: `electron/src/main/hub/dispatch-submit.ts`（移除 `autoAccept:true` 强制——改为「双方 protoVer ≥1.11 时不设」）
- Modify: `electron/src/main/hub/delegation-sync.ts`（done 拍旧映射删除——1.11 路径 submitted 为主，done 仅作 <1.11 降级残路）
- Test: `electron/tests/task/p1-degradation-guard.test.ts`（改写为版本门矩阵）

**Interfaces:**
- Produces: Review Focus #1 完整证据——任一侧 <1.11 → 强制 auto_accept + done 旧语义（回归锁）；双 1.11 → 两段式（submitted→验收）

- [ ] **Step 1** 改写测试（四象限：新旧 hub × 新旧 worker）→ **Step 2 红** → **Step 3 实现** → **Step 4 绿** → **Step 5 Commit** `feat: P1 降级守卫移除——双端 ≥1.11 启用跨节点两段式（版本门矩阵）`

### Task S9: 平行组规则 studio 侧渲染

**Files:**
- Modify: renderer `DelegatedTaskCard.tsx`（六态→八态：submitted「等待发起方验收」+ waiting 中性「执行方处理中」）+ `RemoteViewPane.tsx`（peer 等待态中性文案，M1 矩阵裁定执行）
- Test: colocated 更新

- [ ] **Step 1** 失败测试（八态样式映射；peer 卡无代答/验收按钮——发起方有验收无代答；lf 卡双权）→ **Step 2 红** → **Step 3 实现** → **Step 4 绿** → **Step 5 Commit** `feat: 平行组/主从组跨节点卡片八态与权限渲染`

### Task S10: SimHub 契约 + e2e + 全量回归 + 账本收尾

**Files:**
- Test: `electron/tests/hub/simhub-interventions.test.ts`（新建——沿既有 SimHub/模拟 hub 模式，若仓内无则双进程真 hub 连 localhost）
- Modify: `CHANGELOG.md` + 三处 `package.json` alpha+1 + `.omo/feature-matrices/…-p2.md` 证据列回填

- [ ] **Step 1** SimHub 全链契约：delegate→intervene→origin 代答→worker 续跑→submit→accept→done；reject→rework→二次 submit→accept；断线重连对账；peer 全链（无代答+验收）；版本门降级象限
- [ ] **Step 2** 双仓全量测试 + typecheck + lint 绿
- [ ] **Step 3** 真机 e2e（双 studio 实例 + 本地 hub 进程；沿 P1 momo-acceptance 流程，LLM 驱动 worker 侧 request_human/submit_task；产出 `.omo/qa-reports/2026-11-14-task-lifecycle-p2-e2e/`）
- [ ] **Step 4** spec §16 验收标准 6-9 条逐条自检记录 + 矩阵回填 → **Step 5** Commit `chore: P2 研发账本 + alpha 号 +1`（hub 仓版本已在 H9 定稿）

---

## 自审记录

1. **Spec 覆盖**：§8.1（H2/H3/H6）、§8.2（H1/H4/H5/H6/H7）、§8.3 映射（S5/S8 测试矩阵锁）、§8.4（H7/S7）、§8.5（H8/S8 四象限）、§8.6（H5/H6 权威 + S6 双层防线 + S9 渲染）、§7.3 跟踪会话（SP/S5/S6）、终审遗留 epic（S6 只读闸 + S7 单入口/emit 补发）、§14 P2 行全部对齐；P3（steer/远端抽屉）不含。
2. **占位符扫描**：无 TBD；SP 的 STOP 门禁为待用户裁定项非占位。
3. **类型一致性**：`InterventionRequest/Record/Answer` 在 H1 定义、H4-H7/S2-S6 同名消费；`remote_id`=interventionId 口径与 spec §8.2 命名口径一致；`runNo` 全链同名。
4. **Review Focus 五条**分别钉在 H8+S8、H5、H7+S7、H5+S9、H7+S2。
