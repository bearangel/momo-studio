// electron/tests/migrations/015-agent-last-running.test.ts
//
// v1.5.8 迁移 v15 测试：agent_assignments 表新增 last_running 列，默认值 1。
//
// 注意：v23 会 RENAME COLUMN agent_assignments.bot_matrix_user_id TO agent_user_id。
// 故本测试只 apply 到 v15（applyUpToVersion(15)），不复用 012 之前用
// runMigrations() + getDb() 单例的写法——后者会把 v23 也跑掉，破坏本测试 INSERT 断言。
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
  for (const m of loadMigrations().filter((m) => m.version <= 15)) {
    db.exec(m.sql);
    markApplied.run(m.version);
  }
});

afterAll(() => {
  db.close();
});

describe('migration v15: agent_assignments.last_running', () => {
  it('schema_migrations 记录了 v15', () => {
    const row = db.prepare('SELECT version FROM schema_migrations WHERE version = 15').get();
    expect(row).toBeDefined();
  });

  it('agent_assignments 表含 last_running 列', () => {
    const info = db.prepare('PRAGMA table_info(agent_assignments)').all() as { name: string }[];
    expect(info.map((c) => c.name)).toContain('last_running');
  });

  it('last_running 列默认值为 1（存量数据兼容）', () => {
    // 预建 workspace + agent_definition 满足 FK
    db.prepare(
      `INSERT INTO workspaces (id, name, description, directory_path, matrix_space_id, git_initialized, owner_id, icon_emoji)
       VALUES ('ws-x', 'WS', '', '/tmp', '!s:localhost', 0, '@o:localhost', '📁')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_definitions (id, name, slug, version, runtime, system_prompt, model_name, source)
       VALUES ('def-x', 'A', 'a', '1', 'declarative', 'p', 'gpt-4o', 'custom')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_assignments
        (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id, enabled, role)
       VALUES (?, ?, ?, ?, 1, 'standalone')`,
    ).run('inst-x', 'ws-x', 'def-x', '@bot:x:localhost');
    const row = db
      .prepare('SELECT last_running FROM agent_assignments WHERE instance_id = ?')
      .get('inst-x') as { last_running: number };
    expect(row.last_running).toBe(1);
  });
});
