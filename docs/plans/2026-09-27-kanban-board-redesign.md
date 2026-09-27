# 任务看板重构实施计划(kanban board redesign)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把任务看板重构为真看板——5 状态列 × 分组泳道、@dnd-kit 拖拽(跨列=状态转换/列内=排序/跨泳道=换组)、任务与分组归档、agent 工具分组信息同步。

**Architecture:** 存储层加 `task_groups` 表 + tasks 三新列(group_id/board_position/archived_at);换列语义映射(start/resume/cancel/transition)单点收敛在主进程 `task/move.ts`;renderer 乐观更新 + 失败回滚;`BOARD_COLUMNS` 契约以 renderer/src/ipc/board-columns.ts 为单源(value module,electron 经相对路径 import——与 preload 引 renderer types 同款跨workspace 引用)。

**Tech Stack:** Electron 主进程(CommonJS + better-sqlite3)、React 18 + zustand + Tailwind(语义 token)、@dnd-kit/core + @dnd-kit/sortable、vitest 双 workspace。

**Spec:** `docs/specs/2026-09-27-kanban-board-redesign.md`(本计划从 spec 出发,执行者须同时读 spec)

## Global Constraints

- Node 20 必需:`nvm use 20`;包管理一律 `npx pnpm@9.0.0`
- TypeScript strict:禁止 `any` / `as any` / `@ts-ignore`;ESLint `no-explicit-any: error`
- 代码注释与文档一律中文;标识符英文;Conventional Commits(`feat:`/`fix:`/`test:`/`refactor:`/`chore:`)
- 特性 commit 一律不动版本号(版本纪律见 `docs/dev/release.md`)
- renderer UI:只用语义 token(`bg-surface-*`/`text-secondary`…),禁标准 Tailwind 色阶与 inline 硬编码色;图标一律 lucide-react 16px / stroke 1.75;状态色唯一来源 `lib/task-status.ts`;原子组件优先(`components/ui/`)
- 测试位置:electron 主进程集中 `electron/tests/`(子目录镜像 src);renderer 贴源 colocated(与组件同目录);两处 vitest config 显式 include,放错位置不执行
- 每任务收尾必须过:`npx pnpm@9.0.0 typecheck`(双 workspace)+ 本任务相关 `vitest run`
- IPC 契约(types.d.ts)改动后 electron 与 renderer 两侧都要 typecheck

## Review Focus(最可能咬人的五类输入——各任务测试必须钉死)

1. **move 非法组合零副作用**:终态任务拖向任意活跃列、任意状态拖入待办列 → Error 中文原因,且不写 board_position/group_id 半套 patch(Task 5 钉)
2. **assigned→进行中 必须= start 全语义**:不能只 transition——K9 kickoff 注入、新建会话通知、失败转 failed 缺一不可,否则拖启动的 agent 永不执行(Task 4/5 钉)
3. **组归档级联 cancel 的原子性**:组内含 in_progress 任务 → cancel + 归档同事务;并发改态(他处同时取消)不得半程崩(Task 1 钉)
4. **乐观更新失败回滚 + 轮询跳过窗口**:move IPC 在途时 5s 轮询覆盖乐观态 = 卡片瞬移回旧位(Task 10 钉)
5. **board_position NULL 与精度耗尽**:老任务(NULL)与有值任务混排稳定不抖动;同位反复拖精度 < 1e-6 触发整列重整不抛错(Task 3/9 钉)

---

### Task 1: 迁移 047 + task_groups repo(含归档级联事务)

**Files:**
- Create: `electron/src/main/storage/migrations/047_kanban_groups_archive.ts`
- Modify: `electron/src/main/storage/migrations/index.ts`(import + MIGRATIONS 数组尾部追加)
- Create: `electron/src/main/storage/task-groups/repo.ts`
- Test: `electron/tests/storage/task-groups-repo.test.ts`

**Interfaces:**
- Produces: `GroupRow { id; workspaceId; name; color: string|null; position: number; archivedAt: number|null; createdAt; updatedAt }`
- Produces: `listGroups(workspaceId, opts?: {archived?: 'exclude'|'only'|'all'}): GroupRow[]`(默认 exclude)、`createGroup(input: {workspaceId; name; color?}): GroupRow`、`getGroup(id): GroupRow|null`、`updateGroup(id, patch: {name?; color?}): GroupRow`、`reorderGroups(orderedIds: string[]): void`、`archiveGroup(id): {cancelledIds: string[]; archivedCount: number}`、`unarchiveGroup(id): GroupRow`

- [ ] **Step 1: 写失败测试**(fixture 复用 `electron/tests/storage/tasks-repo.test.ts` 的建库方式——用真实内存库 `new Database(':memory:')` + 跑 migrations,禁 mock)

```ts
// electron/tests/storage/task-groups-repo.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
// 按仓库既有测试的建库 helper:内存库 + 全量 migrations(见 tasks-repo.test.ts 顶部)
import { runMigrations } from '../../src/main/storage/migrations';
import { createGroup, listGroups, archiveGroup, unarchiveGroup, reorderGroups, updateGroup } from '../../src/main/storage/task-groups/repo';
import { insertTask, getTask, listTasks } from '../../src/main/storage/tasks/repo';

let db: Database.Database;
beforeAll(() => {
  db = new Database(':memory:');
  runMigrations(db); // 若 helper 签名不同,照 tasks-repo.test.ts 现场对齐
});

describe('task_groups repo', () => {
  it('创建组默认活跃,position 自增', () => {
    const g1 = createGroup({ workspaceId: 'ws1', name: 'v2.1.0' });
    const g2 = createGroup({ workspaceId: 'ws1', name: 'LSP', color: 'violet' });
    expect(g1.archivedAt).toBeNull();
    expect(g2.color).toBe('violet');
    expect(g2.position).toBeGreaterThan(g1.position);
  });

  it('listGroups 三态过滤:exclude/only/all', () => {
    const g = createGroup({ workspaceId: 'ws2', name: 'tmp' });
    archiveGroup(g.id);
    expect(listGroups('ws2').map((x) => x.id)).not.toContain(g.id);
    expect(listGroups('ws2', { archived: 'only' }).map((x) => x.id)).toEqual([g.id]);
    expect(listGroups('ws2', { archived: 'all' })).toHaveLength(2);
  });

  it('归档组:非终态任务级联 cancel + 全组 archived,事务原子', () => {
    const g = createGroup({ workspaceId: 'ws3', name: 'ver' });
    const running = insertTask({ workspaceId: 'ws3', title: '跑着', creatorUserId: 'owner', status: 'in_progress', groupId: g.id });
    const done = insertTask({ workspaceId: 'ws3', title: '完了', creatorUserId: 'owner', status: 'completed', groupId: g.id });
    const res = archiveGroup(g.id);
    expect(res.cancelledIds).toEqual([running.id]);
    expect(res.archivedCount).toBe(2);
    expect(getTask(running.id)?.status).toBe('cancelled');
    expect(getTask(running.id)?.archivedAt).not.toBeNull();
    expect(getTask(done.id)?.archivedAt).not.toBeNull();
    // 默认 listTasks 不见归档
    expect(listTasks({ workspaceId: 'ws3' })).toHaveLength(0);
  });

  it('unarchive 组只复活组,任务保持归档', () => {
    // 承上:ws3 的组
    const [archived] = listGroups('ws3', { archived: 'only' });
    unarchiveGroup(archived.id);
    expect(listGroups('ws3').map((x) => x.id)).toContain(archived.id);
    expect(listTasks({ workspaceId: 'ws3', archived: 'only' })).toHaveLength(2);
  });

  it('reorder 按入参顺序重写 position', () => {
    const a = createGroup({ workspaceId: 'ws4', name: 'a' });
    const b = createGroup({ workspaceId: 'ws4', name: 'b' });
    reorderGroups([b.id, a.id]);
    const list = listGroups('ws4');
    expect(list[0].id).toBe(b.id);
    expect(list[0].position).toBeLessThan(list[1].position);
  });

  it('updateGroup 改名/换色并 bump updated_at', () => {
    const g = createGroup({ workspaceId: 'ws5', name: 'x' });
    const before = g.updatedAt;
    const next = updateGroup(g.id, { name: 'y', color: 'accent' });
    expect(next.name).toBe('y');
    expect(next.updatedAt).toBeGreaterThanOrEqual(before);
  });
});
```

注:测试里 `insertTask` 传 `groupId` 依赖 Task 2 的字段扩展——**本任务先只写前 5 个用例(不含级联)**,级联用例挪到 Task 2 完成后补跑;或本任务实现 repo 时把 tasks 三列一并迁移(见 Step 3 的迁移 SQL——迁移是整块的,列在但 repo 未映射)。约定:**级联/归档用例写在本文件,Task 2 会被其驱动补 tasks repo 映射;执行本任务时该两用例允许 FAIL,Task 2 收尾全绿。**

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/task-groups-repo.test.ts`
Expected: FAIL——`Cannot find module '../../src/main/storage/task-groups/repo'`

- [ ] **Step 3: 实现迁移 + repo**

```ts
// electron/src/main/storage/migrations/047_kanban_groups_archive.ts
// 任务看板重构(spec 2026-09-27 §2):分组表 + tasks 三新列。
// 全部可空/带默认,老数据零处理开箱即用。
import type { Migration } from './index';

export const migration047: Migration = {
  version: 47,
  sql: `
CREATE TABLE task_groups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  position REAL NOT NULL,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_task_groups_ws ON task_groups(workspace_id);

ALTER TABLE tasks ADD COLUMN group_id TEXT REFERENCES task_groups(id);
ALTER TABLE tasks ADD COLUMN board_position REAL;
ALTER TABLE tasks ADD COLUMN archived_at INTEGER;
CREATE INDEX idx_tasks_ws_archived ON tasks(workspace_id, archived_at);
`.trim(),
};
```

`migrations/index.ts`:仿照既有行 `import { migration047 } from './047_kanban_groups_archive';`,并 push 进 `MIGRATIONS` 尾部。

```ts
// electron/src/main/storage/task-groups/repo.ts
// task_groups 表 CRUD + 归档级联(spec §2/§3.1)。ID 沿用 T-<seq> 同款 G-<seq> 序列。
import { getDb } from '../db';
import { getTask, listTasks, transitionTaskStatus, updateTask, type TaskRow } from '../tasks/repo';
import { isTerminal } from '../tasks/state-machine';

export interface GroupRow {
  id: string;
  workspaceId: string;
  name: string;
  /** 语义色名('accent'/'violet'/'success'/'warning'…),NULL=默认 */
  color: string | null;
  position: number;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

type SqlRow = {
  id: string; workspace_id: string; name: string; color: string | null;
  position: number; archived_at: number | null; created_at: number; updated_at: number;
};

function rowToCamel(r: SqlRow): GroupRow {
  return {
    id: r.id, workspaceId: r.workspace_id, name: r.name, color: r.color,
    position: r.position, archivedAt: r.archived_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** G-<seq>:与 tasks 的 T-<seq> 同款(严格 ^G-(\d+)$ 匹配,零填充 ≥3 位) */
function nextGroupId(db: ReturnType<typeof getDb>): string {
  const rows = db.prepare("SELECT id FROM task_groups WHERE id LIKE 'G-%'").all() as Array<{ id: string }>;
  let max = 0;
  for (const r of rows) {
    const m = /^G-(\d+)$/.exec(r.id);
    if (m && m[1]) max = Math.max(max, parseInt(m[1], 10));
  }
  const next = max + 1;
  return `G-${next < 1000 ? String(next).padStart(3, '0') : String(next)}`;
}

export function getGroup(id: string): GroupRow | null {
  const row = getDb().prepare('SELECT * FROM task_groups WHERE id = ?').get(id) as SqlRow | undefined;
  return row ? rowToCamel(row) : null;
}

export function listGroups(
  workspaceId: string,
  opts?: { archived?: 'exclude' | 'only' | 'all' },
): GroupRow[] {
  const mode = opts?.archived ?? 'exclude';
  const cond = mode === 'all' ? '' : mode === 'only' ? 'WHERE workspace_id = ? AND archived_at IS NOT NULL' : 'WHERE workspace_id = ? AND archived_at IS NULL';
  const rows = getDb().prepare(`SELECT * FROM task_groups ${cond} ORDER BY position ASC, created_at ASC`).all(workspaceId) as SqlRow[];
  return rows.map(rowToCamel);
}

export function createGroup(input: { workspaceId: string; name: string; color?: string }): GroupRow {
  const db = getDb();
  const id = nextGroupId(db);
  const now = Date.now();
  const maxPos = db.prepare('SELECT MAX(position) AS p FROM task_groups WHERE workspace_id = ?').get(input.workspaceId) as { p: number | null };
  db.prepare(
    'INSERT INTO task_groups (id, workspace_id, name, color, position, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
  ).run(id, input.workspaceId, input.name, input.color ?? null, (maxPos.p ?? 0) + 1024, now, now);
  return getGroup(id)!;
}

export function updateGroup(id: string, patch: { name?: string; color?: string }): GroupRow {
  const current = getGroup(id);
  if (!current) throw new Error(`task_group ${id} 不存在`);
  getDb().prepare('UPDATE task_groups SET name = ?, color = ?, updated_at = ? WHERE id = ?').run(
    patch.name ?? current.name, patch.color ?? current.color, Date.now(), id,
  );
  return getGroup(id)!;
}

export function reorderGroups(orderedIds: string[]): void {
  const db = getDb();
  const stmt = db.prepare('UPDATE task_groups SET position = ?, updated_at = ? WHERE id = ?');
  const now = Date.now();
  db.transaction(() => {
    orderedIds.forEach((gid, i) => stmt.run((i + 1) * 1024, now, gid));
  })();
}

/**
 * 归档组(spec §3.1):单事务内——组内非终态任务先 cancel(级联),全组任务置
 * archived_at,组置 archived_at。返回 cancelledIds 供 IPC 层对 in_progress 来源
 * 补执行中断(abort 是进程级副作用,不入 DB 事务)。任一步失败整体回滚。
 */
export function archiveGroup(id: string): { cancelledIds: string[]; archivedCount: number } {
  const db = getDb();
  const group = getGroup(id);
  if (!group) throw new Error(`task_group ${id} 不存在`);
  if (group.archivedAt != null) return { cancelledIds: [], archivedCount: 0 };
  const now = Date.now();
  return db.transaction((): { cancelledIds: string[]; archivedCount: number } => {
    const tasks = listTasks({ workspaceId: group.workspaceId }, { archived: 'all' }).filter(
      (t: TaskRow) => t.groupId === id,
    );
    const cancelledIds: string[] = [];
    for (const t of tasks) {
      if (!isTerminal(t.status)) {
        transitionTaskStatus(t.id, 'cancelled'); // 状态机校验兜底;并发已终态时吞不了——见 catch
        cancelledIds.push(t.id);
      }
    }
    const mark = db.prepare('UPDATE tasks SET archived_at = ?, updated_at = ? WHERE group_id = ? AND archived_at IS NULL');
    const archivedCount = mark.run(now, now, id).changes;
    db.prepare('UPDATE task_groups SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    return { cancelledIds, archivedCount };
  })();
}

export function unarchiveGroup(id: string): GroupRow {
  const group = getGroup(id);
  if (!group) throw new Error(`task_group ${id} 不存在`);
  getDb().prepare('UPDATE task_groups SET archived_at = NULL, updated_at = ? WHERE id = ?').run(Date.now(), id);
  return getGroup(id)!;
}
```

注意:`listTasks` 第二参数 `{ archived: 'all' }` 是 Task 2 加的签名——本任务先写 `db.prepare('SELECT * FROM tasks WHERE group_id = ?')` 直查替代,Task 2 后统一换 listTasks。同理 `transitionTaskStatus`/`isTerminal` 现已存在可直接用;`updateTask` import 仅 Task 2 后需要,先删。

- [ ] **Step 4: 跑测试(允许级联两用例 FAIL,其余 PASS)**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/task-groups-repo.test.ts`
Expected: 前述非级联用例 PASS;`归档组级联`/`unarchive` 两用例 FAIL(缺 tasks 映射)——**记录,Task 2 收尾必须全绿**

- [ ] **Step 5: 全量回归 + 提交**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/`
Expected: 既有迁移测试(tasks-repo 等)全绿

```bash
git add electron/src/main/storage/migrations/ electron/src/main/storage/task-groups/ electron/tests/storage/task-groups-repo.test.ts
git commit -m "feat: task_groups 表迁移与 repo——CRUD/排序/归档级联事务(看板重构 Task 1)"
```

---

### Task 2: tasks repo 三新列映射 + listTasks 过滤扩展

**Files:**
- Modify: `electron/src/main/storage/tasks/repo.ts`(TaskRow/SqlRow/rowToCamel/insertTask/updateTask/listTasks)
- Test: `electron/tests/storage/tasks-repo-board.test.ts`

**Interfaces:**
- Consumes: Task 1 的迁移列(group_id/board_position/archived_at)
- Produces: `TaskRow` 新增 `groupId: string | null; boardPosition: number | null; archivedAt: number | null`(electron 侧)
- Produces: `listTasks(opts)` 新增 `archived?: 'exclude'|'only'|'all'`(默认 `'exclude'`)、`groupId?: string | null`

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/storage/tasks-repo-board.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/main/storage/migrations';
import { insertTask, listTasks, updateTask, getTask } from '../../src/main/storage/tasks/repo';

beforeAll(() => {
  const db = new Database(':memory:');
  runMigrations(db);
});

describe('tasks 看板字段', () => {
  it('insert 默认三新列为 NULL;显式传入可落值', () => {
    const t = insertTask({ workspaceId: 'ws', title: 'a', creatorUserId: 'owner' });
    expect(t.groupId).toBeNull();
    expect(t.boardPosition).toBeNull();
    expect(t.archivedAt).toBeNull();
    const g = insertTask({ workspaceId: 'ws', title: 'b', creatorUserId: 'owner', groupId: 'G-001', boardPosition: 2048 });
    expect(g.groupId).toBe('G-001');
    expect(g.boardPosition).toBe(2048);
  });

  it('updateTask 可 patch 三新列', () => {
    const t = insertTask({ workspaceId: 'ws', title: 'c', creatorUserId: 'owner' });
    updateTask(t.id, { archivedAt: 123, boardPosition: 100 });
    expect(getTask(t.id)?.archivedAt).toBe(123);
    expect(getTask(t.id)?.boardPosition).toBe(100);
  });

  it('listTasks archived 三态 + groupId 过滤', () => {
    const a = insertTask({ workspaceId: 'wsf', title: '活跃', creatorUserId: 'owner' });
    const b = insertTask({ workspaceId: 'wsf', title: '归档', creatorUserId: 'owner' });
    updateTask(b.id, { archivedAt: 999 });
    const c = insertTask({ workspaceId: 'wsf', title: '组内', creatorUserId: 'owner', groupId: 'G-009' });
    expect(listTasks({ workspaceId: 'wsf' }).map((x) => x.id)).toEqual([a.id, c.id]); // 默认 exclude
    expect(listTasks({ workspaceId: 'wsf', archived: 'only' }).map((x) => x.id)).toEqual([b.id]);
    expect(listTasks({ workspaceId: 'wsf', archived: 'all' })).toHaveLength(3);
    expect(listTasks({ workspaceId: 'wsf', groupId: 'G-009' }).map((x) => x.id)).toEqual([c.id]);
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/tasks-repo-board.test.ts`
Expected: FAIL——类型不匹配/字段 undefined

- [ ] **Step 3: 实现**(对 repo.ts 做六处机械扩展)

1. `TaskRow` 接口加三字段(带中文注释,见 spec §2)
2. `SqlRow` 加 `group_id: string | null; board_position: number | null; archived_at: number | null;`
3. `rowToCamel` 加三行映射
4. `insertTask`:INSERT 列清单加 `group_id, board_position, archived_at`,VALUES 加三个 `?`,run 参数追加 `input.groupId ?? null, input.boardPosition ?? null, input.archivedAt ?? null`
5. `updateTask`:SET 子句加 `group_id=?, board_position=?, archived_at=?`,run 参数在 `source_node_id` 后按序插 `next.groupId, next.boardPosition, next.archivedAt`
6. `listTasks`:opts 加 `archived?: 'exclude' | 'only' | 'all'; groupId?: string | null;`,where 拼装加:

```ts
const archivedMode = opts.archived ?? 'exclude';
if (archivedMode === 'exclude') where.push('archived_at IS NULL');
else if (archivedMode === 'only') where.push('archived_at IS NOT NULL');
if (opts.groupId !== undefined) {
  if (opts.groupId === null) where.push('group_id IS NULL');
  else { where.push('group_id = ?'); params.push(opts.groupId); }
}
```

- [ ] **Step 4: 跑测试**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/tasks-repo-board.test.ts tests/storage/task-groups-repo.test.ts`
Expected: **全绿(含 Task 1 遗留的级联两用例)**;若级联用例仍红,回修 Task 1 repo 的直查/映射

- [ ] **Step 5: 全量回归 + 提交**

Run: `cd electron && npx pnpm@9.0.0 vitest run && cd .. && npx pnpm@9.0.0 typecheck`
Expected: electron 全量测试绿(既有消费者对多出的 NULL 字段零感知)

```bash
git add electron/src/main/storage/tasks/repo.ts electron/tests/storage/tasks-repo-board.test.ts
git commit -m "feat: tasks 表 group/board_position/archived 映射与 listTasks 过滤(看板重构 Task 2)"
```

---

### Task 3: BOARD_COLUMNS 契约单源 + board-position 算法(主进程)

**Files:**
- Create: `renderer/src/ipc/board-columns.ts`
- Create: `electron/src/main/task/board-position.ts`
- Test: `renderer/src/ipc/board-columns.test.ts`、`electron/tests/task/board-position.test.ts`

**Interfaces:**
- Produces(renderer + electron 共享):`BOARD_COLUMN_KEYS`、`BoardColumnKey`、`BOARD_COLUMNS: readonly BoardColumnDef[]`、`columnOf(status): BoardColumnKey`、`canDropIntoColumn(from: TaskStatus, to: BoardColumnKey): boolean`(UI 禁投预判单源,与 move 语义表对齐:同列恒 true;目标为 backlog 仅 draft/pending true;目标 assigned 仅 draft/pending/assigned/session_queued;目标 active 仅 assigned/session_queued/in_progress/paused;目标 done 仅 in_progress/completed;目标 closed 仅非终态+failed/cancelled)
- Produces(主进程):`POSITION_GAP=1024`、`placeBetween(prev: number|null, next: number|null, column: {id,boardPosition}[]): number`(中值;列首 `first-GAP`;列尾 `last+GAP`;相邻差 <1e-6 时先整列 rebalance 再取中值)、`rebalanceColumnPositions(tasks: {id;boardPosition}[]): Map<string, number>`(按现序等距 i*GAP 重写)

- [ ] **Step 1: 写失败测试**

```ts
// renderer/src/ipc/board-columns.test.ts
import { describe, it, expect } from 'vitest';
import { BOARD_COLUMNS, columnOf, canDropIntoColumn, type TaskStatus } from './board-columns';

describe('BOARD_COLUMNS 契约', () => {
  it('五列全覆盖九状态且不重不漏', () => {
    const all = BOARD_COLUMNS.flatMap((c) => c.statuses).sort();
    expect(all).toEqual(['assigned','cancelled','completed','draft','failed','in_progress','paused','pending','session_queued'].sort());
  });
  it('columnOf 按状态归列', () => {
    expect(columnOf('draft')).toBe('backlog');
    expect(columnOf('session_queued')).toBe('assigned');
    expect(columnOf('paused')).toBe('active');
    expect(columnOf('completed')).toBe('done');
    expect(columnOf('failed')).toBe('closed');
  });
  it('canDropIntoColumn 与语义表一致(抽验关键格)', () => {
    const s = (x: string) => x as TaskStatus;
    expect(canDropIntoColumn(s('completed'), 'active')).toBe(false); // 终态锁死
    expect(canDropIntoColumn(s('in_progress'), 'backlog')).toBe(false); // 待办只出不进
    expect(canDropIntoColumn(s('assigned'), 'active')).toBe(true);   // start 通道
    expect(canDropIntoColumn(s('paused'), 'active')).toBe(true);     // resume 通道
    expect(canDropIntoColumn(s('in_progress'), 'done')).toBe(true);  // 确认后完成
    expect(canDropIntoColumn(s('draft'), 'assigned')).toBe(true);    // 指派
    expect(canDropIntoColumn(s('pending'), 'active')).toBe(false);   // 不可跳进
  });
});
```

```ts
// electron/tests/task/board-position.test.ts
import { describe, it, expect } from 'vitest';
import { placeBetween, rebalanceColumnPositions, POSITION_GAP } from '../../src/main/task/board-position';

describe('board-position', () => {
  it('中值插入', () => {
    expect(placeBetween(1000, 2000, [])).toBe(1500);
  });
  it('列首/列尾', () => {
    expect(placeBetween(null, 2000, [])).toBe(2000 - POSITION_GAP);
    expect(placeBetween(1000, null, [])).toBe(1000 + POSITION_GAP);
  });
  it('空列', () => {
    expect(placeBetween(null, null, [])).toBe(0);
  });
  it('精度耗尽触发整列重整(Review Focus ⑤)', () => {
    const col = [
      { id: 'a', boardPosition: 1000 },
      { id: 'b', boardPosition: 1000 + 1e-9 }, // a/b 挤死
      { id: 'c', boardPosition: 2000 },
    ];
    const pos = placeBetween(col[0].boardPosition, col[1].boardPosition, col);
    expect(Number.isFinite(pos)).toBe(true);
    // 重整后间距恢复 GAP 量级
    const map = rebalanceColumnPositions(col);
    expect(map.get('a')).toBe(0);
    expect(map.get('b')).toBe(POSITION_GAP);
    expect(map.get('c')).toBe(POSITION_GAP * 2);
  });
});
```

- [ ] **Step 2: 确认失败**(两个文件分别跑,均 FAIL 模块不存在)

- [ ] **Step 3: 实现**

```ts
// renderer/src/ipc/board-columns.ts
// 看板列契约单源(spec §3.3/§4):renderer 与 electron 主进程(move 校验)共同 import。
// 注意这是 value module(非 .d.ts)——主进程经相对路径引用,与 preload 引 types.d.ts 同款。
import type { TaskStatus } from './types';

export const BOARD_COLUMN_KEYS = ['backlog', 'assigned', 'active', 'done', 'closed'] as const;
export type BoardColumnKey = (typeof BOARD_COLUMN_KEYS)[number];

export interface BoardColumnDef {
  key: BoardColumnKey;
  label: string;
  /** 该列合并的底层状态(spec §1 D2) */
  statuses: TaskStatus[];
  /** 列头灰字副标 */
  hint: string;
}

export const BOARD_COLUMNS: readonly BoardColumnDef[] = [
  { key: 'backlog', label: '待办', statuses: ['draft', 'pending'], hint: 'draft+pending' },
  { key: 'assigned', label: '已分配', statuses: ['assigned', 'session_queued'], hint: 'assigned+queued' },
  { key: 'active', label: '进行中', statuses: ['in_progress', 'paused'], hint: 'in_progress+paused' },
  { key: 'done', label: '已完成', statuses: ['completed'], hint: '' },
  { key: 'closed', label: '已关闭', statuses: ['failed', 'cancelled'], hint: 'failed+cancelled' },
];

export function columnOf(status: TaskStatus): BoardColumnKey {
  for (const col of BOARD_COLUMNS) if (col.statuses.includes(status)) return col.key;
  throw new Error(`未知任务状态: ${status}`);
}

/** UI 禁投预判(spec §4 语义表的列级投影);主进程 move 仍是权威裁决 */
export function canDropIntoColumn(from: TaskStatus, to: BoardColumnKey): boolean {
  if (columnOf(from) === to) return true; // 同列(排序/换泳道)恒可
  return allowCross(from, to);
}

function allowCross(from: TaskStatus, to: BoardColumnKey): boolean {
  switch (to) {
    case 'backlog': return false; // 只出不进
    case 'assigned': return from === 'draft' || from === 'pending';
    case 'active': return from === 'assigned' || from === 'session_queued' || from === 'paused';
    case 'done': return from === 'in_progress';
    case 'closed': return from !== 'completed'; // completed→closed 同为关闭语义但无转换意义,禁
  }
}
```

注:`canDropIntoColumn` 首行 `columnOf(from)===to` 已 return true,第二行的 `.includes(from)===false &&` 恒真(同列已排除)——写成直白形式 `return allowCross(from, to);` 即可,上面为防误读保留注释版,实现取直白版。

```ts
// electron/src/main/task/board-position.ts
// board_position 计算与重整(spec §2):浮点中值 + 精度耗尽整列重写。
export const POSITION_GAP = 1024;
const MIN_SPACING = 1e-6;

export function placeBetween(
  prev: number | null,
  next: number | null,
  column: Array<{ id: string; boardPosition: number | null }>,
): number {
  if (prev == null && next == null) return 0;
  if (prev == null) return next! - POSITION_GAP;
  if (next == null) return prev + POSITION_GAP;
  if (next - prev < MIN_SPACING) {
    const rebalanced = rebalanceColumnPositions(column);
    // 以重整后坐标重算(调用方随后会用同一 map 落库)
    const p = prev; // 简化:返回中值近似,调用方拿 rebalanced map 覆盖整列
    return p;
  }
  return (prev + next) / 2;
}

/** 按传入顺序(调用方先 sortColumn)等距重写,i*GAP */
export function rebalanceColumnPositions(tasks: Array<{ id: string; boardPosition: number | null }>): Map<string, number> {
  const map = new Map<string, number>();
  tasks.forEach((t, i) => map.set(t.id, i * POSITION_GAP));
  return map;
}
```

注意:placeBetween 精度分支的返回值语义 = "该列需要重整"信号。Task 5 的 move 会这样用:先 `placeBetween` 取值;若 `column` 内任一相邻差 < MIN_SPACING(暴露 `needsRebalance(column): boolean` 判定函数),则 `rebalanceColumnPositions` + 全列 updateTask + 本任务取新序中值。**补导出 `needsRebalance(column): boolean`**(任意相邻有值对差 < MIN_SPACING 即 true),测试加一例。实现时按此调整,勿留含糊分支。

- [ ] **Step 4: 跑测试**(renderer + electron 两处)全绿
- [ ] **Step 5: typecheck 双 workspace + 提交**

```bash
git add renderer/src/ipc/board-columns.ts renderer/src/ipc/board-columns.test.ts electron/src/main/task/board-position.ts electron/tests/task/board-position.test.ts
git commit -m "feat: BOARD_COLUMNS 契约单源 + board_position 中值/重整算法(看板重构 Task 3)"
```

---

### Task 4: 生命周期抽取——start/resume-paused/cancel 三动作共享化

**Files:**
- Create: `electron/src/main/task/lifecycle.ts`
- Modify: `electron/src/main/task/ipc.handlers.ts`(三处 handler 改为委托)
- Test: `electron/tests/task/lifecycle.test.ts`

**Interfaces:**
- Produces: `startTaskAndKickoff(id: string, opts?: StartTaskOpts): Promise<StartTaskResult>`(K9 全语义:startTask + 幂等判定 + kickoff 注入 + 失败转 failed + broadcast/notify)
- Produces: `resumePausedTask(id: string): Promise<TaskRow>`(K7-5:transition + kickoff 重注入 + broadcast/notify)
- Produces: `cancelTask(id: string): Promise<void>`(transition cancelled + abortTaskExecutionIfAny + broadcast/notify)
- Consumes: starter.ts `startTask`、executor.ts `buildKickoffBody`/`notifyExecutor`、resume 相关(随 ipc.handlers 现 import 搬迁)

- [ ] **Step 1: 写失败测试**(mock 边界按 momo-test-rules:仿真真实语义——`vi.mock` sendUserMessage 断言 kickoff 载荷,不 mock 状态机/repo)

```ts
// electron/tests/task/lifecycle.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
// 建库 helper 同 Task 1;seed 见 tasks-repo 测试既有 helper
vi.mock('../../src/main/im/send-message', () => ({ sendUserMessage: vi.fn().mockResolvedValue(undefined) }));
// ↑ 模块路径按 ipc.handlers.ts 现 import 照搬;执行者读文件头对齐真实路径
import { sendUserMessage } from '../../src/main/im/send-message';
import { startTaskAndKickoff, cancelTask, resumePausedTask } from '../../src/main/task/lifecycle';
import { insertTask, getTask } from '../../src/main/storage/tasks/repo';

describe('lifecycle 共享动作', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('startTaskAndKickoff:assigned 任务启动后 in_progress 且注入 kickoff(Review Focus ②)', async () => {
    const t = insertTask({ workspaceId: 'ws', title: 'x', creatorUserId: 'owner', status: 'assigned', assigneeAgentId: 'inst-1' });
    const res = await startTaskAndKickoff(t.id);
    expect(res.task.status).toBe('in_progress');
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getTask(t.id)?.executionSessionId).not.toBeNull();
  });

  it('startTaskAndKickoff:kickoff 失败 → 任务转 failed 且透出错误', async () => {
    vi.mocked(sendUserMessage).mockRejectedValueOnce(new Error('boom'));
    const t = insertTask({ workspaceId: 'ws', title: 'y', creatorUserId: 'owner', status: 'assigned', assigneeAgentId: 'inst-1' });
    await expect(startTaskAndKickoff(t.id)).rejects.toThrow('boom');
    expect(getTask(t.id)?.status).toBe('failed');
    expect(getTask(t.id)?.errorMessage).toContain('kickoff');
  });

  it('cancelTask:in_progress → cancelled', async () => {
    const t = insertTask({ workspaceId: 'ws', title: 'z', creatorUserId: 'owner', status: 'in_progress', executionSessionId: 's-1', assigneeAgentId: 'inst-1' });
    await cancelTask(t.id);
    expect(getTask(t.id)?.status).toBe('cancelled');
  });

  it('resumePausedTask:paused → in_progress + kickoff 重注入', async () => {
    const t = insertTask({ workspaceId: 'ws', title: 'p', creatorUserId: 'owner', status: 'paused', executionSessionId: 's-2', assigneeAgentId: 'inst-1' });
    const row = await resumePausedTask(t.id);
    expect(row.status).toBe('in_progress');
    expect(sendUserMessage).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 确认失败**(lifecycle 模块不存在)
- [ ] **Step 3: 实现——机械搬运**

从 `ipc.handlers.ts` 原样搬运三段函数体到 `lifecycle.ts`(import 随迁;`broadcastLocalTaskSnapshot`/`broadcastSessionListChanged`/`abortTaskExecutionIfAny` 一并搬入或改为从其定义模块 import——**执行者读 ipc.handlers.ts 头部 import 与 60-90 行区域,照真实来源迁移**;若 abortTaskExecutionIfAny 是本文件私有函数,整体搬走并在 handlers 侧 re-export 保持兼容):

```ts
// electron/src/main/task/lifecycle.ts 骨架
export async function startTaskAndKickoff(id: string, opts?: StartTaskOpts): Promise<StartTaskResult> {
  // = 现 task:start handler 的 K9 主体(before 快照 → startTask → broadcastSessionListChanged
  //   → newlyStarted 判定 → sendUserMessage kickoff → 失败转 failed → broadcast/notify)
}
export async function resumePausedTask(id: string): Promise<TaskRow> {
  // = 现 task:resume handler 的 paused 分支(transition + sendUserMessage(buildKickoffBody) + broadcast/notify)
}
export async function cancelTask(id: string): Promise<void> {
  // = 现 task:cancel handler 主体
}
```

`ipc.handlers.ts` 三个 handler 改为一行委托(注释注明「语义单点在 lifecycle.ts,move.ts 同源消费」)。

- [ ] **Step 4: 跑测试 + 既有回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/`
Expected: lifecycle 全绿;**既有 starter/resume/dispatcher 测试保持绿**(行为逐字节不变的抽取)

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/task/lifecycle.ts electron/src/main/task/ipc.handlers.ts electron/tests/task/lifecycle.test.ts
git commit -m "refactor: start/resume-paused/cancel 生命周期抽取为共享模块(看板重构 Task 4)"
```

---

### Task 5: task.move 编排(语义表单点)

**Files:**
- Create: `electron/src/main/task/move.ts`
- Test: `electron/tests/task/move.test.ts`

**Interfaces:**
- Consumes: Task 3 `columnOf`/`canDropIntoColumn`(board-columns)、`placeBetween`/`rebalanceColumnPositions`/`needsRebalance`;Task 4 `startTaskAndKickoff`/`resumePausedTask`/`cancelTask`;Task 2 repo
- Produces: `executeMove(id: string, target: { column: BoardColumnKey; groupId: string | null; beforeTaskId?: string; afterTaskId?: string }): Promise<TaskRow>`

- [ ] **Step 1: 写失败测试——语义表逐格断言(Review Focus ①②的主战场)**

```ts
// electron/tests/task/move.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../src/main/im/send-message', () => ({ sendUserMessage: vi.fn().mockResolvedValue(undefined) }));
import { insertTask, getTask, updateTask } from '../../src/main/storage/tasks/repo';
import { createGroup } from '../../src/main/storage/task-groups/repo';
import { executeMove } from '../../src/main/task/move';
import { startTaskAndKickoff } from '../../src/main/task/lifecycle';

vi.mock('../../src/main/task/lifecycle', () => ({
  startTaskAndKickoff: vi.fn(),
  resumePausedTask: vi.fn(),
  cancelTask: vi.fn(),
}));
// ↑ lifecycle 以 mock 隔离(本测试锁 move 的「选择哪个动作」映射;动作本身由 Task 4 测试锁)
import { startTaskAndKickoff as startMock, resumePausedTask as resumeMock, cancelTask as cancelMock } from '../../src/main/task/lifecycle';

const seed = (status: string, extra: Record<string, unknown> = {}) =>
  insertTask({ workspaceId: 'wsm', title: 't', creatorUserId: 'owner', status: status as never, ...extra });

describe('executeMove 语义表', () => {
  beforeEach(() => { vi.clearAllMocks(); startMock.mockResolvedValue({} as never); resumeMock.mockResolvedValue({} as never); cancelMock.mockResolvedValue(undefined as never); });

  it('同列同组 = 纯排序:不动状态,写 board_position', async () => {
    const t = seed('draft');
    await executeMove(t.id, { column: 'backlog', groupId: null });
    expect(getTask(t.id)?.status).toBe('draft');
    expect(getTask(t.id)?.boardPosition).not.toBeNull();
  });

  it('draft→assigned 列:有委派目标 → transition assigned;无目标 → 拒且零副作用', async () => {
    const ok = seed('draft', { assigneeAgentId: 'i-1' });
    await executeMove(ok.id, { column: 'assigned', groupId: null });
    expect(getTask(ok.id)?.status).toBe('assigned');
    const bare = seed('draft');
    await expect(executeMove(bare.id, { column: 'assigned', groupId: null })).rejects.toThrow('委派目标');
    expect(getTask(bare.id)?.status).toBe('draft');
    expect(getTask(bare.id)?.boardPosition).toBeNull(); // Review Focus ①:不写半套
  });

  it('pending→assigned:transition + 语义等价手动放行(状态落 assigned)', async () => {
    const t = seed('pending');
    await executeMove(t.id, { column: 'assigned', groupId: null });
    expect(getTask(t.id)?.status).toBe('assigned');
  });

  it('assigned→active:走 startTaskAndKickoff(Review Focus ②)', async () => {
    const t = seed('assigned', { assigneeAgentId: 'i-1' });
    await executeMove(t.id, { column: 'active', groupId: null });
    expect(startMock).toHaveBeenCalledWith(t.id);
  });

  it('paused→active:走 resumePausedTask', async () => {
    const t = seed('paused', { executionSessionId: 's' });
    await executeMove(t.id, { column: 'active', groupId: null });
    expect(resumeMock).toHaveBeenCalledWith(t.id);
  });

  it('in_progress→done:transition completed + completedAt', async () => {
    const t = seed('in_progress', { executionSessionId: 's', assigneeAgentId: 'i' });
    await executeMove(t.id, { column: 'done', groupId: null });
    const after = getTask(t.id)!;
    expect(after.status).toBe('completed');
    expect(after.completedAt).not.toBeNull();
  });

  it('in_progress→closed:走 cancelTask(确认框在 renderer,main 不再二次确认)', async () => {
    const t = seed('in_progress', { executionSessionId: 's', assigneeAgentId: 'i' });
    await executeMove(t.id, { column: 'closed', groupId: null });
    expect(cancelMock).toHaveBeenCalledWith(t.id);
  });

  it('任意→backlog 拒(待办只出不进);终态→active/done 拒', async () => {
    const t = seed('in_progress', { executionSessionId: 's', assigneeAgentId: 'i' });
    await expect(executeMove(t.id, { column: 'backlog', groupId: null })).rejects.toThrow('待办');
    const c = seed('completed');
    await expect(executeMove(c.id, { column: 'active', groupId: null })).rejects.toThrow();
  });

  it('换组:同列跨泳道 → group_id 更新;目标组须同 ws 且活跃', async () => {
    const g = createGroup({ workspaceId: 'wsm', name: 'v1' });
    const t = seed('draft');
    await executeMove(t.id, { column: 'backlog', groupId: g.id });
    expect(getTask(t.id)?.groupId).toBe(g.id);
    const archived = createGroup({ workspaceId: 'wsm', name: 'old' });
    // 归档该组(直调 repo)
    const { archiveGroup } = await import('../../src/main/storage/task-groups/repo');
    archiveGroup(archived.id);
    await expect(executeMove(t.id, { column: 'backlog', groupId: archived.id })).rejects.toThrow('归档');
  });

  it('落点中值:before/after 邻居之间', async () => {
    const a = seed('draft'); updateTask(a.id, { boardPosition: 1000 });
    const b = seed('draft'); updateTask(b.id, { boardPosition: 2000 });
    const c = seed('draft');
    await executeMove(c.id, { column: 'backlog', groupId: null, beforeTaskId: b.id, afterTaskId: a.id });
    const pos = getTask(c.id)!.boardPosition!;
    expect(pos).toBeGreaterThan(1000);
    expect(pos).toBeLessThan(2000);
  });
});
```

- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现 move.ts**

```ts
// electron/src/main/task/move.ts
// task.move 编排(spec §3.2/§4 语义表):换列动作单点映射 + 落点计算 + 换组校验。
// renderer 只发落点不定动作——契约不漂移的关键(momo-boundary-rules)。
import { getDb } from '../storage/db';
import { getTask, listTasks, transitionTaskStatus, updateTask, type TaskRow, type TaskStatus } from '../storage/tasks/repo';
import { getGroup } from '../storage/task-groups/repo';
import { hasDelegationTarget } from './starter';
import { notifyExecutor } from './executor';
import { startTaskAndKickoff, resumePausedTask, cancelTask } from './lifecycle';
import { columnOf, canDropIntoColumn, type BoardColumnKey } from '../../../renderer/src/ipc/board-columns';
import { placeBetween, needsRebalance, rebalanceColumnPositions } from './board-position';

export interface MoveTarget {
  column: BoardColumnKey;
  groupId: string | null;
  beforeTaskId?: string;
  afterTaskId?: string;
}

export async function executeMove(id: string, target: MoveTarget): Promise<TaskRow> {
  const task = getTask(id);
  if (!task) throw new Error(`task ${id} 不存在`);
  const fromCol = columnOf(task.status);
  const sameColumn = fromCol === target.column;

  if (!sameColumn && !canDropIntoColumn(task.status, target.column)) {
    throw new Error(dropRejectReason(task.status, target.column));
  }

  // ① 换列语义动作(spec §4 逐格)
  if (!sameColumn) {
    if (target.column === 'assigned') {
      if (task.status === 'draft') {
        if (!hasDelegationTarget(task)) throw new Error('任务未设置委派目标,请先编辑任务指派 agent/团队/会话');
        transitionTaskStatus(id, 'assigned');
        notifyExecutor();
      } else { // pending → assigned:手动放行
        transitionTaskStatus(id, 'assigned');
        notifyExecutor();
      }
    } else if (target.column === 'active') {
      if (task.status === 'assigned' || task.status === 'session_queued') await startTaskAndKickoff(id);
      else if (task.status === 'paused') await resumePausedTask(id);
      // in_progress 不可能(sameColumn 已排除)
    } else if (target.column === 'done') {
      transitionTaskStatus(id, 'completed', { completedAt: Date.now() });
      // 循环续期 + 放行(与 agent complete_task 同语义)
      const { spawnNextInstanceIfRecurring } = await import('../agent/tools/task-tools');
      spawnNextInstanceIfRecurring(id);
      notifyExecutor();
    } else if (target.column === 'closed') {
      await cancelTask(id);
    }
  }

  // ② 换组校验
  if (target.groupId !== task.groupId) {
    if (target.groupId !== null) {
      const g = getGroup(target.groupId);
      if (!g || g.workspaceId !== task.workspaceId) throw new Error(`目标分组不存在: ${target.groupId}`);
      if (g.archivedAt != null) throw new Error('目标分组已归档,请先取消归档');
    }
  }

  // ③ 落点计算(列内当前序 = boardPosition 升序,NULL 按 created_at 兜底排尾)
  const columnTasks = listTasks({ workspaceId: task.workspaceId, groupId: target.groupId, archived: 'exclude' })
    .filter((t) => columnOf(t.status) === target.column);
  columnTasks.sort(cmpColumn);
  let position = computeDropPosition(columnTasks, target);
  const patch: Partial<TaskRow> = { groupId: target.groupId };
  if (needsRebalance(columnTasks)) {
    const map = rebalanceColumnPositions(columnTasks);
    const db = getDb();
    db.transaction(() => {
      for (const [tid, p] of map) updateTask(tid, { boardPosition: p });
    })();
    position = computeDropPosition(
      columnTasks.map((t) => ({ ...t, boardPosition: map.get(t.id) ?? t.boardPosition })),
      target,
    );
  }
  patch.boardPosition = position;
  updateTask(id, patch);
  return getTask(id)!;
}

function cmpColumn(a: TaskRow, b: TaskRow): number {
  const pa = a.boardPosition ?? Number.MAX_SAFE_INTEGER;
  const pb = b.boardPosition ?? Number.MAX_SAFE_INTEGER;
  return pa !== pb ? pa - pb : a.createdAt - b.createdAt;
}

function computeDropPosition(column: TaskRow[], target: MoveTarget): number {
  const idxBefore = target.beforeTaskId ? column.findIndex((t) => t.id === target.beforeTaskId) : -1;
  const idxAfter = target.afterTaskId ? column.findIndex((t) => t.id === target.afterTaskId) : -1;
  const prev = idxAfter >= 0 ? column[idxAfter].boardPosition : null; // after=下方位邻居 → 值更小
  const next = idxBefore >= 0 ? column[idxBefore].boardPosition : null;
  return placeBetween(prev, next, column);
}

function dropRejectReason(from: TaskStatus, to: BoardColumnKey): string {
  if (to === 'backlog') return `任务不能移回待办列(状态机不允许 ${from} → draft/pending)`;
  if (['completed', 'failed', 'cancelled'].includes(from)) return `终态任务(${from})不可再变更`;
  return `状态机不允许 ${from} → ${to}`;
}
```

注意两处对齐:① `spawnNextInstanceIfRecurring` 若非 task-tools 导出,按其真实定义模块 import(执行者 grep);② `columnOf` 的 import 路径 `../../../renderer/src/ipc/board-columns` 与 preload 引 types.d.ts 同款三层相对路径。

- [ ] **Step 4: 跑测试全绿;补一例 Review Focus ①断言后全量回归**
- [ ] **Step 5: 提交**

```bash
git add electron/src/main/task/move.ts electron/tests/task/move.test.ts
git commit -m "feat: task.move 编排——换列语义映射/落点中值/换组校验单点(看板重构 Task 5)"
```

---

### Task 6: IPC 注册——task:move / task:archive / task:unarchive + task:list archived 透传

**Files:**
- Modify: `electron/src/main/task/ipc.handlers.ts`
- Test: `electron/tests/task/move-ipc.test.ts`

**Interfaces:**
- Consumes: Task 5 `executeMove`、Task 2 repo
- Produces: IPC 通道 `task:move`、`task:archive`(isTerminal 校验)、`task:unarchive`;`task:list` opts 透传 `archived`

- [ ] **Step 1: 写失败测试**(ipcMain.handle 用仓库既有 handler 测试法——`electron/tests/task/` 内已有先例,照 `resume.test.ts` 的注册-调用模式)

```ts
// electron/tests/task/move-ipc.test.ts
import { describe, it, expect } from 'vitest';
import { insertTask, updateTask } from '../../src/main/storage/tasks/repo';
import { registerTaskHandlers } from '../../src/main/task/ipc.handlers';
import { ipcMain } from 'electron';
// electron mock:照仓库既有测试对 ipcMain.handle 的 capture 方式(tests/ 里有先例,照搬 helper)

describe('task:move/archive/unarchive IPC', () => {
  it('task:move 通道透传 executeMove 并返回 TaskRow', async () => {
    const t = insertTask({ workspaceId: 'wsi', title: 'm', creatorUserId: 'owner', status: 'draft', assigneeAgentId: 'i' });
    const row = await handlers['task:move'](null, t.id, { column: 'assigned', groupId: null });
    expect(row.status).toBe('assigned');
  });
  it('task:archive:终态成功置 archived_at;非终态 Error(Review Focus 边界)', async () => {
    const done = insertTask({ workspaceId: 'wsi', title: 'd', creatorUserId: 'owner', status: 'completed' });
    const row = await handlers['task:archive'](null, done.id);
    expect(row.archivedAt).not.toBeNull();
    const run = insertTask({ workspaceId: 'wsi', title: 'r', creatorUserId: 'owner', status: 'in_progress', executionSessionId: 's', assigneeAgentId: 'i' });
    await expect(handlers['task:archive'](null, run.id)).rejects.toThrow('终态');
  });
  it('task:unarchive 清空 archived_at', async () => {
    const t = insertTask({ workspaceId: 'wsi', title: 'u', creatorUserId: 'owner', status: 'completed' });
    updateTask(t.id, { archivedAt: 1 });
    const row = await handlers['task:unarchive'](null, t.id);
    expect(row.archivedAt).toBeNull();
  });
});
```

- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**——ipc.handlers.ts 追加:

```ts
import { executeMove, type MoveTarget } from './move';
import { isTerminal } from '../storage/tasks/state-machine';

ipcMain.handle('task:move', async (_evt, id: string, target: MoveTarget): Promise<TaskRow> => {
  const row = await executeMove(id, target);
  void broadcastLocalTaskSnapshot();
  return row;
});
ipcMain.handle('task:archive', async (_evt, id: string): Promise<TaskRow> => {
  const t = getTask(id);
  if (!t) throw new Error(`task ${id} 不存在`);
  if (!isTerminal(t.status)) throw new Error('仅终态任务可归档(completed/failed/cancelled)');
  updateTask(id, { archivedAt: Date.now() });
  return getTask(id)!;
});
ipcMain.handle('task:unarchive', async (_evt, id: string): Promise<TaskRow> => {
  updateTask(id, { archivedAt: null });
  return getTask(id)!;
});
```

`task:list` 的 `ListOpts` 类型加 `archived?: 'exclude'|'only'|'all'`(透传即可,Task 2 已支持)。归档/取消归档后同样 `void broadcastLocalTaskSnapshot()`。

- [ ] **Step 4: 跑测试全绿 + typecheck**
- [ ] **Step 5: 提交**

```bash
git add electron/src/main/task/ipc.handlers.ts electron/tests/task/move-ipc.test.ts
git commit -m "feat: task:move/archive/unarchive IPC 通道 + list archived 透传(看板重构 Task 6)"
```

---

### Task 7: taskGroup IPC + preload + renderer 类型面

**Files:**
- Create: `electron/src/main/task/groups.ipc.handlers.ts`
- Modify: `electron/src/main/ipc/index.ts`(注册调用,照 registerTaskHandlers 位置追加)
- Modify: `electron/src/preload/index.ts`(taskGroup 命名空间)
- Modify: `renderer/src/ipc/types.d.ts`
- Test: `electron/tests/task/groups-ipc.test.ts`

**Interfaces:**
- Produces: `TaskGroupApiSurface { list; create; update; reorder; archive; unarchive }` + `ApiSurface.taskGroup`
- Produces(types.d.ts): `GroupRow`(renderer 镜像)、`TaskApiSurface` 增 `move/archive/unarchive`、`list` opts 增 `archived`、`TaskRow` 增 `groupId/boardPosition/archivedAt`

- [ ] **Step 1: 写失败测试**(handler capture 同 Task 6 模式;断言 archive 返回计数 + unarchive 后 list 三态)

```ts
// electron/tests/task/groups-ipc.test.ts — 关键断言:
it('taskGroup:archive 通道返回级联计数', async () => {
  const g = createGroup({ workspaceId: 'wsg', name: 'v' });
  insertTask({ workspaceId: 'wsg', title: 'run', creatorUserId: 'owner', status: 'in_progress', executionSessionId: 's', assigneeAgentId: 'i', groupId: g.id });
  const res = await handlers['taskGroup:archive'](null, g.id);
  expect(res).toEqual({ cancelledIds: expect.any(Array), archivedCount: 1 });
});
it('taskGroup:list 默认 exclude / only 只回归档组', async () => { /* 同构断言 */ });
```

- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**

```ts
// electron/src/main/task/groups.ipc.handlers.ts
import { ipcMain } from 'electron';
import { archiveGroup, createGroup, listGroups, reorderGroups, unarchiveGroup, updateGroup } from '../storage/task-groups/repo';
import { logger } from '../logger';

export function registerTaskGroupHandlers(): void {
  ipcMain.handle('taskGroup:list', (_evt, workspaceId: string, opts?: { archived?: 'exclude'|'only'|'all' }) => listGroups(workspaceId, opts));
  ipcMain.handle('taskGroup:create', (_evt, input: { workspaceId: string; name: string; color?: string }) => createGroup(input));
  ipcMain.handle('taskGroup:update', (_evt, id: string, patch: { name?: string; color?: string }) => updateGroup(id, patch));
  ipcMain.handle('taskGroup:reorder', (_evt, orderedIds: string[]) => { reorderGroups(orderedIds); });
  ipcMain.handle('taskGroup:archive', async (_evt, id: string) => {
    const res = archiveGroup(id);
    // 级联 cancel 的 in_progress 来源补执行中断(进程级副作用,不入 DB 事务)
    const { cancelTask } = await import('./lifecycle'); // cancelTask 已含 transition;此处仅 abort
    // 注:archiveGroup 内已 transition cancelled;这里只做 abort——lifecycle 需补导出 abortTaskExecution(id)
    return res;
  });
  ipcMain.handle('taskGroup:unarchive', (_evt, id: string) => unarchiveGroup(id));
  logger.info('TaskGroup IPC handlers 已注册');
}
```

执行注意:上面 archive 通道的 abort 补偿需 lifecycle 导出独立的 `abortTaskExecution(id)`(只 abort 不 transition,与 cancelTask 拆开)——在 Task 4 的 lifecycle.ts 补此导出并加一测;groups handler 对 cancelledIds 逐个调用。

preload(`electron/src/preload/index.ts`,task 命名空间附近追加):

```ts
taskGroup: {
  list: (workspaceId, opts?) => invoke('taskGroup:list', workspaceId, opts),
  create: (input) => invoke('taskGroup:create', input),
  update: (id, patch) => invoke('taskGroup:update', id, patch),
  reorder: (orderedIds) => invoke('taskGroup:reorder', orderedIds),
  archive: (id) => invoke('taskGroup:archive', id),
  unarchive: (id) => invoke('taskGroup:unarchive', id),
},
```

types.d.ts 追加(GroupRow 镜像 / TaskGroupApiSurface / ApiSurface 挂 taskGroup / TaskApiSurface 增三方法 / TaskRow 三字段 / list opts 增 archived):

```ts
export interface GroupRow {
  id: string; workspaceId: string; name: string; color: string | null;
  position: number; archivedAt: number | null; createdAt: number; updatedAt: number;
}
export interface TaskGroupApiSurface {
  list(workspaceId: string, opts?: { archived?: 'exclude' | 'only' | 'all' }): Promise<GroupRow[]>;
  create(input: { workspaceId: string; name: string; color?: string }): Promise<GroupRow>;
  update(id: string, patch: { name?: string; color?: string }): Promise<GroupRow>;
  reorder(orderedIds: string[]): Promise<void>;
  archive(id: string): Promise<{ cancelledIds: string[]; archivedCount: number }>;
  unarchive(id: string): Promise<GroupRow>;
}
// TaskApiSurface 内追加:
move(id: string, target: { column: BoardColumnKey; groupId: string | null; beforeTaskId?: string; afterTaskId?: string }): Promise<TaskRow>;
archive(id: string): Promise<TaskRow>;
unarchive(id: string): Promise<TaskRow>;
// ApiSurface 追加 taskGroup: TaskGroupApiSurface;
```

- [ ] **Step 4: 双 workspace typecheck + 测试全绿**(renderer 侧无新测试,类型编译即验证)
- [ ] **Step 5: 提交**

```bash
git add electron/src/main/task/groups.ipc.handlers.ts electron/src/main/ipc/index.ts electron/src/preload/index.ts renderer/src/ipc/types.d.ts electron/tests/task/groups-ipc.test.ts electron/src/main/task/lifecycle.ts electron/tests/task/lifecycle.test.ts
git commit -m "feat: taskGroup IPC 面 + preload 命名空间 + renderer 类型契约(看板重构 Task 7)"
```

---

### Task 8: agent 工具同步(spec §8:补信息不给能力)

**Files:**
- Modify: `electron/src/main/agent/tools/task-tools.ts`
- Test: `electron/tests/agent/tools/task-tools-groups.test.ts`

**Interfaces:**
- Consumes: Task 1 `listGroups`/`getGroup`
- Produces: `CreateTaskInput.groupId?: string`;新工具 `list_task_groups`;`list_tasks` 入参 `groupId` + 返回附 `groupName`;`readTask` 返回体加 `groupId/groupName`

- [ ] **Step 1: 写失败测试**(ctx 构造照 `task-tools.test.ts` 既有 fixture)

```ts
// electron/tests/agent/tools/task-tools-groups.test.ts 关键用例:
it('create_task 带 groupId 落组;组不存在 → Error', async () => {
  const g = createGroup({ workspaceId: ctxWs, name: 'v2.1' });
  const row = await tools.execute('create_task', { title: 'x', groupId: g.id }, ctx);
  expect(JSON.parse(row).groupId).toBe(g.id);
  await expect(tools.execute('create_task', { title: 'y', groupId: 'G-999' }, ctx)).rejects.toThrow('分组');
});
it('归档组不可作为 create_task 目标', async () => { /* archiveGroup 后 rejects */ });
it('list_task_groups 返回活跃组 id/name/color', async () => { /* 断言数组形状 */ });
it('list_tasks groupId 过滤 + groupName 注入', async () => { /* 断言 */ });
it('read_task 返回 groupId/groupName', async () => { /* 断言 */ });
```

- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**(四处机械改)

1. `CreateTaskInput` + `groupId?: string`;`createTask` 内:有 groupId 时校验 `getGroup` 存在、同 ws、未归档,否则 throw;`insertTask({..., groupId: input.groupId})`
2. `readTask` 返回体加 `groupId: ctx.task.groupId, groupName: ctx.task.groupId ? getGroup(ctx.task.groupId)?.name ?? null : null`
3. `listTasks` 工具:inputSchema 加 `groupId` 参数描述;execute 组 opts 时透传;结果 map 附 `groupName`(组名 map 由 `listGroups(ctx.workspaceId)` 预构建)
4. getDefs 追加 `list_task_groups` 定义 + `handles()` 加名 + execute 加 case:

```ts
{
  name: 'list_task_groups',
  description: '列出当前工作空间的任务分组(看板泳道)。create_task 传 groupId 可让子任务落同组;仅返回活跃组。',
  inputSchema: { type: 'object', properties: {} },
},
// execute case:
case 'list_task_groups': {
  return JSON.stringify(listGroups(ctx.workspaceId).map((g) => ({ id: g.id, name: g.name, color: g.color })));
}
```

- [ ] **Step 4: 既有 task-tools 测试回归全绿(工具描述快照若存在需同步)**
- [ ] **Step 5: 提交**

```bash
git add electron/src/main/agent/tools/task-tools.ts electron/tests/agent/tools/task-tools-groups.test.ts
git commit -m "feat: agent 任务工具分组信息同步——create groupId/list_task_groups/groupName(看板重构 Task 8)"
```

---

### Task 9: renderer lib/board.ts 纯函数

**Files:**
- Create: `renderer/src/lib/board.ts`
- Test: `renderer/src/lib/board.test.ts`

**Interfaces:**
- Consumes: `board-columns.ts` 全部导出、`TaskRow`/`GroupRow`(types)
- Produces: `sortColumn(tasks: TaskRow[]): TaskRow[]`(boardPosition 升序 NULLS-LAST → createdAt 兜底)、`splitLanes(tasks, groups, mode: 'lanes'|'flat'): Array<{ group: GroupRow | null; tasks: TaskRow[] }>`(lanes=活跃组序+未分组垫底;flat=单道)、`filterBoardTasks(tasks, { text; assigneeId }): TaskRow[]`(title+description 文本 AND 指派人)、`groupColorStyle(color: string | null): string`(语义色名→inline style 映射,token 单源)

- [ ] **Step 1: 写失败测试**(Review Focus ⑤的 NULL 排序在此钉死)

```ts
// renderer/src/lib/board.test.ts 关键用例:
it('sortColumn:有值在前升序,NULL 垫底按 createdAt', () => {
  const mk = (id: string, pos: number | null, createdAt: number) => ({ id, boardPosition: pos, createdAt } as TaskRow);
  const out = sortColumn([mk('a', null, 300), mk('b', 2000, 1), mk('c', 1000, 2), mk('d', null, 100)]);
  expect(out.map((t) => t.id)).toEqual(['c', 'b', 'd', 'a']); // NULL 之间 createdAt 升序
});
it('splitLanes 泳道模式:活跃组按 position,未分组垫底', () => { /* 断言顺序与归属 */ });
it('splitLanes 平铺模式:单道全量', () => { /* ... */ });
it('filterBoardTasks 文本命中 title 或 description;assignee AND', () => { /* ... */ });
```

- [ ] **Step 2: 确认失败 → Step 3: 实现**(纯函数,无副作用,直接按接口写;groupColorStyle 用 `Record<string, string>` 映射语义色名到 `rgb(var(--accent-500))` 等 CSS 变量串,未知名回退 tertiary)
- [ ] **Step 4: 全绿 + typecheck**
- [ ] **Step 5: 提交**

```bash
git add renderer/src/lib/board.ts renderer/src/lib/board.test.ts
git commit -m "feat: 看板列组装纯函数——排序/泳道/过滤/组色(看板重构 Task 9)"
```

---

### Task 10: group.store + task.store 乐观 move(Review Focus ④)

**Files:**
- Create: `renderer/src/stores/group.store.ts` + `group.store.test.ts`
- Modify: `renderer/src/stores/task.store.ts` + `task.store.test.ts`

**Interfaces:**
- Produces: `useGroupStore { groups; load(workspaceId); create; rename; setColor; reorder; archive; unarchive }`(全部动作成功后本地同步)
- Produces(task.store 增):`move(id, target): Promise<void>`(乐观+回滚)、`archive(id)/unarchive(id)`、`setDragging(b: boolean)`、内部 `pendingMoveCount`(load 在 `pendingMoveCount>0 || dragging` 时跳过 set)

- [ ] **Step 1: 写失败测试**(window.api mock 注入方式照 task.store.test.ts 既有 fixture;回滚断言是核心)

```ts
// task.store.test.ts 追加关键用例:
it('move 乐观更新:本地先变,IPC 成功用返回行覆盖', async () => {
  const t = { ...mkTask('T-001', 'draft'), groupId: null };
  mockApi.task.move.mockResolvedValue({ ...t, status: 'assigned', groupId: 'G-001' });
  useTaskStore.setState({ tasks: [t] });
  await useTaskStore.getState().move('T-001', { column: 'assigned', groupId: 'G-001' });
  expect(useTaskStore.getState().tasks[0].status).toBe('assigned');
});
it('move 失败回滚快照 + 抛错(Review Focus ④)', async () => {
  mockApi.task.move.mockRejectedValue(new Error('状态机不允许'));
  useTaskStore.setState({ tasks: [t] });
  await expect(useTaskStore.getState().move(...)).rejects.toThrow();
  expect(useTaskStore.getState().tasks[0].status).toBe('draft'); // 回滚
});
it('move 在途时 load 不覆盖(pendingMoveCount 守卫)', async () => {
  let resolveMove: (v: TaskRow) => void;
  mockApi.task.move.mockReturnValue(new Promise((r) => { resolveMove = r; }));
  mockApi.task.list.mockResolvedValue([]); // 轮询返回空列表
  const p = useTaskStore.getState().move(...); // 不 await
  await useTaskStore.getState().load('ws'); // 在途轮询
  expect(useTaskStore.getState().tasks).toHaveLength(1); // 未被空列表覆盖
  resolveMove!({ ...t, status: 'assigned' });
  await p;
});
it('dragging 时 load 跳过', () => { /* setDragging(true) → load → tasks 不变 */ });
```

- [ ] **Step 2: 确认失败 → Step 3: 实现**

task.store 关键实现(乐观状态映射:目标列代表状态 `{ assigned: 'assigned', active: 'in_progress', done: 'completed', closed: 'cancelled' }`,backlog 不变状态):

```ts
// task.store.ts 增量(节选核心,非全文):
pendingMoveCount: 0,
dragging: false,
setDragging: (b) => set({ dragging: b }),

move: async (id, target) => {
  const snapshot = get().tasks;
  const OPTIMISTIC_STATUS: Partial<Record<BoardColumnKey, TaskStatus>> = {
    assigned: 'assigned', active: 'in_progress', done: 'completed', closed: 'cancelled',
  };
  set((s) => ({
    pendingMoveCount: s.pendingMoveCount + 1,
    tasks: s.tasks.map((t) =>
      t.id === id
        ? { ...t, groupId: target.groupId, status: OPTIMISTIC_STATUS[target.column] ?? t.status }
        : t,
    ),
  }));
  try {
    const updated = await ipc.task.move(id, target);
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? updated : t)) }));
  } catch (err) {
    set({ tasks: snapshot }); // 回滚快照
    throw err; // 上层 toast
  } finally {
    set((s) => ({ pendingMoveCount: s.pendingMoveCount - 1 }));
  }
},

// load 内首行改判:
load: async (workspaceId) => {
  if (get().pendingMoveCount > 0 || get().dragging) return; // 在途/手持中跳过本轮
  ...原逻辑
},
```

group.store 按 Interfaces 直写(zustand,动作全部 `await ipc.taskGroup.*` 后重拉或本地更新,照 task.store 风格)。

- [ ] **Step 4: 全绿 + typecheck → Step 5: 提交**

```bash
git add renderer/src/stores/group.store.ts renderer/src/stores/group.store.test.ts renderer/src/stores/task.store.ts renderer/src/stores/task.store.test.ts
git commit -m "feat: group.store + task.store 乐观 move/回滚/轮询守卫(看板重构 Task 10)"
```

---

### Task 11: @dnd-kit 接入 + 平铺画板静态渲染(未拖拽)

**Files:**
- Modify: `renderer/package.json`(dependencies 加 `"@dnd-kit/core": "^6.1.0", "@dnd-kit/sortable": "^8.0.0", "@dnd-kit/utilities": "^3.2.2"`)
- Create: `renderer/src/components/task-board/BoardCard.tsx`、`BoardColumn.tsx`、`BoardToolbar.tsx`
- Modify: `renderer/src/components/task-board/TaskBoardView.tsx`(主区换画板,并发徽标保留进 toolbar)
- Test: `renderer/src/components/task-board/BoardColumn.test.tsx`、`BoardCard.test.tsx`

**Interfaces:**
- Consumes: Task 9 `sortColumn/filterBoardTasks/splitLanes/groupColorStyle`、Task 10 stores、`useTaskEntityNames`
- Produces: `BoardCard { task; selected; onClick; groupChip?: { name; color } | null }`、`BoardColumn { column: BoardColumnDef; tasks; selectedId; onSelect }`、`BoardToolbar` 受控 props `{ text; onText; assignee; onAssignee; assigneeOptions; laneMode; onLaneMode; onOpenArchive }`

- [ ] **Step 1: 安装依赖**

Run: `npx pnpm@9.0.0 --filter momo-studio-renderer add @dnd-kit/core@^6.1.0 @dnd-kit/sortable@^8.0.0 @dnd-kit/utilities@^3.2.2`

- [ ] **Step 2: 写失败测试**(组件测试:@testing-library,断言列头计数/卡片徽标/空态)

```tsx
// BoardColumn.test.tsx 关键用例:
it('渲染列名/计数/卡片,点击卡片回调 onSelect', () => {
  const onClick = vi.fn();
  render(<BoardColumn column={BOARD_COLUMNS[0]} tasks={[mkTask('T-001','draft')]} selectedId={null} onSelect={onClick} />);
  expect(screen.getByText('待办')).toBeTruthy();
  expect(screen.getByText('1')).toBeTruthy();
  fireEvent.click(screen.getByText(/T-001/));
  expect(onClick).toHaveBeenCalledWith('T-001');
});
// BoardCard.test.tsx:中间态徽标(排队中/已暂停)、优先级[高]、平铺模式组 chip
```

- [ ] **Step 3: 实现三组件 + TaskBoardView 改造**

BoardCard 视觉照 spec §5.2(独立圆角卡 bg-surface-2+border-subtle;优先级/短ID/标题/状态徽标 taskStatusStyle/元信息行复用 TaskCard 内容;平铺模式 groupChip);BoardColumn = 列头(label+计数+hint 灰字)+ sortColumn(tasks) 卡片列表;BoardToolbar = 搜索 input + 指派人 select + 分组开关(受控)+ 并发徽标(props 传入)+ 归档 Button secondary + 新建 Button primary(开 CreateTaskDialog,复用现组件)。TaskBoardView:数据流保持(mount load + 5s 轮询 + getGlobal 并发上限),主区替换为 toolbar + 平铺画板(本任务 laneMode 恒 'flat',泳道 Task 12 接),点卡片仍 setSelectedTaskId(抽屉 Task 12 前,沿用主区 TaskDetailPanel 渲染不动,避免中间态断档)。全部语义 token + lucide。

- [ ] **Step 4: 测试全绿 + typecheck + `npx pnpm@9.0.0 --filter momo-studio-renderer test`**
- [ ] **Step 5: 提交**

```bash
git add renderer/package.json renderer/pnpm-lock.yaml renderer/src/components/task-board/BoardCard.tsx renderer/src/components/task-board/BoardColumn.tsx renderer/src/components/task-board/BoardToolbar.tsx renderer/src/components/task-board/TaskBoardView.tsx renderer/src/components/task-board/BoardCard.test.tsx renderer/src/components/task-board/BoardColumn.test.tsx
git commit -m "feat: 平铺画板静态渲染——列/卡片/工具栏/@dnd-kit 依赖(看板重构 Task 11)"
```

---

### Task 12: 拖拽接线——列内排序 + 跨泳道换组 + 泳道模式 + DragOverlay + 详情抽屉

**Files:**
- Create: `renderer/src/components/task-board/BoardCanvas.tsx`、`Lane.tsx`、`TaskDetailDrawer.tsx`
- Modify: `TaskBoardView.tsx`(接 BoardCanvas + Drawer,laneMode localStorage 持久化 key `kanban-lane-mode`)
- Test: `renderer/src/components/task-board/BoardCanvas.test.tsx`、`TaskDetailDrawer.test.tsx`

**Interfaces:**
- Consumes: Task 10 `move/setDragging`、Task 9 `splitLanes`、Task 11 组件
- Produces: `BoardCanvas { tasks; groups; laneMode; selectedId; onSelect }`(内部 DndContext + onDragEnd 三分支);`TaskDetailDrawer { taskId; onClose }`(右侧滑入壳,内部渲染现 TaskDetailPanel 逻辑迁入或包用)

- [ ] **Step 1: 写失败测试**(@dnd-kit 官方测试模式:fireEvent.pointerDown/Move/Up 序列;或对 onDragEnd 纯逻辑抽出 `resolveDrop(active, over, ctx): DropResolution | null` 单测三分支)

```tsx
// BoardCanvas.test.tsx 关键用例(逻辑层):
it('同列同泳道 → 纯排序 move(before/after 邻居透传)', () => { /* resolveDrop 断言 */ });
it('同列跨泳道 → move 换 groupId', () => { /* ... */ });
it('跨列落 active from assigned → move column active(renderer 不指定动作,只发落点)', () => { /* ... */ });
it('canDropIntoColumn false 的列 → 不产生 resolution(禁投)', () => { /* ... */ });
// TaskDetailDrawer.test.tsx:渲染 taskId 内容 + ESC 关闭回调
```

- [ ] **Step 2: 确认失败 → Step 3: 实现**

BoardCanvas 核心(传感组合 PointerSensor+KeyboardSensor;DragOverlay 微倾卡;onDragStart → setDragging(true),onDragEnd → setDragging(false) + resolveDrop → 确认框判定(from in_progress 且落 done/closed → `window.confirm` 式 Dialog,项目内用现有 Dialog 原子件;取消即 return)→ `task.store.move` catch toast):

```tsx
// resolveDrop 纯函数(BoardCanvas 内导出,可单测):
export interface DropCtx { tasks: TaskRow[]; laneTaskIds: Set<string>; /* 泳道归属 */ }
export function resolveDrop(
  activeId: string, over: { taskId: string; column: BoardColumnKey; groupId: string | null } | { column: BoardColumnKey; groupId: string | null },
  ctx: DropCtx,
): { column: BoardColumnKey; groupId: string | null; beforeTaskId?: string; afterTaskId?: string } | null {
  // over 是卡片 → 计算同列可见序中 before/after 邻居;over 是列容器 → 列尾
  // canDropIntoColumn(task.status, column) false → null
}
```

Lane = LaneHeader(色标 groupColorStyle/名称/计数/折叠 chevron/菜单 MoreHorizontal→重命名·换色·归档组,菜单用现有 Popover/Dropdown 原子件,无则简单 details 菜单)+ 5 列横排;折叠态只留 header。泳道模式 splitLanes;平铺单道。TaskDetailDrawer:fixed right-0 top-0 bottom-0 w-[380px] bg-canvas border-l shadow + 遮罩(bg-backdrop)点击关闭 + useEffect ESC;内容 = 现 TaskDetailPanel 函数体整体迁入(props 不变)。TaskBoardView 移除主区 TaskDetailPanel 渲染,改 `{selectedTaskId && <TaskDetailDrawer .../>}`。

- [ ] **Step 4: 测试全绿 + typecheck + 手工冒烟(macOS 主机 `pnpm dev`,容器内 `xvfb-run -a` 按 AGENTS.md)——拖一张卡排序/换列,确认乐观生效与回滚 toast**
- [ ] **Step 5: 提交**

```bash
git add renderer/src/components/task-board/BoardCanvas.tsx renderer/src/components/task-board/Lane.tsx renderer/src/components/task-board/TaskDetailDrawer.tsx renderer/src/components/task-board/TaskBoardView.tsx renderer/src/components/task-board/TaskDetailPanel.tsx renderer/src/components/task-board/BoardCanvas.test.tsx renderer/src/components/task-board/TaskDetailDrawer.test.tsx
git commit -m "feat: 看板拖拽——列内排序/跨泳道换组/泳道模式/详情抽屉(看板重构 Task 12)"
```

---

### Task 13: 跨列语义 UI——确认框 + 禁投反馈 + toast

**Files:**
- Modify: `BoardCanvas.tsx`(onDragOver 禁投列视觉:drop-no 类列变暗;合法列 drop-ok 高亮;插入指示线)
- Create: `renderer/src/components/task-board/ConfirmDialog.tsx`(若无通用确认原子件——查 `components/ui/` 先复用)
- Test: `BoardCanvas.test.tsx` 追加用例

**Interfaces:**
- Consumes: Task 12 resolveDrop、`canDropIntoColumn`
- Produces: 确认流(in_progress→done/closed 松手弹确认,文案:「agent 可能仍在运行,确认手动完成?」/「确认取消该运行中任务?」;取消 → 卡片归位零调用)

- [ ] **Step 1: 写失败测试**:`resolveDrop 加 requireConfirm 输出`(from==='in_progress' && (to==='done'||to==='closed') → `{..., requireConfirm: true}`);UI 测试断言确认弹层出现、点取消不调 mock move
- [ ] **Step 2: 确认失败 → Step 3: 实现**(确认 Dialog 用 Button primary/ghost;toast 用项目既有 toast/notice 机制——grep renderer 内现用法照搬;若无现成 toast,用最简 fixed bottom 通知条组件 `components/ui/Toast.tsx` 实现,单测省略视觉只测显示/隐藏)
- [ ] **Step 4: 全绿 + typecheck + 手工冒烟(拖 in_progress 卡到已完成列,取消确认,卡片归位)**
- [ ] **Step 5: 提交**

```bash
git add renderer/src/components/task-board/
git commit -m "feat: 跨列拖拽确认框与禁投反馈 + move 失败 toast(看板重构 Task 13)"
```

---

### Task 14: 归档面板 + 侧边栏改造 + 旧组件退役 + 全量收尾

**Files:**
- Create: `renderer/src/components/task-board/ArchivePanel.tsx`、`GroupManageList.tsx`
- Modify: `renderer/src/components/task-board/TaskSidebarPanel.tsx`(整体重构:GroupManageList + 归档入口 + RemoteTaskSection 原样保留)
- Delete: `renderer/src/components/task-board/TaskList.tsx`、`TaskList.test.tsx`、`TaskFilters.tsx`、`task-filter.ts`、`task-filter.test.ts`
- Test: `ArchivePanel.test.tsx`、`GroupManageList.test.tsx`、`TaskSidebarPanel.test.tsx`(若原有则改造)

**Interfaces:**
- Consumes: Task 7 `taskGroup.*`、Task 6 `task.archive/unarchive/list(archived)`、Task 10 stores
- Produces: `ArchivePanel { open; onClose }`(overlay 模态:搜索 + 组/状态 select 过滤 + 列表行[checkbox/短ID·标题/组/徽标/归档时间/恢复按钮] + 底部已选 n·批量恢复·恢复整组 select);`GroupManageList { }`(组列表:点选定位/改名/换色/调序(上下移)/归档;「+ 新建组」内联输入)

- [ ] **Step 1: 写失败测试**

```tsx
// ArchivePanel.test.tsx 关键用例:
it('渲染归档行,单条恢复调 unarchive 并从列表消失', () => { /* mockApi.task.list(archived:'only') */ });
it('勾选两条 → 批量恢复按序调 unarchive', () => { /* ... */ });
it('恢复整组 select 选择组 → 逐条 unarchive 该组任务', () => { /* taskGroup.list(only) + 组内任务 */ });
// GroupManageList.test.tsx:新建组输入回车调 create;归档组按钮带 confirm;列表按 position 序
// TaskSidebarPanel.test.tsx:三区块存在(分组/归档入口/远端节点);点归档入口回调打开 ArchivePanel
```

- [ ] **Step 2: 确认失败 → Step 3: 实现**(TaskSidebarPanel 保留 RemoteTaskSection 函数体原样;归档入口显示 `task.list({archived:'only'}).length` 计数,mount 拉一次;ArchivePanel 数据 = `ipc.task.list({ workspaceId, archived: 'only', orderBy: 'created_at_desc', limit: 500 })` + 组名 map 由 `taskGroup.list(ws,{archived:'all'})` 构建)
- [ ] **Step 4: 删除退役文件并全量回归**

Run: `npx pnpm@9.0.0 typecheck && npx pnpm@9.0.0 test`
Expected: 全绿;grep 确认无 `TaskList`/`TaskFilters`/`applyTaskFilters` 残留引用(`rg "TaskList|TaskFilters|applyTaskFilters" renderer/src` 仅剩新组件 BoardColumn 内部数组等误命中人工判读)

- [ ] **Step 5: e2e 拖拽冒烟(可选)+ 提交**

```bash
# 可选:tests/e2e/ 追加 kanban-drag.spec.ts 一条(Playwright dragAndDrop 跨列)——时间紧可跳过,标注 TODO 单开任务
git add -A renderer/src/components/task-board/ && git add renderer/src/stores/ renderer/src/ipc/
git commit -m "feat: 归档面板/侧边栏分组管理/旧列表组件退役(看板重构 Task 14)"
```

---

## 执行顺序与依赖

```
Task 1(迁移+组repo) → Task 2(tasks repo) → Task 3(契约+position)
Task 3 → Task 4(lifecycle) → Task 5(move) → Task 6(IPC) → Task 7(taskGroup IPC+types) → Task 8(agent tools)
Task 7 → Task 9(board.ts) → Task 10(stores) → Task 11(静态画板) → Task 12(拖拽+抽屉) → Task 13(确认框) → Task 14(归档+侧边栏+收尾)
```

Task 8 只依赖 Task 1/7,可与 Task 4-6 并行;Task 11 依赖 9/10(依赖 @dnd-kit 安装先行)。

## 验收清单(对照 spec)

- [ ] 5 列画板 + 泳道/平铺切换,老任务(三列 NULL)开箱即用归未分组
- [ ] 三种拖拽全部生效:跨列(语义动作)/列内排序(中值)/跨泳道换组
- [ ] 待办列禁投反馈;in_progress→done/closed 确认框;move 失败回滚 toast
- [ ] 仅终态可归档;组归档确认后级联 cancel+整组入档;归档面板单条/批量/整组恢复
- [ ] agent:list_task_groups 可查、create_task 带 groupId 落组、list/read 带组名
- [ ] 全量 typecheck + 双 workspace 测试绿;调度器/findNextAssignedTask 零改动(既有测试未动即证)
