// electron/src/main/storage/task-groups/repo.ts
//
// task_groups 表 CRUD + 归档级联事务（任务看板重构 spec 2026-09-27 §2/§3.1）。
//
// 设计要点：
//   - ID 沿用 tasks 的 T-<seq> 同款 G-<seq> 序列（^G-(\d+)$ 严格匹配，零填充 ≥3 位）
//   - position 采用 1024 间隔（新建尾插 / reorder 整段重写），拖拽排序无需频繁重平衡
//   - 归档是单事务级联：组内非终态任务先 cancel，再全组任务 + 组本体置 archived_at，
//     任一步失败整体回滚；cancelledIds 返回给 IPC 层补执行中断（abort 是进程级
//     副作用，不入 DB 事务）
//   - Task 2 过渡：listTasks 的 archived 过滤参数由 Task 2 落地，本 repo 组内任务
//     清点/级联暂用直查 SQL（见 archiveGroup 内注释），Task 2 后统一换 listTasks
import { getDb } from '../db';
import { transitionTaskStatus, type TaskStatus } from '../tasks/repo';
import { isTerminal } from '../tasks/state-machine';

export interface GroupRow {
  id: string;
  workspaceId: string;
  name: string;
  /** 语义色名（'accent'/'violet'/'success'/'warning'…），NULL=默认 */
  color: string | null;
  position: number;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

type SqlRow = {
  id: string;
  workspace_id: string;
  name: string;
  color: string | null;
  position: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
};

function rowToCamel(r: SqlRow): GroupRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    color: r.color,
    position: r.position,
    archivedAt: r.archived_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * 生成下一个 `G-<seq>` 组 id。
 *
 * 与 tasks 的 nextTaskId 同款：seq = max(已有 G-<n> 的 n) + 1，至少 3 位零填充
 * （G-001 … G-999，超出自然增长）；非 G- 前缀行（legacy UUID）跳过不计。
 * better-sqlite3 同步单连接，无并发 TOCTOU 场景。
 */
function nextGroupId(db: ReturnType<typeof getDb>): string {
  const rows = db.prepare("SELECT id FROM task_groups WHERE id LIKE 'G-%'").all() as Array<{
    id: string;
  }>;
  let max = 0;
  for (const r of rows) {
    const m = /^G-(\d+)$/.exec(r.id);
    if (m && m[1]) max = Math.max(max, parseInt(m[1], 10));
  }
  const next = max + 1;
  return `G-${next < 1000 ? String(next).padStart(3, '0') : String(next)}`;
}

export function getGroup(id: string): GroupRow | null {
  const row = getDb().prepare('SELECT * FROM task_groups WHERE id = ?').get(id) as
    | SqlRow
    | undefined;
  return row ? rowToCamel(row) : null;
}

/**
 * 按 workspace 列组，position 升序 + created_at 兜底。
 *
 * archived 三态：'exclude'（默认）只回活跃组；'only' 只回归档组；'all' 全回。
 */
export function listGroups(
  workspaceId: string,
  opts?: { archived?: 'exclude' | 'only' | 'all' },
): GroupRow[] {
  const mode = opts?.archived ?? 'exclude';
  const cond =
    mode === 'all'
      ? 'WHERE workspace_id = ?'
      : mode === 'only'
        ? 'WHERE workspace_id = ? AND archived_at IS NOT NULL'
        : 'WHERE workspace_id = ? AND archived_at IS NULL';
  const rows = getDb()
    .prepare(`SELECT * FROM task_groups ${cond} ORDER BY position ASC, created_at ASC`)
    .all(workspaceId) as SqlRow[];
  return rows.map(rowToCamel);
}

export function createGroup(input: { workspaceId: string; name: string; color?: string }): GroupRow {
  const db = getDb();
  const id = nextGroupId(db);
  const now = Date.now();
  const maxPos = db
    .prepare('SELECT MAX(position) AS p FROM task_groups WHERE workspace_id = ?')
    .get(input.workspaceId) as { p: number | null };
  db.prepare(
    'INSERT INTO task_groups (id, workspace_id, name, color, position, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
  ).run(id, input.workspaceId, input.name, input.color ?? null, (maxPos.p ?? 0) + 1024, now, now);
  return getGroup(id)!;
}

export function updateGroup(id: string, patch: { name?: string; color?: string }): GroupRow {
  const current = getGroup(id);
  if (!current) throw new Error(`task_group ${id} 不存在`);
  getDb()
    .prepare('UPDATE task_groups SET name = ?, color = ?, updated_at = ? WHERE id = ?')
    .run(patch.name ?? current.name, patch.color ?? current.color, Date.now(), id);
  return getGroup(id)!;
}

/** 按入参顺序整段重写 position（(i+1)*1024），单事务。未列入的组 position 不动。 */
export function reorderGroups(orderedIds: string[]): void {
  const db = getDb();
  const stmt = db.prepare('UPDATE task_groups SET position = ?, updated_at = ? WHERE id = ?');
  const now = Date.now();
  db.transaction(() => {
    orderedIds.forEach((gid, i) => stmt.run((i + 1) * 1024, now, gid));
  })();
}

/**
 * 归档组（spec §3.1）：单事务内——组内非终态任务先 cancel（级联），全组任务置
 * archived_at，组置 archived_at。返回 cancelledIds 供 IPC 层对 in_progress 来源
 * 补执行中断（abort 是进程级副作用，不入 DB 事务）。任一步失败整体回滚。
 * 已归档组幂等：直接返回零值，不重复写。
 */
export function archiveGroup(id: string): { cancelledIds: string[]; archivedCount: number } {
  const db = getDb();
  const group = getGroup(id);
  if (!group) throw new Error(`task_group ${id} 不存在`);
  if (group.archivedAt != null) return { cancelledIds: [], archivedCount: 0 };
  const now = Date.now();
  return db.transaction((): { cancelledIds: string[]; archivedCount: number } => {
    // Task 2 过渡（任务裁决）：listTasks 的 archived 过滤参数未落地，此处直查
    // 组内任务清点级联目标；Task 2 后统一换 listTasks({ workspaceId }, { archived: 'all' }) + groupId 映射
    const rows = db.prepare('SELECT id, status FROM tasks WHERE group_id = ?').all(id) as Array<{
      id: string;
      status: string;
    }>;
    const cancelledIds: string[] = [];
    for (const r of rows) {
      if (!isTerminal(r.status as TaskStatus)) {
        transitionTaskStatus(r.id, 'cancelled');
        cancelledIds.push(r.id);
      }
    }
    const mark = db.prepare(
      'UPDATE tasks SET archived_at = ?, updated_at = ? WHERE group_id = ? AND archived_at IS NULL',
    );
    const archivedCount = mark.run(now, now, id).changes;
    db.prepare('UPDATE task_groups SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    return { cancelledIds, archivedCount };
  })();
}

/** 解档组：只复活组本体，任务保持归档（spec：任务归档独立于组归档）。 */
export function unarchiveGroup(id: string): GroupRow {
  const group = getGroup(id);
  if (!group) throw new Error(`task_group ${id} 不存在`);
  getDb()
    .prepare('UPDATE task_groups SET archived_at = NULL, updated_at = ? WHERE id = ?')
    .run(Date.now(), id);
  return getGroup(id)!;
}
