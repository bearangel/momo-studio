# 任务生命周期 v2 设计：人工介入、执行尝试与跨节点验收

- 日期：2026-11-13
- 状态：设计已逐节确认，spec 待用户复核
- 上游：
  - `docs/specs/2026-09-07-task-execution-runtime-design.md`（执行运行时 / 队列 / 委派目标）
  - `docs/specs/2026-10-13-dispatch-receipt-and-interrupt-cascade-design.md`（system 角色 / dispatch 回执 / 中断）
  - `docs/specs/2026-10-30-m5.3-delegation-team-mirror-model-design.md`（外派团队）
  - `docs/specs/2026-11-05-workgroup-peer-mode-design.md`（平行组 / 草稿委派）
- 交付物：studio 2.1.0-alpha.x + momo-hub 0.7.0（协议 1.11.0）

---

## 1. 背景与问题

任务系统最初定位是「记录 + 分发 + 串联多 agent / 多节点自动化」。真实链路（外部 TODO → 采集 agent → 研发团队 → 运维 + 测试 → 缺陷回流）中，任意一环都可能需要人。当前实现有三个结构性缺口（均有代码实证）：

1. **「需要人工」没有一等状态，信号落态不一致。**
   - `task_reply.status` 已有 `needs_input`（`electron/src/main/agent/dispatch.ts`），本地链把它映射成 `paused`（`dispatch-task-ledger.ts` `SETTLE_STATUS`），同步等待路径又把它当 `failed` reject（`dispatch-wait.ts`）。
   - 结果是：同一件事，有时显示暂停，有时直接失败；没有结构化原因、没有恢复入口。
2. **跨节点 HITL 只有「写授权」一种。**
   - hub `waiting` 账本态只由 `kind:'waiting-input'`（sandbox 写授权）进度拍驱动（`delegation-runner.ts` / `delegation-sync.ts`）。
   - `task.answer` 只有 `approve / deny`，`message` 仅审计、永不进入 agent 上下文。
   - 主节点无法提问、无法选择方案、无法要求人去机器上操作——「主节点无法指定」是协议能力缺失，不是配置问题。
3. **任务没有「执行尝试」层，完成是单方宣告。**
   - `tasks.execution_session_id` 一进 `in_progress` 即锁定不可改（`starter.ts`）；返工/重跑没有稳定锚点。
   - `completed` 由 agent `complete_task` 或接收方手动「完结」单方写入；「研发说完了」= 通过，验收环节形同虚设。
   - 会话删除不级联，`execution_session_id` 可悬空。

本设计把「任务」拆成三层：**任务（承诺）→ 执行尝试（run）→ 人工请求（request）**，并把验收变成两方契约。

---

## 2. 目标与非目标

### 2.1 目标

- G1 **人工介入一等公民**：四类介入（回合内工具门、回合结束式提问、人工操作确认、提交验收；选项即问答题载荷）统一建模、统一入口、可跨节点。
- G2 **执行尝试可审计**：同一任务多次执行/返工各有 run 记录，返工理由与旧 run 精确对应。
- G3 **完成 = 验收通过**：`completed` 只能由验收进入；agent 只能「提交」。
- G4 **跨节点闭环**：主从组发起人可代答；平行组人工请求不转发但提交/验收跨节点；断线/重启后请求与答复可恢复。
- G5 **会话即唯一交互入口**：请求卡、验收卡、里程碑都在会话内；会话列表用徽标提示注意力，不做独立收件箱页面。

### 2.2 非目标（scope 锁）

- 不做工作流引擎 / DAG 自动编排；`task_dependencies` 维持展示语义，不自动触发后续任务。
- 不做用户账号 / 角色鉴权；「人」= 节点所有者。
- 平行组不转发人工请求（节点所有者自行处理），只跨节点做提交/验收。
- 不做远端会话在发起方侧边栏的代理条目；完整对话只读抽屉放 P3。
- 不做主动 steer 的一等协议（P3 评估）。
- 不做任务编辑、per-agent 并发、cron、月度循环等既有票桶项。

---

## 3. 裁定记录

| # | 分叉 | 裁定 |
|---|---|---|
| 1 | 跨节点人工授权归属 | 按组模式分流：主从组发起人可代答、执行节点所有者本地优先，先答生效；平行组只由执行节点所有者答，人工请求不转发 |
| 2 | 任务完成语义 | 两段式「提交 → 验收」；验收默认手动，可开「自动验收」；打回带理由生成新 run |
| 3 | 人工介入形态 | ①回合内工具门（升级现有写授权）②回合结束式提问（新增）③人工操作确认（新增）④提交/验收 |
| 4 | 回复输入位置 | 会话为唯一交互入口；不做全局收件箱页面，会话列表顶部「待处理」分区 + 徽标；徽标文案「等待中」 |
| 5 | 发起方会话形态 | 本地委派跟踪会话（每个外派任务一个只读 task_execution 会话），不建远端会话代理 |
| 6 | 核心数据模型 | 三表：`tasks`（聚合）+ `task_runs`（执行尝试）+ `human_requests`（人工请求） |
| 7 | `complete_task` 语义 | 改为「提交」；新增 `submit_task`，旧名保留为别名 |
| 8 | 主动 steer | 放 P3 评估 |
| 9 | 平行组验收 | 人工请求不转发；提交/验收仍跨节点，谁下达谁验收 |

---

## 4. 术语

| 术语 | 定义 |
|---|---|
| 任务（Task） | 对某件事的承诺，看板单位；状态是聚合投影 |
| 执行尝试（Run） | 任务的一次完整执行；可跨多个回合，提交/失败/取消才结束 |
| 人工请求（HumanRequest） | 一次需要人做的事；有类型、载荷、受理人、截止时间、答复 |
| 回合内工具门 | 工具执行前卡住，答复后**原地继续同一回合** |
| 回合结束式提问 | agent 结束回合，答复后**同一 run 开新回合** |
| 提交（Submit） | 执行方声明交付，生成验收请求 |
| 验收（Accept / Reject） | 发起方（或指定验收人）通过或打回；打回生成新 run |
| 委派跟踪会话 | 发起方为外派任务创建的只读会话，承载里程碑与请求卡 |
| 等待中 | 会话/任务存在未决人工请求的展示徽标 |

---

## 5. 数据模型

### 5.1 任务状态机

`TaskStatus` 扩展为：

```
draft | pending | assigned | session_queued | in_progress
| waiting_human | submitted | paused
| completed | failed | cancelled
```

合法转换（单源 `storage/tasks/state-machine.ts`）：

```
draft          → pending | assigned | cancelled
pending        → assigned | cancelled
assigned       → in_progress | session_queued | failed | cancelled
session_queued → in_progress | failed | cancelled
in_progress    → waiting_human | submitted | paused | failed | cancelled
waiting_human  → in_progress | paused | failed | cancelled
submitted      → completed | assigned | cancelled | failed
paused         → in_progress | waiting_human | cancelled
completed / failed / cancelled → ∅
```

**不变量**

1. `completed` 只能由 `submitted` 进入（验收通过）；`in_progress → completed` 从状态机删除。
2. 提交前必须无未决人工请求（验收请求由提交本身生成，不算）。
3. `waiting_human` ⟺ 活动 run 存在未决非验收请求，且任务非 `paused`。
4. `paused` 优先于 `waiting_human` 展示；请求保持 pending，答复不自动恢复执行，需用户恢复。
5. 同一任务至多一个活动 run（`running | waiting_human | submitted`）。
6. 任务状态是活动 run + 暂停标志的投影，由生命周期服务单点写；禁止外部 `updateTask({status})` 直写（现有四处逃生门必须在本次收敛，见 §9.3）。
7. executor 只放行 `routing.mode='local'`（或 routing 为空）的 `assigned` 行；外派行（`delegation_role='out'`）的打回/续跑由 hub 链路驱动，本地不得重复拉起。

任务新增列：

| 列 | 类型 | 语义 |
|---|---|---|
| `current_run_id` | TEXT | 当前活动 run id（终态后保留最后一次） |
| `submitted_at` | INTEGER | 最近一次提交时刻 |
| `accepted_at` | INTEGER | 验收通过时刻 |
| `delegation_role` | TEXT | `'in'` / `'out'` / NULL；外派执行 / 委派跟踪判别 |
| `auto_accept` | INTEGER NOT NULL DEFAULT 0 | 提交后自动验收；`origin='dispatch'` 强制 1 |

### 5.2 `task_runs`（执行尝试）

| 列 | 类型 | 语义 |
|---|---|---|
| `id` | TEXT PK | uuid |
| `task_id` | TEXT NOT NULL | FK tasks ON DELETE CASCADE |
| `run_no` | INTEGER NOT NULL | 1 起；`UNIQUE(task_id, run_no)` |
| `status` | TEXT NOT NULL | `running / waiting_human / submitted / accepted / rejected / failed / cancelled` |
| `execution_session_id` | TEXT | 本次执行的会话 |
| `trigger` | TEXT NOT NULL | `initial / rework / quota_retry / manual`（resume 是回合级，不新建 run） |
| `started_at` / `ended_at` | INTEGER | |
| `deliverable_json` | TEXT | 提交载荷：摘要、文件、产物、测试结果 |
| `reject_reason` | TEXT | 打回理由 |
| `created_at` / `updated_at` | INTEGER | |

run 转换：

```
running        → waiting_human | submitted | failed | cancelled
waiting_human  → running | failed | cancelled
submitted      → accepted | rejected | cancelled | failed
accepted / rejected / failed / cancelled → ∅
```

**返工上限**：同一任务 run 数达到 10（可配）后拒绝再次打回，任务转 `failed`，理由「返工次数超限」——防止无限返工循环。

### 5.3 `human_requests`（人工请求）

| 列 | 类型 | 语义 |
|---|---|---|
| `id` | TEXT PK | uuid |
| `task_id` | TEXT NULL | 非任务会话的请求为 NULL |
| `run_id` | TEXT NULL | 所属执行尝试 |
| `session_id` | TEXT NOT NULL | 本地可操作会话（FK sessions ON DELETE CASCADE） |
| `delegation_id` | TEXT NULL | 跨节点委派关联 |
| `origin_node_id` | TEXT NULL | 镜像行：请求产生的节点；本地行为 NULL |
| `remote_id` | TEXT NULL | 镜像行：远端请求 id |
| `kind` | TEXT NOT NULL | `tool_gate / question / manual_action / acceptance` |
| `status` | TEXT NOT NULL | `pending / answered / expired / cancelled / superseded` |
| `title` | TEXT NOT NULL | 一行摘要 |
| `prompt` | TEXT NOT NULL DEFAULT '' | 正文 |
| `payload_json` | TEXT | 类型化载荷（见 §5.3.1） |
| `options_json` | TEXT | 选择题选项 |
| `assignee_node_id` | TEXT NULL | 主受理节点 |
| `authority_json` | TEXT | `{ nodes: string[], policy: 'first_wins' }` |
| `deadline_at` | INTEGER NULL | 截止时间 |
| `timeout_policy` | TEXT NOT NULL | `deny_and_wrap / keep_waiting / escalate / fail / cancel` |
| `last_reminded_at` | INTEGER NULL | 提醒去重 |
| `answer_json` | TEXT | 答复载荷 |
| `answered_by_node_id` | TEXT NULL | 答复节点 |
| `answered_at` | INTEGER NULL | |
| `created_at` / `updated_at` | INTEGER | |

约束：`UNIQUE(origin_node_id, remote_id)`（SQLite 中 NULL 互不冲突，本地行不受影响）。

请求状态：

```
pending → answered | expired | cancelled | superseded
其余 → ∅
```

- `superseded`：run 结束（submitted/failed/cancelled）时，未决**非验收**请求统一置此态。
- `expired`：超时策略为 `fail` / `cancel` 时由 sweeper 置态（不产生答复）；`deny_and_wrap` 走 `answered` + 自动 deny（`answered_by_node_id='system'`）。
- 验收请求不参与 `waiting_human` 判定；它对应任务 `submitted`。

#### 5.3.1 载荷与答复

```ts
type HumanAnswer = {
  decision?: 'approve' | 'deny' | 'accept' | 'reject'; // 工具门 / 验收
  text?: string;                                        // 附言 / 问答正文
  selected?: string[];                                  // 选项 id
  completed?: boolean;                                  // 人工操作确认
  reason?: string;                                      // 打回理由
};

type HumanPayload = {
  toolGate?: { toolName: string; command?: string; dirs: string[]; reason?: string };
  question?: { options?: Array<{ id: string; label: string; description?: string }>; multiSelect?: boolean };
  manualAction?: { steps: Array<{ id: string; label: string }>; expectedProof?: string };
  acceptance?: { runNo: number; summary: string; files: string[]; artifacts: Array<{ label: string; value: string }> };
};
```

### 5.4 会话关联与显示类型

不新增 `session_type` 枚举值。显示类型由结构 + 链接派生：

| 显示类型 | 判定 | 输入框 |
|---|---|---|
| 快速会话 | `session_type='quick'` | 可用 |
| 协作会话 | `session_type='collab'` | 可用 |
| 任务执行 | `kind='task_execution'`，`delegation_role IS NULL` | 可用 |
| 外派执行 | `kind='task_execution'`，`delegation_role='in'` | 可用 |
| 委派跟踪 | `kind='task_execution'`，`delegation_role='out'` | 禁用（只读） |

- 委派跟踪会话在派发成功（`delegation_id` 回写）时创建，标题 `#T-<id> · → <节点名>`，无成员。
- 外派任务在发起方把 `tasks.execution_session_id` 指向跟踪会话；执行节点侧仍指向自己的执行会话。发起方侧的 run 行 `execution_session_id` 同样指向跟踪会话（本地投影），真实执行的会话 id 由 `task.progress.sessionId` 携带、仅展示不落本地。
- 会话删除级联删除其未决请求（FK）；任务保留，`execution_session_id` 悬空由生命周期服务在下一次操作时标记失败/重建（不新增级联，保持现状语义）。
- **活动任务关联会话禁止删除**：任务处于 `in_progress / waiting_human / submitted` 时，删除其执行/跟踪会话返回人话错误（「任务进行中，请先取消或完结」）；终态任务放行。跟踪会话意外缺失时，任务详情可幂等重建（同一任务只保留一个跟踪会话）。

### 5.5 迁移

新增 `081_task_lifecycle_v2.ts` 与 `082_task_lifecycle_backfill.ts`（版本号顺延当前最大 080）。

**081（结构）**

```sql
ALTER TABLE tasks ADD COLUMN current_run_id TEXT;
ALTER TABLE tasks ADD COLUMN submitted_at INTEGER;
ALTER TABLE tasks ADD COLUMN accepted_at INTEGER;
ALTER TABLE tasks ADD COLUMN delegation_role TEXT;
ALTER TABLE tasks ADD COLUMN auto_accept INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN meta_json TEXT;

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  execution_session_id TEXT,
  trigger TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  deliverable_json TEXT,
  reject_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(task_id, run_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_active
  ON task_runs(task_id) WHERE status IN ('running','waiting_human','submitted');
CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, run_no);

CREATE TABLE IF NOT EXISTS human_requests (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES task_runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  delegation_id TEXT,
  origin_node_id TEXT,
  remote_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  title TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  payload_json TEXT,
  options_json TEXT,
  assignee_node_id TEXT,
  authority_json TEXT,
  deadline_at INTEGER,
  timeout_policy TEXT NOT NULL DEFAULT 'keep_waiting',
  last_reminded_at INTEGER,
  answer_json TEXT,
  answered_by_node_id TEXT,
  answered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(origin_node_id, remote_id)
);
CREATE INDEX IF NOT EXISTS idx_human_requests_session ON human_requests(session_id, status);
CREATE INDEX IF NOT EXISTS idx_human_requests_task ON human_requests(task_id, status);
CREATE INDEX IF NOT EXISTS idx_human_requests_assignee ON human_requests(assignee_node_id, status);
```

**082（回填）**

```sql
-- 存量执行中/暂停任务补 run #1（无则补）
INSERT INTO task_runs (id, task_id, run_no, status, execution_session_id, trigger, started_at, created_at, updated_at)
SELECT lower(hex(randomblob(16))), t.id, 1, 'running', t.execution_session_id, 'initial',
       COALESCE(t.started_at, t.created_at), t.created_at, t.updated_at
FROM tasks t
WHERE t.status IN ('in_progress','paused')
  AND NOT EXISTS (SELECT 1 FROM task_runs r WHERE r.task_id = t.id);

UPDATE tasks
SET current_run_id = (
  SELECT r.id FROM task_runs r
  WHERE r.task_id = tasks.id AND r.status IN ('running','waiting_human','submitted')
  ORDER BY r.run_no DESC LIMIT 1
)
WHERE current_run_id IS NULL;

-- 编排簿记行强制自动验收
UPDATE tasks SET auto_accept = 1 WHERE origin = 'dispatch';
```

**不回填、不猜测**：

- 存量 `paused` 无法区分「用户停止」与「needs_input 等待」——保留原状，文档标注。
- `delegation_role` 不在 SQL 回填（缺少 selfNodeId 判据）；由运行期单点写入：`dispatch-submit` 写 `'out'`，`delegation-sync.ensureRow` 写 `'in'`。存量活跃外派任务由 boot 对账补建跟踪会话与 `'out'`。
- 存量 `completed` 任务保持不变。

---

## 6. 生命周期

### 6.1 本地任务标准路径

```
assigned → executor 放行 → startRun(initial)
  → run running + 任务 in_progress + 执行会话 kickoff
  → [人工请求] 任务 waiting_human → 答复 → run running → 任务 in_progress
  → submitRun(deliverable) → run submitted + 任务 submitted + 生成 acceptance 请求
  → acceptTask → run accepted + 任务 completed
  → 或 rejectTask(reason) → run rejected + 任务 assigned + 新 run（trigger=rework）
```

### 6.2 回合内工具门（tool_gate）

1. sandbox 拦截写操作 → 创建 `human_requests(kind='tool_gate')`（**持久化**，替代现有仅内存的 pending 注册表）；有任务时 run → waiting_human、任务 → waiting_human；无任务会话只影响会话徽标。
2. 工具执行挂起等待答复（同一回合）。
3. 答复 `approve` → 授权写入、请求 answered、run running、工具原地重试；`deny` → 请求 answered、工具返回拒绝文本，agent 继续。
4. 重启后：本地 `tool_gate` 请求置 `expired`，下次恢复回合注入系统消息「授权请求已失效，请重试」；远端请求由 worker 重连对账处理。

### 6.3 回合结束式提问（question）

1. agent 调用 `request_human` 工具（`kind='question'`，可带选项）→ 创建请求 → **结束当前回合** → 有任务时 run waiting_human、任务 waiting_human；无任务会话只影响会话徽标。
2. 答复 → 请求 answered → 以 `sender='system'` 注入【人工答复】消息（含选项与附言）→ **同一 run 开新回合**。
3. 若答复明确「终止」→ 可直接 `cancelTask`（答复携带 `decision='reject'` 且任务级语义由调用方决定）。

### 6.4 人工操作确认（manual_action）

1. agent 调用 `request_human`（steps 清单）→ 结束回合，进入等待。
2. 人在会话请求面板逐项勾选 → `completed=true` + 附言 → 注入答复开新回合。
3. 超时默认 `escalate`：扩大受理人到发起方（主从组），不自动失败。

### 6.5 提交 / 验收 / 打回

- `submitRun`：要求无未决非验收请求；写 `deliverable_json`；run `submitted`；任务 `submitted`；创建 `acceptance` 请求（受理人 = 发起人；`auto_accept=1` 时立即 `acceptTask` 并记系统卡）。
- `acceptTask`：run `accepted`、任务 `completed`、`accepted_at`。
- `rejectTask`：run `rejected`、任务 `assigned`、记录 `reject_reason`；下一次放行创建 `run_no+1`（`trigger='rework'`）。跨节点时由发起方经 hub 下发，worker 生成新 run；发起方侧的 `assigned` 仅表示「等待远端重跑」，不触发本地 executor（§5.1 不变量 7）。
- 验收请求的 `assignee_node_id` 恒为任务发起节点（谁下达谁验收）；主从组可配「自动验收」；平行组同样由发起方验收。
- 验收答复不复用 `task.answer`：本地走 `task:accept` / `task:reject`，跨节点走 `task.accept` / `task.reject` RPC（§8.2），避免与四类请求的答复通道混淆。

### 6.6 失败 / 取消 / 暂停

| 动作 | 语义 |
|---|---|
| `failRun(reason)` | run failed，任务 failed；技术性失败（目标失效、kickoff 失败、心跳超时、返工超限） |
| `cancelTask(reason)` | run cancelled（若有），任务 cancelled；人为放弃，不算失败 |
| `pauseTask` | 任务 paused；run 保持原态；存在未决请求时徽标仍显示「等待中 N」；`resumeTask` 时若有未决请求 → waiting_human，否则 → in_progress |
| 配额受限 | 不落 failed；reset 任务 assigned + `scheduled_at`，下一次放行 `trigger='quota_retry'` |

### 6.7 超时策略

按类型默认：

| kind | 默认策略 | 默认截止 |
|---|---|---|
| `tool_gate` | `deny_and_wrap` | 15 分钟 |
| `question` | `keep_waiting`（到期提醒，不失败） | 30 分钟提醒 |
| `manual_action` | `escalate` | 30 分钟 |
| `acceptance` | `keep_waiting` | 24 小时提醒 |

> `escalate` 仅在主从组生效（扩大到发起节点）；平行组降级为 `keep_waiting`，不把请求转给发起方（§8.6 授权规则）。

sweeper 每 60s 扫描 `deadline_at`：

- `deny_and_wrap`：自动答复 `deny`（`answered_by_node_id='system'`），run 继续收尾。
- `fail` / `cancel`：按对应动作结束。
- `escalate`：扩大 `authority_json.nodes` 到发起节点并推送；请求保持 pending。
- `keep_waiting`：写 `last_reminded_at` 并推送一次提醒，不改变状态。

超时**不是** `failed`；默认策略（`keep_waiting` / `deny_and_wrap` / `escalate`）都不会落失败。只有显式选择 `fail` 策略（或 `cancel`）时，才把任务/run 置为对应终态。

### 6.8 重启恢复

- 未决 `question` / `manual_action` 请求持久化保留，答复后开新回合。
- 本地 `tool_gate` 请求置 `expired`，恢复回合注入重试提示。
- 远端 run 走既有 `handleOnline` 续传；worker 重连后拉取 `task.interventions` 应用未消费答复。
- 任务断点续跑（2026-09-10 spec）的恢复卡与请求面板并存：先显示未决请求，再显示恢复入口。

### 6.9 编排簿记行

`origin='dispatch'` 的任务：

- `auto_accept` 强制 1：提交即验收通过，避免 dispatch 子任务淹没验收面板。
- 仍允许 `request_human`；此时任务可进入 `waiting_human`，答复后继续。
- 会话/任务徽标照常，但验收徽标不出现。

---

## 7. 会话 = 唯一交互入口

### 7.1 三个视图（一套数据）

| 视图 | 职责 |
|---|---|
| 会话内**请求面板**（固定在输入框上方，未决时出现） | 四类请求的行动入口；显示 `N 项`，逐条展开答复；答复后该条消失 |
| 会话内**里程碑系统卡**（流内） | 已派发 / 已接收 / 已安排 / 执行中 / 已提交 / 验收通过 / 打回 / 失败 |
| 任务详情面板 / 看板卡 | 跨 run、跨节点聚合；run 时间线；验收与返工；只读总览 |

- 请求面板是**唯一行动入口**，避免历史滚动丢失；预览中的「流内请求卡」调整为面板 + 流内里程碑（实施前更新静态预览）。
- 三视图共用 `human_requests` 单表 + 推送，状态实时一致。

### 7.2 徽标与「待处理」分区

- 会话徽标（派生）：`等待中 N`（warning）> `待验收`（accent）> `失败`（error）。
- `待验收` 只出现在**验收方**会话（发起方跟踪会话 / 本地任务执行会话）；执行节点侧显示中性 `已提交`，不提供验收按钮。
- 会话列表保持既有排序（置顶 > 分组 > 活跃时间）；顶部增加可折叠「待处理 N」分区，列出有徽标的会话（不改变原列表排序）。
- 活动栏 / 工作空间项显示聚合未读数。
- 非任务会话（快速/协作）同样适用：`task_id IS NULL` 的请求参与徽标。

### 7.3 委派跟踪会话

- 创建：`submitRoutedTask` 成功回写 `delegation_id` 后，建 `kind='task_execution'` 会话，`delegation_role='out'`，`tasks.execution_session_id` 指向它。
- 内容：里程碑系统卡（`sender='system'`、`event_type='delegation_milestone'`、`meta_json` 结构化载荷）；请求面板承载远端人工请求与本方验收。
- 输入框禁用（只读）；「查看远端会话」按需只读抽屉（P3，hub view）。
- 失败重试（`retryDispatch`）沿用同一跟踪会话，不重复建。

### 7.4 只读守卫

- `delegation_role='out'` 会话：禁止发消息、禁止 @、禁止触发 agent；服务端与渲染端双防线（服务端 `sendUserMessage` 拒绝，渲染端隐藏 composer）。
- 远端会话抽屉：只读，不落本地消息表。

### 7.5 通知

- 请求创建、提醒、超时升级推送系统通知（复用既有统一通知分级）。
- 不做独立通知中心页面。

---

## 8. 跨节点协议（momo-hub 0.7.0 / 协议 1.11.0）

### 8.1 账本与表

`DelegationStatus` 扩展：

```
pending | running | waiting | submitted | done | failed | interrupted | cancelled
```

转换：

```
pending     → running | cancelled
running     → waiting | submitted | failed | interrupted | cancelled
waiting     → running | submitted | failed | interrupted | cancelled
submitted   → done | running（打回，新 run） | cancelled
interrupted → running（重连） | failed | cancelled
done / failed / cancelled → ∅
```

`delegations` 新增列：`run_no INTEGER NOT NULL DEFAULT 1`、`submitted_at`、`accepted_at`。

新增表：

```sql
CREATE TABLE IF NOT EXISTS delegation_interventions (
  id TEXT PRIMARY KEY NOT NULL,
  delegation_id TEXT NOT NULL,
  run_no INTEGER NOT NULL,
  kind TEXT NOT NULL,              -- tool_gate | question | manual_action（验收为发起方本地请求，不落 hub）
  status TEXT NOT NULL,            -- pending | answered | expired | cancelled | superseded
  payload_json TEXT NOT NULL,      -- title/prompt/payload/options/deadline
  answer_json TEXT,
  answered_by TEXT,
  answered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delegation_interventions_delegation
  ON delegation_interventions(delegation_id, status);
```

### 8.2 消息与载荷

**新增 RPC**

| 方法 | 方向 | 载荷 | 说明 |
|---|---|---|---|
| `task.intervene` | worker → hub | `{ taskId, intervention: { interventionId, runNo, kind, title, prompt, payload?, options?, deadlineAt? } }` | 创建请求；hub 持久化并定向转发发起方 |
| `task.interventions` | 任意方 → hub | `{ taskId? }` | 重连对账：拉取未决/已答请求；缺省返回本节点作为发起方或执行方的全部相关请求 |
| `task.accept` | origin → hub | `{ taskId, runNo }` | 验收通过 |
| `task.reject` | origin → hub | `{ taskId, runNo, reason }` | 打回，新 run |
| `task.answer` | **任意授权节点** → hub | 见下 | 双向答复；hub 转发对端 |

`task.answer` 载荷扩展（向后兼容）：

```ts
interface TaskAnswerReq {
  taskId: string;
  interventionId?: string;   // 缺省 = 旧写授权语义（兼容 1.10）
  decision?: 'approve' | 'deny' | 'accept' | 'reject';
  answer?: HumanAnswer;
  message?: string;          // 审计与附言；新版本会注入 agent 上下文
}
type TaskAnswerRes = { disposition: 'granted' | 'denied' | 'answered' | 'stale' };
```

**命名口径（必须单点）**：协议里的 `taskId` 恒为 **hub 委派 id**（`delegations.taskId` / 本地 `tasks.delegation_id`），不是本地 `T-xxx`；`interventionId` 在镜像行答复时使用 `remote_id`，本地 `human_requests.id` 仅作 UI/DB 主键。

**新增事件**

| 事件 | 定向 | 载荷 |
|---|---|---|
| `task.intervention` | origin | `{ taskId, intervention }` |
| `task.interventionAnswered` | 对端节点 | `{ taskId, interventionId, answer, answeredBy }` |
| `task.submitted` | origin | `{ taskId, runNo, deliverable }` |
| `task.accepted` | worker | `{ taskId, runNo }` |
| `task.rejected` | worker | `{ taskId, runNo, reason }` |

**扩展现有**

- `DelegationTask` 新增 `runNo?: number`（1 起，缺省 1）。
- `TaskReportPayload.status` 增 `'submitted'`，新增 `runNo?`。
- `TaskRecord` 投影增 `runNo`、`submittedAt`、`acceptedAt`。
- 旧 `kind:'waiting-input'` 进度拍保留（向后兼容），新节点以结构化 `task.intervene` 为准。

### 8.3 状态映射

| 本地（worker） | hub 账本 | 发起方（origin） |
|---|---|---|
| run running | running | 任务 in_progress |
| 未决非验收请求 | waiting | 任务 waiting_human |
| run submitted | submitted | 任务 submitted + 验收请求 |
| 验收通过 | done | 任务 completed |
| 打回 | running（run_no+1） | 任务 assigned → 新 run |
| run failed | failed | 任务 failed |
| 节点离线 | interrupted | 任务保持当前态，徽标「离线」 |
| 重连续跑 | running | 任务 in_progress |

### 8.4 离线与重连

- 答复与验收决定落在 hub 账本/请求行，不依赖对端在线。
- **发起方 run 懒建**：`task.report` / 事件携带 `runNo`，发起方按 `(taskId, runNo)` 幂等建 run 行；若首个到达的是 `submitted`（如断线期间完成），直接以 `submitted` 建行，不伪造 running。
- worker 重连：`task.interventions` 拉取未消费答复 + `task.list` 对账终态；幂等应用。
- origin 重连：`task.interventions` 重放未决请求；`task.list` 对账 `submitted/done/running`。
- 本地未知 `taskId` 的迟到答复：`stale`，仅审计。

### 8.5 版本门与兼容

- `PROTOCOL_VERSION = '1.11.0'`；`TASK_HITL_REQUIRED_MINOR = 11`。
- `task.intervene / task.interventions / task.accept / task.reject` 登记 `METHOD_REQUIRED_MINOR = 11`。
- `submitted` 状态与新载荷字段均要求双方 minor ≥ 11；派发预检在任一侧 < 11 时黄字提示并**降级为旧行为**（单方完成、仅写授权），不静默启用半套语义。降级任务强制 `auto_accept=1`（worker 的 done 直接落到 completed）。
- hub 先发版（0.7.0）→ studio 派发闸读取节点能力，避免半开。

### 8.6 授权规则

| 场景 | 人工请求答复 | 验收 |
|---|---|---|
| 本地任务 | 本节点所有者 | 本节点所有者 |
| 主从组外派 | 发起节点 + 执行节点均可，先答生效（`first_wins`） | 发起节点 |
| 平行组草稿 | **仅执行节点所有者**（hub 拒绝发起方答复） | 发起节点（谁下达谁验收） |
| 编排簿记行 | 本节点所有者 | 自动 |

- hub 按 `by_node_id` + 组模式 + 请求 `authority_json` 校验；越权返回 `forbidden`。**hub 是授权权威**；本地 `authority_json` 仅用于 UI 显隐提示。
- hub 路由口径：答复/请求转发到 `delegations.by_node_id`（发起节点）或 `targetNodeId`（执行节点）；节点身份取自信封鉴权，不信任载荷自报。
- **平行组不转发请求内容**：hub 只向发起方上报中性进度「执行方等待人工处理」，不发送 `task.intervention` 载荷；发起方 UI 显示等待状态但无答复入口。提交/验收事件照常转发。
- `answer.text / decision / selected / completed / reason` 进入 agent 上下文；`message` 为旧字段，仅审计与展示（兼容 1.10 调用方）。答复渲染为 system 消息，LLM 侧按 user 角色映射（沿用 2026-10-13 的 `mapsToUserRole`）。

---

## 9. Agent 工具与运行时

### 9.1 工具

| 工具 | 语义 |
|---|---|
| `request_human`（新增） | `{ kind: 'question'\|'manual_action', title, prompt, options?, deadlineMinutes? }`；创建请求并结束回合；返回 `{ requestId, status:'waiting' }` |
| `submit_task`（新增） | `{ summary, files?, artifacts? }`；提交当前 run，生成验收请求 |
| `complete_task`（保留别名） | 行为改为 `submit_task`；描述改写，避免旧提示词误导 |
| `fail_task`（保留） | 技术性失败；描述明确「需要人帮忙用 request_human，放弃用 cancel」 |

工具注入面不变（全部 agent 可用）；`request_human` 在无任务会话中同样可用（`task_id NULL`）。

### 9.2 运行时

- `request_human` 调用后：写请求 → 结束当前回合（`final` 带 `waiting_human` 标记）；有任务时 run waiting_human，无任务时仅会话徽标。
- 答复注入：内部 `sendUserMessage(systemKickoff:true)` 路径，`sender='system'`，正文【人工答复】+ 结构化答案；同一 run、新回合。
- 工具门：sandbox 的 pending 注册表改为 DB 请求；答复 resolve 挂起 Promise，原地重试。
- turn reconciliation 文案更新：回合结束时若任务未提交/未失败，提示 agent 调用 `submit_task` / `fail_task` / `request_human`。

### 9.3 写路径收敛（必须逐点改造）

| 现写入点 | 新路径 |
|---|---|
| `agent/tools/task-tools.ts` completeTask | `submitTask` |
| `task/move.ts` done（拖拽） | 本地验收方：`submitTask` + `acceptTask`（一步）；执行节点侧（`delegation_role='in'`）：仅 `submitTask` |
| `agent/dispatch-task-ledger.ts` SETTLE_STATUS completed | `submitTask`（`origin='dispatch'` 自动验收） |
| `hub/delegation-sync.ts` done 映射 | `handleRemoteSubmitted`（发起方）/ `handleRemoteAccepted`（worker） |
| `task/executor.ts` failQuietly / `lifecycle.ts` kickoff 失败 | `failRun` |
| `task/runtime-registry.ts` 用户停止 | `pauseTask` |
| `task/quota-resume.ts` | `resetForRetry`（新 run 触发） |
| `task/conflict-executor.ts` | `pauseTask` |
| `task/ipc.handlers.ts` transition | 生命周期服务白名单动作 |
| `storage/task-groups/repo.ts` 归档级联 | `cancelTask` |

**禁止**：任何模块直接 `updateTask({ status })`；生命周期服务是唯一写者（hub 同步作为服务适配器）。

---

## 10. IPC 与类型

新增通道（preload + `renderer/src/ipc/types.d.ts` 双端同步，双 workspace typecheck）：

| 通道 | 方向 | 载荷 |
|---|---|---|
| `human:list` | invoke | `{ sessionId?, taskId?, status? }` |
| `human:answer` | invoke | `{ requestId, answer, message? }` |
| `human:attention` | invoke | `{ workspaceId }` → `Record<sessionId, { waiting:number; submitted:boolean; failed:boolean }>` |
| `task:submit` | invoke | `{ taskId, deliverable }` |
| `task:accept` | invoke | `{ taskId }` |
| `task:reject` | invoke | `{ taskId, reason }` |
| `task:runs` | invoke | `{ taskId }` |
| `human:changed` | push | `{ sessionId, requestId?, kind }` |
| `task:runChanged` | push | `{ taskId, runId, status }` |

`SessionSummary` 扩展（`session:list` 消费方）：`delegationRole: 'in' | 'out' | null`、`readOnly: boolean`、`taskId: string | null`（`LEFT JOIN tasks ON tasks.execution_session_id = sessions.id`；同会话多任务时取最新非终态行）。渲染端按 §5.4 派生显示类型与只读态。

`human:attention` 的 `submitted` 仅在**本地是验收方**时置真（本地任务 / `delegation_role='out'`）；`delegation_role='in'` 用中性 `executorSubmitted` 渲染「已提交」，不出现验收按钮。

---

## 11. UI 变更清单与预览门禁

按 `momo-ui-preview-rules`，以下均为 P1，实施前必须出静态预览并确认：

1. 会话请求面板（四类 + 验收；未决/展开/超时预警三态）+ 明暗。
2. 会话列表徽标 + 「待处理」分区 + 活动栏未读。
3. 委派跟踪会话（只读、里程碑卡、请求面板）。
4. 看板新增 `等待中` / `待验收` 两列与卡片徽标。
5. 任务详情 run 时间线 + 验收/打回。

设计系统约束：只用语义 token；图标 lucide 16px / stroke 1.75；不使用 emoji；状态色统一走 `lib/task-status.ts`。

---

## 12. 迁移与兼容

| 面 | 处置 |
|---|---|
| 存量 `paused` | 保留原状，不猜测来源；新写入走新语义 |
| 存量 `in_progress` | 082 补 run #1 + `current_run_id` |
| 存量外派任务 | boot 对账补建跟踪会话 + `delegation_role='out'`（运行期，不在 SQL 猜测） |
| 存量 `completed` | 不变 |
| 旧版 studio 读新库 | 不支持降级：主进程与 renderer 同版本整体升级，迁移只随新版执行；发布说明标注回滚需清空活动任务 |
| 新 studio 读旧库 | 081/082 幂等；无 `task_runs` 时按需懒建 |
| 跨节点旧节点 | 任一侧 minor < 11 时降级旧行为；不静默半开 |
| 回滚 | 新表/新列保留不读；状态机旧代码不认识 `waiting_human/submitted` → 回滚前需清空活动任务（发布说明标注） |

---

## 13. 测试矩阵

### 13.1 状态机与 run

- 新增边全量：`in_progress→waiting_human→in_progress`、`in_progress→submitted→completed/assigned`、`paused→waiting_human`。
- `in_progress→completed` 非法（回归锁改红）。
- 单活动 run 唯一索引；`run_no` 递增；返工上限 10。
- 提交时有未决请求 → 拒绝。
- `origin='dispatch'` 自动验收。

### 13.2 人工请求

- 四类创建 / 答复 / 过期 / 取消 / superseded。
- `tool_gate` 原地继续；`question` 新回合；`manual_action` 清单。
- 重复答复幂等；已过期答复 `stale`；越权节点拒绝。
- 镜像行 `UNIQUE(origin_node_id, remote_id)` 幂等。
- 重启：`tool_gate` 过期 + 提示；`question` 保留。
- 超时五策略逐条：deny_and_wrap / keep_waiting / escalate / fail / cancel。

### 13.3 会话

- 跟踪会话创建/标题/只读守卫（服务端 + 渲染端）。
- 徽标聚合：等待中计数、待验收、失败、优先级。
- 「待处理」分区排序与空态。
- 非任务会话请求徽标。
- 里程碑 `meta_json` 契约（主进程产出 → renderer 消费）。

### 13.4 跨节点（SimHub 契约 + hub 套件）

- intervene → answer → worker 继续；answer 双向。
- submit → accept / reject → 新 run。
- 账本八态转换全边。
- worker/origin 断线重连对账（请求重放、答复应用、终态对账）。
- 版本门：任一侧 < 11 降级并提示；旧载荷兼容。
- 平行组：发起方答复被拒；验收可用。
- 主从组：双端先答生效。

### 13.5 迁移与回归

- 081/082 幂等、重复执行安全；存量 in_progress 补 run；dispatch 自动验收回填。
- 现有 9 态状态机测试、task 33 套件、hub 套件、dispatch 套件全绿（除有意变更的 `in_progress→completed`）。
- 双 workspace typecheck。

### 13.6 错误路径专项

- hub 离线时提交/答复/验收。
- worker 崩溃在 waiting；重启后请求状态。
- 会话删除时未决请求。
- 验收已通过后重复答复。
- 打回次数超限。
- 跟踪会话被用户删除后的任务状态。

---

## 14. 实施分期

| 期 | 内容 | 依赖 |
|---|---|---|
| **P1 本地闭环** | 081/082 迁移、三表、状态机、生命周期服务、四类请求、提交/验收/打回、会话请求面板 + 徽标、本地任务执行会话、跟踪会话数据模型与只读 UI 骨架（不接 hub）、看板两列（预览先行）、本地工具与运行时、测试 | 无 |
| **P2 跨节点** | hub 0.7.0 / 协议 1.11、intervene/answer/accept/reject、账本 `submitted`、外派跟踪会话创建与里程碑、离线对账、平行组规则、SimHub 与 e2e | P1 |
| **P3 打磨** | 主动 steer 评估、远端会话只读抽屉、通知细化、返工上限可配、看板/详情视觉打磨 | P2 |

P1 期间外派任务保持旧行为（单方完成）以免半套语义：`delegation_role IS NOT NULL` 的任务强制 `auto_accept=1`（提交即验收，等价旧「完成」），P2 移除该强制。P2 全量切换。

---

## 15. 风险与边界

| 风险 | 缓解 |
|---|---|
| 三表改造面大，写路径分散 | §9.3 逐点收敛；生命周期服务单点写；回归锁锁住旧路径 |
| 旧任务状态歧义（paused） | 不猜测；新写入启用新语义；发布说明标注 |
| 跨节点半开（一端升级） | 版本门 + 派发预检 + 降级旧行为 |
| 答复注入的提示注入风险 | 只接受授权节点答复；system 消息带固定前缀；内容长度上限 |
| 验收造成的流程停滞 | 默认手动但支持自动验收开关；超时提醒；`keep_waiting` 不误判失败 |
| 返工死循环 | run 上限 10，超限 failed |
| 跟踪会话消息膨胀 | 只写里程碑，不镜像对话；详情抽屉不落库 |

---

## 16. 验收标准

1. 本地任务：agent 提问 → 任务「等待中」→ 会话面板答复 → 同一 run 继续；不会出现 completed/failed 误标。
2. 回合内工具门：答复后原地继续，不新开回合；超时自动拒绝并收尾。
3. agent 只能提交；任务在发起方验收前保持 `submitted`，不会提前 `completed`。
4. 打回带理由生成新 run；run 时间线可审计；超 10 次返工转 failed。
5. 会话列表出现「等待中 / 待验收 / 失败」徽标与「待处理」分区；点击进入会话即可处理，无独立收件箱页面。
6. 外派任务在发起方生成只读跟踪会话，里程碑与请求面板可用；输入框禁用。
7. 主从组发起人可代答远端请求，执行节点本地也可答，先答生效；平行组发起方不能答人工请求，但可验收。
8. worker 离线时发起方仍可答复/验收；重连后幂等对账，无重复执行、无丢失答复。
9. 双方 minor < 11 时降级旧行为并提示，不出现半套语义。
10. 081/082 幂等；存量数据不丢；双 workspace typecheck、单测、hub 套件全绿。
