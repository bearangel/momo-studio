// electron/tests/migrations/013-room-settings.test.ts
//
// v1.4 迁移 v13 测试：room_settings 表存在、schema_migrations 记录、列结构正确。
//
// 注意：v23 会 DROP TABLE room_settings（合并到 sessions.settings_json）。
// 故本测试只 apply 到 v13（applyUpToVersion(13)），不复用 012 之前用
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
  for (const m of loadMigrations().filter((m) => m.version <= 13)) {
    db.exec(m.sql);
    markApplied.run(m.version);
  }
});

afterAll(() => {
  db.close();
});

describe('migration v13: room_settings', () => {
  it('room_settings 表存在', () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='room_settings'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('room_settings');
  });

  it('schema_migrations 记录了 v13', () => {
    const row = db.prepare('SELECT version FROM schema_migrations WHERE version = 13').get();
    expect(row).toBeDefined();
  });

  it('room_settings 有 room_id 和 max_tool_calls 列', () => {
    const info = db.prepare('PRAGMA table_info(room_settings)').all() as { name: string }[];
    const cols = info.map((c) => c.name);
    expect(cols).toContain('room_id');
    expect(cols).toContain('max_tool_calls');
  });
});
