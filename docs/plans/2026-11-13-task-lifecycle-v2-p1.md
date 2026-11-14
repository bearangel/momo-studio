# 任务生命周期 v2 · P1 本地闭环 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec P1——三表（tasks 扩列 + task_runs + human_requests）、状态机新二态（waiting_human / submitted）、生命周期服务单点写、四类人工请求与提交/验收/打回、会话请求面板 + 徽标、看板七列；跨节点（P2）不在本计划。

**Architecture:** 任务状态降级为「活动 run + 暂停标志」的投影，由新服务 `task/lifecycle-runs.ts` 单点写（收敛全部 `updateTask({status})` 逃生门）；人工请求是持久化实体（human_requests 表），会话是唯一交互入口（请求面板固定在 composer 上方，徽标派生自请求计数 + 任务状态）；`completed` 只能经 `submitted → 验收` 进入。

**Tech Stack:** Electron 主进程（CommonJS + better-sqlite3，内联 SQL migration）、React renderer（Vite ESM）、vitest 双 workspace、zustand。

**Spec:** `docs/specs/2026-11-13-task-human-loop-lifecycle-design.md`（执行前必读；本 plan 只实现其 §14 P1 期，P2/P3 另出 plan）

## Global Constraints

- Node 24（`nvm use 24`）；包管理一律 `npx pnpm@9.0.0`
- TypeScript strict：禁 `any` / `@ts-ignore` / `as any`（ESLint no-explicit-any: error）
- 注释/文档中文，标识符英文；Conventional Commits（`feat:` / `test:` / `fix:` / `docs:` / `chore:`）
- 版本纪律：**只在 Task 25 把三处 `package.json` alpha +1**，此前任何任务不动版本号
- 单测位置：electron 集中 `electron/tests/` 镜像 `src/`；renderer 贴源 colocated（`Foo.test.tsx` 与组件同目录）——放别处不执行
- DB 重度目录（tests/storage、tests/task）单跑显式 `--pool=forks`；全量回归**裸 `vitest run`**（根目录 `npx pnpm@9.0.0 test`）
- 单文件测试命令模板：`cd electron && npx pnpm@9.0.0 vitest run tests/<path> --pool=forks`；renderer：`cd renderer && npx pnpm@9.0.0 vitest run src/<path>`
- IPC 面改动（preload 三层 `../../../` 引 renderer types.d.ts）→ 双 workspace `npx pnpm@9.0.0 typecheck` 必须过
- renderer UI：语义 token、lucide-react 图标 16px / stroke 1.75、禁 emoji 图标、状态色唯一来源 `renderer/src/lib/task-status.ts`（Task 19/20 为 P1 级 UI，**预览过审前不写产品代码**）
- 测试纪律：加载 `momo-test-rules`（业务逻辑用真实 DB/实现，mock 只打 runtime/electron 边界）；改功能前加载 `momo-feature-scope-rules`
- migration 版本号顺延：当前最大 080（`electron/src/main/storage/migrations/080_momo_capability_management_tools.ts`）→ 本计划用 081 / 082
- 每任务收尾跑该任务的测试文件；Task 25 才跑全量

## Review Focus

1. **答复与取消竞态**：请求 pending 期间任务被取消 → `answerHuman` 必须返回 `stale` 且**不唤醒 agent**（不注入 kickoff）→ Task 11 用例 `任务取消后答复返回 stale 且零注入`
2. **提交时仍有未决请求**：tool_gate 挂起时 agent 调 submit_task → `submitRun` 拒绝并人话告知（不变量 §5.1-2）→ Task 10 用例 `有未决 tool_gate 时提交被拒绝`
3. **并发 startRun 打破单活动 run**：部分唯一索引冲突 → 服务层捕获并幂等返回既有 run，不抛裸 SQL 错 → Task 9 用例 `并发 startRun 幂等返回同一 run`
4. **终态/无 run 任务收到 accept / reject**：迁移前的存量终态任务无 run → 明确人话拒绝，不静默 no-op → Task 10 用例 `无活动 run 时验收/打回拒绝`
5. **submitted 拖回 assigned 无理由**：空理由在主进程拒绝（不依赖 UI 校验）→ Task 8 用例 `打回缺理由主进程拒绝`

---

### Task 1: 消费面矩阵落盘（实现前置门禁）

**Files:**
- Create: `.omo/feature-matrices/2026-11-13-task-lifecycle-v2.md`（gitignored，落盘即产物）

**Interfaces:**
- Consumes: spec §3 裁定表、§9.3 写路径收敛表、`momo-feature-scope-rules` W1–W5
- Produces: 矩阵文件（Task 15/18 收敛与降级守卫的裁定依据；Task 25 验收回填证据列）

- [ ] **Step 1: 跑 W1 锚 grep，输出整理进「W1 消费点清单」节**

```bash
# 锚① 任务状态写入点（本计划要收敛的面）
grep -rn "transitionTaskStatus\|updateTask(.*status" electron/src --include="*.ts" | grep -v "\.test\." | grep -v "storage/tasks/repo"
# 锚② TaskStatus 类型消费点（renderer 两态新增的展示面）
grep -rn "TaskStatus" renderer/src --include="*.ts" --include="*.tsx" | grep -v "\.test\." | cut -d: -f1 | sort | uniq -c
# 锚③ 看板列/拖拽消费点
grep -rn "BoardColumnKey\|BOARD_COLUMNS\|canDropIntoColumn" electron/src renderer/src --include="*.ts" --include="*.tsx" | grep -v "\.test\." | cut -d: -f1 | sort | uniq
```

- [ ] **Step 2: 写矩阵主体**——行 = 锚①逐点（对照 spec §9.3 表逐行填「改/不改 + 新路径」）；列 = 写入点 / 状态展示面 / 看板面 / IPC 面。空格必须写理由
- [ ] **Step 3: 写「反查」节**（锚① ∖ §9.3 表的差集，逐点裁定或写「差集为空」）
- [ ] **Step 4: 写「门禁」节**——W4 八问逐项作答（重点：⑦ 生效层 = 状态机转换表 + executor 放行过滤，可见层 = 看板七列 + 徽标 + 详情面板；⑧ = 迁移 082 存量 in_progress 补 run 场景）
- [ ] **Step 5: 验证矩阵四节齐全**

Run: `grep -c "^## " .omo/feature-matrices/2026-11-13-task-lifecycle-v2.md`（期望 ≥ 4）

---

### Task 2: Migration 081（DDL：tasks 五列 + messages.meta_json + task_runs + human_requests）

**Files:**
- Create: `electron/src/main/storage/migrations/081_task_lifecycle_v2.ts`
- Modify: `electron/src/main/storage/migrations/index.ts`（MIGRATIONS 数组尾部追加条目，仿 080 条目注释风格）
- Test: `electron/tests/storage/task-lifecycle-migration-081.test.ts`

**Interfaces:**
- Consumes: `Migration` 类型（index.ts:60 `version: number` + `sql: string`）
- Produces: `version = 81`、`up`（DDL 字符串）；`task_runs` / `human_requests` 表（Task 6/7 的 repo 依赖）；tasks 新列（Task 5 依赖）

- [ ] **Step 1: 写失败测试（迁移后结构断言）**

```ts
// electron/tests/storage/task-lifecycle-migration-081.test.ts
// 迁移测试基座复用 tests/storage 既有 harness（内存库跑全量迁移）——
// 参照同目录既有 migration 测试的 setup 方式（getTestDb / 跑 loadMigrations）。
import { describe, it, expect } from 'vitest';
import { setupTestDb } from '../helpers/db'; // 既有测试 DB harness（按实际路径调整，见同目录任意 migration 测试 import）

describe('migration 081 task_lifecycle_v2', () => {
  it('tasks 新增五列可写可读', () => {
    const db = setupTestDb();
    db.prepare(
      `INSERT INTO tasks (id, workspace_id, title, status, creator_user_id, created_at, updated_at,
         current_run_id, submitted_at, accepted_at, delegation_role, auto_accept)
       VALUES ('T-1','ws','t','draft','u',0,0,NULL,NULL,NULL,'out',1)`,
    ).run();
    const row = db.prepare('SELECT delegation_role, auto_accept FROM tasks WHERE id=?').get('T-1') as {
      delegation_role: string; auto_accept: number;
    };
    expect(row.delegation_role).toBe('out');
    expect(row.auto_accept).toBe(1);
  });
  it('task_runs 单活动 run 部分唯一索引生效', () => {
    const db = setupTestDb();
    db.prepare(`INSERT INTO tasks (id, workspace_id, title, status, creator_user_id, created_at, updated_at)
       VALUES ('T-1','ws','t','in_progress','u',0,0)`).run();
    const ins = db.prepare(
      `INSERT INTO task_runs (id, task_id, run_no, status, trigger, started_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    ins.run('r1', 'T-1', 1, 'running', 'initial', 0, 0, 0);
    expect(() => ins.run('r2', 'T-1', 2, 'waiting_human', 'initial', 0, 0, 0)).toThrow();
    ins.run('r3', 'T-1', 3, 'failed', 'initial', 0, 0, 0); // 终态不占活动槽，不抛
  });
  it('human_requests 镜像唯一约束（origin_node_id+remote_id）且本地行不受限', () => {
    const db = setupTestDb();
    db.prepare(`INSERT INTO sessions (id, workspace_id, title, kind, created_at, updated_at)
       VALUES ('s1','ws','t','chat',0,0)`).run();
    const ins = db.prepare(
      `INSERT INTO human_requests (id, session_id, kind, status, title, timeout_policy, created_at, updated_at,
         origin_node_id, remote_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    ins.run('q1', 's1', 'question', 'pending', 't', 'keep_waiting', 0, 0, 'nodeA', 'rq1');
    expect(() => ins.run('q2', 's1', 'question', 'pending', 't', 'keep_waiting', 0, 0, 'nodeA', 'rq1')).toThrow();
    ins.run('q3', 's1', 'question', 'pending', 't', 'keep_waiting', 0, 0, null, null); // 本地行 NULL 互不冲突
  });
  it('messages.meta_json 列存在', () => {
    const db = setupTestDb();
    db.prepare(`INSERT INTO messages (id, room_id, sender, event_type, body, status, source, created_at, updated_at, meta_json)
       VALUES ('m1','s1','system','delegation_milestone','x','done','local',0,0,'{"k":1}')`).run();
    expect(db.prepare('SELECT meta_json FROM messages WHERE id=?').get('m1')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/task-lifecycle-migration-081.test.ts --pool=forks`
Expected: FAIL（no such column / no such table）

- [ ] **Step 3: 写迁移模块与注册**

```ts
// electron/src/main/storage/migrations/081_task_lifecycle_v2.ts
// 任务生命周期 v2（spec 2026-11-13 §5.5）：tasks 五列 + messages.meta_json +
// task_runs（执行尝试）+ human_requests（人工请求）。结构迁移；回填在 082。
export const version = 81;
export const up = `
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
`;
```

index.ts 注册（尾部追加，仿 080 条目）：

```ts
  {
    // 任务生命周期 v2（spec 2026-11-13 §5.5）：tasks 五列 / messages.meta_json /
    // task_runs / human_requests。SQL 住在独立模块 081_task_lifecycle_v2.ts。
    version: migration081.version,
    sql: migration081.up,
  },
```

（文件头 import 区补 `import * as migration081 from './081_task_lifecycle_v2';`，与 080 同式）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/task-lifecycle-migration-081.test.ts --pool=forks`
Expected: PASS（4 用例）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/storage/migrations/081_task_lifecycle_v2.ts electron/src/main/storage/migrations/index.ts electron/tests/storage/task-lifecycle-migration-081.test.ts
git commit -m "feat: migration 081 任务生命周期 v2 三表结构（task_runs/human_requests/tasks 五列）"
```

---

### Task 3: Migration 082（回填：run #1 + current_run_id + dispatch 自动验收）

**Files:**
- Create: `electron/src/main/storage/migrations/082_task_lifecycle_backfill.ts`
- Modify: `electron/src/main/storage/migrations/index.ts`（追加条目）
- Test: `electron/tests/storage/task-lifecycle-migration-082.test.ts`

**Interfaces:**
- Consumes: 081 的表结构
- Produces: `version = 82`；存量 `in_progress/paused` 任务具备 run #1（Task 9 startRun 的幂等前提）；`origin='dispatch'` 行 `auto_accept=1`

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/storage/task-lifecycle-migration-082.test.ts
// 种子方式：先用 081 完成后的库结构直接 INSERT 存量形态行，再手动执行 082 的 up，
// 断言回填结果（参照同目录 migration 测试的「先跑 081 之前版本、执行目标迁移」模式；
// 若 harness 支持按版本截断则用截断，否则手工执行 082.up）。
import { describe, it, expect } from 'vitest';
import { setupTestDbRaw } from '../helpers/db'; // 拿到 better-sqlite3 原始句柄（按既有 helper 实际名调整）
import * as m082 from '../../src/main/storage/migrations/082_task_lifecycle_backfill';

describe('migration 082 backfill', () => {
  it('存量 in_progress 补 run #1 + current_run_id；终态任务不补', () => {
    const db = setupTestDbRaw();
    const ins = db.prepare(`INSERT INTO tasks (id, workspace_id, title, status, creator_user_id, created_at, updated_at, started_at, origin)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    ins.run('T-act', 'ws', 'a', 'in_progress', 'u', 100, 100, 120, 'user');
    ins.run('T-done', 'ws', 'b', 'completed', 'u', 100, 100, 120, 'user');
    db.exec(m082.up);
    const run = db.prepare(`SELECT * FROM task_runs WHERE task_id='T-act'`).get() as { run_no: number; status: string; trigger: string };
    expect(run.run_no).toBe(1);
    expect(run.status).toBe('running');
    expect(run.trigger).toBe('initial');
    expect(db.prepare(`SELECT current_run_id FROM tasks WHERE id='T-act'`).get()).toEqual(
      db.prepare(`SELECT id AS current_run_id FROM task_runs WHERE task_id='T-act'`).get());
    expect(db.prepare(`SELECT COUNT(*) c FROM task_runs WHERE task_id='T-done'`).get()).toMatchObject({ c: 0 });
  });
  it('dispatch 簿记行回填 auto_accept=1；普通行不动', () => {
    const db = setupTestDbRaw();
    db.prepare(`INSERT INTO tasks (id, workspace_id, title, status, creator_user_id, created_at, updated_at, origin)
      VALUES ('T-d','ws','d','in_progress','agent:x',0,0,'dispatch'),('T-u','ws','u','in_progress','u',0,0,'user')`).run();
    db.exec(m082.up);
    expect(db.prepare(`SELECT auto_accept FROM tasks WHERE id='T-d'`).get()).toMatchObject({ auto_accept: 1 });
    expect(db.prepare(`SELECT auto_accept FROM tasks WHERE id='T-u'`).get()).toMatchObject({ auto_accept: 0 });
  });
  it('幂等：重复执行不产生第二个 run', () => {
    const db = setupTestDbRaw();
    db.prepare(`INSERT INTO tasks (id, workspace_id, title, status, creator_user_id, created_at, updated_at, origin)
      VALUES ('T-1','ws','t','in_progress','u',0,0,'user')`).run();
    db.exec(m082.up);
    db.exec(m082.up);
    expect(db.prepare(`SELECT COUNT(*) c FROM task_runs WHERE task_id='T-1'`).get()).toMatchObject({ c: 1 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**（`Cannot find module ... 082`）

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/task-lifecycle-migration-082.test.ts --pool=forks`

- [ ] **Step 3: 写迁移模块与注册**

```ts
// electron/src/main/storage/migrations/082_task_lifecycle_backfill.ts
// 任务生命周期 v2 回填（spec 2026-11-13 §5.5）：
//   1) 存量 in_progress/paused 任务补 run #1（无则补；幂等由 NOT EXISTS 保证）
//   2) current_run_id 指向活动 run
//   3) origin='dispatch' 簿记行强制 auto_accept=1（spec §6.9）
// 刻意不做：delegation_role 回填（SQL 缺 selfNodeId 判据，运行期单点写，spec §12）。
export const version = 82;
export const up = `
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

UPDATE tasks SET auto_accept = 1 WHERE origin = 'dispatch';
`;
```

index.ts 注册同 Task 2 式（import + 尾部条目，注释写「回填」）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/task-lifecycle-migration-082.test.ts --pool=forks`
Expected: PASS（3 用例）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/storage/migrations/082_task_lifecycle_backfill.ts electron/src/main/storage/migrations/index.ts electron/tests/storage/task-lifecycle-migration-082.test.ts
git commit -m "feat: migration 082 生命周期回填（存量 in_progress 补 run#1 / dispatch 自动验收）"
```

---

### Task 4: 状态机扩展（新二态 + 删 in_progress→completed 边）+ 双端 TaskStatus

**Files:**
- Modify: `electron/src/main/storage/tasks/state-machine.ts`（全文件重写转换表与注释）
- Modify: `renderer/src/ipc/types.d.ts:127-136`（TaskStatus 联合同步 +2）
- Test: `electron/tests/storage/task-state-machine.test.ts`（改写）、`electron/tests/storage/state-machine-session-queued.test.ts`（受影响用例修）

**Interfaces:**
- Consumes: 既有 `canTransition / assertTransition / isTerminal` 导出（9 个调用方不变）
- Produces: `TaskStatus` 新联合（11 值）；新增导出 `ACTIVE_TASK_RUN_STATUSES`、`TaskRunStatus`、`RUN_LEGAL_TRANSITIONS`、`canTransitionRun`（Task 6/9 消费）

- [ ] **Step 1: 改写状态机测试（先红）**

```ts
// electron/tests/storage/task-state-machine.test.ts —— 在既有用例基础上改写：
// 1) 全边枚举断言改为下方新表（逐边 it）
// 2) 追加：in_progress → completed 期望 false（语义变更回归锁）
// 3) 追加新边：in_progress→waiting_human / waiting_human→in_progress /
//    in_progress→submitted / submitted→completed|assigned|failed|cancelled /
//    paused→waiting_human
// 4) 追加 run 状态机：canTransitionRun 全边 + submitted→accepted|rejected|cancelled|failed
describe('task 状态机 v2', () => {
  it('in_progress → completed 非法（完成必须经 submitted 验收）', () => {
    expect(canTransition('in_progress', 'completed')).toBe(false);
  });
  it('waiting_human 双向与 submitted 出边', () => {
    expect(canTransition('in_progress', 'waiting_human')).toBe(true);
    expect(canTransition('waiting_human', 'in_progress')).toBe(true);
    expect(canTransition('waiting_human', 'paused')).toBe(true);
    expect(canTransition('in_progress', 'submitted')).toBe(true);
    expect(canTransition('submitted', 'completed')).toBe(true);
    expect(canTransition('submitted', 'assigned')).toBe(true);
    expect(canTransition('submitted', 'cancelled')).toBe(true);
    expect(canTransition('submitted', 'failed')).toBe(true);
    expect(canTransition('paused', 'waiting_human')).toBe(true);
  });
  it('run 状态机', () => {
    expect(canTransitionRun('running', 'waiting_human')).toBe(true);
    expect(canTransitionRun('waiting_human', 'running')).toBe(true);
    expect(canTransitionRun('running', 'submitted')).toBe(true);
    expect(canTransitionRun('submitted', 'accepted')).toBe(true);
    expect(canTransitionRun('submitted', 'rejected')).toBe(true);
    expect(canTransitionRun('submitted', 'running')).toBe(false); // 打回=新 run，不是转回
    expect(canTransitionRun('accepted', 'rejected')).toBe(false); // 终态
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/task-state-machine.test.ts --pool=forks`

- [ ] **Step 3: 实现状态机 v2**

```ts
// state-machine.ts 变更（保持既有导出名与签名，只扩内容）：
export type TaskStatus =
  | 'draft' | 'pending' | 'assigned' | 'session_queued'
  | 'in_progress' | 'waiting_human' | 'submitted' | 'paused'
  | 'completed' | 'failed' | 'cancelled';

const LEGAL_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  draft: new Set(['pending', 'assigned', 'cancelled']),
  pending: new Set(['assigned', 'cancelled']),
  assigned: new Set(['in_progress', 'session_queued', 'failed', 'cancelled']),
  session_queued: new Set(['in_progress', 'failed', 'cancelled']),
  in_progress: new Set(['waiting_human', 'submitted', 'paused', 'failed', 'cancelled']),
  waiting_human: new Set(['in_progress', 'paused', 'failed', 'cancelled']),
  submitted: new Set(['completed', 'assigned', 'cancelled', 'failed']),
  paused: new Set(['in_progress', 'waiting_human', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

// ── run 状态机（spec §5.2）──
export type TaskRunStatus =
  | 'running' | 'waiting_human' | 'submitted'
  | 'accepted' | 'rejected' | 'failed' | 'cancelled';
export const ACTIVE_TASK_RUN_STATUSES: readonly TaskRunStatus[] = ['running', 'waiting_human', 'submitted'];
const RUN_LEGAL: Record<TaskRunStatus, ReadonlySet<TaskRunStatus>> = {
  running: new Set(['waiting_human', 'submitted', 'failed', 'cancelled']),
  waiting_human: new Set(['running', 'failed', 'cancelled']),
  submitted: new Set(['accepted', 'rejected', 'cancelled', 'failed']),
  accepted: new Set(), rejected: new Set(), failed: new Set(), cancelled: new Set(),
};
export function canTransitionRun(from: TaskRunStatus, to: TaskRunStatus): boolean {
  return RUN_LEGAL[from].has(to);
}
// 头注同步改写：11 态说明 + 「completed 只能由 submitted 进入（验收）」+
// 「paused=用户停止/抢占，不是等人」两条不变量上注释。
```

renderer `types.d.ts` TaskStatus 同步 +2（`| 'waiting_human' | 'submitted'`，注释引用 spec §5.1）。

- [ ] **Step 4: 跑受影响测试套件**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/task-state-machine.test.ts tests/storage/state-machine-session-queued.test.ts --pool=forks`
Expected: PASS；若 session-queued 套件枚举了旧边集，按新表修用例（只修断言，不动语义）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/storage/tasks/state-machine.ts renderer/src/ipc/types.d.ts electron/tests/storage/task-state-machine.test.ts electron/tests/storage/state-machine-session-queued.test.ts
git commit -m "feat: 任务状态机 v2——waiting_human/submitted 二态 + run 状态机（完成必经验收）"
```

---

### Task 5: TaskRow 五列贯通（repo 读写 + renderer 镜像）

**Files:**
- Modify: `electron/src/main/storage/tasks/repo.ts`（TaskRow 接口 36-106、SqlRow、rowToCamel、updateTask SQL 315-361）
- Modify: `renderer/src/ipc/types.d.ts`（TaskRow 接口同步）
- Test: `electron/tests/storage/tasks-repo.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 4 的 TaskStatus
- Produces: `TaskRow` 新字段 `currentRunId: string | null` / `submittedAt: number | null` / `acceptedAt: number | null` / `delegationRole: 'in' | 'out' | null` / `autoAccept: boolean`（Task 9/18 与 renderer 消费）

- [ ] **Step 1: 追加失败测试**

```ts
// electron/tests/storage/tasks-repo.test.ts 追加：
it('五列读写贯通（delegation_role / auto_accept / 三个时间与 run 指针）', () => {
  const t = insertTask({ workspaceId: ws.id, title: 'x', creatorUserId: 'u' }); // 按既有 insertTask 签名
  expect(t.autoAccept).toBe(false);
  expect(t.delegationRole).toBeNull();
  updateTask(t.id, { delegationRole: 'out', autoAccept: true, currentRunId: 'r1', submittedAt: 1, acceptedAt: 2 });
  const after = getTask(t.id)!;
  expect(after).toMatchObject({ delegationRole: 'out', autoAccept: true, currentRunId: 'r1', submittedAt: 1, acceptedAt: 2 });
});
it('updateTask 不触碰新列时保值（全字段 UPDATE 回写current 而非 undefined）', () => {
  const t = insertTask({ workspaceId: ws.id, title: 'x', creatorUserId: 'u' });
  updateTask(t.id, { delegationRole: 'in', autoAccept: true });
  updateTask(t.id, { priority: 5 }); // 无关 patch
  expect(getTask(t.id)!.delegationRole).toBe('in');
  expect(getTask(t.id)!.autoAccept).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**（TS 编译错：属性不存在）

- [ ] **Step 3: 实现**

```ts
// repo.ts：
// 1) TaskRow 追加五字段（中文注释：spec §5.1 列表）
//    currentRunId: string | null; submittedAt: number | null; acceptedAt: number | null;
//    delegationRole: 'in' | 'out' | null; autoAccept: boolean;
// 2) SqlRow 追加 current_run_id/…/auto_accept（number|null|string|null）
// 3) rowToCamel 映射：delegationRole: r.delegation_role === 'in' || r.delegation_role === 'out' ? r.delegation_role : null,
//    autoAccept: r.auto_accept === 1
// 4) updateTask 的 UPDATE SQL 追加五列（SET 尾部 current_run_id=?, submitted_at=?, accepted_at=?, delegation_role=?, auto_accept=?）
//    与 .run(...) 参数尾部对应追加 next.currentRunId, next.submittedAt, next.acceptedAt, next.delegationRole, next.autoAccept ? 1 : 0
// 5) insertTask：新列走 SQL DEFAULT，不入 INSERT 列清单（insertTask 输入不加字段——
//    delegationRole/autoAccept 由生命周期/派发路径创建后 updateTask 写入）
```

renderer `types.d.ts` TaskRow 同步五字段（注释标「迁移 081，spec §5.1」）。

- [ ] **Step 4: 跑测试 + typecheck**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/tasks-repo.test.ts --pool=forks && cd .. && npx pnpm@9.0.0 typecheck`
Expected: PASS / 双 clean

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/storage/tasks/repo.ts renderer/src/ipc/types.d.ts electron/tests/storage/tasks-repo.test.ts
git commit -m "feat: TaskRow 生命周期五列贯通（current_run_id/submitted_at/accepted_at/delegation_role/auto_accept）"
```

---

### Task 6: task_runs repo

**Files:**
- Create: `electron/src/main/storage/tasks/runs-repo.ts`
- Test: `electron/tests/storage/task-runs-repo.test.ts`

**Interfaces:**
- Consumes: `TaskRunStatus / ACTIVE_TASK_RUN_STATUSES / canTransitionRun`（Task 4）；`getDb`
- Produces（Task 9/10 消费）:

```ts
export interface TaskRunRow {
  id: string; taskId: string; runNo: number; status: TaskRunStatus;
  executionSessionId: string | null; trigger: 'initial' | 'rework' | 'quota_retry' | 'manual';
  startedAt: number; endedAt: number | null; deliverableJson: string | null; rejectReason: string | null;
  createdAt: number; updatedAt: number;
}
export function nextRunNo(taskId: string): number
export function insertRun(input: { taskId: string; status: TaskRunStatus; trigger: TaskRunRow['trigger']; executionSessionId?: string | null; runNo?: number }): TaskRunRow
export function getRun(id: string): TaskRunRow | null
export function getActiveRun(taskId: string): TaskRunRow | null   // status IN active，run_no DESC LIMIT 1
export function updateRun(id: string, patch: Partial<Pick<TaskRunRow, 'status' | 'endedAt' | 'deliverableJson' | 'rejectReason' | 'executionSessionId'>>): void
export function listRuns(taskId: string): TaskRunRow[]            // run_no ASC
export function countRuns(taskId: string): number
```

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/storage/task-runs-repo.test.ts
// 覆盖：insert 默认 runNo=nextRunNo 递增 / getActiveRun 只回活动态最新 /
// updateRun 状态变更 / countRuns / 并发活动冲突（第二个活动 insert 抛 SqliteError，
// 断言 throws——服务层在 Task 9 捕获转幂等）。
// 种子：tasks 表插父行（FK）。
```

（用例骨架参照 Task 2 Step 1 的 INSERT 方式；此处不重复整段，测试需覆盖上述五点并给中文名）

- [ ] **Step 2: 跑测试确认失败**（module not found）

- [ ] **Step 3: 实现 runs-repo.ts**

```ts
// 实现要点：
// - insertRun 内部 const runNo = input.runNo ?? nextRunNo(taskId)；id = randomUUID()
// - updateRun 前置 canTransitionRun 校验（from=getRun(id).status；非法抛 Error 带 from/to），
//   终态拒绝再改（canTransitionRun 天然覆盖）
// - getActiveRun: WHERE task_id=? AND status IN ('running','waiting_human','submitted') ORDER BY run_no DESC LIMIT 1
// - 行转 camel（本地 rowToCamel，文件内私有）
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/task-runs-repo.test.ts --pool=forks`

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/storage/tasks/runs-repo.ts electron/tests/storage/task-runs-repo.test.ts
git commit -m "feat: task_runs repo（执行尝试读写单点 + run 状态机校验）"
```

---

### Task 7: human_requests repo

**Files:**
- Create: `electron/src/main/storage/tasks/human-requests-repo.ts`
- Test: `electron/tests/storage/human-requests-repo.test.ts`

**Interfaces:**
- Consumes: `getDb`
- Produces（Task 9/11/12/16 消费）:

```ts
export type HumanRequestKind = 'tool_gate' | 'question' | 'manual_action' | 'acceptance';
export type HumanRequestStatus = 'pending' | 'answered' | 'expired' | 'cancelled' | 'superseded';
export type HumanTimeoutPolicy = 'deny_and_wrap' | 'keep_waiting' | 'escalate' | 'fail' | 'cancel';
export interface HumanRequestRow {
  id: string; taskId: string | null; runId: string | null; sessionId: string;
  delegationId: string | null; originNodeId: string | null; remoteId: string | null;
  kind: HumanRequestKind; status: HumanRequestStatus; title: string; prompt: string;
  payloadJson: string | null; optionsJson: string | null;
  assigneeNodeId: string | null; authorityJson: string | null;
  deadlineAt: number | null; timeoutPolicy: HumanTimeoutPolicy; lastRemindedAt: number | null;
  answerJson: string | null; answeredByNodeId: string | null; answeredAt: number | null;
  createdAt: number; updatedAt: number;
}
export function insertHumanRequest(input: {
  sessionId: string; kind: HumanRequestKind; title: string;
  taskId?: string | null; runId?: string | null;
  prompt?: string; payloadJson?: string | null; optionsJson?: string | null;
  deadlineAt?: number | null; timeoutPolicy?: HumanTimeoutPolicy;
  assigneeNodeId?: string | null; authorityJson?: string | null;
}): HumanRequestRow
export function getHumanRequest(id: string): HumanRequestRow | null
export function listPendingBySession(sessionId: string): HumanRequestRow[]   // created_at ASC
export function listByTask(taskId: string): HumanRequestRow[]
export function countPendingNonAcceptance(runId: string): number
export function tryAnswer(id: string, answerJson: string, byNodeId: string): { ok: true } | { ok: false; reason: 'not_found' | 'not_pending' }  // 单条 UPDATE ... WHERE id=? AND status='pending'，原子防双答
export function markExpired(id: string): void
export function supersedePendingByRun(runId: string): number                 // 非验收 pending → superseded；返回条数
export function cancelPendingByTask(taskId: string): number
export function listDue(now: number): HumanRequestRow[]                      // deadline_at <= now（含 keep_waiting 提醒判定用）
```

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/storage/human-requests-repo.test.ts
// 覆盖：
// 1) insert/get 往返（timeoutPolicy 缺省 keep_waiting）
// 2) tryAnswer 原子性：两次并发 answer 只有第一次 ok（第二次 {ok:false,reason:'not_pending'}）
// 3) supersedePendingByRun 只动非验收：插 question(pending)+acceptance(pending) → 只 question 翻 superseded
// 4) listPendingBySession 排序 ASC、不含 answered
// 5) listDue 命中 deadline（now 之前），未设 deadline 不命中
// 6) 镜像唯一：同 (originNodeId, remoteId) 第二次 insert 抛（UNIQUE 冲突），本地行(NULL,NULL) 任意多条
// 种子：sessions 行（FK）+ tasks 行（task 用例）+ task_runs 行（run 用例）
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 human-requests-repo.ts**（逐接口按上方签名；tryAnswer 用 `UPDATE human_requests SET status='answered', answer_json=?, answered_by_node_id=?, answered_at=?, updated_at=? WHERE id=? AND status='pending'` + `changes` 判定）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/human-requests-repo.test.ts --pool=forks`

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/storage/tasks/human-requests-repo.ts electron/tests/storage/human-requests-repo.test.ts
git commit -m "feat: human_requests repo（人工请求持久化 + 原子答复 + 超期扫描）"
```

---

### Task 8: 看板七列（两镜像）+ move() 打回/验收路由

**Files:**
- Modify: `renderer/src/ipc/board-columns.ts`、`electron/src/main/task/board-columns.ts`（两镜像同步改）
- Modify: `renderer/src/ipc/types.d.ts`（BoardColumnKey +2、TaskApiSurface.move 加 opts）
- Modify: `electron/src/main/task/move.ts`（executeMove 新路由——本 task 只铺「路由桩」，真实动作在 Task 10 接 lifecycle-runs；桩=按列返回明确错误「生命周期服务未接线」？不行，任务必须独立可测——本 task 接 submit/accept/reject 到 lifecycle-runs 的**最小占位函数**（move 内 try/catch import？不：直接让本 task 依赖 Task 9/10 的顺序问题）
  **裁定：调整任务顺序依赖——本 task 只改 board-columns + move 的「列判定与参数校验」，把 submit/accept/reject 调用点写成对 `lifecycle-runs` 的调用并在 **Task 10 之后**补接线步骤。为保持任务独立可测，本 task 的 move 测试只锁：新列归属、禁投规则、打回缺理由主进程拒绝（此时 reject 分支抛「理由必填」即可先行）。**
- Test: `electron/tests/task/board-columns-sync.test.ts`（既有同步锁，更新）、`electron/tests/task/move-v2.test.ts`（新建）

**Interfaces:**
- Consumes: Task 4 新 TaskStatus
- Produces: `BoardColumnKey = 'backlog'|'assigned'|'active'|'waiting'|'review'|'done'|'closed'`；`move(id, target, opts?: { reason?: string })`

- [ ] **Step 1: 改两镜像 board-columns + 同步锁测试**

```ts
// 两文件同式（BOARD_COLUMN_KEYS、BOARD_COLUMNS、allowCross 三处）：
export const BOARD_COLUMN_KEYS = ['backlog', 'assigned', 'active', 'waiting', 'review', 'done', 'closed'] as const;
// BOARD_COLUMNS 插两列：
{ key: 'waiting', label: '等待中', statuses: ['waiting_human'], hint: '等人工（系统驱动）' },
{ key: 'review', label: '待验收', statuses: ['submitted'], hint: '已提交待验收' },
// allowCross 全量替换：
function allowCross(from: TaskStatus, to: BoardColumnKey): boolean {
  switch (to) {
    case 'backlog': return false;
    case 'assigned': return from === 'draft' || from === 'pending' || from === 'submitted'; // submitted→assigned = 打回
    case 'active': return from === 'assigned' || from === 'session_queued';
    case 'waiting': return false;                       // 等待中只能由系统进出
    case 'review': return from === 'in_progress';       // in_progress→review = 提交
    case 'done': return from === 'in_progress' || from === 'submitted'; // 一步提交+验收 / 验收通过
    case 'closed': return from !== 'completed';
  }
}
// renderer 侧 types.d.ts BoardColumnKey 同步七值；
// board-columns-sync.test.ts 既有「逐导出断言」自然锁同步（如断言列名集合需 +2，按测试失败信息更新期望值）。
```

- [ ] **Step 2: move.ts 新路由（校验先行版）+ 失败测试**

```ts
// electron/tests/task/move-v2.test.ts 核心用例（先红）：
// 1) waiting_human 行 columnOf → 'waiting'
// 2) submitted → assigned 且 opts.reason 缺省/空白 → move 抛「打回必须填写理由」（人话）
// 3) in_progress → review 路由到 submitRun（本 task 断言：reason 不需要；真实 submit 在 Task 10 后接线——
//    本 task 以 spy 模块边界？不可 mock 业务——裁定：本 task 把路由写成调用 lifecycle-runs 导出函数，
//    lifecycle-runs 在 Task 9 才存在 → 本 task 先创建 lifecycle-runs.ts 的**签名占位实现**（throw NotImplemented），
//    测试 3/4 标记 todo 跳过，Task 10 接线后回头补跑。用例文件同 commit 落下，vitest it.todo 占位。
// 4) submitted → done / submitted → closed 路由断言（同上 it.todo 接线后补）
```

- [ ] **Step 3: 实现 move 路由骨架**

```ts
// move.ts executeMove 追加分支（列判定先行、真实动作 import lifecycle-runs）：
//   case 判 to.column：
//   - 'review' && from.status === 'in_progress' → submitRun(id, { summary: '' })
//   - 'done' && from === 'in_progress' → submitRun 后 acceptTask（delegation_role='in' 只 submit——Task 18 守卫）
//   - 'done' && from === 'submitted' → acceptTask(id)
//   - 'assigned' && from === 'submitted' → reason 空白校验（本 task 实测点）→ rejectTask(id, reason)
//   - 'waiting' → 不可达（canDropIntoColumn 已禁；主进程兜底 throw）
// lifecycle-runs.ts 占位：export function submitRun/acceptTask/rejectTask —— 本 task 先
//   `throw new Error('lifecycle-runs 未接线（Task 10）')`，Task 10 替换为真实实现。
```

- [ ] **Step 4: 跑列判定与理由校验用例（接线组 it.todo 跳过）**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/move-v2.test.ts tests/task/board-columns-sync.test.ts --pool=forks`
Expected: PASS（todo 除外）

- [ ] **Step 5: Commit**

```bash
git add renderer/src/ipc/board-columns.ts electron/src/main/task/board-columns.ts renderer/src/ipc/types.d.ts electron/src/main/task/move.ts electron/src/main/task/lifecycle-runs.ts electron/tests/task/move-v2.test.ts electron/tests/task/board-columns-sync.test.ts
git commit -m "feat: 看板七列（等待中/待验收）+ move 打回理由校验与验收路由骨架"
```

---

### Task 9: lifecycle-runs 服务（一）：startRun / 等待投影 / failRun / cancel / pause / resume

**Files:**
- Create: `electron/src/main/task/lifecycle-runs.ts`（替换 Task 8 占位为真实文件，本 task 先落 run 管理 + 投影；submit/accept/reject 仍占位）
- Modify: `electron/src/main/task/executor.ts`（放行成功处改调 `startRun`——写路径收敛第一站）
- Test: `electron/tests/task/lifecycle-runs-core.test.ts`

**Interfaces:**
- Consumes: runs-repo（Task 6）、human-requests-repo（Task 7）、`transitionTaskStatus / updateTask / getTask`（repo.ts）
- Produces（Task 10/11/13/15 消费）:

```ts
export const MAX_RUNS_PER_TASK = 10;
export function startRun(taskId: string, opts?: { trigger?: 'initial' | 'rework' | 'quota_retry' | 'manual'; executionSessionId?: string | null }): TaskRunRow
  // 语义：ensure 语义——已有活动 run 直接返回它（幂等，Review Focus #3）；
  // countRuns >= MAX_RUNS_PER_TASK → throw 人话；插 run(running) + updateTask({currentRunId}) +
  // 任务非终态时 transitionTaskStatus(task.status → 'in_progress')（draft 快路径 assigned→in_progress 由调用方先行，
  // 此处统一走 in_progress 边；paused 恢复路径不走 startRun——resumeTask 保留 paused→in_progress）
export function enterWaitingHuman(taskId: string): void
  // 活动 run → waiting_human + transitionTaskStatus(task → 'waiting_human')；任务 paused 时不改任务态（只改 run）
export function resumeFromWaiting(taskId: string): void
  // 活动 run → running + 任务 waiting_human → in_progress；paused 不动
export function failRun(taskId: string, reason: string): void
  // 活动 run → failed(endedAt) + supersedePendingByRun + 任务 → failed（errorMessage=reason）
export function cancelActiveRun(taskId: string, reason?: string): void
  // 活动 run → cancelled + supersedePendingByRun + 任务 → cancelled
export function pauseForTask(taskId: string, errorMessage?: string): void
  // 任务 → paused（in_progress|waiting_human 边都合法）；run 状态不动（spec §6.6）
export function resumePaused(taskId: string): void
  // paused →（有未决非验收请求 ? waiting_human : in_progress）
export function refreshTaskProjection(taskId: string): void
  // 单点投影（不变量 §5.1-6）：按活动 run 状态 + paused + 未决请求重算任务状态；
  // 已在目标态则 no-op（transitionTaskStatus 对同态会抛，需先 canTransition 判或同态跳过）
```

- [ ] **Step 1: 写失败测试**（`electron/tests/task/lifecycle-runs-core.test.ts`）

```ts
// 用例清单（真实 DB，无 mock）：
// 1) startRun 建 run#1 + 任务 in_progress + currentRunId 回写
// 2) 并发幂等（Review Focus #3）：先 insert 活动行后 startRun → 返回既有行不抛
// 3) enterWaitingHuman/resumeFromWaiting 双向 + 任务态联动
// 4) paused 优先：pauseForTask 在 waiting_human 时任务 → paused、run 仍 waiting_human；
//    resumePaused → waiting_human（有未决请求时）/ in_progress（无）
// 5) failRun：run failed + 请求 superseded + 任务 failed + errorMessage
// 6) MAX_RUNS 上限：种 10 个终态 run 后 startRun → 人话 throw
// 7) refreshTaskProjection 同态 no-op 不抛
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现服务核心**

```ts
// 实现要点：
// - startRun 幂等：const active = getActiveRun(taskId); if (active) return active;
//   唯一索引竞态兜底：insertRun try/catch SQLITE_CONSTRAINT → 重新 getActiveRun 返回
// - 状态写一律走 transitionTaskStatus（合法边），同态跳过：if (task.status !== target && canTransition(task.status, target))
// - 事务：db.transaction 包「插 run + updateTask + transition」三步（better-sqlite3 同步事务）
// - executor.ts 接线：原 startTask 成功路径（starter.ts:144 transitionTaskStatus in_progress 处）
//   改为：先 transition（保留既有决策树/会话创建），成功后 startRun(taskId, { trigger:'initial', executionSessionId })
//   ——startRun 幂等保证 boot 重扫/双触发不重复建 run
```

- [ ] **Step 4: 跑测试 + executor 回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/lifecycle-runs-core.test.ts tests/task --pool=forks`
Expected: PASS；executor 既有套件绿（starter 行为不变，只是补 run 记账）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/task/lifecycle-runs.ts electron/src/main/task/executor.ts electron/tests/task/lifecycle-runs-core.test.ts
git commit -m "feat: lifecycle-runs 服务核心（run 生命周期 + 任务状态投影单点）"
```

---

### Task 10: lifecycle-runs 服务（二）：submitRun / acceptTask / rejectTask

**Files:**
- Modify: `electron/src/main/task/lifecycle-runs.ts`（替换占位实现）
- Modify: `electron/src/main/task/move.ts`（Task 8 的 it.todo 接线组转正）
- Test: `electron/tests/task/lifecycle-runs-submit.test.ts`、`electron/tests/task/move-v2.test.ts`（todo 转正）

**Interfaces:**
- Consumes: Task 9 服务核心
- Produces（Task 14 工具面 / Task 16 IPC / Task 18 消费）:

```ts
export interface DeliverableInput { summary: string; files?: string[]; artifacts?: Array<{ label: string; value: string }> }
export function submitRun(taskId: string, deliverable: DeliverableInput): TaskRunRow
  // 校验：活动 run 存在；countPendingNonAcceptance(run.id) === 0 否则人话拒（Review Focus #2）
  // run → submitted（deliverable_json 落库）+ 任务 in_progress|waiting_human → submitted（submitted_at=now）
  // 生成 acceptance 请求（sessionId=任务 execution_session_id，taskId/runId 关联，
  // timeoutPolicy='keep_waiting'，deadlineAt=24h 提醒）——任务无 execution_session_id 时挂 source_session_id，两者皆无则抛人话
  // auto_accept=1 → 立即 acceptTask（记 answer answeredByNodeId='system:auto'）
export function acceptTask(taskId: string): TaskRow
  // 活动 run.status='submitted' 否则人话拒（Review Focus #4）；run → accepted(endedAt)；
  // acceptance 请求 tryAnswer({decision:'accept'})；任务 submitted → completed（accepted_at/completed_at）
export function rejectTask(taskId: string, reason: string): TaskRow
  // reason 空白人话拒；run → rejected(reject_reason) + acceptance 请求 tryAnswer({decision:'reject', reason})；
  // countRuns+1 > MAX → 人话拒并建议取消；任务 submitted → assigned（回到队列，trigger='rework' 的 run 在下次 startRun 建）
```

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/task/lifecycle-runs-submit.test.ts 用例清单：
// 1) 提交全链：startRun → submitRun({summary}) → run submitted + 任务 submitted + acceptance 请求 pending + submitted_at
// 2) 未决 tool_gate 时提交被拒（Review Focus #2，人话含「先处理未决请求」）
// 3) accept：任务 completed + accepted_at + acceptance answered；再 accept → 人话拒（Review Focus #4）
// 4) reject 带理由：任务 assigned + run rejected + 理由落库；空理由拒（与 move 校验双保险）
// 5) reject 后再 startRun：run#2 trigger='rework'
// 6) auto_accept=1（含 origin='dispatch' 回填行）：submit 即 completed，无 pending acceptance 残留
// 7) 返工上限：reject 到第 10 个 run 后再 reject → 人话拒
// 8) 无 run 终态任务 submit/accept → 人话拒（Review Focus #4）
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**（占位三函数替换为真实逻辑；acceptance 请求 insert 用 human-requests-repo）

- [ ] **Step 4: move it.todo 转正 + 跑两组测试**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/lifecycle-runs-submit.test.ts tests/task/move-v2.test.ts --pool=forks`
Expected: 全 PASS（含 Task 8 留下的 4 个接线用例）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/task/lifecycle-runs.ts electron/src/main/task/move.ts electron/tests/task/lifecycle-runs-submit.test.ts electron/tests/task/move-v2.test.ts
git commit -m "feat: 提交/验收/打回三动作（两段式完成语义 + 返工上限 + 自动验收）"
```

---

### Task 11: requestHuman / answerHuman + 答复系统消息注入

**Files:**
- Modify: `electron/src/main/task/lifecycle-runs.ts`（追加两函数）
- Create: `electron/src/main/task/human-answer-inject.ts`（答复唤醒注入，独立小模块）
- Test: `electron/tests/task/lifecycle-runs-human.test.ts`

**Interfaces:**
- Consumes: human-requests-repo、enterWaitingHuman/resumeFromWaiting（Task 9）、`sendSystemKickoffMessage`（本 task 新建，见下）
- Produces（Task 13 tool_gate / Task 14 request_human 工具 / Task 16 IPC 消费）:

```ts
export interface HumanAnswerInput {
  decision?: 'approve' | 'deny' | 'accept' | 'reject';
  text?: string; selected?: string[]; completed?: boolean; reason?: string;
}
export function requestHuman(input: {
  sessionId: string; kind: 'question' | 'manual_action'; title: string; prompt: string;
  taskId?: string | null; runId?: string | null;
  optionsJson?: string | null; payloadJson?: string | null;
  deadlineMinutes?: number; timeoutPolicy?: HumanTimeoutPolicy;
}): HumanRequestRow
  // 插请求 + 有 run 时 enterWaitingHuman；不结束回合（回合结束由调用方 runtime 决定）
export function answerHuman(requestId: string, answer: HumanAnswerInput, byNodeId: string): { disposition: 'answered' | 'stale' }
  // tryAnswer 原子；stale 直接返回（Review Focus #1——任务/run 已终态时不注入）
  // kind 分派：
  //   tool_gate → 回调 onToolGateAnswer（Task 13 注册：approve→grantWriteDirs / deny→broadcastWriteGrantDenied）
  //   question|manual_action → resumeFromWaiting + humanAnswerInject 系统消息唤醒
  //   acceptance → 语义上不应走此通道（IPC 层 task:accept/reject），到者 throw 契约错
```

```ts
// human-answer-inject.ts：
// sendSystemKickoffMessage(sessionId, body, metaJson?)：仿 router-service.deliverChainResult 既有模式——
//   1) insertMessage(sender='system', event_type='human_answer', body, meta_json)
//   2) pushSessionMessage 推送（实时可见）
//   3) router.routeUserChat(sessionId, { systemKickoff: true, body })（唤醒新回合）
// body 模板：【人工答复】<结构化摘要>（选项/附言/操作确认结果 + reason），中文，≤500 字截断
```

- [ ] **Step 1: 写失败测试**

```ts
// 用例清单（router 边界 mock：只 mock routeUserChat/push，DB 真实）：
// 1) requestHuman(question)：请求 pending + 任务 waiting_human + run waiting_human
// 2) answerHuman：请求 answered + 任务 in_progress + system 消息 1 条（sender='system'、body 前缀【人工答复】）+ routeUserChat 调用 1 次（systemKickoff=true）
// 3) 任务取消后答复（Review Focus #1）：cancelActiveRun 后 answerHuman → {disposition:'stale'} + 零消息 + 零 routeUserChat
// 4) manual_action completed=false + text：同样注入（正文含说明文本）
// 5) acceptance kind 走 answerHuman → throw 契约错
// 6) 双答幂等：第二次 answerHuman → stale
```

- [ ] **Step 2: 跑测试确认失败** → **Step 3: 实现** → **Step 4: 跑通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/lifecycle-runs-human.test.ts --pool=forks`

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/task/lifecycle-runs.ts electron/src/main/task/human-answer-inject.ts electron/tests/task/lifecycle-runs-human.test.ts
git commit -m "feat: requestHuman/answerHuman 与【人工答复】系统注入（stale 防竞态）"
```

---

### Task 12: 超时 sweeper（五策略）

**Files:**
- Create: `electron/src/main/task/human-timeout-sweeper.ts`
- Test: `electron/tests/task/human-timeout-sweeper.test.ts`

**Interfaces:**
- Consumes: `listDue / markExpired / tryAnswer`（Task 7）、`answerHuman / failRun / cancelActiveRun`（Task 9/11）
- Produces: `sweepHumanTimeouts(now?: number): { processed: number }`（主进程 60s interval 注册——注册点放 Task 16 IPC 聚合处，本 task 纯函数可测）

- [ ] **Step 1: 写失败测试**

```ts
// 用例（DB 时间用注入 now 控制 deadline）：
// 1) deny_and_wrap 到期：请求 answered（answered_by='system:timeout'，answer={decision:'deny'}）+ tool_gate 回调触发 + run 保持（不失败）
// 2) keep_waiting 到期：状态不变 + lastRemindedAt 写入（二次 sweep 不重复提醒）
// 3) fail 到期：请求 expired + failRun（任务 failed）
// 4) cancel 到期：请求 expired + 任务 cancelled
// 5) escalate 到期：状态不变（P1 无跨节点，仅提醒；authority 扩展留 P2）——断言 no-op + lastRemindedAt
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现**（switch timeoutPolicy；deny_and_wrap 复用 answerHuman(requestId, {decision:'deny'}, 'system:timeout')）

- [ ] **Step 4: 跑通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/human-timeout-sweeper.test.ts --pool=forks`

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/task/human-timeout-sweeper.ts electron/tests/task/human-timeout-sweeper.test.ts
git commit -m "feat: 人工请求超时 sweeper（deny_and_wrap/keep_waiting/escalate/fail/cancel 五策略）"
```

---

### Task 13: tool_gate 持久化接线（写授权卡 → human_requests）

**Files:**
- Modify: `electron/src/main/sandbox/write-blocked-emit.ts`（信号产生处同步落请求行；grant/deny/清理处同步答复）
- Test: `electron/tests/task/tool-gate-persistence.test.ts`（新）+ 既有 sandbox 写授权套件回归

**Interfaces:**
- Consumes: `insertHumanRequest / getHumanRequest / tryAnswer`（Task 7）、`answerHuman` 的 tool_gate 分派钩子（Task 11）
- Produces: `registerToolGateRequest(signal: WriteBlockedSignal): HumanRequestRow`（生命周期消费）；请求行 `payload_json = { toolGate: { toolName:'bash', command, dirs, reason } }`、`timeout_policy='deny_and_wrap'`、`deadline_at=now+15min`

- [ ] **Step 1: 写失败测试**

```ts
// 用例：
// 1) WriteBlockedSignal → human_requests 行落库（kind=tool_gate、payload 含 command/dirs）+ 内存 pending 注册表照旧（双写）
// 2) 面板答复 approve → grantWriteDirs('session') 等价调用（dirs 来自 payload）+ 请求 answered + pending 清理
// 3) 答复 deny → broadcastWriteGrantDenied 等价 + 请求 answered
// 4) 重启恢复：boot 时 pending tool_gate 请求（origin 本地、run 已失联）置 expired——
//    导出 recoverOrphanToolGates()，扫 pending tool_gate 且对应会话无活动流 → markExpired + 注入「授权请求已失效」steer/系统消息由 Task 14 的恢复链处理（此处只断言 expired）
// 5) sweeper 自动拒绝（Task 12 联动）：deny_and_wrap 到期 → broadcastWriteGrantDenied 路径触发
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现**（write-blocked-emit 在既有 pendingWriteBlocked.set 处并写 DB；answerHuman 的 tool_gate 分派调用本模块注册的回调——回调注册 API：`setToolGateHandler(fn: (requestId, payload, approve: boolean) => void)`，避免循环依赖：lifecycle-runs 定义 hook 容器，write-blocked-emit 启动时注入）

- [ ] **Step 4: 跑通过 + 既有 write-grant 套件回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/tool-gate-persistence.test.ts tests/sandbox --pool=forks`

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/sandbox/write-blocked-emit.ts electron/tests/task/tool-gate-persistence.test.ts
git commit -m "feat: 写授权卡持久化为 tool_gate 人工请求（双写 + 答复驱动授权/拒绝 + 孤儿回收）"
```

---

### Task 14: agent 工具面（request_human / submit_task / complete_task 别名 / fail_task 描述）+ 回合纪律

**Files:**
- Modify: `electron/src/main/agent/tools/task-tools.ts`（工具 schema 与 handlers）
- Modify: `electron/src/main/agent/runtime-entry.ts`（task-end 纪律：needs_input 语义退役——`request_human` 已在工具内落请求，task_reply 仍只发 completed/failed）
- Modify: `renderer/src/lib/turn-reconcile.ts`（收尾核对合成条文案改为 submit/fail/request_human 三选一）
- Test: `electron/tests/agent/tools/task-tools-v2.test.ts`（新）+ 既有 task-tools 套件回归

**Interfaces:**
- Consumes: `requestHuman / submitRun / failRun`（Task 9-11）、ToolContext（既有 `roomId / workspaceId` 注入）
- Produces: 三工具 schema（中文描述，见 Step 3 文案）；`complete_task` 行为=submit_task

- [ ] **Step 1: 写失败测试**

```ts
// 用例（ToolContext 注入真实 DB 会话）：
// 1) request_human(question+options)：返回 {requestId,status:'waiting'} + DB 请求行 + 任务 waiting_human
// 2) request_human 无任务会话：task_id NULL 也能建（仅会话徽标）
// 3) submit_task：任务 submitted + 返回 {status:'submitted', runNo}
// 4) complete_task 别名：行为与 submit_task 一致（同返回）
// 5) 有未决 tool_gate 时 submit_task 返回人话错误（Review Focus #2 工具面）
// 6) fail_task：任务 failed + run failed（既有语义保持）
// 7) 描述断言：三工具 description 含「提交后等待验收」「需要人帮助用 request_human」关键句（锁文案防回退）
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现工具面**

```ts
// schema 文案（关键句，中文）：
// request_human: 「当你无法继续、需要人提供信息/决策/系统外操作时调用。调用后立即结束本回合，
//   不要继续等待或轮询；人答复后你会收到【人工答复】消息并继续。kind: question=提问(可带选项)，
//   manual_action=请人做系统外的事(steps)。」
// submit_task: 「当前任务的实现已完成时调用，提交交付说明(files/artifacts)。提交后任务进入
//   待验收状态，由发起方验收；不要宣告『任务已完成』——你没有完成权限，只有提交权限。」
// complete_task（别名，description 改写）: 「已废弃别名——等价 submit_task，请改用 submit_task。」
// fail_task description 追加: 「仅用于技术性失败。需要人帮助改用 request_human；放弃任务请告知用户取消。」
// runtime 侧：request_human handler 返回后由 chat loop 结束回合——工具返回
//   {requestId, status:'waiting'} 即可，回合自然收尾（turn 纪律由 turn-reconcile 催促）。
```

- [ ] **Step 4: 跑通过 + 回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools --pool=forks && cd ../renderer && npx pnpm@9.0.0 vitest run src/lib/turn-reconcile.test.ts`

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/tools/task-tools.ts electron/src/main/agent/runtime-entry.ts renderer/src/lib/turn-reconcile.ts electron/tests/agent/tools/task-tools-v2.test.ts
git commit -m "feat: agent 工具面 v2（request_human/submit_task；complete_task 改提交语义）"
```

---

### Task 15: 写路径收敛批（§9.3 表逐点）

**Files（全部 Modify）:**
- `electron/src/main/agent/runtime-registry.ts:327-344`（用户停止 → pauseForTask）
- `electron/src/main/task/conflict-executor.ts:40`（抢占 → pauseForTask）
- `electron/src/main/agent/dispatch-task-ledger.ts`（SETTLE_STATUS completed → submitRun；needs_input → requestHuman 映射退役：`needs_input` 到达时转 requestHuman(question)+不落 paused）
- `electron/src/main/task/quota-resume.ts:188-193`（复位走 refreshTaskProjection + 下次 startRun trigger='quota_retry'）
- `electron/src/main/storage/task-groups/repo.ts:152`（归档级联 → cancelActiveRun）
- `electron/src/main/task/ipc.handlers.ts`（task:transition 白名单：renderer 可用的 to 收窄为 cancel/pause/resume；in_progress/completed 直转拒绝并人话指路 submit/accept）
- `electron/src/main/task/lifecycle.ts`（cancelTask 内部改调 cancelActiveRun 保持单点）
- Test: 上述各文件既有测试更新 + `electron/tests/task/write-path-consolidation.test.ts`（新，锁「无 updateTask({status}) 残留」语义级断言）

**Interfaces:**
- Consumes: Task 9/10 服务
- Produces: 状态写入单点化（不变量 §5.1-6 达成）；`task:transition` 收窄面

- [ ] **Step 1: 写收敛锁测试（先红）**

```ts
// electron/tests/task/write-path-consolidation.test.ts
// 1) grep 级断言（vitest 内读源码文件字符串）：electron/src/main 除
//    storage/tasks/repo.ts、task/lifecycle-runs.ts、task/lifecycle.ts 外，
//    不出现 `updateTask(` 且同行含 `status`（白名单文件清单显式列出）——
//    注意 delegation-sync.ts 本期豁免（Task 18 处理，P2 全切）
// 2) 行为级：ipc task:transition(id,'completed') → 拒绝（人话指路 task:submit/accept）
// 3) dispatch ledger settle completed：origin='dispatch' 行 → submitRun+auto accept → completed（幂等）
// 4) runtime-registry stopAgentRuntime：任务 paused + run 不动
```

- [ ] **Step 2: 确认失败** → **Step 3: 逐点改造**（按 Files 清单；每点最小 diff：替换 transitionTaskStatus/updateTask 调用为服务函数，语义见 §9.3 表）

- [ ] **Step 4: 跑受影响既有套件 + 收敛锁**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/write-path-consolidation.test.ts tests/task tests/agent/dispatch-task-ledger.test.ts tests/storage/task-groups-repo.test.ts --pool=forks`
Expected: PASS（既有用例按新语义更新断言：ledger completed→经 submitted 瞬态、ipc transition 拒绝用例改期望）

- [ ] **Step 5: Commit**

```bash
git add -A electron/src/main electron/tests
git commit -m "refactor: 任务状态写入收敛至 lifecycle-runs 单点（§9.3 十处逃生门收口）"
```

---

### Task 16: IPC 面（task 扩展 + human 命名空间 + 推送）+ sweeper 注册

**Files:**
- Modify: `electron/src/main/task/ipc.handlers.ts`（task:submit/accept/reject/listRuns + move reason 透传）
- Create: `electron/src/main/task/human.ipc.handlers.ts`（human:list/answer/attention + human:changed 推送）
- Modify: `electron/src/main/hub/../index` 无关——注册点：`electron/src/main/index.ts`（或既有 ipc 聚合注册文件，按 repo 惯例找 task/ipc.handlers 注册处同址追加 human 注册 + `setInterval(sweepHumanTimeouts, 60_000)`）
- Modify: `electron/src/preload/index.ts`（task 扩展 + human 命名空间 + onHumanChanged/onTaskRunChanged 订阅）
- Modify: `renderer/src/ipc/types.d.ts`（TaskApiSurface 扩展 + HumanApiSurface + push 事件类型）
- Test: `electron/tests/task/human-ipc.test.ts`（新）

**Interfaces:**
- Consumes: lifecycle-runs 全量、human-requests-repo
- Produces（Task 17/22/23/24 renderer 消费）:

```ts
// TaskApiSurface 追加：
submit(id: string, deliverable: { summary: string; files?: string[]; artifacts?: Array<{ label: string; value: string }> }): Promise<TaskRow>;
accept(id: string): Promise<TaskRow>;
reject(id: string, reason: string): Promise<TaskRow>;
listRuns(id: string): Promise<TaskRunRow[]>;
move(id, target, opts?: { reason?: string }): Promise<TaskRow>; // 扩签名
// HumanApiSurface（新）：
export interface HumanApiSurface {
  list(input: { sessionId?: string; taskId?: string; status?: 'pending' | 'all' }): Promise<HumanRequestRow[]>;
  answer(requestId: string, answer: HumanAnswerInput, message?: string): Promise<{ disposition: 'answered' | 'stale' }>;
  attention(workspaceId: string): Promise<Record<string, { waiting: number; submitted: boolean; executorSubmitted: boolean; failed: boolean }>>;
  onChanged(cb: (e: { sessionId: string; requestId?: string; kind: string }) => void): () => void;
}
// HumanRequestRow / HumanAnswerInput / TaskRunRow 的 renderer 镜像类型同步进 types.d.ts
// task:runChanged push：{ taskId, runId, status }——onTaskRunChanged(cb): () => void
```

- [ ] **Step 1: 写失败测试（IPC 契约，真实 handler + mock webContents 推送）**

```ts
// electron/tests/task/human-ipc.test.ts
// 1) human:list 按 sessionId 过滤 + status 过滤
// 2) human:answer question → disposition answered + human:changed 推送（sessionId/requestId）
// 3) human:attention 聚合：两会话（一会话 pending question×2 + 任务 submitted、另一会话无）→ map 断言
//    waiting=2/submitted=true；executorSubmitted 判定：delegation_role='in' 的 submitted 任务 → submitted=false + executorSubmitted=true
// 4) task:reject 空理由 → 人话拒；task:listRuns 返回 run_no ASC
// 5) sweeper 注册不重复（handler 注册幂等——模块级 flag）
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现**（attention SQL：human_requests pending 计数 GROUP BY session_id + tasks LEFT JOIN execution_session_id 取非终态最新行，两者内存合并——避免巨型 JOIN）

- [ ] **Step 4: 跑通过 + 双 typecheck**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/human-ipc.test.ts --pool=forks && cd .. && npx pnpm@9.0.0 typecheck`

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/task/ipc.handlers.ts electron/src/main/task/human.ipc.handlers.ts electron/src/main/index.ts electron/src/preload/index.ts renderer/src/ipc/types.d.ts electron/tests/task/human-ipc.test.ts
git commit -m "feat: 任务生命周期 IPC 面（submit/accept/reject/runs + human 命名空间 + 推送）"
```

---

### Task 17: SessionSummary 扩展 + 活动任务会话删除守卫

**Files:**
- Modify: `electron/src/main/im/session-ops.ts`（SessionSummary + delegationRole/readOnly/taskId；listSessions 报告函数 JOIN tasks）
- Modify: `electron/src/main/storage/tasks/repo.ts`（新增 `assertSessionDeletable(sessionId): void`——活动任务查询）
- Modify: `electron/src/main/im/session.ipc.handlers.ts`（delete 前调守卫）
- Test: `electron/tests/im/session-delete-guard.test.ts`（新）+ 既有 session 套件回归

**Interfaces:**
- Consumes: Task 5 的 delegationRole
- Produces: `SessionSummary.delegationRole: 'in' | 'out' | null`、`readOnly: boolean`（= delegationRole==='out'，P1 唯一只读源）、`taskId: string | null`（renderer Task 22/23 消费）

- [ ] **Step 1: 写失败测试**

```ts
// 1) readOnly 派生：delegation_role='out' 的执行会话（手工 updateTask 种子）→ summary.readOnly=true
// 2) 删除守卫：任务 in_progress/waiting_human/submitted 且 execution_session_id=目标 → delete 抛
//    「任务进行中，请先取消或完结」；终态/无任务会话放行
// 3) SessionSummary.taskId：同一会话多任务取最新非终态行
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 跑通过 + 回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/im/session-delete-guard.test.ts tests/im --pool=forks`

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/im/session-ops.ts electron/src/main/storage/tasks/repo.ts electron/src/main/im/session.ipc.handlers.ts electron/tests/im/session-delete-guard.test.ts
git commit -m "feat: SessionSummary 生命周期字段 + 活动任务会话删除守卫"
```

---

### Task 18: P1 降级守卫（外派任务保持旧行为）

**Files:**
- Modify: `electron/src/main/hub/delegation-sync.ts`（worker 侧 ensureRow 写 `delegation_role='in'`；done 拍映射保持 completed——即 applyRemote done → 任务直接 completed 并置 accepted_at，不走 submitted；waiting 拍除既有 kv 外不改任务态）
- Modify: `electron/src/main/hub/dispatch-submit.ts`（submitRoutedTask 成功回写时 updateTask({delegationRole:'out', autoAccept:true})——P1 强制，P2 移除）
- Test: `electron/tests/task/p1-degradation-guard.test.ts`（新）+ 既有 hub delegation 套件回归

**Interfaces:**
- Consumes: Task 5 delegationRole/autoAccept
- Produces: P1 不变量「`delegation_role IS NOT NULL` → auto_accept=1 且任务完成走旧单方语义」（spec §14）

- [ ] **Step 1: 写失败测试**

```ts
// 1) dispatch-submit 后任务 delegationRole='out' + autoAccept=true
// 2) delegation-sync done 拍（mock hub 事件）→ 任务 completed（不经 submitted）+ accepted_at 写入
// 3) worker ensureRow → delegationRole='in'
// 4) spec §5.1-7 守卫：executor admitOnce 跳过 delegation_role='out' 的 assigned 行
//    （executor.ts 候选查询补 routing 过滤——本 task 落，测试：种 out+assigned 行 → admitOnce 后仍 assigned）
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 跑通过 + hub 套件回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/p1-degradation-guard.test.ts tests/hub --pool=forks`

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/hub/delegation-sync.ts electron/src/main/hub/dispatch-submit.ts electron/src/main/task/executor.ts electron/tests/task/p1-degradation-guard.test.ts
git commit -m "feat: P1 外派降级守卫（delegation_role 双写 + auto_accept 强制 + executor 本地过滤）"
```

---

### Task 19: 静态预览包 1：会话请求面板 + 徽标/待处理分区【STOP 门禁】

**Files:**
- Create: `.omo/previews/2026-11-13-task-lifecycle-session.html`

**Interfaces:**
- Consumes: `momo-ui-preview-rules`（P1 预览规范：真实 token、明暗并排、真实中文 mock、静态无 JS）
- Produces: 用户确认的视觉合同（Task 22/23 落码定值来源；预览头部列「定值清单」节）

- [ ] **Step 1: 制作预览 HTML**——内容四节，全部明暗并排：
  1) **请求面板**（固定 composer 上方）：四种 kind 卡（tool_gate 命令+目录+三按钮；question 选项+补充输入；manual_action 步骤勾选+已完成/做不到；acceptance 交付摘要+通过/打回）× 状态（未决/超时预警/已答折叠消失）
  2) **会话列表行徽标**：等待中 N（warning 计数）/ 待验收（accent）/ 已提交（中性，executor 侧）/ 失败（error）——与快速/协作/任务/外派/跟踪五种会话类型图标组合示例
  3) **「待处理 N」分区**：置顶区上方可折叠分区（默认展开，行=徽标+标题+等待时长）
  4) **跟踪会话只读态**：里程碑系统卡（已派发/已接收/执行中/等待中/已提交）+ composer 禁用占位
- [ ] **Step 2: macOS 主机 `open` 预览并向用户展示**

Run: `open .omo/previews/2026-11-13-task-lifecycle-session.html`

- [ ] **Step 3: 【STOP】等用户明确确认**——未确认不得进入 Task 22/23 落码；用户提修改 → 改预览 → 再确认（回到本步）
- [ ] **Step 4: 确认后抽取「定值清单」节写进预览文件尾部**（面板高度/徽标尺寸/分区折叠形态/间距 token——Task 22/23 的验收合同）

（本任务无 commit——预览 gitignored）

---

### Task 20: 静态预览包 2：看板七列 + 任务详情 run 时间线【STOP 门禁】

**Files:**
- Create: `.omo/previews/2026-11-13-task-lifecycle-board.html`

**Interfaces:**
- Consumes: `momo-ui-preview-rules`；Task 8 的七列定义
- Produces: Task 21/24 的视觉合同 + 定值清单

- [ ] **Step 1: 制作预览**——明暗并排：
  1) 看板七列全景（含等待中/待验收两新列的卡量与列头 hint）
  2) 卡片徽标特写：等待人工·N 项 / 待验收 / run #N 标记 / 返工箭头
  3) 拖拽语义提示态：submitted→done（验收通过 hover）、submitted→assigned（弹「打回理由」对话框态）
  4) 任务详情：run 时间线（run#1 失败→run#2 返工→等待人工→提交→验收）+ 验收区（通过/打回+理由输入）
- [ ] **Step 2: `open` 展示** → Run: `open .omo/previews/2026-11-13-task-lifecycle-board.html`
- [ ] **Step 3: 【STOP】等用户确认**（同 Task 19 门禁）
- [ ] **Step 4: 确认后补定值清单**

（无 commit）

---

### Task 21: renderer 状态样式 + 看板七列落码

**Files:**
- Modify: `renderer/src/lib/task-status.ts`（STATUS_LABEL/TONE +2、DispatchStatus 不动；新增 run 状态样式可选导出 runStatusStyle）
- Modify: `renderer/src/components/task-board/BoardCanvas.tsx`、`TaskBoardView.tsx`、`BoardCard.tsx`（七列渲染 + 等待人工徽标 + run 标记）
- Modify: `renderer/src/components/task-board/useTaskStore` 所在文件或调用点（拖拽 submitted→assigned 弹理由输入——用既有 ConfirmDialog/输入弹窗模式）
- Test: `renderer/src/lib/task-status.test.ts`（更新）、`renderer/src/components/task-board/` 相关 colocated 测试更新 + 新增拖拽理由用例

**Interfaces:**
- Consumes: Task 8/16 的 board-columns 七列 + `ipc.task.move(id, target, {reason})`、Task 19/20 已确认预览
- Produces: 七列看板 UI（P1 验收面）

- [ ] **Step 1: 更新 task-status 测试（先红）**

```ts
// task-status.test.ts 追加：
expect(taskStatusStyle('waiting_human')).toMatchObject({ label: '等待中', tone: 'warning' });
expect(taskStatusStyle('submitted')).toMatchObject({ label: '待验收', tone: 'accent' });
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现**（STATUS_LABEL/TONE 加两行；BoardCanvas 列渲染数据源=board-columns 常量天然扩；BoardCard 加「等待人工 · N」徽标——N 来自任务行 pending 请求数：`ipc.human.list({taskId, status:'pending'})` 或 attention map 复用，取轻量：TaskCard 渲染时不逐卡拉取，看板层一次 `ipc.human.attention` 无 sessionId 版本？裁定：attention 以 session 维度返回，看板徽标改用 TaskDetailPanel 打开时拉取 + 状态本身（waiting_human 态显示「等待中」列归属已足够，N 计数仅详情面板显示）——卡片不显示 N，只显示列与状态徽标）
- [ ] **Step 4: 跑看板测试 + 属性级对照（预览定值清单逐项核）**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/lib/task-status.test.ts src/components/task-board`

- [ ] **Step 5: Commit**

```bash
git add renderer/src/lib/task-status.ts renderer/src/components/task-board renderer/src/ipc/board-columns.ts
git commit -m "feat: 看板七列与等待中/待验收状态样式（预览合同落地）"
```

---

### Task 22: 会话请求面板 + human store

**Files:**
- Create: `renderer/src/components/im/HumanRequestPanel.tsx` + `renderer/src/components/im/HumanRequestPanel.test.tsx`
- Create: `renderer/src/stores/human.store.ts` + `renderer/src/stores/human.store.test.ts`
- Modify: `renderer/src/components/im/RichComposer.tsx`（外层容器挂 `<HumanRequestPanel/>` 于输入框上方——若挂载点在 MainLayout 的会话视图容器，按实际组件树选「composer 直接父容器」，保持单点挂载）

**Interfaces:**
- Consumes: `ipc.human.list/answer/attention/onChanged`（Task 16）、Task 19 已确认预览（定值清单）
- Produces: `<HumanRequestPanel sessionId={…} />`（Task 23/24 复用；acceptance kind 卡复用于详情面板）

- [ ] **Step 1: 写失败测试**

```tsx
// HumanRequestPanel.test.tsx（mock ipc.human 边界，真实 store）：
// 1) pending question 渲染选项组 + 提交后调 ipc.human.answer(selected/text) 并本地下架
// 2) tool_gate 三按钮（允许本次/允许本会话/拒绝）→ answer({decision}) 映射正确
//    （允许本会话=approve+scope 标记进 answer.text='scope:session'——payload 约定写入 store 注释）
// 3) manual_action 勾选步骤 + 已完成/做不到两出口
// 4) acceptance 卡：通过 → ipc.task.accept；打回 → 理由必填前端校验 + ipc.task.reject
// 5) onChanged 推送刷新（跨视图一致）
// 6) 空态：无 pending → 面板不渲染（高度 0）
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现**（zustand store：per-session 列表 + attention map + onChanged 订阅去重；组件按 kind 分支渲染，样式走预览定值）
- [ ] **Step 4: 跑通过 + 属性级对照**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/HumanRequestPanel.test.tsx src/stores/human.store.test.ts`

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/im/HumanRequestPanel.tsx renderer/src/components/im/HumanRequestPanel.test.tsx renderer/src/stores/human.store.ts renderer/src/stores/human.store.test.ts renderer/src/components/im/RichComposer.tsx
git commit -m "feat: 会话请求面板（四类人工卡 + 验收卡，composer 上方唯一行动入口）"
```

---

### Task 23: 会话徽标 + 待处理分区 + 只读跟踪态

**Files:**
- Modify: `renderer/src/components/im/RoomList.tsx`（SessionItem 徽标 prop + 置顶区上方「待处理」折叠分区）
- Modify: `renderer/src/components/im/RichComposer.tsx`（session.readOnly → 输入区整体禁用占位「只读跟踪会话」）
- Test: `renderer/src/components/im/RoomList.test.tsx`（更新）+ `RichComposer.test.tsx`（更新）

**Interfaces:**
- Consumes: `human.store.attention`（Task 22）、`SessionSummary.readOnly`（Task 17）、Task 19 预览定值
- Produces: 徽标三分支（等待中 N > 待验收 > 失败；executor 侧已提交中性）+ 分区 + 只读态

- [ ] **Step 1: 更新 RoomList 测试（先红）**——用例：attention waiting=2 的会话行渲染「等待中 2」徽标且优先于待验收；readOnly 会话行/分区点击进入后 composer 禁用；待处理分区列出且仅列出有徽标会话、折叠态切换
- [ ] **Step 2: 确认失败** → **Step 3: 实现**（徽标为纯派生组件 `<SessionAttentionBadge attention={…}/>`，RoomList 内部私有；分区复用 GroupHeader 折叠交互模式）
- [ ] **Step 4: 跑通过**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/RoomList.test.tsx src/components/im/RichComposer.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/im/RoomList.tsx renderer/src/components/im/RichComposer.tsx renderer/src/components/im/RoomList.test.tsx renderer/src/components/im/RichComposer.test.tsx
git commit -m "feat: 会话注意力徽标 + 待处理分区 + 跟踪会话只读态"
```

---

### Task 24: 任务详情 run 时间线 + 验收/打回

**Files:**
- Modify: `renderer/src/components/task-board/TaskDetailPanel.tsx`
- Test: `renderer/src/components/task-board/TaskDetailPanel.test.tsx`（更新）

**Interfaces:**
- Consumes: `ipc.task.listRuns/accept/reject`（Task 16）、Task 20 预览定值
- Produces: 详情面板「执行尝试」时间线（run_no/状态/trigger/起止/打回理由）+ 验收区（submitted 态显示通过/打回）

- [ ] **Step 1: 更新测试（先红）**——用例：listRuns 渲染时间线（含 rejected 理由行）；任务 submitted 时验收区出现、打回空理由前端拦截、accept 后面板状态刷新（onTaskRunChanged 订阅）
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 跑通过**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/task-board/TaskDetailPanel.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/task-board/TaskDetailPanel.tsx renderer/src/components/task-board/TaskDetailPanel.test.tsx
git commit -m "feat: 任务详情执行尝试时间线与验收/打回操作"
```

---

### Task 25: 全量回归 + typecheck + 账本 + 版本号

**Files:**
- Modify: `CHANGELOG.md`（研发账本新节）、三处 `package.json`（root / electron / renderer，alpha +1）

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 可交付的 P1

- [ ] **Step 1: 双 workspace typecheck**

Run: `nvm use 24 && npx pnpm@9.0.0 typecheck`
Expected: 双 clean

- [ ] **Step 2: 全量单测（裸跑，禁 --pool）**

Run: `npx pnpm@9.0.0 test`
Expected: 全绿；若 vitest 非正常退出（exit 139/137），按 AGENTS.md 清理孤儿 worker 后重跑

- [ ] **Step 3: 真机冒烟（macOS 主机 `npx pnpm@9.0.0 dev`）**——脚本：建任务指派 agent → 会话让 agent 调 request_human → 看板「等待中」+ 会话徽标 + 面板答复 → agent 继续 → submit_task → 「待验收」+ 验收通过 → completed；打回路径抽测一次（详情打回 → 任务回排队 + run#2）
- [ ] **Step 4: CHANGELOG 研发账本 + 三处 alpha +1（同 commit）**

```bash
git add CHANGELOG.md package.json electron/package.json renderer/package.json
git commit -m "chore: 任务生命周期 v2 P1 研发账本 + alpha 号 +1"
```

- [ ] **Step 5: 消费面矩阵回填证据列**（Task 1 矩阵每行补「已落地 task #」），并对照 spec §16 验收标准 1–5 逐条自检记录在 CHANGELOG 节内

---

## 自审记录（writing-plans Self-Review）

1. **Spec 覆盖**：§5.1–5.5（Task 2–8）、§6.1–6.9（Task 9–14）、§7（Task 19/22/23）、§9（Task 14/15）、§10（Task 16）、§5.4 会话（Task 17/23）、§11 预览（Task 19/20）、§12 兼容（Task 18/3）、§13 测试（各 task 内嵌 + Task 25）、§14 P1 范围（全程）——§8 跨节点与 §7.3 跟踪会话创建属 P2，本 plan 仅落数据模型与只读判定（Task 17/18/23），符合 spec §14 分期。
2. **占位符扫描**：Task 8 的 lifecycle-runs 占位是显式分阶段接线（it.todo 转正机制），非「TBD」；其余任务步骤均含实码或逐点指令。
3. **类型一致性**：`TaskRunRow/HumanRequestRow/HumanAnswerInput` 在 Task 6/7/11 定义、Task 10/16 镜像进 types.d.ts，字段名全程一致；`startRun` 幂等语义在 Task 8/9 两处描述一致。
4. **Review Focus**：五条均落测试（Task 11/10/9/10/8）。
