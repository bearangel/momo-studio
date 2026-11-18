# 验收裁决 UX 重构设计（三动作 · 权限收敛 · 跨节点保真）

- 日期：2026-11-18
- 状态：待评审（评审通过后进入实施计划）
- 上游：`docs/specs/2026-11-13-task-human-loop-lifecycle-design.md`（任务生命周期 v2 §6.5 两段式验收）、`docs/specs/2026-11-17-remote-session-view-redesign-design.md`（远端会话查看 / §12 面板直连）
- 影响面：renderer 验收卡与输入框、主进程验收权限守卫与写路径、hub 协议 1.14.0（momo-hub）、studio pin

---

## 1. 背景：人工验收实测暴露的四类问题

2026-11-18 双节点实测（A=发起方，B=执行方，任务「提出三个节气散文主题」）暴露以下问题。四条均为实测复现，非推测。

### 1.1 执行方可自行验收（权限错位 · 真缺陷）

B 的 `submitRun` 在本地落一条 acceptance 请求（`origin_node_id` 为空），面板据此渲染「验收通过 / 打回返工」按钮。B 点「验收通过」走 `acceptTaskRouted`，其远端判定 `isRemoteSubmitted` 只认 `delegation_role='out'`——于是 B **本地把任务标完成且不通知 A**，A 侧镜像验收卡永久滞留 pending。按设计验收权归发起方，这是错的。

### 1.2 两侧卡片内容不一致（跨节点截断 · 真缺陷）

交付物经 `task.report.reason` 过线，hub 侧 `REASON_MAX = 512` 字符；超限时 studio 的 `buildDeliverableReason` 降级为「仅 summary 且截断」。实测同一份交付：

| 字段 | B（执行方本地行） | A（发起方镜像行） |
|---|---|---|
| summary | 519 字完整 | 401 字，断在「那一点…」 |
| files | `二十四节气散文-三个候选主题.md` | **空** |
| artifacts | 2 条 | **空** |

发起方是在看残缺交付物做裁决。附带观感问题：卡片标题取各自节点的任务 id（`T-018` vs `#T-013`），进一步放大「两边不一样」的错觉。

### 1.3 两个输入框语义打架

验收卡内嵌「打回理由」输入框，面板底部同时有「补充指令」输入框。二者视觉同形、语义不同。更严重的是主进程 `handleTaskSteered` 只挡终态——**任务处于 `submitted` 时补充指令仍会注入执行会话并开出新回合**，而验收单仍指向旧 run，形成僵尸回合。

### 1.4 三动作缺失与后果不可读

交付物里有「请选择主题一/二/三」的诉求，但裁决只有「通过」（直接完成任务）与「打回返工」（字面像否定）。用户真实意图「认可本轮 + 继续做下一步」无处表达。同时卡片没有写明任一动作的后果，输入框紧贴按钮更让人以为必须先填选。

---

## 2. 目标与非目标

**目标**

1. 验收裁决权只在发起方手里，三层机械收敛（投影 / UI / IPC），执行方看到的是「等待裁决」状态而非操作面板。
2. 裁决动作三选一：**继续 / 完成 / 驳回**，每个动作的后果在卡片上写明。
3. 「继续」= 当前 run 验收通过 + 立即开续作 run（同一任务，`run#N+1`）+ 把要求送到执行方。
4. 发起方看到的交付内容与执行方一致（协议级保真），做不到时显式标注截断。
5. 同一屏内只有一个可输入的地方在等用户：待裁决时补充指令框禁用。

**非目标**

- 不改变 `submit_task` / 两段式验收的基本模型（agent 只能 submit，accept/reject 归发起方）。
- 不引入「驳回后撤销」「完成后撤销」——`completed` 仍是不可逆终态。
- 不做多节点广播/群组裁决（裁决权单一：委派发起方）。
- 不改造非验收类人工请求（tool_gate / question / manual_action）的既有交互。

---

## 3. 裁决权模型（CONTRACT DEC-1 ~ DEC-4）

### DEC-1 权威单一

验收请求权属委派发起方。判定规则（主进程单点）：

```
canDecide(task) =
  task.delegationRole === 'in'  → false   // 执行方，等发起方
  其余（'out' 镜像行 / 本地非委派任务 / peer 承接行） → true
```

### DEC-2 投影层

`electron/src/main/task/human.ipc.handlers.ts` 的 `projectHumanListRows` 由「镜像行才附加」改为**所有行附加**：

- `HumanRequestWireRow` 增 `canDecide?: boolean`（仅 acceptance 行消费；其他 kind 恒 `true`，行为不变）。
- `renderer/src/ipc/types.d.ts` 的 `HumanRequestRow` 同步增可选键。
- 本地非委派行、发起方镜像行恒 `true`；`delegation_role='in'` 行（执行方本机验收单）为 `false`。

### DEC-3 UI 层

`decidable=false` 的验收卡渲染**只读信息卡**：无按钮、无输入框、无确认（见 §4.2）。

请求行仍照常落库、不删除：`human:attention` 的 `submitted` 聚合（执行方「等待远端裁决」的侧栏提示）与审计链依赖它；只读卡的「等待发起方裁决」正是它的呈现面。

### DEC-4 IPC 守卫

`electron/src/main/task/ipc.handlers.ts`：

- `acceptTaskRouted` / `rejectTaskRouted` 入口对 `task.delegationRole === 'in'` 人话拒绝：`验收裁决权归发起方（本机为执行方）`。
- 守卫只加在 IPC 路由层，**不加在 `lifecycle-runs` 服务层**——`degradeSubmit` 的本地自动验收（hub 离线兜底）与 worker 的 `handleTaskAccepted` 仍走服务层直达，不受影响。

---

## 4. 卡片信息架构与文案

### 4.1 发起方（可裁决）

```
┌─ [验收] 第 1 轮交付 · 待你裁决        · 已等待 3 分钟 ─┐
│ 任务：提出三个「节气」散文主题（暂不写正文）            │
│                                                        │
│ 交付说明                                               │
│   已按格式给出三个差异明显的节气散文选题……（Markdown） │
│ 文件                                                   │
│   [二十四节气散文-三个候选主题.md]                     │
│ 产物                                                   │
│   ✓ 三个候选主题：1. 春雷落处……                       │
│   ✓ 下一步：用户点选其一后，再撰写正文                 │
│                                                        │
│ [继续] [完成] [驳回]                                   │
│ 继续 = 认可本轮，按你的要求让它再跑一轮（任务继续）    │
│ 完成 = 结束任务（不可撤销） · 驳回 = 退回重做          │
└────────────────────────────────────────────────────────┘
```

- 顶部：kind badge「验收」+ `第 N 轮交付` + `待你裁决`；右上保留 `RemainPill`（24h 提醒刻度不变）。
- 「任务：」行取 `human_requests.prompt`（落库时写入任务标题）——两侧同文，消除 id 错位的观感。
- 交付说明用 `MarkdownBody` 渲染（`renderer/src/components/im/MarkdownBody.tsx`），文件/产物分段带小标题（当前是裸 chip + 绿勾行，像选项）。
- 镜像行保留「来自 {节点} · {工作站}」徽标（既有无改动）。

### 4.2 执行方（只读）

```
┌─ [验收] 第 1 轮交付 · 等待发起方裁决 ─────────────────┐
│ 任务：提出三个「节气」散文主题（暂不写正文）            │
│ 交付说明 / 文件 / 产物（同 §4.1，只读）                │
│ 发起方在 node-a 上裁决，结果会显示在这里               │
└────────────────────────────────────────────────────────┘
```

无任何操作元素。`originNodeId === null` 时文案降级为「等待发起方裁决」。

---

## 5. 三动作语义（CONTRACT DEC-5 ~ DEC-9）

| 动作 | 语义 | 必填 | 卡片表现 | 状态机结果 |
|---|---|---|---|---|
| **继续** | 当前 run 验收通过，同一任务立即开续作 run | 下一步要求（1..4000 码点） | primary；点击就地展开「下一步要求」textarea + `发送要求并继续`；默认收起 | run#N `accepted`；task `in_progress`；新 run#N+1 `running`（trigger `continue`） |
| **完成** | 验收通过并结束任务 | 无 | secondary；点击弹 `ConfirmDialog`（「完成后任务不可撤销」） | run#N `accepted`；task `completed`（`acceptedAt = completedAt = now`） |
| **驳回** | 退回重做，任务不结束 | 驳回理由（1..4000 码点） | danger-outline；点击就地展开「驳回理由」textarea + `确认驳回` | run#N `rejected`；task `assigned`；worker 建 rework run 并注入理由 |

- **DEC-5 文案**：按钮名固定为 继续 / 完成 / 驳回。后果说明以常驻小字置于按钮行下方，不用 tooltip。
- **DEC-6 展开式输入**：「继续」「驳回」的文本框默认不渲染，选中动作后才展开；标签、placeholder、确认按钮文案随动作而异（不得复用同一个「打回理由」框）。
- **DEC-7 完成需确认**：`completed` 不可逆，`完成` 走 `components/ui/ConfirmDialog.tsx` 二次确认；确认取消则不动。
- **DEC-8 驳回沿用既有链路**：`ipc.task.reject(taskId, reason)` 语义与跨节点转发零改动；本次只改呈现与文案。
- **DEC-9 继续的 answerJson**：验收请求答复写 `{"decision":"accept","requirement":"<要求>"}`，让「这一轮通过时附带了什么要求」可在 `human_requests` 单表审计（无 schema 迁移）。

### 5.1 输入框分工（DEC-10 ~ DEC-11）

- **DEC-10 待裁决期禁用补充指令**：`RemoteSteerComposer` 在 `task.status === 'submitted'` 时禁用，placeholder 改「等待你的裁决——裁决后可继续补充指令」；`task === null` 时保持现状。
- **DEC-11 主进程守卫**：`steerTaskRouted`（`electron/src/main/task/ipc.handlers.ts`）在 `task.status === 'submitted'` 时人话拒绝：`任务待验收，请先裁决（继续 / 完成 / 驳回）后再补充指令`。防僵尸回合，两端一致。

---

## 6. 状态机与写路径（DEC-12 ~ DEC-16）

### DEC-12 新增合法边

`electron/src/main/storage/tasks/state-machine.ts`：`submitted` 的合法目标集增 `'in_progress'`。

- 注释锁死：该边**仅供 `acceptAndContinue` 单点**使用，`in_progress → completed` 直达边仍不存在，不变量①（completed 只能从 submitted 进）不变。
- 回归锁：`task-state-machine.test.ts` 增边断言 + `completed` 入口唯一性断言。

### DEC-13 run 触发值

`electron/src/main/storage/tasks/runs-repo.ts`：`TaskRunTrigger` 增 `'continue'`（DB 为 TEXT 列，无迁移）。返工上限 `effectiveMaxRuns` 只累计 `rejected` 触发，`continue` 不消耗配额——需加回归锁。

### DEC-14 唯一写者

`electron/src/main/task/lifecycle-runs.ts` 新增导出：

```
acceptAndContinue(taskId, requirement, byNodeId): void
```

单事务内（顺序即语义）：

1. `requireActiveRun(taskId)`，状态必须为 `submitted`（否则人话抛错）。
2. `requirement.trim()` 长度 1..4000，空白人话拒。
3. `updateRun(runN, { status: 'accepted', endedAt: now })`。
4. `answerAcceptance(taskId, runN, { decision: 'accept', requirement }, byNodeId)`（answerJson 见 DEC-9）。
5. `projectTaskStatus(taskId, 'in_progress')`。
6. `insertRun({ taskId, runNo: runN + 1, status: 'running', trigger: 'continue', executionSessionId })` + 任务 `currentRunId` 指向新 run。
7. 事务外：`emitRunChanged(accepted)` + `emitRunChanged(running)` + `emitHumanChanged(answered)`。

本地单机任务与 worker 远端消费（`handleTaskContinued`）共用此函数——守 write-path-consolidation 红线（`lifecycle-runs.ts` 是任务/run 唯一写者）。

### DEC-15 要求注入

worker 侧注入复用既有管线 `injectExecutionSessionNotice`（`remote-intervene-bridge.ts`）：

- 里程碑 `kind='continued'`，body：`【发起方要求继续】<requirement>\n完成后请再次调用 submit_task 提交。`
- meta：`{ runNo, requirement: truncateCodePoints(requirement, 79) }`。
- 路由语义同 steer（在途流注入当前流，空闲则开新回合）。
- 发起方跟踪会话同步落里程碑「已要求继续（第 N 轮通过）：<摘要>」。

### DEC-16 跨节点顺序

A 侧 `task:continue` IPC（`electron/src/main/task/ipc.handlers.ts` 新增 `continueTaskRouted`）：**远端先行，本地后落**。

1. 本地非委派任务（`delegationRole !== 'out'`）→ 直接 `acceptAndContinue`，无远端步骤。
2. 委派任务 → 先调 hub `task.continue`；成功后本地 `acceptAndContinue`。
3. 远端失败 → 人话 toast，卡片保持待裁决（可重试），本地零写入。
4. 远端成功、本地写失败（罕见）：下一轮 `task.submitted` 镜像会 `authoritativeReset` 回正，可自愈；日志 warn。

> 与 `accept`/`reject` 的「本地先行」有意不同：继续的本质是把活交给对方，本地先落会得到「A 已进入 N+1 轮、B 从未收到要求」的静默挂起，比「A 仍待裁决」难恢复得多。

IPC 面：`electron/src/preload/index.ts` + `renderer/src/ipc/types.d.ts` 增 `task.continue(taskId: string, requirement: string): Promise<TaskRow & { remoteWarning?: string }>`（与 `task.accept` 同形返回，便于卡片复用 `remoteWarning` 呈现）。

---

## 7. 协议 1.14.0（momo-hub）

### 7.1 新方法 `task.continue`（DEC-17）

- 请求 `TaskContinueReq { taskId: string; requirement: string }`（`requirement` trim 后 1..4000 码点）。
- 响应 `TaskContinueRes { runNo: number }`（= 新 run 号）。
- `METHOD_REQUIRED_MINOR[RPC.task.continue] = 14`。
- hub 校验：来源 = 委派发起方（信封鉴权 `by_node_id`），否则 `forbidden`；账本必须 `status='submitted'`，否则 `not_submitted`；执行节点连接 `peerProtoVer` minor ≥ 14，否则新错误码 `peer_version_unsupported`。
- 账本迁移：`submitted → running`，`run_no = run_no + 1`，`submitted_at` 保留（历史不清），`accepted_at` 不写（任务未结束）。
- 定向发 `task.continued` 给执行节点。

### 7.2 新事件 `task.continued`（DEC-18）

```
interface TaskContinuedEvent { taskId: string; runNo: number; requirement: string }
```

语义：`run #(runNo-1)` 已验收通过，请开 `run #runNo` 并按要求继续。worker 消费：

1. `resolveWorkerTask` → 无承接行 / 终态 / 非 `submitted` → 静默幂等收敛。
2. `acceptAndContinue(task.id, requirement, REMOTE_ORIGIN_BY)`。
3. `injectExecutionSessionNotice` 注入要求（DEC-15）。
4. 停靠项出清：`settleDocked` 联合类型扩为 `'accepted' | 'rejected' | 'continued'`；`'continued'` 分支只 `unwatch` + 出清停靠项，**不**把本地委派账本置 `done`（现状 `'accepted'` 会置 done——继续场景要置 `running`）。新 run 的回合终态到达后由 `localTaskAwaitingAcceptance` 重新停靠，链路自洽。

### 7.3 报告载荷增结构化交付物（DEC-19）

`TaskReportPayload` 增可选 `deliverable?: Record<string, unknown>`，仅 `submitted` 上报消费：

- hub 优先取 `payload.deliverable`，缺省回落既有「`reason` 当 JSON 解析」通道（旧节点零破坏）。
- 体积上限 16 KiB（`JSON.stringify` 字节数）；超限 hub 丢弃 `deliverable` 键并回落 reason 通道（记录 warn，不抛）。
- `task.submitted` 事件的 `deliverable` 键语义不变（`TaskSubmittedEvent.deliverable?` 已存在）。

studio 侧 `remote-intervene-bridge.ts`：

- `submitToHub` 同时发送 `reason = buildDeliverableReason(摘要)`（旧 hub 兼容，修成「summary 截断但保留 files/artifacts」）与 `deliverable = { summary, files, artifacts }`（hub ≥ 1.14 生效）。
- `buildDeliverableReason` 降级算法修订：预算内优先保 `files` + `artifacts`，summary 按剩余预算截断（现状是 summary-only，丢结构化信息）。

### 7.4 版本与门槛

- hub：`PROTOCOL_VERSION = '1.14.0'`，package `0.7.7`，tag `v0.7.7`。
- studio：`electron/package.json` pin 改 `github:bearangel/momo-hub#v0.7.7`。
- 发起方侧 `task:continue` 路径：hub `hubProtoVer()` minor < 14 → 「继续」按钮禁用并注明「对端 hub 版本不支持继续（需 1.14）」。
- 执行节点版本过低：hub 返回 `peer_version_unsupported` → toast「执行节点版本不支持继续，可改用完成或驳回」。

---

## 8. 跨节点保真（发起方呈现）

- 镜像消费（`remote-intervene-bridge.ts` 的 `task.submitted` 处理）已读 `p.deliverable`（`parseMirrorDeliverable`），本次只补「缺席即截断」的显式标注：`payload.remote.truncated = true`。
- 卡片读 `remote.truncated === true` 时在交付说明下方显示警示行：「交付内容经旧版通道截断，完整内容请在执行节点查看」（`text-status-warning`，非可点击）。
- 标题统一：`insertHumanRequest` 的 acceptance `title` 由 `T-… 提交验收（run #N）` / `#T-… 提交验收（run #N）` 改为 `第 N 轮交付`（两侧同形）；`prompt` 写入任务标题。历史行不改写（新卡才生效）。

---

## 9. 失败与降级矩阵

| 场景 | 行为 |
|---|---|
| hub < 1.14 | 「继续」禁用 + 说明；完成/驳回照常 |
| 执行节点 < 1.14 | `peer_version_unsupported` → toast，卡片保持待裁决 |
| 继续后 hub 不可达 | 远端失败 → toast，本地零写入，卡片保持待裁决 |
| 继续成功但注入失败 | run 照建，里程碑 warn，agent 经其它路径续跑（同 steer 语义） |
| `task.continued` 重复/迟到 | worker 非 `submitted` 静默收敛 |
| 返工上限 | `continue` 不占配额；驳回仍走既有 `effectiveMaxRuns` 与超限 `failed` |
| 旧卡（历史行无 `prompt`/无 `deliverable`） | 文案降级：标题仍显示旧 title，说明回退 `row.prompt`/summary |
| 任务在待裁决期被取消 | 既有取消链；卡片随请求 `cancelled` 消失（本次不动） |

---

## 10. 测试计划（回归锁）

**electron**

1. `state-machine`：`submitted → in_progress` 合法；`in_progress → completed` 仍非法；`completed` 入口唯一。
2. `lifecycle-runs` `acceptAndContinue`：单活动 run 不变量、非 submitted 拒绝、空白要求拒绝、新 run `trigger='continue'`、`answerJson` 含 requirement、返工配额不变。
3. `ipc.handlers`：`accept/reject` 对 `role='in'` 人话拒绝；`steer` 对 `submitted` 人话拒绝；`task:continue` 远端失败零本地写入。
4. `remote-intervene-bridge`：`handleTaskContinued` 验收+新 run+注入；重复事件幂等；`deliverable` 优先于 reason；截断降级保留 files/artifacts。
5. `human.ipc.handlers` 投影：`canDecide` 三态（本地 / out 镜像 / in 本机）。

**momo-hub**

6. `task.continue`：发起方校验、账本迁移与 `run_no+1`、`peer_version_unsupported`、非 submitted 拒绝。
7. 协议快照：`PROTOCOL_VERSION`、方法门槛表、新事件载荷形状。

**renderer**

8. `HumanRequestPanel`：三动作卡（继续/驳回展开必填门控、完成走确认、取消不动）、只读卡（零按钮零输入）、`truncated` 警示行、Markdown 渲染、历史行降级。
9. `RemoteSteerComposer`：`submitted` 禁用 + placeholder。
10. 入口真机复验（A/B 拓扑）：A 点继续 → B 收要求并开第 2 轮 → 再提交 → A 收到第 2 轮卡片且 summary/files/artifacts 与 B 完全一致；B 侧卡片全为只读。

---

## 11. 实施阶段建议

| 阶段 | 内容 | 可独立验收 |
|---|---|---|
| P1 权限收敛 | DEC-1~4（投影 canDecide + 只读卡 + IPC 守卫） | 是（B 侧不再可操作、A 侧不再被 B 抢先完成） |
| P2 卡片重构 | §4 布局 + §5 三动作呈现 + DEC-9~11（含 composer 禁用） | 是（继续/完成/驳回走既有通道：继续先临时映射为「驳回」不可用——见下） |
| P3 续作 run | DEC-12~16（状态机 + 写路径 + IPC + 本地单机闭环） | 是（单机任务可继续） |
| P4 协议与保真 | §7 全部 + §8（hub 1.14 + deliverable 通道 + pin 升级） | 是（跨节点继续 + 内容一致） |

> 四阶段在**同一分支**顺序推进（P1→P2→P3→P4），每阶段全绿再进下一阶段；「继续」按钮在 P3 完成前不渲染（不用打回冒充继续），避免中间态给出错误承诺。

---

## 12. 被否方案与风险

- **B2 派生续作任务**（验收通过 + 新建 `parentTaskId` 子任务，零协议改动）：被否——看板多一行、交付流断裂；保留为 P4 协议受阻时的回退备案。
- **仅改文案（两动作）**：被否——用户核心诉求「认可本轮 + 继续」无法表达。
- **提高 reason 上限代替结构化字段**：被否——污染 reason 语义、放大 ws 帧、仍需截断策略。
- **风险**：`submitted → in_progress` 新边是状态机首次允许「验收后回到进行中」，须以单点写者 + 回归锁把守；协议 1.14 要求两端同步升级，版本门与错误码已覆盖未升级场景。
