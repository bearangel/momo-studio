// electron/src/main/storage/tasks/runs-repo.ts
//
// task_runs 表 CRUD（执行尝试读写单点，任务生命周期 v2，spec §5.2）。
// 设计要点：
//   - run_no 默认 = nextRunNo(taskId)（同任务内 1 起递增，UNIQUE(task_id, run_no) 兜底）
//   - 单活动 run 由部分唯一索引 idx_task_runs_active 保证（running/waiting_human/
//     submitted 占槽）——第二个活动 run insert 直接抛 SqliteError；本 repo 不吞，
//     服务层（Task 9）捕获转幂等
//   - updateRun 状态变更前置 canTransitionRun 校验（非法抛 Error 含 from/to）；
//     终态的 to 集合为空 → 任何转出天然被拒
//   - 行转 camelCase（本地 rowToCamel，文件内私有）
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import {
  canTransitionRun,
  ACTIVE_TASK_RUN_STATUSES,
  type TaskRunStatus,
} from './state-machine';

export type { TaskRunStatus } from './state-machine';

/** run 触发方式：initial 首跑 / rework 打回重跑 / quota_retry 配额重试 / manual 手动 */
export type TaskRunTrigger = 'initial' | 'rework' | 'quota_retry' | 'manual';

export interface TaskRunRow {
  id: string;
  taskId: string;
  runNo: number;
  status: TaskRunStatus;
  executionSessionId: string | null;
  trigger: TaskRunTrigger;
  startedAt: number;
  endedAt: number | null;
  deliverableJson: string | null;
  rejectReason: string | null;
  createdAt: number;
  updatedAt: number;
}

/** task_runs 原始行（snake_case，SELECT * 收敛到显式形状） */
interface TaskRunDbRow {
  id: string;
  task_id: string;
  run_no: number;
  status: string;
  execution_session_id: string | null;
  trigger: string;
  started_at: number;
  ended_at: number | null;
  deliverable_json: string | null;
  reject_reason: string | null;
  created_at: number;
  updated_at: number;
}

function rowToCamel(row: TaskRunDbRow): TaskRunRow {
  return {
    id: row.id,
    taskId: row.task_id,
    runNo: row.run_no,
    status: row.status as TaskRunStatus,
    executionSessionId: row.execution_session_id,
    trigger: row.trigger as TaskRunTrigger,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    deliverableJson: row.deliverable_json,
    rejectReason: row.reject_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 同任务下一个 run 序号（1 起）——MAX(run_no)+1，无行则 1 */
export function nextRunNo(taskId: string): number {
  const row = getDb()
    .prepare('SELECT MAX(run_no) AS maxNo FROM task_runs WHERE task_id = ?')
    .get(taskId) as { maxNo: number | null };
  return (row.maxNo ?? 0) + 1;
}

export function insertRun(input: {
  taskId: string;
  status: TaskRunStatus;
  trigger: TaskRunTrigger;
  executionSessionId?: string | null;
  runNo?: number;
}): TaskRunRow {
  const now = Date.now();
  const row: TaskRunRow = {
    id: randomUUID(),
    taskId: input.taskId,
    runNo: input.runNo ?? nextRunNo(input.taskId),
    status: input.status,
    executionSessionId: input.executionSessionId ?? null,
    trigger: input.trigger,
    startedAt: now,
    endedAt: null,
    deliverableJson: null,
    rejectReason: null,
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .prepare(
      `INSERT INTO task_runs (id, task_id, run_no, status, execution_session_id, trigger,
         started_at, ended_at, deliverable_json, reject_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.taskId,
      row.runNo,
      row.status,
      row.executionSessionId,
      row.trigger,
      row.startedAt,
      row.endedAt,
      row.deliverableJson,
      row.rejectReason,
      row.createdAt,
      row.updatedAt,
    );
  return row;
}

export function getRun(id: string): TaskRunRow | null {
  const row = getDb().prepare('SELECT * FROM task_runs WHERE id = ?').get(id) as
    | TaskRunDbRow
    | undefined;
  return row ? rowToCamel(row) : null;
}

/** 活动态 run（running/waiting_human/submitted，与 idx_task_runs_active 同值域），
 *  run_no DESC 取最新；无则 null */
export function getActiveRun(taskId: string): TaskRunRow | null {
  const placeholders = ACTIVE_TASK_RUN_STATUSES.map(() => '?').join(', ');
  const row = getDb()
    .prepare(
      `SELECT * FROM task_runs WHERE task_id = ? AND status IN (${placeholders})
       ORDER BY run_no DESC LIMIT 1`,
    )
    .get(taskId, ...ACTIVE_TASK_RUN_STATUSES) as TaskRunDbRow | undefined;
  return row ? rowToCamel(row) : null;
}

export function updateRun(
  id: string,
  patch: Partial<
    Pick<TaskRunRow, 'status' | 'endedAt' | 'deliverableJson' | 'rejectReason' | 'executionSessionId'>
  >,
): void {
  const current = getRun(id);
  if (!current) {
    throw new Error(`task_runs 行不存在: ${id}`);
  }
  // 状态变更前置状态机校验：非法抛错含 from/to；
  // 同值 patch（幂等重放）不算转换，不校验
  if (patch.status !== undefined && patch.status !== current.status) {
    if (!canTransitionRun(current.status, patch.status)) {
      throw new Error(`非法 run 状态转换: ${current.status} → ${patch.status}`);
    }
  }
  // !== undefined 合并（非 ??）：显式传 null 才能清空字段
  const next = {
    status: patch.status !== undefined ? patch.status : current.status,
    endedAt: patch.endedAt !== undefined ? patch.endedAt : current.endedAt,
    deliverableJson: patch.deliverableJson !== undefined ? patch.deliverableJson : current.deliverableJson,
    rejectReason: patch.rejectReason !== undefined ? patch.rejectReason : current.rejectReason,
    executionSessionId:
      patch.executionSessionId !== undefined ? patch.executionSessionId : current.executionSessionId,
    updatedAt: Date.now(),
  };
  getDb()
    .prepare(
      `UPDATE task_runs SET status = ?, ended_at = ?, deliverable_json = ?, reject_reason = ?,
         execution_session_id = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      next.status,
      next.endedAt,
      next.deliverableJson,
      next.rejectReason,
      next.executionSessionId,
      next.updatedAt,
      id,
    );
}

export function listRuns(taskId: string): TaskRunRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY run_no ASC')
    .all(taskId) as TaskRunDbRow[];
  return rows.map(rowToCamel);
}

export function countRuns(taskId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM task_runs WHERE task_id = ?')
    .get(taskId) as { n: number };
  return row.n;
}
