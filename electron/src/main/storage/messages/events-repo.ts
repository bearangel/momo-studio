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

export function insertEventBatch(
  rows: Array<Omit<MessageEventRow, 'id' | 'createdAt'> & Partial<Pick<MessageEventRow, 'id'>>>,
): MessageEventRow[] {
  if (rows.length === 0) return [];
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO message_events (id, message_id, seq, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const inserted: MessageEventRow[] = [];
  const insertMany = db.transaction((rs: typeof rows) => {
    const now = Date.now();
    for (const r of rs) {
      const id = r.id ?? randomUUID();
      stmt.run(id, r.messageId, r.seq, r.eventType, JSON.stringify(r.payload), now);
      inserted.push({
        id,
        messageId: r.messageId,
        seq: r.seq,
        eventType: r.eventType,
        payload: r.payload,
        createdAt: now,
      });
    }
  });
  insertMany(rows);
  return inserted;
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

/**
 * 聚合指定消息的全部 text_delta 为最终正文（按 seq 顺序拼接）。
 *
 * 用途（2026-09-06 复制/导出契约修复）：stream-relay 在流终态（end / 崩溃收尾）
 * 调用本函数把正文回写 messages.body——messages.body 从此是 agent 回复正文的
 * 单一真相源，复制按钮与会话导出不再各自踩空。thinking 等其他事件类型不参与。
 *
 * payload 损坏防御：payload_json 由本模块 JSON.stringify 写入，正常恒合法；
 * 极端损坏行按空增量跳过（不中断整条消息的回填）。
 */
export function aggregateTextDeltas(messageId: string): string {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT payload_json FROM message_events
       WHERE message_id = ? AND event_type = 'text_delta'
       ORDER BY seq ASC`,
    )
    .all(messageId) as Array<{ payload_json: string }>;
  let out = '';
  for (const r of rows) {
    try {
      const payload = JSON.parse(r.payload_json) as { delta?: unknown };
      if (typeof payload.delta === 'string') out += payload.delta;
    } catch {
      // 损坏行跳过：见函数头注释
    }
  }
  return out;
}