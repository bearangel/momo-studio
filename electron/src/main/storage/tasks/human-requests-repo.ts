// electron/src/main/storage/tasks/human-requests-repo.ts
//
// human_requests 表 CRUD（人工请求持久化，任务生命周期 v2，spec §5.5 / §6 HITL）。
// 设计要点：
//   - 缺省：status='pending'、timeout_policy='keep_waiting'、prompt=''（与 DB 端 DEFAULT 同值）
//   - 镜像唯一 UNIQUE(origin_node_id, remote_id)：SQLite 的 UNIQUE 只在两列**均非 NULL**
//     时去重——本地行两列皆 NULL，任意多条互不冲突；insert 不做任何绕过/去重处理，
//     同镜像行重复 insert 由 SQLite 直接抛 UNIQUE 冲突（上层捕获转幂等）
//   - tryAnswer 原子防双答：单条 UPDATE ... WHERE id=? AND status='pending'，
//     以 run().changes 判定命中；changes=0 才回落 SELECT 区分 not_found /
//     not_pending（读只发生在未命中之后，不构成 read-then-write 竞态窗口）
//   - supersedePendingByRun 只翻非验收（kind != 'acceptance'）pending；两个批量
//     翻转函数均返回受影响条数（changes），供调用方做幂等判定
//   - markExpired / markReminded 带 WHERE status='pending' 原子守卫——sweep 窗口
//     内被人工答复的行不被误翻 expired / 误写提醒（幂等 no-op）
//   - listDue 只扫 pending（已答/已过期行不该再进超期处理）
//   - 行转 camelCase（本地 rowToCamel，文件内私有）
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';

export type HumanRequestKind = 'tool_gate' | 'question' | 'manual_action' | 'acceptance';
export type HumanRequestStatus = 'pending' | 'answered' | 'expired' | 'cancelled' | 'superseded';
export type HumanTimeoutPolicy = 'deny_and_wrap' | 'keep_waiting' | 'escalate' | 'fail' | 'cancel';

export interface HumanRequestRow {
  id: string;
  taskId: string | null;
  runId: string | null;
  sessionId: string;
  delegationId: string | null;
  originNodeId: string | null;
  remoteId: string | null;
  kind: HumanRequestKind;
  status: HumanRequestStatus;
  title: string;
  prompt: string;
  payloadJson: string | null;
  optionsJson: string | null;
  assigneeNodeId: string | null;
  authorityJson: string | null;
  deadlineAt: number | null;
  timeoutPolicy: HumanTimeoutPolicy;
  lastRemindedAt: number | null;
  answerJson: string | null;
  answeredByNodeId: string | null;
  answeredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** human_requests 原始行（snake_case，SELECT * 收敛到显式形状） */
interface HumanRequestDbRow {
  id: string;
  task_id: string | null;
  run_id: string | null;
  session_id: string;
  delegation_id: string | null;
  origin_node_id: string | null;
  remote_id: string | null;
  kind: string;
  status: string;
  title: string;
  prompt: string;
  payload_json: string | null;
  options_json: string | null;
  assignee_node_id: string | null;
  authority_json: string | null;
  deadline_at: number | null;
  timeout_policy: string;
  last_reminded_at: number | null;
  answer_json: string | null;
  answered_by_node_id: string | null;
  answered_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToCamel(row: HumanRequestDbRow): HumanRequestRow {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    sessionId: row.session_id,
    delegationId: row.delegation_id,
    originNodeId: row.origin_node_id,
    remoteId: row.remote_id,
    kind: row.kind as HumanRequestKind,
    status: row.status as HumanRequestStatus,
    title: row.title,
    prompt: row.prompt,
    payloadJson: row.payload_json,
    optionsJson: row.options_json,
    assigneeNodeId: row.assignee_node_id,
    authorityJson: row.authority_json,
    deadlineAt: row.deadline_at,
    timeoutPolicy: row.timeout_policy as HumanTimeoutPolicy,
    lastRemindedAt: row.last_reminded_at,
    answerJson: row.answer_json,
    answeredByNodeId: row.answered_by_node_id,
    answeredAt: row.answered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertHumanRequest(input: {
  sessionId: string;
  kind: HumanRequestKind;
  title: string;
  taskId?: string | null;
  runId?: string | null;
  prompt?: string;
  payloadJson?: string | null;
  optionsJson?: string | null;
  deadlineAt?: number | null;
  timeoutPolicy?: HumanTimeoutPolicy;
  assigneeNodeId?: string | null;
  authorityJson?: string | null;
  delegationId?: string | null;
  originNodeId?: string | null;
  remoteId?: string | null;
}): HumanRequestRow {
  const now = Date.now();
  const row: HumanRequestRow = {
    id: randomUUID(),
    taskId: input.taskId ?? null,
    runId: input.runId ?? null,
    sessionId: input.sessionId,
    delegationId: input.delegationId ?? null,
    originNodeId: input.originNodeId ?? null,
    remoteId: input.remoteId ?? null,
    kind: input.kind,
    status: 'pending',
    title: input.title,
    prompt: input.prompt ?? '',
    payloadJson: input.payloadJson ?? null,
    optionsJson: input.optionsJson ?? null,
    assigneeNodeId: input.assigneeNodeId ?? null,
    authorityJson: input.authorityJson ?? null,
    deadlineAt: input.deadlineAt ?? null,
    timeoutPolicy: input.timeoutPolicy ?? 'keep_waiting',
    lastRemindedAt: null,
    answerJson: null,
    answeredByNodeId: null,
    answeredAt: null,
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .prepare(
      `INSERT INTO human_requests (id, task_id, run_id, session_id, delegation_id,
         origin_node_id, remote_id, kind, status, title, prompt, payload_json, options_json,
         assignee_node_id, authority_json, deadline_at, timeout_policy, last_reminded_at,
         answer_json, answered_by_node_id, answered_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.taskId,
      row.runId,
      row.sessionId,
      row.delegationId,
      row.originNodeId,
      row.remoteId,
      row.kind,
      row.status,
      row.title,
      row.prompt,
      row.payloadJson,
      row.optionsJson,
      row.assigneeNodeId,
      row.authorityJson,
      row.deadlineAt,
      row.timeoutPolicy,
      row.lastRemindedAt,
      row.answerJson,
      row.answeredByNodeId,
      row.answeredAt,
      row.createdAt,
      row.updatedAt,
    );
  return row;
}

export function getHumanRequest(id: string): HumanRequestRow | null {
  const row = getDb().prepare('SELECT * FROM human_requests WHERE id = ?').get(id) as
    | HumanRequestDbRow
    | undefined;
  return row ? rowToCamel(row) : null;
}

/** 会话内 pending 请求（按 created_at ASC——面板按请求先后展示） */
export function listPendingBySession(sessionId: string): HumanRequestRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM human_requests WHERE session_id = ? AND status = 'pending'
       ORDER BY created_at ASC`,
    )
    .all(sessionId) as HumanRequestDbRow[];
  return rows.map(rowToCamel);
}

/** 按 kind 列 pending 请求（Task 13 tool_gate 孤儿回收扫描面） */
export function listPendingByKind(kind: HumanRequestKind): HumanRequestRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM human_requests WHERE kind = ? AND status = 'pending' ORDER BY created_at ASC`,
    )
    .all(kind) as HumanRequestDbRow[];
  return rows.map(rowToCamel);
}

export function listByTask(taskId: string): HumanRequestRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM human_requests WHERE task_id = ? ORDER BY created_at ASC')
    .all(taskId) as HumanRequestDbRow[];
  return rows.map(rowToCamel);
}

/**
 * 通用列表查询（Task 16 human:list IPC 面）：sessionId / taskId 可选过滤，
 * status 缺省 'pending'（面板默认只看未决），'all' 全量。
 * 条件动态拼接（无过滤时退化为 status 单条件——与手工 SQL 等价）。
 */
export function listRequests(filter: {
  sessionId?: string;
  taskId?: string;
  status?: 'pending' | 'all';
}): HumanRequestRow[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.sessionId !== undefined) {
    where.push('session_id = ?');
    params.push(filter.sessionId);
  }
  if (filter.taskId !== undefined) {
    where.push('task_id = ?');
    params.push(filter.taskId);
  }
  if (filter.status !== 'all') where.push("status = 'pending'");
  const rows = getDb()
    .prepare(
      `SELECT * FROM human_requests${where.length > 0 ? ' WHERE ' + where.join(' AND ') : ''}
       ORDER BY created_at ASC`,
    )
    .all(...params) as HumanRequestDbRow[];
  return rows.map(rowToCamel);
}

/** run 下非验收（kind != 'acceptance'）pending 计数——run 收尾判定「还有没有人等着」 */
export function countPendingNonAcceptance(runId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM human_requests
       WHERE run_id = ? AND status = 'pending' AND kind != 'acceptance'`,
    )
    .get(runId) as { n: number };
  return row.n;
}

export function tryAnswer(
  id: string,
  answerJson: string,
  byNodeId: string,
): { ok: true } | { ok: false; reason: 'not_found' | 'not_pending' } {
  const db = getDb();
  // 原子门闩：WHERE status='pending' 即竞态防线（防双答），changes 判定命中；
  // 不先读后写——SELECT 只在 UPDATE 未命中后区分 not_found / not_pending
  const now = Date.now();
  const res = db
    .prepare(
      `UPDATE human_requests SET status = 'answered', answer_json = ?, answered_by_node_id = ?,
         answered_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(answerJson, byNodeId, now, now, id);
  if (res.changes > 0) return { ok: true };
  const exists = db.prepare('SELECT 1 FROM human_requests WHERE id = ?').get(id);
  return exists ? { ok: false, reason: 'not_pending' } : { ok: false, reason: 'not_found' };
}

export function markExpired(id: string): number {
  // pending 原子守卫：sweep 窗口内被答复/顶替的行不得误翻 expired（幂等 no-op）；
  // 返回受影响条数（changes），供 sweeper 判定是否继续任务侧 fail/cancel 动作
  return getDb()
    .prepare(
      `UPDATE human_requests SET status = 'expired', updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(Date.now(), id).changes;
}

/** 提醒落账（keep_waiting/escalate 超时提醒判重依据）；pending 守卫同 markExpired */
export function markReminded(id: string, now: number): void {
  getDb()
    .prepare(
      `UPDATE human_requests SET last_reminded_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(now, now, id);
}

/** run 收尾：非验收 pending → superseded（新 run 接管）；acceptance 不动。返回条数 */
export function supersedePendingByRun(runId: string): number {
  return getDb()
    .prepare(
      `UPDATE human_requests SET status = 'superseded', updated_at = ?
       WHERE run_id = ? AND status = 'pending' AND kind != 'acceptance'`,
    )
    .run(Date.now(), runId).changes;
}

/** 任务取消：该任务全部 pending → cancelled。返回条数 */
export function cancelPendingByTask(taskId: string): number {
  return getDb()
    .prepare(
      `UPDATE human_requests SET status = 'cancelled', updated_at = ?
       WHERE task_id = ? AND status = 'pending'`,
    )
    .run(Date.now(), taskId).changes;
}

/** 超期扫描：deadline_at <= now 的 pending 行（keep_waiting 提醒判定同源）；
 *  未设 deadline 或已答/已终态的行不命中 */
export function listDue(now: number): HumanRequestRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM human_requests
       WHERE status = 'pending' AND deadline_at IS NOT NULL AND deadline_at <= ?
       ORDER BY deadline_at ASC`,
    )
    .all(now) as HumanRequestDbRow[];
  return rows.map(rowToCamel);
}
