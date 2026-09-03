// electron/src/main/storage/messages/repo.ts
//
// messages 表 CRUD。所有 IM 消息（user / agent / dispatch / task_reply）统一进此表。
// v23 列语义迁移：room_id → session_id；matrix_event_id 列已删除（去 Matrix 化）。
// 设计要点：
//   - 字段名 camelCase（SQLite 是 snake_case），用 rowToCamel 做映射
//   - id 默认 randomUUID()；调用方可显式传入（A7 多段消息需要可预测 id）
//   - status 默认 'done'（user 消息、最终态消息）；agent 流式消息插入时显式传 'streaming'
//   - source 默认 'local'；跨节点同步（C 阶段）传 'lan' / 'hub'
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';

export interface MessageRow {
  id: string;
  sessionId: string;
  sender: string;
  eventType: string;
  body: string;
  streamSessionId: string | null;
  parentStreamSessionId: string | null;
  segmentOf: string | null;
  segmentIndex: number | null;
  status: 'streaming' | 'done' | 'failed' | 'aborted';
  source: 'local' | 'lan' | 'hub' | 'matrix';
  workspaceId: string | null;
  taskId: string | null;
  createdAt: number;
  updatedAt: number;
}

type SqlRow = {
  id: string;
  session_id: string;
  sender: string;
  event_type: string;
  body: string;
  stream_session_id: string | null;
  parent_stream_session_id: string | null;
  segment_of: string | null;
  segment_index: number | null;
  status: string;
  source: string;
  workspace_id: string | null;
  task_id: string | null;
  created_at: number;
  updated_at: number;
};

function rowToCamel(r: SqlRow): MessageRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    sender: r.sender,
    eventType: r.event_type,
    body: r.body,
    streamSessionId: r.stream_session_id,
    parentStreamSessionId: r.parent_stream_session_id,
    segmentOf: r.segment_of,
    segmentIndex: r.segment_index,
    status: r.status as MessageRow['status'],
    source: r.source as MessageRow['source'],
    workspaceId: r.workspace_id,
    taskId: r.task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * 插入一条 message 行。
 *
 * 必填：sessionId / sender / eventType / body。其余字段（含可空的 streamSessionId 等）
 * 全部可选——实现层用 `?? null` 兜底。这样调用方只需传关心的字段（如 A7 的
 * routeChunkToBuffer 只传 sessionId/sender/eventType/body/streamSessionId/status）。
 */
export function insertMessage(
  input: Pick<MessageRow, 'sessionId' | 'sender' | 'eventType' | 'body'> &
    Partial<Omit<MessageRow, 'sessionId' | 'sender' | 'eventType' | 'body'>>,
): MessageRow {
  const db = getDb();
  const now = Date.now();
  const id = input.id ?? randomUUID();
  const status = input.status ?? 'done';
  const source = input.source ?? 'local';
  db.prepare(
    `INSERT INTO messages (
      id, session_id, sender, event_type, body,
      stream_session_id, parent_stream_session_id, segment_of, segment_index,
      status, source, workspace_id, task_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.sessionId,
    input.sender,
    input.eventType,
    input.body,
    input.streamSessionId ?? null,
    input.parentStreamSessionId ?? null,
    input.segmentOf ?? null,
    input.segmentIndex ?? null,
    status,
    source,
    input.workspaceId ?? null,
    input.taskId ?? null,
    now,
    now,
  );
  return getMessage(id)!;
}

export function updateMessageStatus(id: string, status: MessageRow['status'], body?: string): void {
  const db = getDb();
  const now = Date.now();
  if (body !== undefined) {
    db.prepare('UPDATE messages SET status = ?, body = ?, updated_at = ? WHERE id = ?').run(status, body, now, id);
  } else {
    db.prepare('UPDATE messages SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
  }
}

export function getMessage(id: string): MessageRow | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as SqlRow | undefined;
  return row ? rowToCamel(row) : null;
}

export function getMessageByStreamSessionId(streamSessionId: string): MessageRow | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM messages WHERE stream_session_id = ?').get(streamSessionId) as SqlRow | undefined;
  return row ? rowToCamel(row) : null;
}

export function listMessagesBySession(sessionId: string, opts?: { limit?: number; beforeTs?: number }): MessageRow[] {
  const db = getDb();
  const limit = opts?.limit ?? 1000;
  const beforeTs = opts?.beforeTs;
  const rows = beforeTs !== undefined
    ? db.prepare('SELECT * FROM messages WHERE session_id = ? AND created_at < ? ORDER BY created_at ASC LIMIT ?').all(sessionId, beforeTs, limit) as SqlRow[]
    : db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?').all(sessionId, limit) as SqlRow[];
  return rows.map(rowToCamel);
}

export function listOlderMessages(sessionId: string, beforeTs: number, limit: number): MessageRow[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM messages WHERE session_id = ? AND created_at < ? ORDER BY created_at ASC LIMIT ?').all(sessionId, beforeTs, limit) as SqlRow[];
  return rows.map(rowToCamel);
}

/** 统计会话内用户（owner）消息数——v2.2 记忆提取轮次触发用（agent 回复不计轮次） */
export function countOwnerMessages(sessionId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND sender = 'owner'`)
    .get(sessionId) as { n: number };
  return row.n;
}
