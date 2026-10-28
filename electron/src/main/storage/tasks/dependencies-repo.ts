// electron/src/main/storage/tasks/dependencies-repo.ts
//
// M3.3 task_dependencies 边表 + parent_task_id 的 SQL 访问层（spec 2026-10-29 §2.1）。
//
// 职责边界：
//   - 边表 CRUD（插边 / 全量替换 / 全图读取）
//   - 父任务边全图读取（环检测图的另一半输入）
//   - blocked 派生：给定任务 id 集合，聚合「未完成直接依赖」列表——
//     「未完成」的判定单源在 task/dependency-graph.ts unsatisfiedDeps（与
//     executor peekNextAssigned 的 SQL NOT EXISTS 口径一致：仅 completed 解锁）
//   - 环检测与写编排不在此层（task/relations.ts 单点）
import { getDb } from '../db';
import {
  unsatisfiedDeps,
  type GraphEdge,
} from '../../task/dependency-graph';

/** 全图依赖边（task → depends_on），环检测输入 */
export function listDependencyEdges(): GraphEdge[] {
  const rows = getDb()
    .prepare('SELECT task_id, depends_on_task_id FROM task_dependencies')
    .all() as Array<{ task_id: string; depends_on_task_id: string }>;
  return rows.map((r) => ({ from: r.task_id, to: r.depends_on_task_id }));
}

/** 全图父任务边（child → parent），与依赖边并入同一张环检测图（跨 parent 链环） */
export function listParentEdges(): GraphEdge[] {
  const rows = getDb()
    .prepare('SELECT id, parent_task_id FROM tasks WHERE parent_task_id IS NOT NULL')
    .all() as Array<{ id: string; parent_task_id: string }>;
  return rows.map((r) => ({ from: r.id, to: r.parent_task_id }));
}

/**
 * 插入依赖边（创建路径——新任务落行后同事务调用）。
 *
 * 调用方须已完成存在性 + 环检测（task/relations.ts）；自环由表 CHECK 兜底抛错。
 * 重复边（PK 冲突）按幂等忽略——dedupe 语义与 replaceTaskDependencies 一致。
 */
export function insertDependencyEdges(
  taskId: string,
  dependsOn: ReadonlyArray<string>,
  now: number,
): void {
  if (dependsOn.length === 0) return;
  const stmt = getDb().prepare(
    `INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, created_at)
     VALUES (?, ?, ?)`,
  );
  for (const dep of new Set(dependsOn)) {
    stmt.run(taskId, dep, now);
  }
}

/**
 * 全量替换任务的依赖边（setRelations 语义：dependsOn 数组即最终态）。
 *
 * 自带事务（DELETE + 批量 INSERT 原子）；嵌套在外层事务时 better-sqlite3
 * 自动降级为 savepoint，语义不变。
 */
export function replaceTaskDependencies(
  taskId: string,
  dependsOn: ReadonlyArray<string>,
): void {
  const db = getDb();
  const run = db.transaction(() => {
    db.prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(taskId);
    insertDependencyEdges(taskId, dependsOn, Date.now());
  });
  run();
}

/**
 * 批量派生 blockedBy（listTasks / getTask 读路径聚合）。
 *
 * 一次 JOIN 查询覆盖整批任务（边表 task_id 索引命中），未完成判定委托
 * unsatisfiedDeps 单源——返回 Map 只含「存在未完成依赖」的任务
 * （缺失 = 无依赖或全部完成，blocked = false）。
 */
export function deriveBlockedBy(taskIds: ReadonlyArray<string>): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (taskIds.length === 0) return result;
  const db = getDb();
  const edgeStmt = db.prepare(
    `SELECT d.task_id AS taskId, d.depends_on_task_id AS depId, t.status AS status
     FROM task_dependencies d
     JOIN tasks t ON t.id = d.depends_on_task_id
     WHERE d.task_id = ?`,
  );
  // 目标 id 集合去重后逐个查边（≤500 行本地库，索引点查开销可忽略；
  // 避免 IN (?,...) 分块拼接两条语句的复杂度）
  for (const id of new Set(taskIds)) {
    const rows = edgeStmt.all(id) as Array<{
      taskId: string;
      depId: string;
      status: string;
    }>;
    if (rows.length === 0) continue;
    const statusOf = (depId: string): string | undefined =>
      rows.find((r) => r.depId === depId)?.status;
    const unsatisfied = unsatisfiedDeps(
      id,
      rows.map((r) => ({ from: r.taskId, to: r.depId })),
      statusOf,
    );
    if (unsatisfied.length > 0) result.set(id, unsatisfied);
  }
  return result;
}
