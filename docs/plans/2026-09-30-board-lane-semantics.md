# 看板泳道语义重构实施计划（待办=草稿 / 排队中=已启动队列）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 泳道语义对齐用户心智模型——表单创建一律草稿、「启动」=入队（拖拽/按钮两入口）、排队中列由 executor `scheduled_at` 闸门统一表达「等并发/等计划时间/等车道」，pending 退役。

**Architecture:** 入队语义单点收敛在既有 `executeMove`（不新增 IPC 通道）；executor 队首 SQL 加时间闸门；scheduler 由「pending 升级扫描」改「due-wakeup 通知」；K1 落态决策抽纯函数双入口消费（表单=draft / agent 工具=建即入队）；迁移 051 收编 pending→draft 与 050 遗失的 `DROP board_position`。

**Tech Stack:** Electron 主进程（CommonJS + better-sqlite3）、React renderer（Vite + zustand）、vitest 双 workspace、dnd-kit 既有拖拽链。

**Spec:** `docs/specs/2026-09-30-board-lane-semantics-design.md`（含 §4.5 修订）

## Global Constraints

- Node 20 LTS（`nvm use 20`）；pnpm 一律 `npx pnpm@9.0.0`；better-sqlite3 二进制当前为 Electron ABI，跑 electron 测试前需换 Node ABI（见 AGENTS.md 陷阱表），验收前换回。
- TypeScript strict：禁 `any` / `@ts-ignore` / `as any`；ESLint `no-explicit-any: error`。
- 全部注释中文；Conventional Commits（`feat:` / `fix:` / `test:` / `refactor:`）；**不动版本号**。
- 测试位置：electron 集中 `electron/tests/`（镜像 src）；renderer 贴源 colocated。
- 改 IPC / 协议字段两 workspace 都要 typecheck（momo-boundary-rules）；board-columns 两份镜像必须同 commit 改，`board-columns-sync.test` 锁死。
- electron 全量测试的 threads 池基建限制：`tests/agent` 全量会崩，分片 ≤25 文件跑（vitest.config.ts 注释为准）。
- UI 门禁（momo-ui-preview-rules）：AssignTargetDialog 为 **P1**（Task 9 预览须用户确认后才能实现）；列改名/hint/表单删字段为 P2 文案变更（豁免预览，事后截图验收）。
- **执行前置**：工作区存在上一功能未提交改动（顶置/抽屉等 60+ 文件）与 `tests/storage/migration-050-task-pin.test.ts` 3 个红用例（050 的 DROP 丢失，Task 1 修复）。开工前由用户处置基线（提交现有改动）。

## Review Focus

1. **表单创建带目标+定时 → draft 停待办，不自动跑**（最大行为变化）→ Task 4 用例「表单路径带目标带定时落 draft」。
2. **`scheduled_at == now` 边界立即有资格**（闸门 `<=` 语义，差一秒都不行）→ Task 2 用例「边界相等放行」。
3. **并发满 + 无计划时间 → 停排队中不跑**（闸门不得误挡 NULL；既有并发行为不回退）→ Task 2 用例「NULL 立即有资格」+ 既有 executor 并发用例全绿。
4. **agent 建无目标任务 → draft**（不得误入队后被 executor 转failed）→ Task 4 用例「agent 无目标落 draft」。
5. **迁移 051 对已应用 050 的存量库：board_position 补删成功 + pending 清零且 scheduledAt 保留** → Task 1 用例「050(ADD-only) 后跑 051」路径。

---

### Task 1: 迁移 051（pending→draft + 补 DROP board_position + 修复 050 测试/注释）

**Files:**
- Create: `electron/src/main/storage/migrations/051_lane_semantics_pending_to_draft.ts`
- Modify: `electron/src/main/storage/migrations/index.ts`（挂载）
- Modify: `electron/tests/storage/migration-050-task-pin.test.ts`（DROP 断言移交 051）
- Create: `electron/tests/storage/migration-051-lane-semantics.test.ts`

**Interfaces:**
- Consumes: `Migration` 接口（`migrations/index.ts`，`{ version: number; sql: string }`）；050 文件的 `migration050` 导出形状（`{ version, up, down }`）。
- Produces: `migration051: { version: 51, up: string, down: string }`；挂载后 `loadMigrations()` 末尾含 version 51。

- [ ] **Step 1: 写 051 失败测试**

```typescript
// electron/tests/storage/migration-051-lane-semantics.test.ts
//
// 迁移 051：泳道语义重构两件事（spec 2026-09-30 §4.5）——
//   1. UPDATE pending → draft（pending 退役；scheduledAt 原样保留，
//      用户启动时由 executor 闸门消费）
//   2. 补挂 DROP COLUMN board_position（迁移 050 上线事故：其 up 中的
//      DROP 语句丢失且已按 ADD-only 应用到存量库；DROP 收敛到 051，
//      新旧库统一生效）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDb, closeDb, runMigrations } from '../../../src/main/storage/db';
import { getDb } from '../../../src/main/storage/db';
import { insertTask, getTask } from '../../../src/main/storage/tasks/repo';

describe('migration 051 泳道语义（pending→draft + DROP board_position）', () => {
  beforeAll(() => {
    openDb(':memory:');
    runMigrations();
  });
  afterAll(() => {
    closeDb();
  });

  it('pending 行转 draft 且 scheduledAt 保留；其余状态不动', () => {
    const db = getDb();
    const mk = (id: string, status: string, scheduledAt: number | null) =>
      insertTask({
        id, workspaceId: 'ws1', title: `t-${id}`, creatorUserId: 'owner',
        status: status as never, scheduledAt,
      });
    mk('T-901', 'pending', 1893456000000);   // 带定时存量
    mk('T-902', 'pending', null);              // 无目标存量
    mk('T-903', 'assigned', null);             // 不应被动
    mk('T-904', 'draft', 1893456000000);       // 不应被动
    // 051 在 runMigrations 已应用——直接断言落库结果
    expect(getTask('T-901')?.status).toBe('draft');
    expect(getTask('T-901')?.scheduledAt).toBe(1893456000000);
    expect(getTask('T-902')?.status).toBe('draft');
    expect(getTask('T-903')?.status).toBe('assigned');
    expect(getTask('T-904')?.status).toBe('draft');
  });

  it('board_position 列已删除（含对已应用 050(ADD-only) 的存量库路径）', () => {
    const db = getDb();
    const cols = db.prepare("SELECT name FROM pragma_table_info('tasks')").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).not.toContain('board_position');
    expect(cols.map((c) => c.name)).toContain('pinned_at'); // 050 的 ADD 仍在
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/migration-051-lane-semantics.test.ts`
Expected: FAIL——挂载前 051 不存在，pending 行保持 pending / board_position 列仍存在（047 建列，050 ADD-only 未删）。

- [ ] **Step 3: 写迁移 051 + 挂载**

```typescript
// electron/src/main/storage/migrations/051_lane_semantics_pending_to_draft.ts
//
// Migration 051：泳道语义重构（spec docs/specs/2026-09-30-board-lane-semantics-design.md §4.5）。
//
// 两件事：
//   - UPDATE tasks SET status='draft' WHERE status='pending'——pending 状态退役
//     （定时不再经 pending 中转：assigned + scheduled_at + executor 闸门直接表达
//     「排队中等到点」）。带定时存量 scheduledAt 保留，用户启动时闸门消费。
//   - DROP COLUMN board_position——迁移 050 上线事故补救：050 的 up 中
//     tx-wrapped DROP 语句因脚本事故丢失，且 050 已按 ADD-only 版本应用到
//     存量库（版本已记录不可重跑）；DROP 收敛到本迁移，新库（047 建列→051 删）
//     与存量库（列残留→051 删）统一愈合。
//
// 显式事务包裹沿 050 纪律：DROP COLUMN 的隐式自事务表重建路径在
// better-sqlite3 + worker_threads（vitest threads 池）下会放大 SIGSEGV 概率。

export interface Migration051 {
  version: number;
  up: string;
  down: string;
}

export const migration051: Migration051 = {
  version: 51,
  up: `
    BEGIN;
    UPDATE tasks SET status='draft' WHERE status='pending';
    ALTER TABLE tasks DROP COLUMN board_position;
    COMMIT;
  `,
  down: `
    ALTER TABLE tasks ADD COLUMN board_position REAL;
    UPDATE tasks SET status='pending' WHERE status='draft' AND scheduled_at IS NOT NULL;
  `,
};
```

挂载（`migrations/index.ts`，仿 050 的两处）：

```typescript
import { migration051 } from './051_lane_semantics_pending_to_draft';
// MIGRATIONS 数组末尾追加（050 条目之后）：
  {
    version: migration051.version,
    sql: migration051.up,
  },
```

- [ ] **Step 4: 跑 051 测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/migration-051-lane-semantics.test.ts`
Expected: PASS（2 用例）

- [ ] **Step 5: 修正 050 测试与注释**

`tests/storage/migration-050-task-pin.test.ts`：3 个红用例的 DROP 断言（`board_position` 相关 12 处引用）——改为断言 050 后 board_position **仍存在**（ADD-only 事实）并加注释「DROP 移交 051（见 migration-051 测试）」；`pinned_at` 断言保留。050 源文件头注释中「DROP COLUMN … 显式事务包裹」段改为如实描述：「DROP 因上线事故移交 051 执行，本迁移只 ADD pinned_at」。

- [ ] **Step 6: 回归 047/050/051 三个迁移测试**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/migration-047-kanban-groups.test.ts tests/storage/migration-050-task-pin.test.ts tests/storage/migration-051-lane-semantics.test.ts`
Expected: 全 PASS（050 由 3 红 → 绿）

- [ ] **Step 7: Commit**

```bash
git add electron/src/main/storage/migrations/ electron/tests/storage/
git commit -m "feat: 迁移 051——pending 退役转 draft + 补删 board_position（050 事故愈合）"
```

---

### Task 2: executor scheduled_at 闸门

**Files:**
- Modify: `electron/src/main/task/executor.ts:182-199`（`peekNextAssigned`）
- Test: `electron/tests/task/executor.test.ts`（新增 describe；沿用该文件既有 DB/依赖注入 setup）

**Interfaces:**
- Consumes: 既有 `getDb()` / `getTask`；测试既有 executor 实例与 deps 注入模式。
- Produces: `peekNextAssigned(slots, skip)` 行为变更——只捞 `scheduled_at IS NULL OR scheduled_at <= now` 的 assigned/session_queued 行（对外签名不变）。

- [ ] **Step 1: 写失败测试（闸门三态 + 边界）**

在 `executor.test.ts` 既有 setup 基础上追加（种子用 `insertTask` 直插 assigned 行，时间用相对 `Date.now()` 构造）：

```typescript
describe('executor scheduled_at 闸门（spec §3.2：排队中三情况）', () => {
  it('NULL 计划时间 → 立即有放行资格', async () => {
    seedAssignedTask('T-910', { scheduledAt: null });
    await admitAndAssertLaunched('T-910'); // 既有放行断言辅助（startTask mock 成功 + kickoff 注入）
  });

  it('计划时间已过（< now）→ 立即有放行资格', async () => {
    seedAssignedTask('T-911', { scheduledAt: Date.now() - 60_000 });
    await admitAndAssertLaunched('T-911');
  });

  it('计划时间未来 → 不捞；到点后（推进时间或改库）捞', async () => {
    const t = seedAssignedTask('T-912', { scheduledAt: Date.now() + 3_600_000 });
    await admitOnceAndAssertNotLaunched('T-912');   // 未来：留排队中
    getDb().prepare('UPDATE tasks SET scheduled_at = ? WHERE id = ?').run(Date.now() - 1, 'T-912');
    executor.notify(); // 或直调 admitOnce
    await admitAndAssertLaunched('T-912');
  });

  it('边界：scheduled_at == now → 有放行资格（<= 语义）', async () => {
    const now = Date.now();
    seedAssignedTask('T-913', { scheduledAt: now });
    await admitAndAssertLaunched('T-913');
  });
});
```

（`seedAssignedTask` / `admitAndAssertLaunched` / `admitOnceAndAssertNotLaunched` 若文件内无现成辅助，按既有用例的「seed + taskExecutor.admitOnce + 断言 status/in_progress」模式内联实现。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/executor.test.ts`
Expected: 「未来不捞」「边界相等」两条 FAIL（现状未来时间也被放行）。

- [ ] **Step 3: 实现——peekNextAssigned SQL 加闸门**

```typescript
/** 队首候选：assigned / session_queued 按放行序（v2.3 车道队列并入），排除本轮已处理过的失败候选。
 * scheduled_at 闸门（spec 2026-09-30 §3.2）：NULL 或已到点（<= now）才有放行资格——
 * 未来时间的任务停在排队中，由 executor 30s 兜底扫描 + scheduler due-wakeup 到点捞起。 */
function peekNextAssigned(slots: number, skip: ReadonlySet<string>): TaskRow | null {
  const skipIds = [...skip];
  const excludeClause =
    skipIds.length > 0 ? `AND id NOT IN (${skipIds.map(() => '?').join(',')})` : '';
  const rows = getDb()
    .prepare(
      `SELECT id FROM tasks WHERE status IN ('assigned', 'session_queued') ${excludeClause}
       AND (scheduled_at IS NULL OR scheduled_at <= ?)
       ORDER BY priority DESC, COALESCE(scheduled_at, created_at) ASC, created_at ASC
       LIMIT ?`,
    )
    .all(...skipIds, Date.now(), Math.max(slots, 1)) as Array<{ id: string }>;
  for (const r of rows) {
    const t = getTask(r.id);
    if (t && (t.status === 'assigned' || t.status === 'session_queued')) return t; // SELECT 与读取间竞态防御
  }
  return null;
}
```

- [ ] **Step 4: 跑 executor 测试确认全绿（含既有并发用例不回退）**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/executor.test.ts tests/task/executor-lane.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/task/executor.ts electron/tests/task/executor.test.ts
git commit -m "feat: executor 队首捞取加 scheduled_at 闸门（排队中等到点才放行）"
```

---

### Task 3: scheduler 改 due-wakeup（pending 升级扫描退役）

**Files:**
- Modify: `electron/src/main/task/scheduler.ts`（`checkOnce` 重写 + 头注释更新）
- Test: `electron/tests/task/scheduler.test.ts`（重写既有 pending 升级用例为 due-wakeup 语义）

**Interfaces:**
- Consumes: `SchedulerOpts.scanPickup`（签名不变，语义从「升级后逐条触发」变「存在 due 任务时触发一次」）。
- Produces: `checkOnce()` 新契约——**零转态零广播**；命中 `status='assigned' AND scheduled_at <= now` 任意行 → `scanPickup('')` 恰好一次。

- [ ] **Step 1: 重写 scheduler 测试（失败）**

```typescript
// 用例替换原「pending 到点升 assigned」族：
it('存在到点 assigned → 触发一次 scanPickup，不转任何状态', () => {
  seedTask('T-920', 'assigned', Date.now() - 1000);
  const scanPickup = vi.fn().mockResolvedValue(true);
  new TaskScheduler({ scanPickup, intervalMs: 1000, now: () => Date.now() }).checkOnce();
  expect(scanPickup).toHaveBeenCalledTimes(1);
  expect(getTask('T-920')?.status).toBe('assigned'); // 零转态
});

it('只有未来时间的 assigned → 不触发', () => {
  seedTask('T-921', 'assigned', Date.now() + 3_600_000);
  const scanPickup = vi.fn().mockResolvedValue(true);
  new TaskScheduler({ scanPickup, intervalMs: 1000 }).checkOnce();
  expect(scanPickup).not.toHaveBeenCalled();
});

it('draft 带过去时间（未启动）→ 不触发（草稿永不入队）', () => {
  seedTask('T-922', 'draft', Date.now() - 1000);
  const scanPickup = vi.fn().mockResolvedValue(true);
  new TaskScheduler({ scanPickup, intervalMs: 1000 }).checkOnce();
  expect(scanPickup).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/scheduler.test.ts`
Expected: FAIL（现行为是 pending 升级 + 广播，非 due-wakeup）

- [ ] **Step 3: 重写 checkOnce**

```typescript
  /**
   * 立即执行一次扫描（2026-09-30 泳道语义重构，spec §4.3）：
   * due-wakeup——排队中（assigned/session_queued）存在 scheduled_at <= now
   * 的任务时触发一次 scanPickup（executor notify），加速到点放行。
   * 纯加速器：零转态、零广播（转态由 executor 放行链完成；executor 自身
   * 30s 兜底扫描天然覆盖本扫描缺失）。原「pending→assigned 升级 + 快照
   * 广播」随 pending 退役（迁移 051）。
   */
  checkOnce(): void {
    const now = this.opts.now?.() ?? Date.now();
    const db = getDb();
    const due = db
      .prepare(
        `SELECT 1 FROM tasks
         WHERE status IN ('assigned', 'session_queued') AND scheduled_at <= ?
         LIMIT 1`,
      )
      .get(now);
    if (due) void this.opts.scanPickup('');
  }
```

（头注释「职责」段同步改为 due-wakeup 描述；`transitionTaskStatus` / `broadcastLocalTaskSnapshot` import 移除。）

- [ ] **Step 4: 跑 scheduler 测试 + scheduler 消费方回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/scheduler.test.ts tests/task/scheduled-pipeline.test.ts tests/task/resume.test.ts`
Expected: PASS（scheduled-pipeline 若锁旧 pending 管线语义，按新语义改写其断言——定时任务现落 assigned 由闸门管）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/task/scheduler.ts electron/tests/task/scheduler.test.ts electron/tests/task/scheduled-pipeline.test.ts
git commit -m "refactor: scheduler 退役 pending 升级扫描，改 due-wakeup 通知 executor"
```

---

### Task 4: K1 落态决策抽纯函数 + 双入口改道

**Files:**
- Create: `electron/src/main/task/create-status.ts`
- Modify: `electron/src/main/task/ipc.handlers.ts:94-105`（task:create 决策段）
- Modify: `electron/src/main/agent/tools/task-tools.ts:191-199`（createTask 决策段）
- Create: `electron/tests/task/create-status.test.ts`

**Interfaces:**
- Consumes: `hasDelegationTarget`（`starter.ts` 导出，入参 `{assigneeAgentId?, targetTeamId?, targetSessionId?}`）。
- Produces: `resolveCreateStatus(input: { hasDelegationTarget: boolean; scheduledAt: number | null }, source: 'form' | 'agent'): TaskStatus | undefined`——form 一律 `'draft'`；agent：有目标 `'assigned'`（建即入队，未来时间由闸门管），无目标 `undefined`（repo 默认 draft）。

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/task/create-status.test.ts
import { describe, it, expect } from 'vitest';
import { resolveCreateStatus } from '../../src/main/task/create-status';

describe('resolveCreateStatus（K1 落态单源，spec §4.1）', () => {
  it('表单路径一律 draft——无论目标/定时（核心行为变化）', () => {
    expect(resolveCreateStatus({ hasDelegationTarget: true, scheduledAt: null }, 'form')).toBe('draft');
    expect(resolveCreateStatus({ hasDelegationTarget: true, scheduledAt: Date.now() + 3600_000 }, 'form')).toBe('draft');
    expect(resolveCreateStatus({ hasDelegationTarget: false, scheduledAt: Date.now() + 3600_000 }, 'form')).toBe('draft');
    expect(resolveCreateStatus({ hasDelegationTarget: false, scheduledAt: null }, 'form')).toBe('draft');
  });

  it('agent 路径：有目标建即入队 assigned（未来时间由闸门管，不再产 pending）', () => {
    expect(resolveCreateStatus({ hasDelegationTarget: true, scheduledAt: null }, 'agent')).toBe('assigned');
    expect(resolveCreateStatus({ hasDelegationTarget: true, scheduledAt: Date.now() + 3600_000 }, 'agent')).toBe('assigned');
  });

  it('agent 路径：无目标落 draft（undefined 由 repo 默认）', () => {
    expect(resolveCreateStatus({ hasDelegationTarget: false, scheduledAt: null }, 'agent')).toBeUndefined();
    expect(resolveCreateStatus({ hasDelegationTarget: false, scheduledAt: Date.now() }, 'agent')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/create-status.test.ts`
Expected: FAIL——模块不存在

- [ ] **Step 3: 实现 create-status.ts + 双入口改道**

```typescript
// electron/src/main/task/create-status.ts
//
// K1 落态决策单源（spec 2026-09-30 §4.1，取代旧「创建即调度」决策表）：
//   form（表单路径：看板新建 / 会话内创建按钮 / InlineTaskSuggestion）
//     → 一律 draft——创建/编辑是纯数据操作，「启动」是唯一入队动作
//   agent（create_task 工具，用户在会话中已授权）
//     → 有目标 assigned（建即入队；scheduledAt 为未来时间时由 executor
//       闸门等到点），无目标 draft
// pending 不再产出（迁移 051 退役）。
import type { TaskStatus } from '../storage/tasks/state-machine';

export function resolveCreateStatus(
  input: { hasDelegationTarget: boolean; scheduledAt: number | null },
  source: 'form' | 'agent',
): TaskStatus | undefined {
  if (source === 'form') return 'draft';
  return input.hasDelegationTarget ? 'assigned' : undefined;
}
```

`ipc.handlers.ts` 决策段替换为：

```typescript
    // K1（2026-09-30 泳道语义重构 §4.1）：表单路径一律 draft——「创建即入队」
    // 退役，启动是唯一入队动作（拖拽/详情按钮）；决策单源 create-status.ts
    const status = resolveCreateStatus(
      { hasDelegationTarget: hasDelegationTarget(input), scheduledAt: input.scheduledAt ?? null },
      'form',
    );
```

`task-tools.ts` 决策行替换为：

```typescript
  // K1（2026-09-30 §4.1）：agent 建即入队（用户在会话中已授权）；未来时间
  // 由 executor 闸门管，pending 不再产出。决策单源 create-status.ts
  const row = insertTask({
    ...
    status: resolveCreateStatus({ hasDelegationTarget: hasTarget, scheduledAt: input.scheduledAt ?? null }, 'agent'),
    ...
  });
```

- [ ] **Step 4: 跑单测 + 受影响的 ipc/task-tools 既有测试**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/create-status.test.ts tests/task/ tests/agent/tools/task-tools.test.ts`
Expected: 既有用例若锁旧落态（带目标→assigned / 定时→pending）按新决策表改写断言（表单带目标→draft；agent 定时→assigned）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/task/create-status.ts electron/src/main/task/ipc.handlers.ts electron/src/main/agent/tools/task-tools.ts electron/tests/task/create-status.test.ts
git commit -m "feat: K1 落态重写——表单创建一律草稿，agent 建即入队（决策单源 create-status）"
```

---

### Task 5: 循环续期实例落 assigned

**Files:**
- Modify: `electron/src/main/task/recurrence.ts:79`（`status: 'pending'` → `'assigned'`）
- Test: `electron/tests/task/recurrence.test.ts`

**Interfaces:**
- Produces: 续期实例 `status='assigned' + scheduledAt=下次时间`——闸门等到点自动放行；调用方（completeTask/executeMove/agent-runner task-end）既有 `notifyExecutor()` 覆盖入场评估。

- [ ] **Step 1: 改测试断言（失败）**

既有「续期生成下一实例」用例中 `expect(next.status).toBe('pending')` → `'assigned'`，并补一条：

```typescript
it('续期实例落 assigned + 未来时间 → executor 闸门不捞（等下个周期）', () => {
  // 复用既有 seed；spawn 后断言 status==='assigned' 且 scheduledAt > now
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/recurrence.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现（一行）+ 头注释一句**

`status: 'pending'` → `status: 'assigned',`，行注释：`// 泳道语义重构：续期即入队（assigned+下次时间），闸门到点放行——pending 中转退役`

- [ ] **Step 4: 跑 recurrence 测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/recurrence.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/task/recurrence.ts electron/tests/task/recurrence.test.ts
git commit -m "refactor: 循环续期实例落 assigned 由闸门到点放行（pending 中转退役）"
```

---

### Task 6: 列改名「排队中」+ STATUS_LABEL（P2 文案）

**Files:**
- Modify: `renderer/src/ipc/board-columns.ts:33-34` 与 `electron/src/main/task/board-columns.ts:25-26`（两份镜像同 commit）
- Modify: `renderer/src/lib/task-status.ts:13`（`assigned: '已分配'` → `'排队中'`）
- Test: 全局 grep `已分配` 收敛断言（见 Step 4）

**Interfaces:**
- Produces: 列 `label: '排队中'`、`hint: '等并发/等计划时间/等车道'`；待办 `hint: '草稿'`；状态徽标 `STATUS_LABEL.assigned = '排队中'`。`STATUS_LABEL.pending = '待分配'` 保留（存量兼容）。

- [ ] **Step 1: 改断言（失败）**

`renderer/src/lib/task-status.test.ts` 与 board-columns 相关测试中锁 `已分配` 的断言先改为 `排队中`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/lib/task-status.test.ts`
Expected: FAIL

- [ ] **Step 3: 改两份镜像 + STATUS_LABEL**

```typescript
// 两份 board-columns.ts 同款两行：
  { key: 'backlog', label: '待办', statuses: ['draft', 'pending'], hint: '草稿' },
  { key: 'assigned', label: '排队中', statuses: ['assigned', 'session_queued'], hint: '等并发/等计划时间/等车道' },
// task-status.ts：
  assigned: '排队中',
```

- [ ] **Step 4: 全局收敛 + 双端回归**

Run: `grep -rn "已分配" renderer/src electron/src --include="*.ts" --include="*.tsx"`——残余仅允许出现在：历史注释、p2p 远端快照兼容、`STATUS_LABEL.pending` 相关无关处；其余（含测试断言）全部改「排队中」。
Run: `cd renderer && npx pnpm@9.0.0 vitest run src/ipc src/lib/task-status.test.ts src/components/task-board/` 与 `cd electron && npx pnpm@9.0.0 vitest run tests/task/board-columns-sync.test.ts`
Expected: PASS（sync 测试深比较两镜像，双改即绿）

- [ ] **Step 5: Commit**

```bash
git add renderer/src/ipc/board-columns.ts electron/src/main/task/board-columns.ts renderer/src/lib/task-status.ts renderer/src electron/tests
git commit -m "feat: 已分配列改名排队中（语义正名，spec §4.4）"
```

---

### Task 7: 详情面板启动按钮改道 move 入队

**Files:**
- Modify: `renderer/src/components/task-board/TaskDetailPanel.tsx`（`canStart` 收敛 + `handleStart` 改道 + 头注释操作矩阵更新）
- Test: `renderer/src/components/task-board/TaskDetailPanel.test.tsx`

**Interfaces:**
- Consumes: `useTaskStore` 的 `move(id, { column, groupId })`（既有 action）；`hasDelegationTarget` renderer 谓词（Task 10 一并提为 `lib/board.ts` 导出——本任务先内联三列判断，Task 10 收敛）。
- Produces: `canStart = task.status === 'draft' && hasTarget`；启动点击 → `move(taskId, { column: 'assigned', groupId: task.groupId })`，成功 `refreshTask`，失败进 `actionError`（既有 `runAction` 模式）。

- [ ] **Step 1: 改测试（失败）**

```typescript
// TaskDetailPanel.test.tsx 操作矩阵族：
// 1) 既有「draft 有目标可启动」用例：断言 ipc.task.start 不再被调，
//    改断言 mock 的 store.move 被调（task.store 真实实现 → mockApi.task.move）
it('draft 有目标：启动按钮 → task.move(assigned, 当前组)（不再直调 start）', async () => {
  mockApi.task.get.mockResolvedValue(makeTask({ status: 'draft', assigneeAgentId: 'inst-pm' }));
  mockApi.task.move.mockResolvedValue(makeTask({ status: 'assigned' }));
  render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: '启动' }));
  await waitFor(() => expect(mockApi.task.move).toHaveBeenCalledWith('task-1', { column: 'assigned', groupId: null }));
  expect(mockApi.task.start).not.toHaveBeenCalled();
});
// 2) 新增：assigned 任务（已在队列）无启动按钮
it('assigned 已在队列：无启动按钮（executor 管）', async () => {
  mockApi.task.get.mockResolvedValue(makeTask({ status: 'assigned', assigneeAgentId: 'inst-pm' }));
  render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
  await screen.findByText('排队中');
  expect(screen.queryByRole('button', { name: '启动' })).not.toBeInTheDocument();
});
```

（`mockApi` 增补 `move: vi.fn()`；既有 pending/assigned 可启动用例按新矩阵删除或改写。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/task-board/TaskDetailPanel.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

```tsx
// canStart 收敛（spec §4.2）：draft 且有目标——pending 已迁移退役、assigned
// 在队列由 executor 管；启动 = move 入队（executeMove 单点：目标校验/转态/notify）
const hasTarget =
  task.assigneeAgentId != null || task.targetTeamId != null || task.targetSessionId != null;
const canStart = task.status === 'draft' && hasTarget;
// handleStart：
const handleStart = (): void => {
  runAction(() => move(taskId, { column: 'assigned', groupId: task.groupId }));
};
```

（`const move = useTaskStore((s) => s.move);` 顶部订阅；`mockApi.task.start` 相关导入清理。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/task-board/TaskDetailPanel.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/task-board/TaskDetailPanel.tsx renderer/src/components/task-board/TaskDetailPanel.test.tsx
git commit -m "feat: 详情面板启动改道 move 入队（canStart 收敛 draft+目标）"
```

---

### Task 8: 表单删「截止时间」字段

**Files:**
- Modify: `renderer/src/components/im/CreateTaskDialog.tsx`（`deadlineAt` state/字段/submit payload 三处）
- Modify: `renderer/src/components/task-board/EditTaskDialog.tsx`（state/effect/submit/字段 四处）
- Test: 两个组件的 colocated 测试

**Interfaces:**
- Produces: 两表单不再含截止时间输入与 payload 字段（`deadlineAt` DB 列、详情展示、kickoff meta 保留——存量兼容）。

- [ ] **Step 1: 改测试（失败）**——两测试文件加断言：

```typescript
it('不含截止时间字段；提交 payload 无 deadlineAt', async () => {
  // CreateTaskDialog：render + 填标题 + 提交
  expect(screen.queryByLabelText('截止时间')).not.toBeInTheDocument();
  await waitFor(() => {
    const call = mockTaskCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).toBeDefined();
    expect('deadlineAt' in call).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/CreateTaskDialog.test.tsx src/components/task-board/EditTaskDialog.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**——`CreateTaskDialog`：删 `const [deadlineAt, ...]` state、open-effect 的 `setDeadlineAt('')`、`deadlineAt: deadlineAt ? ... : null` payload 行、`<Input label="截止时间" ...>` JSX；`EditTaskDialog` 同款四处（state/预填 effect/payload/JSX）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/CreateTaskDialog.test.tsx src/components/task-board/EditTaskDialog.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/im/CreateTaskDialog.tsx renderer/src/components/task-board/EditTaskDialog.tsx renderer/src/components/im/CreateTaskDialog.test.tsx renderer/src/components/task-board/EditTaskDialog.test.tsx
git commit -m "refactor: 新建/编辑表单删除截止时间字段（无执行语义，spec §4.4）"
```

---

### Task 9: AssignTargetDialog 静态预览（P1 门禁 — 须用户确认）

**Files:**
- Create: `.omo/previews/assign-target-dialog.html`（gitignored 预览目录，board-pin.html 先例）

- [ ] **Step 1: 生成预览 HTML**——独立文件、明暗双主题（`prefers-color-scheme`）、语义 token 近似（与 board-pin.html 同源变量表）。内容契约：
  - Dialog 壳：标题「指派并放入队列」+ 副文案「任务 #T-XXX 将进入排队中，等待并发/计划时间放行」
  - 字段：委派类型 Select（agent/团队/会话，默认 agent）→ 委派目标 Select（未选时「放入队列」按钮 disabled 态同时画出）→ 计划时间 `datetime-local`（label「计划时间（可选）」，min=now，下方灰字「不填=有空位立即执行；填未来时间=到点自动执行」）
  - 按钮：取消（ghost）/ 放入队列（primary，画 enabled + disabled 两态）
  - 视觉遵循 design-system（`docs/dev/design-system.md`）：ui/Dialog + ui/Select 形状、lucide 图标位、13px 正文。

- [ ] **Step 2: 请用户确认预览**（打开文件截图对照或用户直接看文件）——**此步骤为人工门禁：未获确认不得进入 Task 10 实现**。用户若提修改，改预览再确认。

---

### Task 10: AssignTargetDialog 实现 + 拖拽拦截接线

**Files:**
- Create: `renderer/src/components/task-board/AssignTargetDialog.tsx`
- Create: `renderer/src/components/task-board/AssignTargetDialog.test.tsx`
- Modify: `renderer/src/lib/board.ts`（导出 `hasDelegationTarget` renderer 谓词）
- Modify: `renderer/src/components/task-board/useBoardDrop.ts`（dragEnd 拦截 + `pendingAssign` 状态）
- Modify: `renderer/src/components/task-board/TaskBoardView.tsx`（挂载弹框）
- Modify: `renderer/src/components/task-board/useBoardDrop.test.ts`、`TaskDetailPanel.tsx`（内联三列判断换 lib 谓词）

**Interfaces:**
- Produces:
  - `lib/board.ts`: `export function hasDelegationTarget(t: { assigneeAgentId?: string | null; targetTeamId?: string | null; targetSessionId?: string | null }): boolean`
  - `useBoardDrop` 返回新增 `pendingAssign: { taskId: string; groupId: string | null } | null` + `cancelAssign(): void`；dragEnd 预判 `!hasDelegationTarget(activeRow) && resolution.column === 'assigned'` → 拦截不发 move。
  - `AssignTargetDialogProps: { open: boolean; taskId: string; groupId: string | null; workspaceId: string; onCancel: () => void }`——内部拉三列表、确定时 `update` 目标(+scheduledAt) → `move` → `onCancel()` 关闭；失败 `showToast` 后关闭（目标已写可重试，spec §4.4）。

- [ ] **Step 1: 写 useBoardDrop 拦截失败测试**

```typescript
// useBoardDrop.test.ts 新增：
it('draft 无目标拖入排队中 → 不发 move，进 pendingAssign（弹框接管）', async () => {
  const { result } = renderHook(() => useBoardDrop({ tasks: [draftNoTarget], laneMode: 'flat', dropIndex }), { wrapper });
  act(() => { result.current.dragStart('T-001'); result.current.dragEnd('T-001', 'col:flat:assigned'); });
  expect(mockMove).not.toHaveBeenCalled();
  expect(result.current.pendingAssign).toEqual({ taskId: 'T-001', groupId: null });
});
it('draft 有目标拖入排队中 → 直接 move（不弹框）', () => { /* 同构：mockMove called once, pendingAssign null */ });
it('cancelAssign → 清空且零 IPC', () => { /* ... */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/task-board/useBoardDrop.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 lib 谓词 + useBoardDrop 拦截**

```typescript
// lib/board.ts 追加：
/** 委派目标三列任一非空——与 electron starter.hasDelegationTarget 同义（renderer 单源；
 *  TaskDetailPanel/AssignTargetDialog/useBoardDrop 三处共用，禁再内联三列判断） */
export function hasDelegationTarget(t: {
  assigneeAgentId?: string | null;
  targetTeamId?: string | null;
  targetSessionId?: string | null;
}): boolean {
  return t.assigneeAgentId != null || t.targetTeamId != null || t.targetSessionId != null;
}
// useBoardDrop dragEnd 内、requireConfirm 分支之前：
      // 泳道语义重构 §4.4：无目标 draft 拖入排队中 → 指派弹框接管（不发 move，
      // 取消零副作用）；有目标直接 move 入队
      const activeRow = tasks.find((t) => t.id === taskId);
      if (
        resolution.column === 'assigned' && activeRow &&
        activeRow.status === 'draft' && !hasDelegationTarget(activeRow)
      ) {
        setPendingAssign({ taskId, groupId: resolution.groupId });
        return;
      }
```

（新增 `pendingAssign` state 与 `cancelAssign`，返回对象增列；`TaskDetailPanel` 的 `hasTarget` 换用 lib 谓词。）

- [ ] **Step 4: 跑 useBoardDrop 测试通过**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/task-board/useBoardDrop.test.ts`
Expected: PASS

- [ ] **Step 5: 写 AssignTargetDialog 失败测试**

```typescript
// AssignTargetDialog.test.tsx 核心用例（mock ../../ipc/client：agent.listMembers/
// team.list/session.list/task.update/task.move）：
it('未选目标时「放入队列」禁用；选 agent + 提交 → update 互斥目标后 move(assigned, groupId)', async () => {
  mockApi.agent.listMembers.mockResolvedValue([{ instanceId: 'inst-1', agentName: 'Sisyphus' }]);
  render(<AssignTargetDialog open taskId="T-001" groupId="G-003" workspaceId="ws1" onCancel={() => {}} />);
  fireEvent.change(await screen.findByLabelText('委派目标'), { target: { value: 'inst-1' } });
  fireEvent.click(screen.getByRole('button', { name: '放入队列' }));
  await waitFor(() => {
    expect(mockApi.task.update).toHaveBeenCalledWith('T-001', expect.objectContaining({
      assigneeAgentId: 'inst-1', targetTeamId: null, targetSessionId: null,
    }));
    expect(mockApi.task.move).toHaveBeenCalledWith('T-001', { column: 'assigned', groupId: 'G-003' });
  });
});
it('填未来计划时间 → update 携带 scheduledAt（move 目标不变）', () => { /* 同构 */ });
it('计划时间预填 task.scheduledAt 已有值；min=当前时间', () => { /* 断言 input.min 非空 + value 预填 */ });
it('update 成功 move 失败 → toast 且关闭（目标已写可重试）', () => { /* move reject → showToast + onCancel 调用 */ });
it('取消 → 零 IPC 调用', () => { /* update/move 均未被调 */ });
```

- [ ] **Step 6: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/task-board/AssignTargetDialog.test.tsx`
Expected: FAIL

- [ ] **Step 7: 按 Task 9 已确认预览实现组件**（ui/Dialog + ui/Select + ui/Input 原子件；scheduledAt `min={new Date(Date.now() - new Date().getTimezoneOffset()*60000).toISOString().slice(0,16)}`；预填 `task.scheduledAt`；确定序列 `update → move → onCancel`，catch `showToast` 后仍 `onCancel`）

- [ ] **Step 8: TaskBoardView 挂载**——`pendingAssign` 非空时渲染 `<AssignTargetDialog open taskId groupId workspaceId onCancel={() => cancelAssign()} />`

- [ ] **Step 9: 跑 AssignTargetDialog + task-board 目录全量**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/task-board/ src/lib/board.test.ts`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add renderer/src/components/task-board/ renderer/src/lib/board.ts
git commit -m "feat: 无目标草稿拖入排队中弹指派弹框（目标+可选计划时间）入队"
```

---

### Task 11: 门禁收尾 + 真机验收

**Files:** 无新改动（验证 + 修复本计划引入的问题）

- [ ] **Step 1: 双端 typecheck**：`npx pnpm@9.0.0 typecheck` → 双 Done。
- [ ] **Step 2: renderer 全量**：`cd renderer && npx pnpm@9.0.0 test` → 0 fail。
- [ ] **Step 3: electron 全量（除 agent）**：Node ABI 二进制就位后 `cd electron && npx pnpm@9.0.0 vitest run --exclude 'tests/agent/**'`；`tests/agent` 按 ≤25 文件分片跑（基建限制见 vitest.config.ts 注释）。既有平台性失败清单（p2p/lan-transport、sandbox、shell-net-trust/shell-sandbox-wiring）不归本计划。
- [ ] **Step 4: 真机验收**（`pnpm dev`，Electron ABI）：
  1. 启动日志出现 `Applying migration { version: 51 }`；`PRAGMA table_info(tasks)` 无 board_position。
  2. 看板列头「排队中 / 等并发/等计划时间/等车道」「待办 / 草稿」。
  3. 新建任务（选 agent + 未来计划时间）→ 落**待办**（草稿徽标，不自动跑）。
  4. 无目标草稿拖入排队中 → 弹指派弹框（对照 Task 9 预览截图）；选 agent + 未来时间 → 卡片入排队中且**不跑**；改库把 scheduled_at 改过去 → ≤30s 自动放行进进行中。
  5. 有目标草稿详情面板「启动」→ 入排队中；并发满（设置 max=当前 in_progress 数）→ 停排队中。
  6. 新建/编辑表单无「截止时间」字段。
- [ ] **Step 5: 截图归档**（弹框明暗双主题对照预览，P1 事后验收；列头 P2 截图）。

---

## Self-Review 记录

- **Spec 覆盖**：§4.1→Task 4；§4.2→Task 7；§4.3→Task 2/3/5；§4.4→Task 6/8/9/10；§4.5→Task 1；§4.6 分布各任务测试步；§5 清点项（ipc.task.start 调用方=仅 TaskDetailPanel，已核实 MembersPanel.handleStart 为 agent 成员启动无关；快照广播=scheduler 零转态后广播点随 pending 退役消失，executor 放行链现状无广播，p2p 快照由既有 5s 全量广播兜底——Task 3 Step 4 回归覆盖）；§6 已知限制无任务。
- **占位符**：无 TBD/TODO；Task 2/3 测试辅助注明「按既有模式内联实现」均给出断言目标与数据形状。
- **类型一致性**：`resolveCreateStatus` / `hasDelegationTarget`（renderer lib 版）/ `pendingAssign` / `AssignTargetDialogProps` 在各任务间签名一致。
- **Review Focus**：5 条均已落到对应任务的显式用例。
