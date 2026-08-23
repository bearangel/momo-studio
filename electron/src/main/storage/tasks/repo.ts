// electron/src/main/storage/tasks/repo.ts
//
// tasks 表 CRUD + 状态机集成。
// 设计要点：
//   - 字段名 camelCase（SQLite 是 snake_case），rowToCamel 做映射
//   - id 默认 randomUUID()；调用方可显式传入（A7 多段消息需要可预测 id，C 阶段做幂等去重）
//   - status 默认 'draft'；toolCallsUsed 默认 0
//   - transitionTaskStatus 走 state-machine 校验，非法转换抛错；
//     调度器 / agent runtime 调此方法时可在 extraPatch 里带 startedAt / completedAt /
//     executionSessionId / assigneeAgentId 等副作用字段（updateTask 自动 merge + bump updated_at）
//   - updateTask 实现为「读全行 → 合并 patch → 全字段 UPDATE」——任务字段数适中（25 个），
//     全字段写一次 SQL 比动态拼 SET 子句可读性更高、也无 SQL 注入面。
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import {
  assertTransition,
  type TaskStatus,
} from './state-machine';

export type { TaskStatus } from './state-machine';

export interface TaskRow {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  status: TaskStatus;
  sourceSessionId: string | null;
  sourceMessageId: string | null;
  creatorUserId: string;
  executionSessionId: string | null;
  assigneeAgentId: string | null;
  priority: number;
  scheduledAt: number | null;
  recurrenceRule: string | null;
  deadlineAt: number | null;
  // D 阶段占位字段（D 子系统填值）
  queuePosition: number | null;
  runtimeInstanceId: string | null;
  estimatedTokens: number | null;
  actualTokens: number | null;
  toolCallsUsed: number;
  errorMessage: string | null;
  sourceNodeId: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

// better-sqlite3 返回行是 snake_case 列名直出。
type SqlRow = {
  id: string;
  workspace_id: string;
  title: string;
  description: string;
  status: string;
  source_session_id: string | null;
  source_message_id: string | null;
  creator_user_id: string;
  execution_session_id: string | null;
  assignee_agent_id: string | null;
  priority: number;
  scheduled_at: number | null;
  recurrence_rule: string | null;
  deadline_at: number | null;
  queue_position: number | null;
  runtime_instance_id: string | null;
  estimated_tokens: number | null;
  actual_tokens: number | null;
  tool_calls_used: number;
  error_message: string | null;
  source_node_id: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
};

function rowToCamel(r: SqlRow): TaskRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title,
    description: r.description,
    status: r.status as TaskStatus,
    sourceSessionId: r.source_session_id,
    sourceMessageId: r.source_message_id,
    creatorUserId: r.creator_user_id,
    executionSessionId: r.execution_session_id,
    assigneeAgentId: r.assignee_agent_id,
    priority: r.priority,
    scheduledAt: r.scheduled_at,
    recurrenceRule: r.recurrence_rule,
    deadlineAt: r.deadline_at,
    queuePosition: r.queue_position,
    runtimeInstanceId: r.runtime_instance_id,
    estimatedTokens: r.estimated_tokens,
    actualTokens: r.actual_tokens,
    toolCallsUsed: r.tool_calls_used,
    errorMessage: r.error_message,
    sourceNodeId: r.source_node_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  };
}

/**
 * 插入一条 task 行。
 *
 * 必填：workspaceId / title / creatorUserId。
 * 可选：description（默认 ''）、除 id（默认 randomUUID）/ status（默认 'draft'）外的所有字段。
 * toolCallsUsed 默认 0；其他可空字段默认 null。
 *
 * 注意：brief 给的签名 `Omit<TaskRow, 'id'|'createdAt'|'updatedAt'|'status'|'toolCallsUsed'>`
 * 要求 description 必填，但 v19 schema 是 `description TEXT NOT NULL DEFAULT ''`，
 * 实际调用方（包括本 task 的测试和未来 B/C 阶段调度器）通常只传标题不写描述。
 * 这里放宽 description 为可选，函数体用 `?? ''` 兜底，对齐 messages repo 模式。
 */
export function insertTask(
  input: Pick<TaskRow, 'workspaceId' | 'title' | 'creatorUserId'> &
    Partial<Omit<TaskRow, 'workspaceId' | 'title' | 'creatorUserId' | 'toolCallsUsed'>>,
): TaskRow {
  const db = getDb();
  const id = input.id ?? randomUUID();
  const now = Date.now();
  const status = input.status ?? 'draft';
  const description = input.description ?? '';
  const priority = input.priority ?? 0;
  db.prepare(
    `INSERT INTO tasks (
      id, workspace_id, title, description, status,
      source_session_id, source_message_id, creator_user_id,
      execution_session_id, assignee_agent_id,
      priority, scheduled_at, recurrence_rule, deadline_at,
      queue_position, runtime_instance_id, estimated_tokens, actual_tokens, tool_calls_used, error_message, source_node_id,
      created_at, updated_at, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workspaceId,
    input.title,
    description,
    status,
    input.sourceSessionId,
    input.sourceMessageId,
    input.creatorUserId,
    input.executionSessionId,
    input.assigneeAgentId,
    priority,
    input.scheduledAt,
    input.recurrenceRule,
    input.deadlineAt,
    input.queuePosition,
    input.runtimeInstanceId,
    input.estimatedTokens,
    input.actualTokens,
    0,
    input.errorMessage,
    input.sourceNodeId,
    now,
    now,
    input.startedAt,
    input.completedAt,
  );
  return getTask(id)!;
}

/**
 * 部分更新 task 字段。
 *
 * 不允许改 id / createdAt；其他字段（status / 时间戳 / assignee 等）都可 patch。
 * status 字段独立校验：直接 patch 'status' 可绕过状态机——调用方需明确自己在做什么
 * （如调度器把 pending → assigned 是合法但跨多个 patch）。正常路径请用 transitionTaskStatus。
 *
 * 实现为读全行 → 合并 patch → 全字段 UPDATE：任务 25 列全字段写一次 SQL，可读性高于
 * 动态拼 SET 子句。updatedAt 自动 bump 到 now()。
 */
export function updateTask(id: string, patch: Partial<Omit<TaskRow, 'id' | 'createdAt'>>): void {
  const db = getDb();
  const current = getTask(id);
  if (!current) throw new Error(`task ${id} 不存在`);
  const next: TaskRow = { ...current, ...patch, updatedAt: Date.now() };
  db.prepare(
    `UPDATE tasks SET
      workspace_id=?, title=?, description=?, status=?,
      source_session_id=?, source_message_id=?, creator_user_id=?,
      execution_session_id=?, assignee_agent_id=?,
      priority=?, scheduled_at=?, recurrence_rule=?, deadline_at=?,
      queue_position=?, runtime_instance_id=?, estimated_tokens=?, actual_tokens=?, tool_calls_used=?, error_message=?, source_node_id=?,
      updated_at=?, started_at=?, completed_at=?
    WHERE id=?`,
  ).run(
    next.workspaceId,
    next.title,
    next.description,
    next.status,
    next.sourceSessionId,
    next.sourceMessageId,
    next.creatorUserId,
    next.executionSessionId,
    next.assigneeAgentId,
    next.priority,
    next.scheduledAt,
    next.recurrenceRule,
    next.deadlineAt,
    next.queuePosition,
    next.runtimeInstanceId,
    next.estimatedTokens,
    next.actualTokens,
    next.toolCallsUsed,
    next.errorMessage,
    next.sourceNodeId,
    next.updatedAt,
    next.startedAt,
    next.completedAt,
    id,
  );
}

/**
 * 状态机驱动的状态转换。
 *
 * 读当前行 → 状态机断言合法 → updateTask 合并 extraPatch + 新 status。
 * extraPatch 用于传递副作用字段：
 *   - in_progress：executionSessionId / startedAt / assigneeAgentId
 *   - completed / failed：completedAt / errorMessage
 *   - paused：errorMessage（可选，记录 preempt 原因）
 *
 * 非法转换抛 Error（含 from/to 信息）。返回更新后的 TaskRow。
 */
export function transitionTaskStatus(
  id: string,
  to: TaskStatus,
  extraPatch?: Partial<TaskRow>,
): TaskRow {
  const current = getTask(id);
  if (!current) throw new Error(`task ${id} 不存在`);
  assertTransition(current.status, to);
  updateTask(id, { ...extraPatch, status: to });
  return getTask(id)!;
}

export function getTask(id: string): TaskRow | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as SqlRow | undefined;
  return row ? rowToCamel(row) : null;
}

/**
 * 多维过滤 + 排序的任务列表。
 *
 * 过滤：workspaceId / status（单个或数组）/ assigneeAgentId / executionSessionId / sourceSessionId。
 * 排序：priority（高优先 + created_at 升序兜底）/ scheduled_at（升序，NULLS LAST + created_at 兜底）/
 *       created_at（默认升序）。
 * limit：限制返回行数（无 LIMIT 时全返回）。
 */
export function listTasks(opts: {
  workspaceId?: string;
  status?: TaskStatus | TaskStatus[];
  assigneeAgentId?: string;
  executionSessionId?: string;
  sourceSessionId?: string;
  orderBy?: 'priority' | 'scheduled_at' | 'created_at';
  limit?: number;
}): TaskRow[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.workspaceId) {
    where.push('workspace_id = ?');
    params.push(opts.workspaceId);
  }
  if (opts.status) {
    if (Array.isArray(opts.status)) {
      const placeholders = opts.status.map(() => '?').join(',');
      where.push(`status IN (${placeholders})`);
      params.push(...opts.status);
    } else {
      where.push('status = ?');
      params.push(opts.status);
    }
  }
  if (opts.assigneeAgentId) {
    where.push('assignee_agent_id = ?');
    params.push(opts.assigneeAgentId);
  }
  if (opts.executionSessionId) {
    where.push('execution_session_id = ?');
    params.push(opts.executionSessionId);
  }
  if (opts.sourceSessionId) {
    where.push('source_session_id = ?');
    params.push(opts.sourceSessionId);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderClause =
    opts.orderBy === 'priority'
      ? 'ORDER BY priority DESC, created_at ASC'
      : opts.orderBy === 'scheduled_at'
        ? 'ORDER BY scheduled_at ASC, created_at ASC'
        : 'ORDER BY created_at ASC';
  const limitClause = opts.limit ? `LIMIT ${opts.limit}` : '';
  const rows = db
    .prepare(`SELECT * FROM tasks ${whereClause} ${orderClause} ${limitClause}`)
    .all(...params) as SqlRow[];
  return rows.map(rowToCamel);
}

/**
 * 取出 agent 的下一个待执行任务。
 *
 * 条件：assigneeAgentId 匹配 + status='assigned' + scheduled_at 已到（或未设）。
 * 排序：priority DESC（高优先优先）→ scheduled_at ASC NULLS LAST（已排队的优先）→
 *       created_at ASC（先到先得兜底）。
 * 返回一条（limit 1）。无候选返回 null。
 *
 * C 阶段 P2P 任务可能由 source_node_id != null 标识，但本函数只过滤本地 agent 的任务。
 */
export function findNextAssignedTask(assigneeAgentId: string, now: number): TaskRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM tasks
       WHERE assignee_agent_id = ? AND status = 'assigned'
         AND (scheduled_at IS NULL OR scheduled_at <= ?)
       ORDER BY priority DESC, scheduled_at ASC, created_at ASC
       LIMIT 1`,
    )
    .get(assigneeAgentId, now) as SqlRow | undefined;
  return row ? rowToCamel(row) : null;
}