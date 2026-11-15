# 任务生命周期 v2 · P3 打磨期 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec §14 P3——steer 最小实现、远端会话只读抽屉、通知细化、返工上限可配、视觉打磨；外加 P2 终审 follow-up 票据全清与打回/peer 真机补测。

**Architecture:** 三条复用线——①抽屉零协议改动：origin 已持 (targetNodeId=delegation 路由, workerSessionId=task.report 落账本 `delegations.session_id` 经 task.list 反查, workspaceName=账本字段)，直接调既有 `hub:viewMessages/viewSubscribe` + 复用 hub-view.store 的回放机制；②steer 走既有 `injectSteer` worker 管线 + hub 新增 `task.steer` RPC（spec §8.2 预留槽位）；③通知走 human:changed 既有推送 + NoticeStack 同款吐司形态。

**Tech Stack:** 双仓（hub minor 1.12 仅 steer 一方法；studio 既有栈）。

**Spec:** `docs/specs/2026-11-13-task-human-loop-lifecycle-design.md` §7.3（抽屉）/§7.5（通知）/§8.2（steer 槽位）/§14 P3 行。**P2 终审 follow-up 清单:** `.superpowers/sdd/2026-11-14-task-lifecycle-v2-p2/progress.md` 末节。

## Global Constraints

- 双仓双分支（hub `feat/steer-1-12`、studio `feat/task-lifecycle-v2-p3`）；hub 测试 `cd /Users/stbearangel/dev/AiProject/momo-hub && npx pnpm@9.0.0 test`；studio 沿 P1/P2 命令纪律（`cd electron && node scripts/test.mjs <path>`、全量 `npx pnpm@9.0.0 test`）
- 协议只增不改义；`task.steer` 登记 `METHOD_REQUIRED_MINOR=12`（新常量 `TASK_STEER_REQUIRED_MINOR` 或并入 11——**裁定：并入 11 不新开**，steer 与 HITL 同属 1.11 能力域，但已发布 1.11.0 pin 的节点没有该 handler 会 unknown_method……**改裁定：新常量 =12**，避免 1.11 节点静默 unsupported 歧义）；hub 版本顺延 0.7.3、studio pin 随之
- UI 任务（SP 预览后）遵循 momo-ui-preview-rules P1 门禁——**本计划 SP 为 STOP 门禁**（用户在线，预览确认后才落 B/C/D/F 的 UI 代码；A 批与 E 无 UI 可先行）
- 版本纪律：收尾任务 alpha+1；中文注释；Conventional Commits；strict TS
- steer 权威：发起方 by_node_id 单点（沿 accept/reject 先例）；peer 组**允许** steer（它是任务指令不是人工请求转发——**裁定：peer 允许**，草稿承接方收指令合理，spec §8.6 的「不转发」仅限人工请求内容）

## Review Focus

1. **steer 注入与在途回合竞态**：agent 回合进行中注入 steer 消息——注入链是否串行到下一回合（沿【人工答复】注入同款机制），不撕裂当前流
2. **抽屉会话错位**：runNo 递增后 delegation.session_id 是否随新 run 更新（旧会话 vs 新 run 会话——worker 每次 run 复用同一执行会话？验证：MC1 会话跨 run 复用，账本 session_id 首拍回填后不变——若 rework 换会话需跟随）
3. **通知风暴**：远端镜像行 inserted 与本地行 inserted 双到——去重（session 维度单吐司）
4. **上限可配的迁移面**：settings 无此键时默认 10 的读取路径（缺省零迁移）
5. **A2 对账缓存一致性**：per-pass 缓存不得跨对账轮复用（陈旧 workstation）

---

### Task A1: hub 票据清偿（payload 上限 + submitted 自封口 + 注释）

**Files:**
- Modify: `/Users/stbearangel/dev/AiProject/momo-hub/packages/hub/src/delegations.ts`（acceptReport submitted 分支 UPDATE 加 `AND status IN ('running','waiting')` 自封口 + changes 判定；handleIntervene 载荷校验补 payload 序列化总量上限 64KB）
- Modify: `packages/hub/tests/delegations.test.ts`（describe 计数注释笔误）
- Test: `packages/hub/tests/interventions.test.ts`（自封口竞态用例：预置 submitted 后并发态改写不可半套）

- [ ] 失败测试 → 实现 → 全量绿 → Commit `fix(hub): 终审票据——submitted UPDATE 自封口 + intervene payload 64KB 上限`

### Task A2: studio F4 RPC 放大收敛

**Files:**
- Modify: `electron/src/main/hub/hub/index.ts`（mirrorWorkstationOf：`origin==='peer_draft'` 前置短路——lf 恒返 null 免 RPC）
- Modify: `electron/src/main/hub/reconnect-reconcile.ts`（对账轮内缓存：workstationOf 结果与 task.interventions 拉取按 pass 作用域缓存——阶段 2 的 per-row interventions 若多行同 delegation 合并）
- Test: `electron/tests/hub/reconnect-reconcile.test.ts`（缓存不跨轮断言）+ `origin-submitted-mirror.test.ts`（lf 短路零组清单调用）

- [ ] 失败测试 → 实现 → Commit `perf: 镜像 RPC 放大收敛（lf workstation 短路 + 对账轮内缓存）`

### Task A3: studio 杂项票据

**Files:**
- Modify: `electron/src/main/task/human.ipc.handlers.ts`（F3：两域零 import 声明改为如实描述或 hubGetPresenceNodes 改注入——**裁定：改注入**，沿 ports 先例消弭漂移）
- Modify: `electron/tests/hub/reconnect-reconcile.test.ts`（「running+runNo==local no-op」一行断言补）
- Modify: `renderer/src/ipc/types.d.ts`（HubTaskRecord 横幅字段数注释）
- Modify: `electron/src/main/hub/hub/index.ts`（mirrorWorkstationOf 多组盲选 → 按 delegation routing.groupId 精确取组）

- [ ] 测试 → Commit `chore: 终审杂项——presence 注入化 + no-op 断言 + workstation 按组精确解析`

### Task E1: 返工上限可配

**Files:**
- Modify: `electron/src/main/task/lifecycle-runs.ts`（MAX_RUNS_PER_TASK → `effectiveMaxRuns()`：settings 读 `taskMaxRuns` 缺省 10，clamp 1..50）
- Modify: settings 存取面（沿 delegation-settings.ts 先例建 task-settings 或并入——**裁定：并入既有 delegation-settings.ts 同 kv 模式新键**，避免新文件）
- Modify: `renderer/src/ipc/types.d.ts` + preload + 设置页（任务设置段：数字输入 1-50）
- Test: lifecycle-runs 用例（缺省 10/自定义生效/clamp）+ 设置页 colocated

- [ ] 失败测试 → 实现 → Commit `feat: 返工上限可配（1-50，缺省 10）`

### Task H1: hub task.steer RPC（协议 1.12.0）

**Files:**
- Modify: `/Users/stbearangel/dev/AiProject/momo-hub/src/delegation.ts`（TASK_RPC + 'task.steer'；TaskSteerReq {taskId, message}（message 1-4000 字）/Res {ok}；注释条目）
- Modify: `src/methods.ts`（=12 + TASK_STEER_REQUIRED_MINOR 导出）、`src/version.ts`（1.12.0 + 头注）
- Modify: `packages/hub/src/delegations.ts`（handleSteer：来源=by_node_id 否则 forbidden；账本非终态；载荷校验；**不迁账本态**（纯指令非状态事件）→ sendTo(target, 新事件 EVT.taskSteered {taskId, message})；worker 离线容忍——**裁定：离线拒**（指令时效性强，缓存重发语义弱，人话「执行节点离线，稍后再试」））
- Modify: `src/events.ts`（EVT.taskSteered = 'task.steered'）
- Test: `packages/hub/tests/interventions.test.ts` 或新 steer 组（全链/越权/离线拒/终态拒/载荷）

- [ ] 失败测试 → 实现 → Commit `feat(hub): 协议 1.12.0——task.steer 发起方指令通道（1.11 节点 unknown_method 无歧义）`

### Task H2: hub 0.7.3 发版

- [ ] CHANGELOG 0.7.3 + 版本双 bump + 合并 main + tag v0.7.3 + push（controller 亲执）

### Task S1: studio pin v0.7.3 + steer worker 消费

**Files:**
- Modify: `electron/package.json`（#v0.7.3）+ pin 锁测试同步
- Modify: `electron/src/main/hub/remote-intervene-bridge.ts` 或 hub/index（订阅 EVT.taskSteered → 目标会话=账本/本地 execution_session_id → 复用 injectSteer 管线（P2 HITL 超时已用）注入；里程碑 kind='steered'；**Review Focus #1**：注入走既有 steer 通道（回合边界串行），测试锁不撕裂在途流——沿 human-answer-inject 的注入断言模式）
- Test: steer 消费用例（注入到达/幂等（同 message 重发去重键 taskId+message hash+窗口）/终态静默）

- [ ] 失败测试 → 实现 → Commit `feat: worker 消费 task.steered（回合边界注入 + 里程碑）`

### Task SP: 静态预览包【STOP 门禁】

**Files:**
- Create: `.omo/previews/2026-11-15-task-lifecycle-p3.html`

- [ ] 四节（明暗并排）：①抽屉（跟踪会话头部「查看远端会话」入口 + 抽屉形态：回放流/实时徽标/加载更早/只读条）②steer 入口（跟踪会话头部「补充指令」按钮 + 输入浮层 + 发起方权威提示）③请求吐司（右下 NoticeStack 同位形态：「等待你确认 · <title>」+点击跳会话+超时预警变体）④看板打磨项（submitted 文案长短统一 + #T 头部 CONTRACT #6 形态 + 返工上限设置项）
- [ ] `open` 展示 → **【STOP】等用户确认** → 定值清单

### Task S2: 远端会话只读抽屉

**Files:**
- Create: `renderer/src/components/hub/RemoteSessionDrawer.tsx` + store 扩展（hub-view.store 加 drawer 域或轻量局部 store）
- Modify: `renderer/src/components/im/`（跟踪会话头部入口按钮——session.delegationRole==='out' 且详情有 delegation 时显示）
- **会话定位链**：origin delegation 行 → routing.targetNodeId + workspaceName（账本/D5 回写）+ worker sessionId（hub:taskList 的 TaskRecord.sessionId 反查——**Review Focus #2**：rework 换 run 时若 worker 复用会话则 id 不变；若变需按最新 run 取——用 taskList 实时查不缓存）→ `ipc.hub.viewMessages(targetNodeId, sessionId, fromSeq…)` + viewSubscribe + onViewAppended（groupId 传 delegation 组避免 commonGroupId 回退歧义）
- 只读：无 composer、消息流复用 ReplayMessage 形态（轻量化——不复用整页 ReplayView，抽屉内滚动列表）
- Test: colocated（打开/加载/实时追加/断线徽标/权限态）

- [ ] 失败测试 → 实现（SP 定值）→ Commit `feat: 委派跟踪会话远端会话只读抽屉（零协议改动复用 view.*）`

### Task S3: steer 发起方入口

**Files:**
- Modify: `renderer/src/components/im/`（跟踪会话头部「补充指令」+输入浮层→ 新 IPC `task:steer`）
- Modify: `electron/src/main/task/ipc.handlers.ts`（task:steer → delegation_role='out' 校验 → hub client task.steer；错误人话透传（离线拒等））
- Modify: preload + types.d.ts
- Test: 入口渲染条件/发送流/错误态 colocated + IPC 契约

- [ ] 失败测试 → 实现（SP 定值）→ Commit `feat: 发起方 steer 入口（跟踪会话补充指令 → task.steer）`

### Task S4: 请求吐司通知

**Files:**
- Create: `renderer/src/components/notices/HumanRequestToast.tsx`
- Modify: `renderer/src/stores/human.store.ts`（onChanged kind='inserted' → 吐司队列；**Review Focus #3**：session 维度去重——同会话已有未消吐司则更新计数不叠条；本地与远端镜像行同事件单吐司）
- 点击跳会话（selectSession）；超时预警变体（sweeper 提醒事件——沿 human:changed 扩 kind='reminded'？**裁定：主进程 sweeper 提醒时 emitHumanChanged 复用 kind='inserted'+deadline 临近标记**……更简：吐司侧对既有 pending 行按 deadline_at<5min 渲染预警色，无需新事件）
- Test: colocated（去重/跳转/预警色/自动消散）

- [ ] 失败测试 → 实现（SP 定值）→ Commit `feat: 人工请求吐司（会话去重 + 点击直达 + 临近超时预警）`

### Task S5: 看板与详情打磨

**Files:**
- Modify: `renderer/src/lib/task-status.ts`（submitted 文案统一短版「待验收」——S9 裁定落定）+ `TaskDetailPanel.tsx`（#T 头部 CONTRACT #6 形态：`#T-<id> · → <节点>` 副标行）
- Test: colocated 更新

- [ ] 实现（SP 定值）→ Commit `polish: 看板/详情打磨（文案统一 + 头部形态落 CONTRACT）`

### Task S6: 真机 E2E 补测（打回返工 + peer 全链）

- [ ] 双实例 + hub 沿 P2 拓扑（隔离 profile 复用 p2-e2e 或新开）：场景 1 lf 打回全链（提交→A 打回带理由→B 返工 run#2→再提交→验收）；场景 2 peer 组全链（B 建组入 peer 模式→A 委派草稿→B 承接→request_human 本地等待（B 侧自答）→提交→A 验收）；产出 `.omo/qa-reports/2026-11-15-task-lifecycle-p3-e2e/`
- [ ] 报告四态 + 证据

### Task S7: 全量回归 + 收尾

- [ ] 双仓全量 + typecheck + lint 绿；CHANGELOG P3 条目 + alpha+1（studio）；hub 0.7.3 已定稿；spec §16 全条自检记录；矩阵回填
- [ ] Commit `chore: P3 研发账本 + alpha 号 +1`

---

## 自审记录

1. **Spec 覆盖**：§14 P3 五项全对齐（steer=H1/H2/S1/S3、抽屉=S2、通知=S4、上限=E1、打磨=S5）+ 终审票据（A1-A3）+ 真机补测（S6）；远端抽屉复用面经 hub view 探索实证（零协议改动路线）。
2. **占位符**：无；SP STOP 为流程门禁非占位。
3. **类型一致性**：TaskSteerReq/EVT.taskSteered 双仓同名；drawer 复用 ViewMessage/ViewAppendedEvent 既有类型零新增。
4. **Review Focus 五条**分别钉在 S1/S2/S4/E1/A2 测试。
