// electron/tests/storage/migration-v28.test.ts
// 迁移 v28 测试：回填 agent 消息最终正文（复制/导出契约修复）。
//
// 根因：stream-relay 生命周期里 agent 消息 body 恒 ''（start 插空、text 只进
// message_events、end 不回写）。显示侧靠 events 聚合正常，复制/导出读
// messages.body 双双踩空。v28 把历史行的最终正文从 text_delta 序列聚合回填；
// 此后新流由 stream-relay 终态直接回写（见 stream-relay.test.ts 契约）。
//
// 模式参照 migration-v26.test.ts：内存库升到 v27 → 注入 fixture → 应用 v28。
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations } from '../../src/main/storage/migrations';

const V27 = 27;

function applyUpTo(db: DB, version: number): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
  const markApplied = db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)');
  for (const m of loadMigrations()) {
    if (m.version > version) break;
    db.exec(m.sql);
    markApplied.run(m.version);
  }
}

function applyRemaining(db: DB, afterVersion: number): void {
  const markApplied = db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)');
  for (const m of loadMigrations()) {
    if (m.version <= afterVersion) continue;
    db.exec(m.sql);
    markApplied.run(m.version);
  }
}

interface FixtureMsg {
  id: string;
  body: string;
  streamSessionId: string | null;
  status: string;
}

/** 注入一条 messages 行（created_at 由 id 尾号区分时序） */
function insertMsg(db: DB, m: FixtureMsg): void {
  db.prepare(
    `INSERT INTO messages (id, session_id, sender, event_type, body,
       stream_session_id, parent_stream_session_id, segment_of, segment_index,
       status, source, workspace_id, task_id, created_at, updated_at)
     VALUES (?, 'sess-mig', '@bot.x:home', 'm.room.message', ?,
       ?, NULL, NULL, NULL, ?, 'local', NULL, NULL, ?, ?)`,
  ).run(m.id, m.body, m.streamSessionId, m.status, 1000, 1000);
}

/** 注入一条 message_events 行（seq 显式指定以保证拼接顺序可断言） */
function insertEvent(db: DB, messageId: string, seq: number, payloadJson: string): void {
  db.prepare(
    `INSERT INTO message_events (id, message_id, seq, event_type, payload_json, created_at)
     VALUES (?, ?, ?, 'text_delta', ?, 1000)`,
  ).run(`ev-${messageId}-${seq}`, messageId, seq, payloadJson);
}

function bodyOf(db: DB, id: string): string {
  const row = db.prepare('SELECT body FROM messages WHERE id = ?').get(id) as { body: string };
  return row.body;
}

describe('migration v28：agent 消息 body 回填', () => {
  it('body 为空且存在 text_delta 的行：按 seq 顺序聚合回填', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, V27);

    insertMsg(db, { id: 'm-agent-1', body: '', streamSessionId: 'ss-1', status: 'done' });
    insertEvent(db, 'm-agent-1', 0, JSON.stringify({ delta: '你好' }));
    insertEvent(db, 'm-agent-1', 1, JSON.stringify({ delta: '，' }));
    insertEvent(db, 'm-agent-1', 2, JSON.stringify({ delta: '世界' }));

    applyRemaining(db, V27);
    expect(bodyOf(db, 'm-agent-1')).toBe('你好，世界');
    db.close();
  });

  it('thinking 事件不参与回填（只有 text_delta 进正文）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, V27);

    insertMsg(db, { id: 'm-agent-2', body: '', streamSessionId: 'ss-2', status: 'done' });
    db.prepare(
      `INSERT INTO message_events (id, message_id, seq, event_type, payload_json, created_at)
       VALUES ('ev-think', 'm-agent-2', 0, 'thinking_delta', ?, 1000)`,
    ).run(JSON.stringify({ delta: '内心独白' }));
    insertEvent(db, 'm-agent-2', 1, JSON.stringify({ delta: '正文' }));

    applyRemaining(db, V27);
    expect(bodyOf(db, 'm-agent-2')).toBe('正文');
    db.close();
  });

  it('body 非空的行不被覆盖（幂等：修复后新数据安全）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, V27);

    insertMsg(db, { id: 'm-user-1', body: '用户原话', streamSessionId: null, status: 'done' });
    insertMsg(db, { id: 'm-agent-3', body: '已有正文', streamSessionId: 'ss-3', status: 'done' });
    insertEvent(db, 'm-agent-3', 0, JSON.stringify({ delta: '多余增量' }));

    applyRemaining(db, V27);
    expect(bodyOf(db, 'm-user-1')).toBe('用户原话');
    expect(bodyOf(db, 'm-agent-3')).toBe('已有正文');
    db.close();
  });

  it('无任何 text_delta 的空 body 行保持空串（纯 thinking 流/子代理占位）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, V27);

    insertMsg(db, { id: 'm-agent-4', body: '', streamSessionId: 'ss-4', status: 'aborted' });

    applyRemaining(db, V27);
    expect(bodyOf(db, 'm-agent-4')).toBe('');
    db.close();
  });

  it('空库直接升到最新：迁移不炸', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const latest = Math.max(...loadMigrations().map((m) => m.version));
    applyUpTo(db, latest);
    db.close();
  });
});
