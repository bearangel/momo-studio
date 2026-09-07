# 任务执行运行时实施计划（队列调度 + 委派目标 + 循环任务）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重建任务执行运行时——定时/`#T` 激活双启动、全局并发队列有序放行、agent/团队/会话三类委派目标、单次/循环任务，并修复看板数据层 P0 缺陷。

**Architecture:** 方案 B（spec D1）：新 `executor.ts` 模块做队列放行（写触发 + 30s 兜底双路），kickoff 复用 `sendUserMessage` 进程内路径注入执行会话；委派目标用三互斥列（不动 `assignee_agent_id` 现有消费者）；循环任务用自复制实例（`recurrence_parent_id` 链）；不新增任务状态、状态机零改动。设计全文：`docs/specs/2026-09-07-task-execution-runtime-design.md`。

**Tech Stack:** Electron 主进程（CommonJS）+ better-sqlite3 + React/zustand renderer；无新依赖。

## Global Constraints

- Node 20 LTS：所有命令前 `nvm use 20`；包管理用 `npx pnpm@9.0.0`
- TypeScript strict：禁止 `any` / `@ts-ignore` / `as any`（ESLint `no-explicit-any: error`）
- 所有代码注释使用中文；Conventional Commits（`feat:` / `test:` / `refactor:` / `docs:`）
- renderer 新 UI 只用语义 token（`text-secondary` / `bg-surface-*` 等）；图标用 lucide-react（16px / stroke 1.75）；禁 emoji 图标
- 单测位置：electron 主进程测试集中 `electron/tests/`（子目录镜像 `src/`）；renderer 测试贴源（`Foo.test.tsx` 与 `Foo.tsx` 同目录）
- `dispatcher.ts` 是 2.1 未接线预留模块，**本计划不改不删**
- 涉及 IPC 接口改动时两个 workspace 都要 typecheck

---

### Task 1: Migration v29 + repo 三新字段

**Files:**
- Modify: `electron/src/main/storage/migrations/index.ts`（v28 条目后追加 v29）
- Modify: `electron/src/main/storage/tasks/repo.ts`（TaskRow / SqlRow / rowToCamel / insertTask / updateTask）
- Test: `electron/tests/task/target-columns.test.ts`（新建）

**Interfaces:**
- Produces: `TaskRow` 新增 `targetTeamId: string | null` / `targetSessionId: string | null` / `recurrenceParentId: string | null`；`insertTask` / `updateTask` 支持三字段；DB 层三目标互斥 trigger

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/task/target-columns.test.ts
//
// Migration v29 + tasks repo 三新字段（目标两列 + 循环母任务链）测试。
// 隔离模式与 scheduler.test.ts 相同：tmp 目录 + AP_USER_DATA_DIR + closeDb。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, updateTask } from '../../src/main/storage/tasks/repo';

const tmpRoot = path.join(os.tmpdir(), `ap-targets-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('tasks 目标三列 + 循环链（v29）', () => {
  it('insertTask 带 targetTeamId → getTask 往返保真', () => {
    insertTask({
      workspaceId: 'ws1', title: 'T1', creatorUserId: '@owner:home',
      targetTeamId: 'team-1', status: 'assigned',
    });
    expect(getTask('T-001')?.targetTeamId).toBe('team-1');
    expect(getTask('T-001')?.targetSessionId).toBeNull();
    expect(getTask('T-001')?.recurrenceParentId).toBeNull();
  });

  it('updateTask 改 targetSessionId / recurrenceParentId → 往返保真', () => {
    insertTask({ workspaceId: 'ws1', title: 'T1', creatorUserId: '@owner:home' });
    updateTask('T-001', { targetSessionId: 'sess-1', recurrenceParentId: 'T-000' });
    const t = getTask('T-001')!;
    expect(t.targetSessionId).toBe('sess-1');
    expect(t.recurrenceParentId).toBe('T-000');
  });

  it('两个委派目标同设 → trigger 拒绝（insert 与 update 双路径）', () => {
    expect(() =>
      insertTask({
        workspaceId: 'ws1', title: 'T1', creatorUserId: '@owner:home',
        assigneeAgentId: 'inst1', targetTeamId: 'team-1',
      }),
    ).toThrow(/最多一个非空/);

    insertTask({ workspaceId: 'ws1', title: 'T2', creatorUserId: '@owner:home', assigneeAgentId: 'inst1' });
    expect(() => updateTask('T-001', { targetSessionId: 'sess-1' })).toThrow(/最多一个非空/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/target-columns.test.ts`
Expected: FAIL——`targetTeamId` 不在 TaskRow 类型上（typecheck 报错）或往返读到 undefined

- [ ] **Step 3: 实现 migration v29 + repo 扩展**

`migrations/index.ts` 在 v28 条目（`version: 28` 对象）后追加：

```typescript
  {
    version: 29,
    sql: `
-- ─── v29：任务执行运行时（委派目标三列 + 循环实例链）─────────────────────────
-- spec: docs/specs/2026-09-07-task-execution-runtime-design.md §4.1
-- 三目标互斥用 trigger 模拟 CHECK（SQLite 不支持 ALTER ADD CONSTRAINT，
-- 与 v17 messages.task_id trigger 先例同法）。
ALTER TABLE tasks ADD COLUMN target_team_id      TEXT;
ALTER TABLE tasks ADD COLUMN target_session_id   TEXT;
ALTER TABLE tasks ADD COLUMN recurrence_parent_id TEXT;

-- executor 放行查询：status + 优先级 + 计划时间（spec §5.1）
CREATE INDEX IF NOT EXISTS idx_tasks_admission ON tasks(status, priority DESC, scheduled_at);

CREATE TRIGGER trg_tasks_target_exclusive_insert
BEFORE INSERT ON tasks
BEGIN
  SELECT CASE WHEN
    ((NEW.assignee_agent_id IS NOT NULL) + (NEW.target_team_id IS NOT NULL)
     + (NEW.target_session_id IS NOT NULL)) > 1
  THEN RAISE(ABORT, '任务委派目标三列（agent/team/session）最多一个非空') END;
END;

CREATE TRIGGER trg_tasks_target_exclusive_update
BEFORE UPDATE ON tasks
BEGIN
  SELECT CASE WHEN
    ((NEW.assignee_agent_id IS NOT NULL) + (NEW.target_team_id IS NOT NULL)
     + (NEW.target_session_id IS NOT NULL)) > 1
  THEN RAISE(ABORT, '任务委派目标三列（agent/team/session）最多一个非空') END;
END;
    `.trim(),
  },
```

`repo.ts` 五处扩展（保持既有列序风格）：

`TaskRow`（line 35 `assigneeAgentId` 后）加：

```typescript
  assigneeAgentId: string | null;
  /** 委派目标三列（v29，互斥：最多一个非空；trigger 强制） */
  targetTeamId: string | null;
  targetSessionId: string | null;
  /** 循环实例链：本行由哪次运行完成后续期生成（自复制实例模型，spec §7） */
  recurrenceParentId: string | null;
```

`SqlRow`（line 65 `assignee_agent_id` 后）加 `target_team_id / target_session_id / recurrence_parent_id: string | null;`

`rowToCamel`（line 94 后）加：

```typescript
    assigneeAgentId: r.assignee_agent_id,
    targetTeamId: r.target_team_id,
    targetSessionId: r.target_session_id,
    recurrenceParentId: r.recurrence_parent_id,
```

`insertTask`：INSERT 列清单在 `assignee_agent_id,` 后加三列，VALUES 加三个 `?`（参数总数 25→28），`.run(...)` 在 `input.assigneeAgentId,` 后加 `input.targetTeamId, input.targetSessionId, input.recurrenceParentId,`

`updateTask`：UPDATE SET 在 `assignee_agent_id=?,` 后加 `target_team_id=?, target_session_id=?, recurrence_parent_id=?,`；`.run()` 在 `next.assigneeAgentId,` 后加 `next.targetTeamId, next.targetSessionId, next.recurrenceParentId,`

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/target-columns.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: 跑既有测试防回归 + commit**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage tests/task`
Expected: 全绿（migration 既有测试兼容新列）

```bash
git add electron/src/main/storage/migrations/index.ts electron/src/main/storage/tasks/repo.ts electron/tests/task/target-columns.test.ts
git commit -m "feat: tasks 表 v29 迁移——委派目标三互斥列 + 循环实例链"
```

---

### Task 2: recurrence 规则模块（nextRun 纯函数 + 续期生成）

**Files:**
- Create: `electron/src/main/task/recurrence.ts`
- Test: `electron/tests/task/recurrence.test.ts`（新建）

**Interfaces:**
- Produces: `nextRun(from: number, rule: string): number | null`——三种预设规则推算下次运行时间；`spawnNextInstanceIfRecurring(taskId: string): void`——completed 任务按规则生成下一实例（依赖 Task 1 的 `recurrenceParentId` / 目标三列）

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/task/recurrence.test.ts
//
// nextRun 纯函数 + spawnNextInstanceIfRecurring 测试。
// 时间全部注入固定值，不依赖真实时钟（防 flaky）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, listTasks } from '../../src/main/storage/tasks/repo';
import { nextRun, spawnNextInstanceIfRecurring } from '../../src/main/task/recurrence';

const tmpRoot = path.join(os.tmpdir(), `ap-rec-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('nextRun 纯函数', () => {
  // 2026-09-07 08:30 (周一) UTC+0 本地时区无关——用 Date 构造
  const base = new Date(2026, 8, 7, 8, 30).getTime();

  it('every:30m → 完成时间 + 30 分钟', () => {
    expect(nextRun(base, 'every:30m')).toBe(base + 30 * 60_000);
  });
  it('every:2h / every:1d 单位换算', () => {
    expect(nextRun(base, 'every:2h')).toBe(base + 2 * 3_600_000);
    expect(nextRun(base, 'every:1d')).toBe(base + 86_400_000);
  });
  it('daily@09:00 → 当天 09:00（08:30 未过）', () => {
    expect(nextRun(base, 'daily@09:00')).toBe(new Date(2026, 8, 7, 9, 0).getTime());
  });
  it('daily@09:00 → 已过 09:00 取明天', () => {
    const late = new Date(2026, 8, 7, 9, 30).getTime();
    expect(nextRun(late, 'daily@09:00')).toBe(new Date(2026, 8, 8, 9, 0).getTime());
  });
  it('weekly@1,09:00 → 周一 08:30 取当天；周一 09:30 取下周一', () => {
    expect(nextRun(base, 'weekly@1,09:00')).toBe(new Date(2026, 8, 7, 9, 0).getTime());
    const late = new Date(2026, 8, 7, 9, 30).getTime();
    expect(nextRun(late, 'weekly@1,09:00')).toBe(new Date(2026, 8, 14, 9, 0).getTime());
  });
  it('weekly@3,09:00 → 周一取本周三', () => {
    expect(nextRun(base, 'weekly@3,09:00')).toBe(new Date(2026, 8, 9, 9, 0).getTime());
  });
  it('非法规则 / 非法数值 → null', () => {
    expect(nextRun(base, 'cron:0 9 * * *')).toBeNull();
    expect(nextRun(base, 'every:0m')).toBeNull();
    expect(nextRun(base, 'daily@25:00')).toBeNull();
    expect(nextRun(base, '')).toBeNull();
  });
});

describe('spawnNextInstanceIfRecurring', () => {
  it('completed + every:30m → 生成 pending 下一实例（字段复制 + scheduledAt + 母链）', () => {
    const now = Date.now();
    insertTask({
      workspaceId: 'ws1', title: '日报', description: '写日报', creatorUserId: 'owner',
      priority: 5, assigneeAgentId: 'inst1', recurrenceRule: 'every:30m',
      status: 'in_progress', startedAt: now - 60_000,
    });
    getDb().prepare(
      `UPDATE tasks SET status='completed', completed_at=? WHERE id='T-001'`,
    ).run(now);
    // completed 由 updateTask 裸写（此处测 spawn，不测状态机）

    spawnNextInstanceIfRecurring('T-001');

    const next = listTasks({ workspaceId: 'ws1' }).find((t) => t.id !== 'T-001')!;
    expect(next.status).toBe('pending');
    expect(next.recurrenceParentId).toBe('T-001');
    expect(next.recurrenceRule).toBe('every:30m');
    expect(next.assigneeAgentId).toBe('inst1');
    expect(next.scheduledAt).toBe(now + 30 * 60_000);
    expect(next.title).toBe('日报');
    expect(next.deadlineAt).toBeNull(); // deadline 不复制（spec §7.2）
  });

  it('failed / 无规则 / 非 completed → 不生成', () => {
    insertTask({ workspaceId: 'ws1', title: 'A', creatorUserId: 'owner', recurrenceRule: 'every:1h', status: 'failed' });
    insertTask({ workspaceId: 'ws1', title: 'B', creatorUserId: 'owner', status: 'completed' });
    spawnNextInstanceIfRecurring('T-001');
    spawnNextInstanceIfRecurring('T-002');
    expect(listTasks({ workspaceId: 'ws1' })).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/recurrence.test.ts`
Expected: FAIL——模块不存在

- [ ] **Step 3: 实现 recurrence.ts**

```typescript
// electron/src/main/task/recurrence.ts
//
// 循环任务规则（spec §7）：三种预设编码 + 完成后续期生成。
//   every:Nm|Nh|Nd  间隔型——从完成时间起算
//   daily@HH:mm      每天——取严格晚于 from 的下一个时间点
//   weekly@D,HH:mm   每周（0=周日）——取严格晚于 from 的下一个时间点
// 本期不做 cron 解析（spec D5）；非法规则一律 nextRun → null（不抛错，
// spawn 侧静默跳过——规则坏了不能拖垮任务终态处理链）。
import { getTask, insertTask } from '../storage/tasks/repo';
import { broadcastLocalTaskSnapshot } from '../p2p/task-broadcast';
import { logger } from '../logger';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** 推算下次运行时间；规则非法返回 null */
export function nextRun(from: number, rule: string): number | null {
  const ev = /^every:(\d+)([mhd])$/.exec(rule);
  if (ev) {
    const n = parseInt(ev[1], 10);
    if (n <= 0) return null;
    const unitMs = ev[2] === 'm' ? MINUTE : ev[2] === 'h' ? HOUR : DAY;
    return from + n * unitMs;
  }
  const dv = /^daily@(\d{1,2}):(\d{2})$/.exec(rule);
  if (dv) {
    const h = parseInt(dv[1], 10);
    const mi = parseInt(dv[2], 10);
    if (h > 23 || mi > 59) return null;
    const d = new Date(from);
    d.setHours(h, mi, 0, 0);
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const wv = /^weekly@(\d),(\d{1,2}):(\d{2})$/.exec(rule);
  if (wv) {
    const wd = parseInt(wv[1], 10);
    const h = parseInt(wv[2], 10);
    const mi = parseInt(wv[3], 10);
    if (wd > 6 || h > 23 || mi > 59) return null;
    const d = new Date(from);
    d.setHours(h, mi, 0, 0);
    const offset = (wd - d.getDay() + 7) % 7;
    let t = d.getTime() + offset * DAY;
    if (t <= from) t += 7 * DAY;
    return t;
  }
  return null;
}

/**
 * 完成后续期（spec §7.2）：任务带规则且已 completed → 生成下一实例。
 * failed / cancelled / 无规则 / 规则非法 → 静默跳过（链自然停止）。
 * transition 单点调用（agent-runner task-end / task-tools completeTask），
 * 天然无重复 spawn。
 */
export function spawnNextInstanceIfRecurring(taskId: string): void {
  const task = getTask(taskId);
  if (!task?.recurrenceRule || task.status !== 'completed') return;
  const at = nextRun(task.completedAt ?? Date.now(), task.recurrenceRule);
  if (at === null) {
    logger.warn('循环规则无法解析，链停止', { taskId, rule: task.recurrenceRule });
    return;
  }
  const next = insertTask({
    workspaceId: task.workspaceId,
    title: task.title,
    description: task.description,
    creatorUserId: task.creatorUserId,
    sourceSessionId: task.sourceSessionId,
    assigneeAgentId: task.assigneeAgentId,
    targetTeamId: task.targetTeamId,
    targetSessionId: task.targetSessionId,
    priority: task.priority,
    recurrenceRule: task.recurrenceRule,
    status: 'pending',
    scheduledAt: at,
    recurrenceParentId: task.id,
    // deadline 不复制（spec §7.2：绝对截止时间对下次运行无意义）
  });
  logger.info('循环任务已续期', { parent: task.id, next: next.id, scheduledAt: at });
  void broadcastLocalTaskSnapshot();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/recurrence.test.ts`
Expected: PASS（9 个用例）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/task/recurrence.ts electron/tests/task/recurrence.test.ts
git commit -m "feat: 循环任务规则模块——nextRun 纯函数 + 完成后自复制续期"
```

---

### Task 3: team.ts 导出 + starter 团队分支

**Files:**
- Modify: `electron/src/main/agent/team.ts`（加 3 个导出）
- Modify: `electron/src/main/task/starter.ts`（决策树团队分支）
- Test: `electron/tests/task/starter-team.test.ts`（新建）

**Interfaces:**
- Produces: `teamExists(teamId: string): boolean`；`expandTeamMembers(teamId: string): WorkspaceAgentMember[]`；`getTeamLeaderInstanceId(teamId: string): string | null`（均在 `agent/team.ts`）；`startTask` 支持团队目标任务（`task.targetTeamId` 非空 → 事务内建 `kind='task_execution'` 会话 + 团队快照成员 + leader 标记）

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/task/starter-team.test.ts
//
// starter 团队分支（spec §5.3）：targetTeamId 任务启动 → 事务内建
// task_execution 会话 + 成员=团队快照展开 + leader is_leader=1 + 转 in_progress。
// seed 直接写 teams / team_members / workspace_agent_members / agent_definitions
// （不走 createTeam 服务——少一层校验依赖）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask } from '../../src/main/storage/tasks/repo';
import { startTask } from '../../src/main/task/starter';
import { getSessionMembersInfo } from '../../src/main/storage/sessions/repo';

const tmpRoot = path.join(os.tmpdir(), `ap-st-team-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function seedTeam(): void {
  const db = getDb();
  db.prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'T', '/tmp', '@o')`).run();
  db.prepare(`INSERT INTO agent_definitions (id, slug, name, created_at, updated_at) VALUES ('def1', 'coder', 'Coder', 0, 0)`).run();
  const insMember = db.prepare(
    `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, added_at) VALUES (?, 'ws1', 'def1', 0)`,
  );
  insMember.run('leader1');
  insMember.run('member1');
  db.prepare(`INSERT INTO teams (id, workspace_id, name, icon_emoji, leader_instance_id, created_at) VALUES ('team1', 'ws1', '组', '👥', 'leader1', 0)`).run();
  const insTm = db.prepare(`INSERT INTO team_members (team_id, instance_id, added_at) VALUES ('team1', ?, 0)`);
  insTm.run('leader1');
  insTm.run('member1');
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  seedTeam();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('startTask 团队分支', () => {
  it('团队目标任务 → 新建执行会话（成员快照 + leader 标记）+ 转 in_progress', async () => {
    insertTask({
      workspaceId: 'ws1', title: '团队任务', creatorUserId: 'owner',
      targetTeamId: 'team1', status: 'assigned',
    });
    const result = await startTask('T-001');

    expect(result.createdNewRoom).toBe(true);
    const task = getTask('T-001')!;
    expect(task.status).toBe('in_progress');
    expect(task.executionSessionId).toBe(result.executionSessionId);

    const members = getSessionMembersInfo(result.executionSessionId);
    expect(members).toHaveLength(2);
    const leader = members.find((m) => m.isLeader);
    expect(leader?.instanceId).toBe('leader1'); // leader 标记 = 接待路由依据
  });

  it('团队已解散 → 抛错且任务保持 assigned', async () => {
    getDb().prepare(`DELETE FROM teams WHERE id='team1'`).run();
    insertTask({
      workspaceId: 'ws1', title: '孤儿任务', creatorUserId: 'owner',
      targetTeamId: 'team1', status: 'assigned',
    });
    await expect(startTask('T-001')).rejects.toThrow(/目标团队不存在/);
    expect(getTask('T-001')!.status).toBe('assigned');
  });
});
```

注意：`agent_definitions` / `workspace_agent_members` / `teams` / `team_members` / `sessions` 的必填列以现行 migration 定义为准——若 seed INSERT 报 NOT NULL 错，按 `migrations/index.ts` 中对应表的 DDL 补齐缺失列（不要改表）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/starter-team.test.ts`
Expected: FAIL——`teamExists` 未导出（或团队任务走了「新建任务会话」旧分支，成员数 0）

- [ ] **Step 3: 实现**

`team.ts` 文件末尾追加：

```typescript
/** 团队是否存在（executor 目标校验 / starter 团队分支用） */
export function teamExists(teamId: string): boolean {
  return getTeamRow(teamId) !== undefined;
}

/** 展开团队成员（starter 建团队执行会话时的成员快照） */
export function expandTeamMembers(teamId: string): WorkspaceAgentMember[] {
  return loadMembersByTeam([teamId]).get(teamId) ?? [];
}

/** 团队 leader 的 instanceId（执行会话 is_leader 标记来源）；团队不存在返回 null */
export function getTeamLeaderInstanceId(teamId: string): string | null {
  return getTeamRow(teamId)?.leader_instance_id ?? null;
}
```

`starter.ts`：import 区加 `import { teamExists, expandTeamMembers, getTeamLeaderInstanceId } from '../agent/team';`；`addSessionMember` import 保持（见下）。决策树（`getDb().transaction` 内，`o.createNewRoom` 分支后插入）：

```typescript
    if (o.executionSessionId) {
      executionSessionId = o.executionSessionId;
    } else if (o.createNewRoom) {
      executionSessionId = createNewTaskRoom(task);
      createdNewRoom = true;
    } else if (task.targetTeamId) {
      // v29 团队分支（spec §5.3）：事务内建执行会话 + 团队快照成员 +
      // leader is_leader 标记（kickoff 无 mention → 接待路由给 leader）
      if (!teamExists(task.targetTeamId)) {
        throw new Error(`目标团队不存在: ${task.targetTeamId}`);
      }
      executionSessionId = createTeamTaskRoom(task);
      createdNewRoom = true;
    } else if (task.sourceSessionId) {
```

文件末尾追加（与 `createNewTaskRoom` 同风格）：

```typescript
/** 建团队执行会话：成员=团队快照展开，leader 加 is_leader=1（接待路由依据） */
function createTeamTaskRoom(task: TaskRow): string {
  const titlePrefix = task.title.slice(0, 20);
  const row = insertSession({
    workspaceId: task.workspaceId,
    title: `任务 #${task.id}: ${titlePrefix}`,
    kind: 'task_execution',
  });
  const leaderId = getTeamLeaderInstanceId(task.targetTeamId!);
  for (const m of expandTeamMembers(task.targetTeamId!)) {
    addSessionMember(row.id, m.instanceId, m.instanceId === leaderId);
  }
  return row.id;
}
```

既有 `if (createdNewRoom && task.assigneeAgentId)` 分支不动——团队任务因互斥约束无 assignee，天然不冲突。文件头注释的决策优先级列表同步加一行团队分支。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/starter-team.test.ts tests/task/starter.test.ts`
Expected: PASS（新 2 用例 + 既有 starter 回归全绿）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/team.ts electron/src/main/task/starter.ts electron/tests/task/starter-team.test.ts
git commit -m "feat: startTask 团队分支——事务内建团队执行会话（快照成员+leader 标记）"
```

---

### Task 4: executor 模块（队列放行 + kickoff 注入 + notify 去抖）

**Files:**
- Create: `electron/src/main/task/executor.ts`
- Test: `electron/tests/task/executor.test.ts`（新建）

**Interfaces:**
- Consumes: `startTask`（Task 3 扩展后）；repo 层三新字段（Task 1）
- Produces:
  - `interface ExecutorDeps { sendKickoff(input: { sessionId: string; body: string; mentionedInstanceIds?: string[] }): Promise<void>; getGlobalMax?(): number; sweepIntervalMs?: number; }`
  - `class TaskExecutor { init(deps): void; start(): void; stop(): void; notify(): void; admitOnce(): Promise<void> }`
  - 模块级单例 `taskExecutor` 与 `notifyExecutor(): void`（后续任务统一 import 这两个）

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/task/executor.test.ts
//
// TaskExecutor 放行测试（spec §5.1）：全局并发 gate / 放行排序 /
// 目标校验失败→failed / kickoff 失败→failed / 会话目标走显式 executionSessionId。
// kickoff 走注入的 fake（不依赖 session-service / router 真链路）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, listTasks } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { TaskExecutor } from '../../src/main/task/executor';

const tmpRoot = path.join(os.tmpdir(), `ap-exec-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'T', '/tmp', '@o')`)
    .run();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** agent 目标合法 seed：workspace_agent_members 有 inst1 */
function seedAgentMember(instanceId: string): void {
  getDb()
    .prepare(
      `INSERT INTO agent_definitions (id, slug, name, created_at, updated_at) VALUES ('def1', 'c', 'C', 0, 0)`,
    )
    .run();
  getDb()
    .prepare(
      `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, added_at) VALUES (?, 'ws1', 'def1', 0)`,
    )
    .run(instanceId);
}

function mkExecutor(max: number, kickoff: ExecutorDeps['sendKickoff']): TaskExecutor {
  const ex = new TaskExecutor();
  ex.init({ sendKickoff: kickoff, getGlobalMax: () => max });
  return ex;
}

describe('TaskExecutor.admitOnce', () => {
  it('并发满 → assigned 不放行', async () => {
    seedAgentMember('inst1');
    insertTask({ workspaceId: 'ws1', title: 'running', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'in_progress', startedAt: Date.now() });
    insertTask({ workspaceId: 'ws1', title: 'waiting', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'assigned' });
    const ex = mkExecutor(1, vi.fn().mockResolvedValue(undefined));
    await ex.admitOnce();
    expect(getTask('T-002')!.status).toBe('assigned'); // 满 1 不放行
  });

  it('有空位 → 按优先级放行 + kickoff 注入执行会话（agent 目标带 mention）', async () => {
    seedAgentMember('inst1');
    insertTask({ workspaceId: 'ws1', title: 'low', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'assigned', priority: 1 });
    insertTask({ workspaceId: 'ws1', title: 'high', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'assigned', priority: 10 });
    const kickoff = vi.fn().mockResolvedValue(undefined);
    const ex = mkExecutor(1, kickoff);
    await ex.admitOnce();

    expect(getTask('T-002')!.status).toBe('in_progress'); // 高优先级先放行
    expect(getTask('T-001')!.status).toBe('assigned');
    expect(kickoff).toHaveBeenCalledTimes(1);
    const call = kickoff.mock.calls[0][0];
    expect(call.mentionedInstanceIds).toEqual(['inst1']);
    expect(call.body).toContain('【任务启动】#T-002 · high');
    expect(getTask('T-002')!.executionSessionId).toBe(call.sessionId);
  });

  it('目标无效（agent 已移除）→ 转 failed 带明示错误，不占槽，后续候选继续', async () => {
    seedAgentMember('inst1');
    insertTask({ workspaceId: 'ws1', title: 'orphan', creatorUserId: 'o', assigneeAgentId: 'gone', status: 'assigned', priority: 10 });
    insertTask({ workspaceId: 'ws1', title: 'ok', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'assigned', priority: 1 });
    const ex = mkExecutor(1, vi.fn().mockResolvedValue(undefined));
    await ex.admitOnce();

    const orphan = getTask('T-001')!;
    expect(orphan.status).toBe('failed');
    expect(orphan.errorMessage).toContain('指派 agent');
    expect(getTask('T-002')!.status).toBe('in_progress'); // 失败不占槽，下一个顶上
  });

  it('会话目标任务 → kickoff 进目标会话（显式 executionSessionId 路径）', async () => {
    const sess = insertSession({ workspaceId: 'ws1', title: '已有会话', kind: 'quick' });
    insertTask({ workspaceId: 'ws1', title: 'inplace', creatorUserId: 'o', targetSessionId: sess.id, status: 'assigned' });
    const kickoff = vi.fn().mockResolvedValue(undefined);
    await mkExecutor(3, kickoff).admitOnce();

    const t = getTask('T-001')!;
    expect(t.status).toBe('in_progress');
    expect(t.executionSessionId).toBe(sess.id);
    expect(kickoff.mock.calls[0][0].sessionId).toBe(sess.id);
    expect(kickoff.mock.calls[0][0].mentionedInstanceIds).toBeUndefined(); // 会话目标不 mention → 接待路由
  });

  it('kickoff 抛错 → 任务转 failed 带错误信息', async () => {
    seedAgentMember('inst1');
    insertTask({ workspaceId: 'ws1', title: 'boom', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'assigned' });
    const kickoff = vi.fn().mockRejectedValue(new Error('session 服务不可用'));
    await mkExecutor(3, kickoff).admitOnce();

    const t = getTask('T-001')!;
    expect(t.status).toBe('failed');
    expect(t.errorMessage).toContain('session 服务不可用');
  });

  it('pending（未到点）与 draft 不参与放行', async () => {
    seedAgentMember('inst1');
    insertTask({ workspaceId: 'ws1', title: 'p', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'pending', scheduledAt: Date.now() + 60_000 });
    insertTask({ workspaceId: 'ws1', title: 'd', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'draft' });
    const kickoff = vi.fn().mockResolvedValue(undefined);
    await mkExecutor(3, kickoff).admitOnce();
    expect(kickoff).not.toHaveBeenCalled();
    expect(listTasks({ workspaceId: 'ws1', status: 'in_progress' })).toHaveLength(0);
  });
});
```

（顶部 `import type { ExecutorDeps } from '../../src/main/task/executor';` 一并加上。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/executor.test.ts`
Expected: FAIL——模块不存在

- [ ] **Step 3: 实现 executor.ts**

```typescript
// electron/src/main/task/executor.ts
//
// TaskExecutor —— 队列放行 + kickoff 注入（spec §5，方案 B）。
//
// 职责：
//   - admitOnce：全局并发 gate（count(in_progress) < maxConcurrentTasks）
//     → 按优先级/计划时间/创建时间取队首 assigned → 校验目标 → startTask
//     → 向执行会话注入 kickoff 消息
//   - notify：写触发入口（100ms 去抖合并）——task 域写通道成功后调用
//   - start/stop：30s 兜底扫描定时器（丢失通知自愈）
//
// 设计要点：
//   - kickoff 的消息发送通过 deps.sendKickoff 注入（runtime-init 接
//     sendUserMessage）——避免 executor → im/session-service → activation →
//     executor 的 import 环
//   - admitOnce 串行互斥（admitting 标志）：并发放行不超限
//   - 每次成功放行后重查 in_progress 数（以 DB 为准，不信任内存计数）
//   - 全状态在 DB：通知只是加速器，丢了有兜底扫描（与 task-broadcast 同构）
//   - dispatcher.ts 是 2.1 未接线预留（per-agent 并发 + 直启子进程模型），
//     本模块是全新会话驱动路径，互不相干
import { getDb } from '../storage/db';
import { getTask, transitionTaskStatus, type TaskRow } from '../storage/tasks/repo';
import { startTask } from './starter';
import { teamExists } from '../agent/team';
import { getSession } from '../storage/sessions/repo';
import { getGlobalSettings } from '../settings/crud';
import { logger } from '../logger';

/** kickoff 注入依赖（runtime-init 装配时注入 sendUserMessage 包装） */
export interface ExecutorDeps {
  sendKickoff(input: { sessionId: string; body: string; mentionedInstanceIds?: string[] }): Promise<void>;
  /** 测试注入全局并发上限；缺省读 global_settings */
  getGlobalMax?(): number;
  /** 兜底扫描间隔（毫秒），默认 30s */
  sweepIntervalMs?: number;
}

const DEFAULT_SWEEP_MS = 30_000;
const NOTIFY_DEBOUNCE_MS = 100;
const PRIORITY_LABEL: Record<number, string> = { 1: '低', 5: '中', 10: '高' };

class TaskExecutor {
  private deps: ExecutorDeps | null = null;
  private timer: NodeJS.Timeout | null = null;
  private notifyTimer: NodeJS.Timeout | null = null;
  private admitting = false;

  init(deps: ExecutorDeps): void {
    this.deps = deps;
  }

  start(): void {
    if (this.timer || !this.deps) return;
    const interval = this.deps.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
    this.timer = setInterval(() => this.safeAdmit(), interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
  }

  /** 写触发入口：100ms 去抖合并后立即评估放行 */
  notify(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.safeAdmit();
    }, NOTIFY_DEBOUNCE_MS);
    this.notifyTimer.unref?.();
  }

  private safeAdmit(): void {
    void this.admitOnce().catch((err: unknown) => {
      logger.warn('executor 放行轮异常', { error: err instanceof Error ? err.message : String(err) });
    });
  }

  /** 放行一轮：串行互斥（防并发改行超限） */
  async admitOnce(): Promise<void> {
    if (!this.deps || this.admitting) return;
    this.admitting = true;
    try {
      const max = this.deps.getGlobalMax?.() ?? getGlobalSettings().maxConcurrentTasks;
      let slots = max - countInProgress();
      while (slots > 0) {
        const candidate = peekNextAssigned(slots);
        if (!candidate) break;
        const launched = await this.launch(candidate);
        if (!launched) continue; // 目标无效转 failed 不占槽 → 继续看下一候选
        slots = max - countInProgress(); // 以 DB 为准重查
      }
    } finally {
      this.admitting = false;
    }
  }

  /** 单候选放行：目标校验 → startTask → kickoff。返回是否占槽 */
  private async launch(task: TaskRow): Promise<boolean> {
    const invalid = validateTarget(task);
    if (invalid) {
      failQuietly(task.id, invalid);
      return false;
    }
    let executionSessionId: string;
    try {
      const result = await startTask(task.id, task.targetSessionId ? { executionSessionId: task.targetSessionId } : undefined);
      executionSessionId = result.executionSessionId;
    } catch (err) {
      // startTask 抛错（状态竞态 / 锁定冲突等）：留给兜底扫描重试，本轮跳过
      logger.warn('executor startTask 失败（跳过该候选）', {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    try {
      await this.deps!.sendKickoff({
        sessionId: executionSessionId,
        body: buildKickoffBody(task),
        mentionedInstanceIds: task.assigneeAgentId ? [task.assigneeAgentId] : undefined,
      });
    } catch (err) {
      failQuietly(task.id, `kickoff 注入失败: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    logger.info('executor 已放行任务', { taskId: task.id, executionSessionId });
    return true;
  }
}

function countInProgress(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status='in_progress'`)
    .get() as { n: number };
  return row.n;
}

/** 队首候选：assigned 按放行序（spec §4.4），排除本轮已处理过的失败候选 */
function peekNextAssigned(slots: number): TaskRow | null {
  const rows = getDb()
    .prepare(
      `SELECT id FROM tasks WHERE status='assigned'
       ORDER BY priority DESC, COALESCE(scheduled_at, created_at) ASC, created_at ASC
       LIMIT ?`,
    )
    .all(Math.max(slots, 1)) as Array<{ id: string }>;
  for (const r of rows) {
    const t = getTask(r.id);
    if (t && t.status === 'assigned') return t; // SELECT 与读取间竞态防御
  }
  return null;
}

/** 目标有效性校验：返回错误文案（null = 通过）。spec §9 边界表 */
function validateTarget(task: TaskRow): string | null {
  if (task.assigneeAgentId) {
    const member = getDb()
      .prepare(
        `SELECT 1 FROM workspace_agent_members WHERE instance_id = ? AND workspace_id = ?`,
      )
      .get(task.assigneeAgentId, task.workspaceId);
    if (!member) return `指派 agent 已不在工作空间: ${task.assigneeAgentId.slice(0, 12)}`;
    return null;
  }
  if (task.targetTeamId && !teamExists(task.targetTeamId)) {
    return `目标团队已解散: ${task.targetTeamId.slice(0, 12)}`;
  }
  if (task.targetSessionId && !getSession(task.targetSessionId)) {
    return `目标会话不存在: ${task.targetSessionId.slice(0, 12)}`;
  }
  return null;
}

/** 转 failed：吞错（任务可能已被并发改态），只留日志 */
function failQuietly(taskId: string, reason: string): void {
  try {
    transitionTaskStatus(taskId, 'failed', { completedAt: Date.now(), errorMessage: reason });
    logger.warn('executor 候选转 failed', { taskId, reason });
  } catch (err) {
    logger.warn('executor 候选转 failed 失败（并发改态）', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** kickoff 消息体（spec §5.4） */
export function buildKickoffBody(task: TaskRow): string {
  const lines = [`【任务启动】#${task.id} · ${task.title}`];
  if (task.description) lines.push('', task.description);
  const meta: string[] = [];
  if (PRIORITY_LABEL[task.priority]) meta.push(`优先级:${PRIORITY_LABEL[task.priority]}`);
  if (task.deadlineAt) meta.push(`截止:${new Date(task.deadlineAt).toLocaleString('zh-CN')}`);
  if (meta.length > 0) lines.push('', meta.join('　'));
  return lines.join('\n');
}

/** 模块级单例 + 写触发入口（全线统一 import 这两个） */
export const taskExecutor = new TaskExecutor();
export function notifyExecutor(): void {
  taskExecutor.notify();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/executor.test.ts`
Expected: PASS（6 个用例）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/task/executor.ts electron/tests/task/executor.test.ts
git commit -m "feat: TaskExecutor 队列放行模块——全局并发 gate + kickoff 注入 + 写触发去抖"
```

---

### Task 5: 运行时接线（runtime-init 装配 + 写通道埋点 + 终态钩子）

**Files:**
- Modify: `electron/src/main/task/runtime-init.ts`（executor 装配 + scheduler scanPickup 改 notify）
- Modify: `electron/src/main/task/ipc.handlers.ts`（写通道埋点）
- Modify: `electron/src/main/settings/ipc.handlers.ts`（并发上限变更埋点）
- Modify: `electron/src/main/agent/agent-runner.ts`（终态钩子：续期 + notify）
- Modify: `electron/src/main/agent/tools/task-tools.ts`（completeTask / failTask 钩子）
- Test: `electron/tests/task/runtime-init.test.ts`（更新）

**Interfaces:**
- Consumes: `taskExecutor` / `notifyExecutor`（Task 4）；`spawnNextInstanceIfRecurring`（Task 2）
- Produces: boot 后执行运行时在位——`initTaskRuntime()` 同时启动 scheduler + executor；全部 task 写通道与终态转换都会触发放行评估

- [ ] **Step 1: 更新 runtime-init 测试**

先读 `electron/tests/task/runtime-init.test.ts` 既有结构，在其 describe 中追加用例（沿用其 DB 隔离模式；若无 DB seed 则按 Task 4 测试的 beforeEach 模式补）：

```typescript
  it('initTaskRuntime 后 executor 在位：assigned 任务在 boot 即被放行', async () => {
    getDb()
      .prepare(
        `INSERT INTO agent_definitions (id, slug, name, created_at, updated_at) VALUES ('def1', 'c', 'C', 0, 0)`,
      )
      .run();
    getDb()
      .prepare(
        `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, added_at) VALUES ('inst1', 'ws1', 'def1', 0)`,
      )
      .run();
    insertTask({ workspaceId: 'ws1', title: 'boot', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'assigned' });

    const kickoffs: Array<{ sessionId: string }> = [];
    initTaskRuntime({ kickoff: (input) => { kickoffs.push(input); } });
    await vi.waitFor(() => expect(getTask('T-001')!.status).toBe('in_progress'));
    expect(kickoffs).toHaveLength(1);
    stopTaskRuntime();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/runtime-init.test.ts`
Expected: FAIL——`initTaskRuntime` 无 `kickoff` 入参

- [ ] **Step 3: 实现接线**

`runtime-init.ts` 重写（保持既有导出名与幂等语义）：

```typescript
// electron/src/main/task/runtime-init.ts
//
// task-driven runtime 调度层初始化：TaskScheduler（定时升级）+ TaskExecutor（队列放行）。
// executor 的 kickoff 依赖在此注入（sendUserMessage 包装）——避免 executor
// → im/session-service → task/activation → executor 的 import 环。
import { TaskScheduler } from './scheduler';
import { taskExecutor, type ExecutorDeps } from './executor';
import { sendUserMessage } from '../im/session-service';
import { logger } from '../logger';

let scheduler: TaskScheduler | null = null;

export interface InitTaskRuntimeOpts {
  intervalMs?: number;
  /** 测试注入 kickoff（缺省 sendUserMessage 包装） */
  kickoff?: ExecutorDeps['sendKickoff'];
  /** 测试注入全局并发上限 */
  getGlobalMax?: () => number;
}

export function initTaskRuntime(opts?: InitTaskRuntimeOpts): void {
  if (scheduler) scheduler.stop();
  taskExecutor.stop();

  scheduler = new TaskScheduler({
    // 到点升级（pending → assigned）后通知 executor 立即评估放行
    scanPickup: async (): Promise<boolean> => {
      taskExecutor.notify();
      return true;
    },
    intervalMs: opts?.intervalMs,
  });

  taskExecutor.init({
    sendKickoff: opts?.kickoff ?? (async (input) => {
      await sendUserMessage({
        sessionId: input.sessionId,
        body: input.body,
        mentionedInstanceIds: input.mentionedInstanceIds,
      });
    }),
    getGlobalMax: opts?.getGlobalMax,
  });

  scheduler.start();
  taskExecutor.start();
  taskExecutor.notify(); // boot 恢复：assigned 池立即评估一轮
  logger.info('task runtime 已启动（scheduler + executor）');
}

export function stopTaskRuntime(): void {
  scheduler?.stop();
  scheduler = null;
  taskExecutor.stop();
}
```

`task/ipc.handlers.ts`：import 加 `import { notifyExecutor } from './executor';`；在**每个已有** `void broadcastLocalTaskSnapshot();` 的 handler（create / transition / cancel / start）后各加一行 `notifyExecutor();`。

`settings/ipc.handlers.ts`：`'settings:updateGlobal'` handler 中 `updateGlobalSettings(patch);` 后加：

```typescript
  // 并发上限变更 → 立即评估补充放行（spec §9 边界表）
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'maxConcurrentTasks')) {
    notifyExecutor();
  }
```

（import：`import { notifyExecutor } from '../task/executor';`）

`agent-runner.ts` `finalizeActiveTask`：transition 成功的 try 块内（`transitionTaskStatus(...)` 之后）加：

```typescript
      // 循环任务续期（仅 completed；spec §7.2）+ 释放槽位立即评估放行
      if (to === 'completed') spawnNextInstanceIfRecurring(taskId);
      notifyExecutor();
```

`failTaskOnCrash`：`transitionTaskStatus(taskId, 'failed', {...})` 后加 `notifyExecutor();`

`task-tools.ts`：`completeTask` 的 `transitionTaskStatus(...)` 后加 `spawnNextInstanceIfRecurring(taskId); notifyExecutor();`；`failTask` 的 `transitionTaskStatus(...)` 后加 `notifyExecutor();`

（以上 import：`import { spawnNextInstanceIfRecurring } from '../../task/recurrence';`、`import { notifyExecutor } from '../../task/executor';`——按各文件相对路径调整）

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/`
Expected: 全绿（含 runtime-init 既有用例）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/task/runtime-init.ts electron/src/main/task/ipc.handlers.ts electron/src/main/settings/ipc.handlers.ts electron/src/main/agent/agent-runner.ts electron/src/main/agent/tools/task-tools.ts electron/tests/task/runtime-init.test.ts
git commit -m "feat: 执行运行时接线——boot 装配 + task/settings 写通道埋点 + 终态续期钩子"
```

---

### Task 6: #T 激活（activation 模块 + session-service 挂点）

**Files:**
- Create: `electron/src/main/task/activation.ts`
- Modify: `electron/src/main/im/session-service.ts`（sendUserMessage 挂激活钩子）
- Test: `electron/tests/task/activation.test.ts`（新建）

**Interfaces:**
- Consumes: `parseTaskMentions`（conflict-detector 唯一权威正则）；`notifyExecutor`（Task 4）
- Produces: `activateMentionedTasks(sessionId: string, body: string): void`——正文内每个可激活任务的 `target_session_id ← 当前会话`（清空另两目标列）+ 转 assigned + 触发放行评估

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/task/activation.test.ts
//
// #T 激活语义（spec §6）：draft/pending/assigned → 激活到当前会话；
// in_progress/终态 → 仅引用不动。幂等：已在队列只改目标。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask } from '../../src/main/storage/tasks/repo';
import { activateMentionedTasks } from '../../src/main/task/activation';

const tmpRoot = path.join(os.tmpdir(), `ap-act-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'T', '/tmp', '@o')`)
    .run();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('activateMentionedTasks', () => {
  it('draft 任务 → 目标覆盖为当前会话（清空 agent 目标）+ 转 assigned', () => {
    insertTask({ workspaceId: 'ws1', title: '草稿', creatorUserId: 'o', assigneeAgentId: 'inst1', status: 'draft' });
    activateMentionedTasks('sess-9', '请处理 #T-001 谢谢');
    const t = getTask('T-001')!;
    expect(t.status).toBe('assigned');
    expect(t.targetSessionId).toBe('sess-9');
    expect(t.assigneeAgentId).toBeNull(); // 用户显式意图覆盖原目标（spec §6）
  });

  it('pending → assigned；assigned → 幂等只更新目标', () => {
    insertTask({ workspaceId: 'ws1', title: '定时', creatorUserId: 'o', status: 'pending', scheduledAt: Date.now() + 999_999 });
    insertTask({ workspaceId: 'ws1', title: '排队', creatorUserId: 'o', targetTeamId: 'team1', status: 'assigned' });
    activateMentionedTasks('sess-9', '#T-001 和 #T-002');
    expect(getTask('T-001')!.status).toBe('assigned');
    const t2 = getTask('T-002')!;
    expect(t2.status).toBe('assigned');
    expect(t2.targetSessionId).toBe('sess-9');
    expect(t2.targetTeamId).toBeNull();
  });

  it('in_progress / 终态任务与不存在的 id → 不动作', () => {
    insertTask({ workspaceId: 'ws1', title: '跑着', creatorUserId: 'o', status: 'in_progress' });
    insertTask({ workspaceId: 'ws1', title: '完了', creatorUserId: 'o', status: 'completed' });
    activateMentionedTasks('sess-9', '#T-001 #T-002 #T-999');
    expect(getTask('T-001')!.status).toBe('in_progress');
    expect(getTask('T-002')!.status).toBe('completed');
    expect(getTask('T-001')!.targetSessionId).toBeNull();
  });

  it('无 mention 正文 → no-op 不抛错', () => {
    expect(() => activateMentionedTasks('sess-9', '普通消息 #hashtag')).not.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/activation.test.ts`
Expected: FAIL——模块不存在

- [ ] **Step 3: 实现**

```typescript
// electron/src/main/task/activation.ts
//
// #T mention 激活（spec §6）：用户在会话中 #T-xxx 发送 → 任务在当前会话
// 就地执行。挂点：session-service.sendUserMessage 落库后（冲突检测同段）。
//   - 可激活态：draft / pending / assigned
//   - 动作：target_session_id ← 当前会话（覆盖原目标，清空另两列）→ assigned → notify
//   - in_progress / 终态：仅引用语义（现状），不动作
// 单任务失败只 warn——激活是增值路径，不能拖垮消息发送。
import { parseTaskMentions } from './conflict-detector';
import { getTask, updateTask, transitionTaskStatus } from '../storage/tasks/repo';
import { notifyExecutor } from './executor';
import { logger } from '../logger';

const ACTIVATABLE = new Set(['draft', 'pending', 'assigned']);

export function activateMentionedTasks(sessionId: string, body: string): void {
  for (const refId of parseTaskMentions(body)) {
    try {
      const task = getTask(refId);
      if (!task || !ACTIVATABLE.has(task.status)) continue;
      // 用户显式意图覆盖：目标 = 当前会话（三列互斥 → 清空另两列）
      updateTask(refId, { targetSessionId: sessionId, assigneeAgentId: null, targetTeamId: null });
      if (task.status !== 'assigned') transitionTaskStatus(refId, 'assigned');
      notifyExecutor();
      logger.info('#T 任务已激活到当前会话', { taskId: refId, sessionId });
    } catch (err) {
      logger.warn('#T 激活失败（不阻塞消息发送）', {
        refId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
```

`session-service.ts` `sendUserMessage` 冲突检测 try/catch 块**之后**、路由之前加：

```typescript
  // #T mention 激活（v2.3）：可激活任务拉到本会话执行（spec §6）。
  // activateMentionedTasks 内部逐任务 try/catch——此处再包一层防御。
  try {
    activateMentionedTasks(input.sessionId, input.body);
  } catch (err) {
    logger.warn('#T 激活钩子异常（不阻塞消息发送）', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
```

（import：`import { activateMentionedTasks } from '../task/activation';`）

- [ ] **Step 4: 跑测试确认通过 + session-service 回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/activation.test.ts tests/im`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/task/activation.ts electron/src/main/im/session-service.ts electron/tests/task/activation.test.ts
git commit -m "feat: #T mention 激活——会话内任务就地执行链路"
```

---

### Task 7: IPC create 入参扩展（双端类型 + agent 工具）

**Files:**
- Modify: `electron/src/main/task/ipc.handlers.ts`（CreateInput + insertTask 透传）
- Modify: `electron/src/main/agent/tools/task-tools.ts`（CreateTaskInput + createTask）
- Modify: `renderer/src/ipc/types.d.ts`（TaskRow 3 字段 + create 入参 3 字段）
- Test: `electron/tests/task/ipc-handlers.test.ts`（追加用例）

**Interfaces:**
- Produces: `task:create` IPC 与 `create_task` agent 工具均接受 `targetTeamId? / targetSessionId? / recurrenceRule?`；renderer `TaskRow` 含三新字段（preload 为透传桥，无需改动——已核实 `preload/index.ts:216`）

- [ ] **Step 1: 追加失败测试**

在 `electron/tests/task/ipc-handlers.test.ts` 既有 describe 内追加（沿用其 IPC 调用模式；若该测试直接调 handler 函数则同法）：

```typescript
  it('task:create 支持目标三列 + 循环规则', async () => {
    const created = await handlerCreate({
      workspaceId: 'ws1', title: '循环任务', creatorUserId: 'owner',
      targetTeamId: 'team1', recurrenceRule: 'daily@09:00', scheduledAt: 123,
    });
    expect(created.targetTeamId).toBe('team1');
    expect(created.recurrenceRule).toBe('daily@09:00');
    expect(created.scheduledAt).toBe(123);
  });
```

（`handlerCreate` 按该测试文件既有调用方式替换——直接 invoke handler 或经 ipcMain 桥。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/ipc-handlers.test.ts`
Expected: FAIL——CreateInput 无三字段

- [ ] **Step 3: 实现**

`task/ipc.handlers.ts` `CreateInput` 加三行 + `insertTask({...})` 调用透传：

```typescript
  assigneeAgentId?: string | null;
  targetTeamId?: string | null;
  targetSessionId?: string | null;
  recurrenceRule?: string | null;
```

```typescript
      assigneeAgentId: input.assigneeAgentId,
      targetTeamId: input.targetTeamId,
      targetSessionId: input.targetSessionId,
      recurrenceRule: input.recurrenceRule,
```

`task-tools.ts` `CreateTaskInput` 同样加三字段 + `createTask` 透传（模式同上）。工具的 JSON schema defs（`getDefs()` 内 create_task 的 parameters）同步加三个可选属性。

`renderer/src/ipc/types.d.ts`：`TaskRow`（line 140 `assigneeAgentId` 后）加：

```typescript
  /** v29：委派目标三列（互斥）+ 循环实例链 */
  targetTeamId: string | null;
  targetSessionId: string | null;
  recurrenceParentId: string | null;
```

`TaskApiSurface.create` 入参（`assigneeAgentId?: string | null;` 后）加 `targetTeamId?: string | null; targetSessionId?: string | null; recurrenceRule?: string | null;`

- [ ] **Step 4: 双端验证**

Run: `npx pnpm@9.0.0 typecheck && cd electron && npx pnpm@9.0.0 vitest run tests/task/ipc-handlers.test.ts`
Expected: typecheck 双 clean + PASS

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/task/ipc.handlers.ts electron/src/main/agent/tools/task-tools.ts renderer/src/ipc/types.d.ts electron/tests/task/ipc-handlers.test.ts
git commit -m "feat: 任务创建入参扩展——委派目标三列 + 循环规则（IPC 与 agent 工具同步）"
```

---

### Task 8: renderer P0 修复（store 全生命周期 + 筛选语义 + # 菜单过滤）

**Files:**
- Modify: `renderer/src/stores/task.store.ts`
- Modify: `renderer/src/components/task-board/TaskSidebarPanel.tsx`（'all' 筛选语义）
- Modify: `renderer/src/components/im/MentionInput.tsx`（# 菜单过滤成为承载逻辑）
- Test: `renderer/src/stores/task.store.test.ts`（更新）；`renderer/src/components/task-board/TaskSidebarPanel.test.tsx`（更新）

**Interfaces:**
- Produces: `useTaskStore.load(workspaceId)` 返回全生命周期任务（limit 500）；`#` 菜单仅显示 draft/pending/assigned

- [ ] **Step 1: 更新失败测试**

`task.store.test.ts`：把「load 只拉待处理任务」的既有断言改为：

```typescript
  it('load 拉全生命周期任务（不按状态过滤，limit 500）', async () => {
    // mock ipc.task.list 断言入参
    await useTaskStore.getState().load('ws1');
    expect(listMock).toHaveBeenCalledWith({ workspaceId: 'ws1', orderBy: 'created_at', limit: 500 });
  });
```

`TaskSidebarPanel.test.tsx`：追加「'all' 只显示活跃态；选 completed 显示已完成」用例（seed store：一条 in_progress + 一条 completed，断言渲染行数）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/stores/task.store.test.ts src/components/task-board/TaskSidebarPanel.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

`task.store.ts`：删除 `PENDING_STATUSES` 常量与 `status` 过滤，`load` 改为：

```typescript
  load: async (workspaceId) => {
    set({ loading: true, error: null });
    try {
      // v2.3：全生命周期拉取（spec §8.1）——单用户桌面端任务量级下
      // 全量 + 本地过滤足够；终态历史靠 limit 500 截断
      const tasks = await ipc.task.list({ workspaceId, orderBy: 'created_at', limit: 500 });
      set({ tasks, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },
```

文件头注释同步改（「仅 pending 态」描述删除；`# 菜单`过滤职责移交 MentionInput 本地）。

`TaskSidebarPanel.tsx` `filteredTasks` useMemo 的 status 分支改：

```typescript
  /** 活跃态集合：'all' 的语义 = 全部活跃（终态需显式选择，防历史淹没列表） */
  const ACTIVE_STATUSES: TaskStatus[] = ['draft', 'pending', 'assigned', 'in_progress', 'paused'];
  // ...
    if (filter.status === 'all') {
      list = list.filter((t) => ACTIVE_STATUSES.includes(t.status));
    } else {
      list = list.filter((t) => t.status === filter.status);
    }
```

（`ACTIVE_STATUSES` 定义放组件外模块级，`TaskStatus` 从 `../../ipc/types` import。）

`MentionInput.tsx`：其本地 `# 菜单只展示未完结任务` 过滤常量改为**显式承载**（store 不再过滤）：

```typescript
/** # 菜单仅展示可激活态（v2.3：store 全量拉取后此过滤成为唯一防线） */
const MENU_STATUSES: TaskStatus[] = ['draft', 'pending', 'assigned'];
```

过滤逻辑用它（原防御性过滤同款位置），注释从「保留作防御」改为「唯一过滤点」。

- [ ] **Step 4: 跑测试确认通过 + renderer 回归**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/stores/task.store.test.ts src/components/task-board src/components/im/MentionInput.test.tsx`
Expected: 全绿（MentionInput 既有测试若因菜单过滤断言变化需同步更新断言）

- [ ] **Step 5: Commit**

```bash
git add renderer/src/stores/task.store.ts renderer/src/components/task-board/TaskSidebarPanel.tsx renderer/src/components/im/MentionInput.tsx renderer/src/stores/task.store.test.ts renderer/src/components/task-board/TaskSidebarPanel.test.tsx
git commit -m "fix: 看板数据层 P0——store 拉全生命周期任务，筛选/菜单语义分层"
```

---

### Task 9: TaskCard / TaskDetailPanel 增量展示 + renderer recurrence lib

**Files:**
- Create: `renderer/src/lib/recurrence.ts`
- Modify: `renderer/src/components/task-board/TaskCard.tsx`
- Modify: `renderer/src/components/task-board/TaskList.tsx`（透传 queueRank）
- Modify: `renderer/src/components/task-board/TaskSidebarPanel.tsx`（排队排名计算）
- Modify: `renderer/src/components/task-board/TaskDetailPanel.tsx`
- Test: `renderer/src/lib/recurrence.test.ts`（新建）；`renderer/src/components/task-board/TaskCard.test.tsx`（新建）

**Interfaces:**
- Produces:
  - `renderer/src/lib/recurrence.ts`: `serializeRecurrence(p: RecurrencePreset): string | null`、`humanizeRecurrence(rule: string): string`、`interface RecurrencePreset { kind: 'once' | 'every' | 'daily' | 'weekly'; everyN?: number; everyUnit?: 'm' | 'h' | 'd'; time?: string; weekday?: number }`
  - `TaskCard` 新 prop `queueRank?: number`

- [ ] **Step 1: 写失败测试**

`renderer/src/lib/recurrence.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { serializeRecurrence, humanizeRecurrence } from './recurrence';

describe('serializeRecurrence', () => {
  it('once → null；every/daily/weekly 序列化', () => {
    expect(serializeRecurrence({ kind: 'once' })).toBeNull();
    expect(serializeRecurrence({ kind: 'every', everyN: 30, everyUnit: 'm' })).toBe('every:30m');
    expect(serializeRecurrence({ kind: 'daily', time: '09:00' })).toBe('daily@09:00');
    expect(serializeRecurrence({ kind: 'weekly', weekday: 1, time: '09:00' })).toBe('weekly@1,09:00');
  });
});

describe('humanizeRecurrence', () => {
  it('三种规则 + 未知规则回退原文', () => {
    expect(humanizeRecurrence('every:30m')).toBe('每 30 分钟');
    expect(humanizeRecurrence('every:2h')).toBe('每 2 小时');
    expect(humanizeRecurrence('daily@09:00')).toBe('每天 09:00');
    expect(humanizeRecurrence('weekly@1,09:00')).toBe('每周一 09:00');
    expect(humanizeRecurrence('???')).toBe('???');
  });
});
```

`TaskCard.test.tsx`（贴源，沿用项目组件测试模式——@testing-library/react）：

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskCard } from './TaskCard';
import type { TaskRow } from '../../ipc/types';

const base: TaskRow = {
  id: 'T-001', workspaceId: 'ws1', title: '任务A', description: '', status: 'assigned',
  sourceSessionId: null, sourceMessageId: null, creatorUserId: 'owner', executionSessionId: null,
  assigneeAgentId: null, targetTeamId: null, targetSessionId: null, recurrenceParentId: null,
  priority: 0, scheduledAt: null, recurrenceRule: null, deadlineAt: null, queuePosition: null,
  runtimeInstanceId: null, estimatedTokens: null, actualTokens: null, toolCallsUsed: 0,
  errorMessage: null, sourceNodeId: null, createdAt: 0, updatedAt: 0, startedAt: null, completedAt: null,
};

describe('TaskCard 增量展示', () => {
  it('assigned + queueRank → 显示「排队 #N」', () => {
    render(<TaskCard task={base} selected={false} onSelect={() => {}} queueRank={2} />);
    expect(screen.getByText(/排队 #2/)).toBeInTheDocument();
  });
  it('recurrenceRule → 显示循环标记 + pending 显示下次时间', () => {
    render(<TaskCard task={{ ...base, status: 'pending', recurrenceRule: 'daily@09:00', scheduledAt: Date.now() + 3600_000 }} selected={false} onSelect={() => {}} />);
    expect(screen.getByText(/每天 09:00/)).toBeInTheDocument();
    expect(screen.getByText(/下次/)).toBeInTheDocument();
  });
});
```

（`TaskRow` 若还有其他必填字段以 typecheck 报错为准补齐。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/lib/recurrence.test.ts src/components/task-board/TaskCard.test.tsx`
Expected: FAIL——模块/prop 不存在

- [ ] **Step 3: 实现**

`renderer/src/lib/recurrence.ts`：

```typescript
// renderer/src/lib/recurrence.ts
//
// 循环规则 renderer 侧（创建对话框序列化 + 展示人性化）。
// 规则编码契约与 electron/src/main/task/recurrence.ts 的 nextRun 对齐
// （双端独立声明，同 TaskStatus 镜像先例）；改格式两边同步。
export interface RecurrencePreset {
  kind: 'once' | 'every' | 'daily' | 'weekly';
  everyN?: number;
  everyUnit?: 'm' | 'h' | 'd';
  time?: string;
  weekday?: number;
}

const WEEKDAY_LABEL = ['日', '一', '二', '三', '四', '五', '六'];
const UNIT_LABEL: Record<string, string> = { m: '分钟', h: '小时', d: '天' };

export function serializeRecurrence(p: RecurrencePreset): string | null {
  if (p.kind === 'once') return null;
  if (p.kind === 'every' && p.everyN && p.everyUnit) return `every:${p.everyN}${p.everyUnit}`;
  if (p.kind === 'daily' && p.time) return `daily@${p.time}`;
  if (p.kind === 'weekly' && p.weekday !== undefined && p.time) return `weekly@${p.weekday},${p.time}`;
  return null;
}

export function humanizeRecurrence(rule: string): string {
  const ev = /^every:(\d+)([mhd])$/.exec(rule);
  if (ev && UNIT_LABEL[ev[2]]) return `每 ${ev[1]} ${UNIT_LABEL[ev[2]]}`;
  const dv = /^daily@(\d{1,2}:\d{2})$/.exec(rule);
  if (dv) return `每天 ${dv[1]}`;
  const wv = /^weekly@(\d),(\d{1,2}:\d{2})$/.exec(rule);
  if (wv && WEEKDAY_LABEL[Number(wv[1])]) return `每周${WEEKDAY_LABEL[Number(wv[1])]} ${wv[2]}`;
  return rule;
}
```

`TaskCard.tsx`：props 加 `queueRank?: number`；import 加 `Repeat, Users, MessagesSquare`（lucide）与 `humanizeRecurrence`。渲染增量（现有结构内插入）：

```tsx
      {/* 排队徽标：assigned 未放行（spec §8.2） */}
      {task.status === 'assigned' && queueRank !== undefined && (
        <span className="text-xs text-status-warning">排队 #{queueRank}</span>
      )}
      {/* 循环标记 + 下次运行（pending） */}
      {task.recurrenceRule && (
        <span className="inline-flex items-center gap-1">
          <Repeat size={11} strokeWidth={1.75} aria-hidden />
          {humanizeRecurrence(task.recurrenceRule)}
        </span>
      )}
      {task.status === 'pending' && task.recurrenceRule && task.scheduledAt && (
        <span>下次 {new Date(task.scheduledAt).toLocaleString('zh-CN')}</span>
      )}
      {/* 委派目标（agent=既有 Bot；团队/会话新图标） */}
      {task.targetTeamId && (
        <span className="inline-flex items-center gap-1">
          <Users size={11} strokeWidth={1.75} aria-hidden />
          {task.targetTeamId.slice(0, 8)}
        </span>
      )}
      {task.targetSessionId && (
        <span className="inline-flex items-center gap-1">
          <MessagesSquare size={11} strokeWidth={1.75} aria-hidden />
          {task.targetSessionId.slice(0, 8)}
        </span>
      )}
```

（具体插槽：排队徽标放标题行状态徽标前；其余放 `mt-1 flex gap-3 text-xs text-tertiary` 元信息行内。）

`TaskList.tsx`：props 加 `queueRanks?: Map<string, number>`，透传 `queueRank={queueRanks?.get(t.id)}`。

`TaskSidebarPanel.tsx`：`filteredTasks` 后新增排名计算并传入 TaskList：

```typescript
  /** 排队排名：assigned 按放行序（spec §4.4 同款排序）计算「排队 #N」 */
  const queueRanks = useMemo(() => {
    const assigned = [...tasks]
      .filter((t) => t.status === 'assigned')
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          (a.scheduledAt ?? a.createdAt) - (b.scheduledAt ?? b.createdAt) ||
          a.createdAt - b.createdAt,
      );
    const map = new Map<string, number>();
    assigned.forEach((t, i) => map.set(t.id, i + 1));
    return map;
  }, [tasks]);
```

`TaskDetailPanel.tsx`：元信息 grid 内追加（复用既有 `text-xs` 分格样式）：

```tsx
        {task.recurrenceRule && <div>循环: {humanizeRecurrence(task.recurrenceRule)}</div>}
        {task.recurrenceParentId && (
          <div>
            母任务:{' '}
            <button
              type="button"
              onClick={() => useTaskStore.getState().setSelectedTaskId(task.recurrenceParentId)}
              className="text-accent-600 hover:underline dark:text-accent-300"
            >
              #{task.recurrenceParentId}
            </button>
          </div>
        )}
        {task.targetTeamId && <div>目标团队: {task.targetTeamId.slice(0, 12)}</div>}
        {task.targetSessionId && <div>目标会话: {task.targetSessionId.slice(0, 12)}</div>}
```

（import `humanizeRecurrence` 与 `useTaskStore`——后者 panel 已有 store 使用先例可循。）

- [ ] **Step 4: 跑测试确认通过 + 组件回归**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/lib/recurrence.test.ts src/components/task-board`
Expected: 全绿（TaskBoardView / DetailPanel 既有测试若快照断言变化同步更新）

- [ ] **Step 5: Commit**

```bash
git add renderer/src/lib/recurrence.ts renderer/src/lib/recurrence.test.ts renderer/src/components/task-board/TaskCard.tsx renderer/src/components/task-board/TaskCard.test.tsx renderer/src/components/task-board/TaskList.tsx renderer/src/components/task-board/TaskSidebarPanel.tsx renderer/src/components/task-board/TaskDetailPanel.tsx
git commit -m "feat: 看板卡片增量展示——排队徽标/循环标记/下次运行/委派目标"
```

---

### Task 10: CreateTaskDialog 目标三选 + 循环预设

**Files:**
- Modify: `renderer/src/components/im/CreateTaskDialog.tsx`
- Test: `renderer/src/components/im/CreateTaskDialog.test.tsx`（新建）

**Interfaces:**
- Consumes: `serializeRecurrence` / `RecurrencePreset`（Task 9）；`ipc.team.list(workspaceId): Promise<Team[]>`；`ipc.session.list(workspaceId?): Promise<SessionSummary[]>`
- Produces: 创建对话框支持委派目标三选一 + 循环规则预设；提交走扩展后的 `ipc.task.create`（Task 7）

- [ ] **Step 1: 写失败测试**

```tsx
// renderer/src/components/im/CreateTaskDialog.test.tsx
//
// 创建对话框目标三选 + 循环预设（spec §8.3）。
// ipc 全 mock（client 模块级 vi.mock——项目组件测试既有模式）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CreateTaskDialog } from './CreateTaskDialog';

vi.mock('../../ipc/client', () => ({
  ipc: {
    agent: { listMembers: vi.fn().mockResolvedValue([]) },
    team: { list: vi.fn().mockResolvedValue([{ id: 'team1', name: '写码组', members: [] }]) },
    session: { list: vi.fn().mockResolvedValue([{ id: 'sess1', title: '既有会话' }]) },
    task: { create: vi.fn().mockResolvedValue({ id: 'T-001' }) },
  },
}));

describe('CreateTaskDialog 委派目标 + 循环', () => {
  beforeEach(() => vi.clearAllMocks());

  it('选团队目标 → create 携带 targetTeamId', async () => {
    const onCreated = vi.fn();
    render(<CreateTaskDialog open onClose={() => {}} onCreated={onCreated} workspaceId="ws1" />);
    fireEvent.change(screen.getByLabelText('标题*'), { target: { value: '团队活' } });
    fireEvent.change(screen.getByLabelText('委派目标类型'), { target: { value: 'team' } });
    fireEvent.change(await screen.findByLabelText('委派目标'), { target: { value: 'team1' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith('T-001'));
  });

  it('选循环每天 09:00 → create 携带 recurrenceRule=daily@09:00', async () => {
    const onCreated = vi.fn();
    render(<CreateTaskDialog open onClose={() => {}} onCreated={onCreated} workspaceId="ws1" />);
    fireEvent.change(screen.getByLabelText('标题*'), { target: { value: '日报' } });
    fireEvent.change(screen.getByLabelText('循环规则'), { target: { value: 'daily' } });
    fireEvent.change(screen.getByLabelText('运行时间'), { target: { value: '09:00' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalled());
    const { ipc } = await import('../../ipc/client');
    expect(ipc.task.create).toHaveBeenCalledWith(
      expect.objectContaining({ recurrenceRule: 'daily@09:00' }),
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/CreateTaskDialog.test.tsx`
Expected: FAIL——无「委派目标类型」/「循环规则」控件

- [ ] **Step 3: 实现**

`CreateTaskDialog.tsx` 扩展（保留既有字段与 preset 逻辑）：

新增 state：

```tsx
type TargetKind = 'none' | 'agent' | 'team' | 'session';
type RecurrenceKind = 'once' | 'every' | 'daily' | 'weekly';

const [targetKind, setTargetKind] = useState<TargetKind>('none');
const [targetTeamId, setTargetTeamId] = useState('');
const [targetSessionId, setTargetSessionId] = useState('');
const [recurrenceKind, setRecurrenceKind] = useState<RecurrenceKind>('once');
const [everyN, setEveryN] = useState('30');
const [everyUnit, setEveryUnit] = useState<'m' | 'h' | 'd'>('m');
const [recTime, setRecTime] = useState('09:00');
const [weekday, setWeekday] = useState('1');
const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
const [sessions, setSessions] = useState<Array<{ id: string; title: string }>>([]);
```

`useEffect`（open 时，与既有 `ipc.agent.listMembers` 并列）：

```tsx
    ipc.team.list(workspaceId).then((list) => setTeams(list.map((t) => ({ id: t.id, name: t.name }))));
    ipc.session.list(workspaceId).then((list) => setSessions(list.map((s) => ({ id: s.id, title: s.title }))));
```

提交参数构造（`handleSubmit` 内）：

```tsx
      const recurrenceRule = serializeRecurrence(
        recurrenceKind === 'every'
          ? { kind: 'every', everyN: Number(everyN) || 1, everyUnit }
          : recurrenceKind === 'daily'
            ? { kind: 'daily', time: recTime }
            : recurrenceKind === 'weekly'
              ? { kind: 'weekly', weekday: Number(weekday), time: recTime }
              : { kind: 'once' },
      );
      const created = await ipc.task.create({
        workspaceId,
        title: title.trim(),
        description,
        priority: priorityNum,
        sourceSessionId: preset?.sourceSessionId ?? null,
        sourceMessageId: preset?.sourceMessageId ?? null,
        assigneeAgentId: targetKind === 'agent' ? assigneeAgentId : null,
        targetTeamId: targetKind === 'team' ? targetTeamId || null : null,
        targetSessionId: targetKind === 'session' ? targetSessionId || null : null,
        recurrenceRule,
        scheduledAt: scheduledAt ? new Date(scheduledAt).getTime() : null,
        deadlineAt: deadlineAt ? new Date(deadlineAt).getTime() : null,
      });
```

表单控件（「指派 agent」Select 替换为类型 + 联动目标两个 Select；循环区追加在「计划开始」前）：

```tsx
        <Select label="委派目标类型" value={targetKind}
          onChange={(e) => setTargetKind(e.target.value as TargetKind)}>
          <option value="none">未指定（手动启动）</option>
          <option value="agent">agent</option>
          <option value="team">团队</option>
          <option value="session">会话</option>
        </Select>
        {targetKind === 'agent' && (
          <Select label="委派目标" value={assigneeAgentId ?? ''}
            onChange={(e) => setAssigneeAgentId(e.target.value || null)}>
            <option value="">未指派</option>
            {assignments.map((a) => <option key={a.instanceId} value={a.instanceId}>{a.agentName}</option>)}
          </Select>
        )}
        {targetKind === 'team' && (
          <Select label="委派目标" value={targetTeamId} onChange={(e) => setTargetTeamId(e.target.value)}>
            <option value="">请选择团队</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        )}
        {targetKind === 'session' && (
          <Select label="委派目标" value={targetSessionId} onChange={(e) => setTargetSessionId(e.target.value)}>
            <option value="">请选择会话</option>
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </Select>
        )}
        <Select label="循环规则" value={recurrenceKind}
          onChange={(e) => setRecurrenceKind(e.target.value as RecurrenceKind)}>
          <option value="once">单次</option>
          <option value="every">固定间隔</option>
          <option value="daily">每天</option>
          <option value="weekly">每周</option>
        </Select>
        {recurrenceKind === 'every' && (
          <div className="flex gap-2">
            <Input label="间隔数值" type="number" value={everyN} onChange={(e) => setEveryN(e.target.value)} />
            <Select label="单位" value={everyUnit} onChange={(e) => setEveryUnit(e.target.value as 'm' | 'h' | 'd')}>
              <option value="m">分钟</option>
              <option value="h">小时</option>
              <option value="d">天</option>
            </Select>
          </div>
        )}
        {(recurrenceKind === 'daily' || recurrenceKind === 'weekly') && (
          <Input label="运行时间" type="time" value={recTime} onChange={(e) => setRecTime(e.target.value)} />
        )}
        {recurrenceKind === 'weekly' && (
          <Select label="星期" value={weekday} onChange={(e) => setWeekday(e.target.value)}>
            {['一', '二', '三', '四', '五', '六', '日'].map((d, i) => (
              <option key={d} value={String((i + 1) % 7)}>{`周${d}`}</option>
            ))}
          </Select>
        )}
```

提交校验：`targetKind === 'team' && !targetTeamId`（会话同）时禁用创建按钮（`disabled` 条件追加）。`preset.assigneeAgentId` 预填时 `targetKind` 初值置 `'agent'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/CreateTaskDialog.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/im/CreateTaskDialog.tsx renderer/src/components/im/CreateTaskDialog.test.tsx
git commit -m "feat: 创建对话框——委派目标三选一 + 循环规则预设"
```

---

### Task 11: 全量验证与收尾

**Files:**
- 无新文件；全库验证

- [ ] **Step 1: typecheck 双 clean**

Run: `nvm use 20 && npx pnpm@9.0.0 typecheck`
Expected: electron + renderer 双 clean，零错误

- [ ] **Step 2: 全量测试**

Run: `npx pnpm@9.0.0 test`
Expected: electron + renderer 全绿零 flake

- [ ] **Step 3: spec 验收标准对照自查**

对照 `docs/specs/2026-09-07-task-execution-runtime-design.md` §12 七条验收：1/4/5/6/7 已有单测覆盖；2（#T 激活端到端）与 3（定时自动执行）由 Task 5/6 接线 + Task 4/6 单测组合保证——真机冒烟（容器无 GUI）留 macOS 主机：
- 建定时循环任务 → 等到点 → 任务自动进执行会话 kickoff
- 会话内发 `#T-xxx` → agent 开跑
- 并发满时看「排队 #N」→ 前序完成后自动放行

- [ ] **Step 4: Commit（如有收尾修正）**

```bash
git add -A && git commit -m "chore: 任务执行运行时收尾——全量验证通过"
```

---

## 执行顺序与依赖

Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11（严格顺序；4 依赖 1+3，5 依赖 2+4，8 依赖 7，9 依赖 8，10 依赖 7+9）

## 关键回归风险提示

- Task 1 migration 触发既有 storage 测试：若 trigger 令旧测试的双目标 seed 失败，修 seed（那是测试数据违规，不是行为回归）
- Task 8 store 语义变化波及 `MentionInput.test.tsx` / `TaskBoardView.test.tsx` / `TaskSidebarPanel.test.tsx`——按新语义更新断言，不许删测试
- Task 5 在 `agent-runner.ts` / `session-service.ts` 动刀属跨模块接线，遵守 `momo-boundary-rules`（改 IPC/跨模块时双端 typecheck）
- executor → starter → team.ts 的 import 链不得引入 `im/session-service`（环）；kickoff 只能经 runtime-init 注入
