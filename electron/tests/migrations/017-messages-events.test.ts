// electron/tests/migrations/017-messages-events.test.ts
//
// v17 migration 测试：
//   1. messages 表 schema（含全部字段 + 索引）
//   2. message_events 表 schema（含 UNIQUE(message_id, seq) 约束 + 索引）
//   3. 外键 ON DELETE CASCADE（删 message 自动清 events）
//   4. 默认值（status='done', source='local', body='')
//
// 注意：v23 会 RENAME COLUMN messages.room_id TO session_id + DROP COLUMN matrix_event_id。
// 故本测试只 apply 到 v17（applyUpToVersion(17)），不复用 012 之前用
// runMigrations() + getDb() 单例的写法——后者会把 v23 也跑掉，破坏本测试断言。
// 模式参照 012-agent-role-separation.test.ts。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations } from '../../src/main/storage/migrations';

let db: DB;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
  const markApplied = db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)',
  );
  for (const m of loadMigrations().filter((m) => m.version <= 17)) {
    db.exec(m.sql);
    markApplied.run(m.version);
  }
});

afterAll(() => {
  db.close();
});

describe('migration v17: messages + message_events', () => {
  it('创建 messages 表，含所有字段', () => {
    const cols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
    const colMap = new Map(cols.map((c) => [c.name, c]));

    // 必填字段
    expect(colMap.get('id')?.type).toBe('TEXT');
    expect(colMap.get('id')?.notnull).toBe(1);
    expect(colMap.get('room_id')?.notnull).toBe(1);
    expect(colMap.get('sender')?.notnull).toBe(1);
    expect(colMap.get('event_type')?.notnull).toBe(1);

    // 默认值
    expect(colMap.get('status')?.dflt_value).toBe("'done'");
    expect(colMap.get('source')?.dflt_value).toBe("'local'");
    expect(colMap.get('body')?.dflt_value).toBe("''");

    // 可空字段
    expect(colMap.has('stream_session_id')).toBe(true);
    expect(colMap.has('parent_stream_session_id')).toBe(true);
    expect(colMap.has('segment_of')).toBe(true);
    expect(colMap.has('segment_index')).toBe(true);
    expect(colMap.has('matrix_event_id')).toBe(true);
    expect(colMap.has('workspace_id')).toBe(true);
    expect(colMap.has('task_id')).toBe(true);
    expect(colMap.has('created_at')).toBe(true);
    expect(colMap.has('updated_at')).toBe(true);
  });

  it('messages 表主键为 id', () => {
    const pk = db.prepare('PRAGMA table_info(messages)').all() as Array<{ pk: number; name: string }>;
    expect(pk.find((c) => c.pk === 1)?.name).toBe('id');
  });

  it('messages 表有索引（room+created, stream, parent, task）', () => {
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'").all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_messages_room_created');
    expect(indexNames).toContain('idx_messages_stream');
    expect(indexNames).toContain('idx_messages_parent');
    expect(indexNames).toContain('idx_messages_task');
  });

  it('创建 message_events 表，含 UNIQUE(message_id, seq) 约束', () => {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='message_events'").get() as { sql: string };
    expect(sql.sql).toContain('message_id');
    expect(sql.sql).toContain('seq');
    expect(sql.sql).toContain('event_type');
    expect(sql.sql).toContain('payload_json');
    expect(sql.sql).toContain('UNIQUE(message_id, seq)');
  });

  it('message_events 有索引 idx_events_msg_seq', () => {
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='message_events'").all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('idx_events_msg_seq');
  });

  it('外键 ON DELETE CASCADE：删 message 自动清对应 events', () => {
    db.prepare('PRAGMA foreign_keys = ON').run();
    db.prepare(
      `INSERT INTO messages (id, room_id, sender, event_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('m1', 'r1', '@a:home', 'm.room.message', Date.now(), Date.now());
    db.prepare(
      `INSERT INTO message_events (id, message_id, seq, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('e1', 'm1', 0, 'final', '{}', Date.now());

    db.prepare('DELETE FROM messages WHERE id = ?').run('m1');
    const events = db.prepare('SELECT COUNT(*) AS n FROM message_events WHERE message_id = ?').get('m1') as { n: number };
    expect(events.n).toBe(0);
  });

  it('UNIQUE(message_id, seq) 约束生效', () => {
    db.prepare(
      `INSERT INTO messages (id, room_id, sender, event_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('m1', 'r1', '@a:home', 'm.room.message', Date.now(), Date.now());
    db.prepare(
      `INSERT INTO message_events (id, message_id, seq, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('e1', 'm1', 0, 'final', '{}', Date.now());

    expect(() => {
      db.prepare(
        `INSERT INTO message_events (id, message_id, seq, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('e2', 'm1', 0, 'final', '{}', Date.now()); // 同 seq，应失败
    }).toThrow();
  });
});
