// electron/src/main/storage/messages/events-repo.ts
//
// message_events 表 CRUD（事件溯源表）。
// 关键：payload 在 SQLite 是 TEXT（JSON 字符串），代码层是 Record<string, unknown>。
// insertEventBatch 用单事务批量插入（性能优化——比逐条快 ~50 倍）。
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';

export interface MessageEventRow {
  id: string;
  messageId: string;
  seq: number;
  eventType:
    | 'thinking_delta'
    | 'text_delta'
    | 'tool_call_start'
    | 'tool_call_result'
    | 'todo_update'
    | 'dispatch_start'
    | 'dispatch_result'
    | 'segment_boundary'
    | 'status_change'
    | 'final';
  payload: Record<string, unknown>;
  createdAt: number;
}

type SqlRow = {
  id: string;
  message_id: string;
  seq: number;
  event_type: string;
  payload_json: string;
  created_at: number;
};

function rowToCamel(r: SqlRow): MessageEventRow {
  return {
    id: r.id,
    messageId: r.message_id,
    seq: r.seq,
    eventType: r.event_type as MessageEventRow['eventType'],
    payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    createdAt: r.created_at,
  };
}

export function insertEvent(
  input: Omit<MessageEventRow, 'id' | 'createdAt'> & Partial<Pick<MessageEventRow, 'id'>>,
): MessageEventRow {
  const db = getDb();
  const id = input.id ?? randomUUID();
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO message_events (id, message_id, seq, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.messageId, input.seq, input.eventType, JSON.stringify(input.payload), createdAt);
  return {
    id,
    messageId: input.messageId,
    seq: input.seq,
    eventType: input.eventType,
    payload: input.payload,
    createdAt,
  };
}

export function insertEventBatch(rows: Array<Omit<MessageEventRow, 'id' | 'createdAt'>>): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO message_events (id, message_id, seq, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMany = db.transaction((rs: typeof rows) => {
    const now = Date.now();
    for (const r of rs) {
      stmt.run(randomUUID(), r.messageId, r.seq, r.eventType, JSON.stringify(r.payload), now);
    }
  });
  insertMany(rows);
}

export function listEventsByMessage(messageId: string): MessageEventRow[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM message_events WHERE message_id = ? ORDER BY seq ASC').all(messageId) as SqlRow[];
  return rows.map(rowToCamel);
}

export function nextSeqForMessage(messageId: string): number {
  const db = getDb();
  const row = db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM message_events WHERE message_id = ?').get(messageId) as { next: number } | undefined;
  return row?.next ?? 0;
}