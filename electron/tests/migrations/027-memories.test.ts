// electron/tests/migrations/027-memories.test.ts
// 迁移 v27 测试：memories 三层 scope CHECK、session 级联删除、
// session_summaries 表、memories_fts 虚拟表（FTS5）。模式参照 024-settings.test.ts。
import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations, type Migration } from '../../src/main/storage/migrations';

let db: DB;

function applyUpTo(version: number): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
  const markApplied = db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)');
  const migrations = [...loadMigrations()].sort((a: Migration, b: Migration) => a.version - b.version);
  for (const m of migrations) {
    if (m.version > version) break;
    db.exec(m.sql);
    markApplied.run(m.version);
  }
}

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyUpTo(27);
});

function seedWsSession(): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'WS', '/tmp', '@owner:home')`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, title, title_auto, kind, created_at, updated_at)
     VALUES ('s1', 'ws1', 't', 0, 'chat', 1, 1)`,
  ).run();
}

describe('migration v27 memories 三层记忆', () => {
  it('memories 表存在且列齐全', () => {
    const cols = db.prepare("PRAGMA table_info('memories')").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining([
      'id', 'scope', 'workspace_id', 'session_id', 'kind', 'pinned', 'content',
      'tags', 'source', 'source_detail', 'confidence', 'use_count', 'last_used_at',
      'created_at', 'updated_at',
    ]));
  });

  it('scope CHECK：global 必须无 ws/session 外键', () => {
    seedWsSession();
    // 合法三条
    db.prepare(
      `INSERT INTO memories (id, scope, kind, content, source, created_at, updated_at)
       VALUES ('g1', 'global', 'preference', '回答用中文', 'user', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO memories (id, scope, workspace_id, kind, content, source, created_at, updated_at)
       VALUES ('w1', 'workspace', 'ws1', 'rule', '使用 pnpm', 'user', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO memories (id, scope, workspace_id, session_id, kind, content, source, created_at, updated_at)
       VALUES ('s1m', 'session', 'ws1', 's1', 'knowledge', '目标是重构登录', 'agent', 1, 1)`,
    ).run();
    // 非法：global 带 workspace_id
    expect(() => {
      db.prepare(
        `INSERT INTO memories (id, scope, workspace_id, kind, content, source, created_at, updated_at)
         VALUES ('bad', 'global', 'ws1', 'rule', 'x', 'user', 1, 1)`,
      ).run();
    }).toThrow();
    // 非法：scope 越界值
    expect(() => {
      db.prepare(
        `INSERT INTO memories (id, scope, kind, content, source, created_at, updated_at)
         VALUES ('bad2', 'agent', 'rule', 'x', 'user', 1, 1)`,
      ).run();
    }).toThrow();
  });

  it('session 级联删除：删会话连带删会话记忆与摘要', () => {
    db.prepare(
      `INSERT INTO session_summaries (session_id, summary, covered_until, updated_at)
       VALUES ('s1', '会话摘要', 100, 1)`,
    ).run();
    db.prepare("DELETE FROM sessions WHERE id = 's1'").run();
    expect(db.prepare("SELECT * FROM memories WHERE id = 's1m'").get()).toBeUndefined();
    expect(db.prepare("SELECT * FROM session_summaries WHERE session_id = 's1'").get()).toBeUndefined();
  });

  it('memories_fts 虚拟表存在且可 MATCH', () => {
    db.prepare(
      `INSERT INTO memories (id, scope, kind, content, source, created_at, updated_at)
       VALUES ('g2', 'global', 'knowledge', 'SQLite FTS5 检索', 'user', 1, 1)`,
    ).run();
    const rowid = (db.prepare("SELECT rowid FROM memories WHERE id = 'g2'").get() as { rowid: number }).rowid;
    db.prepare('INSERT INTO memories_fts (rowid, content, tags) VALUES (?, ?, ?)').run(rowid, '检索 fts5', '');
    const hit = db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'fts5'").all();
    expect(hit.length).toBeGreaterThan(0);
  });
});
