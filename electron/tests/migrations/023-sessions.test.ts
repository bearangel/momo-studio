// electron/tests/migrations/023-sessions.test.ts
// 迁移 v23 测试：sessions/session_members 新表 + 列语义重命名（room_id→session_id、
// team_room_id→team_session_id、execution_room_id→execution_session_id、
// source_room_id→source_session_id、bot_matrix_user_id→agent_user_id），
// 删除 matrix_event_id / matrix_space_id 列、room_settings 表。
//
// 设计依据 docs/specs/2026-08-23-v2.0.0-platform-refactor-design.md §5.1 / §5.2。
//
// 模式参照 012-agent-role-separation.test.ts：直接用 better-sqlite3 内存 DB
// 顺序执行 loadMigrations() 的 SQL，绕过项目 db 模块便于 schema-only 验证。
import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations } from '../../src/main/storage/migrations';

let db: DB;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // schema_migrations 表由 v1 建好；按 loadMigrations() 的顺序逐条 exec SQL
  // （与 012 测试的 applyUpToVersion 同法）。
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
  const markApplied = db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)',
  );
  for (const m of loadMigrations()) {
    db.exec(m.sql);
    markApplied.run(m.version);
  }
});

describe('migration v23 sessions', () => {
  it('sessions 表存在且列齐全', () => {
    const cols = db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining([
      'id', 'workspace_id', 'title', 'kind', 'settings_json',
      'created_at', 'updated_at', 'last_message_at',
    ]));
  });
  it('session_members 双主键', () => {
    const pk = db.prepare("PRAGMA table_info('session_members')").all() as Array<{ name: string; pk: number }>;
    const pkCols = pk.filter((c) => c.pk > 0).map((c) => c.name).sort();
    expect(pkCols).toEqual(['assignment_id', 'session_id']);
  });
  it('messages.room_id 已重命名为 session_id 且 matrix_event_id 已删', () => {
    const cols = db.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('session_id');
    expect(names).not.toContain('room_id');
    expect(names).not.toContain('matrix_event_id');
  });
  it('tasks 两列已重命名', () => {
    const cols = db.prepare("PRAGMA table_info('tasks')").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('execution_session_id');
    expect(names).toContain('source_session_id');
    expect(names).not.toContain('execution_room_id');
  });
  it('agent_assignments.bot_matrix_user_id → agent_user_id', () => {
    const cols = db.prepare("PRAGMA table_info('agent_assignments')").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('agent_user_id');
    expect(names).not.toContain('bot_matrix_user_id');
  });
  it('workspaces: team_session_id 存在、matrix_space_id 不存在；room_settings 表已删', () => {
    const cols = db.prepare("PRAGMA table_info('workspaces')").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('team_session_id');
    expect(names).not.toContain('matrix_space_id');
    const t = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='room_settings'",
    ).get();
    expect(t).toBeUndefined();
  });
});
