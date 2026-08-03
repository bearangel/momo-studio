// electron/tests/migrations/012-agent-role-separation.test.ts
// 迁移 v12 测试：agent 定义/分配解耦 schema 改动 + 数据回填。
// 用 better-sqlite3 内存 DB 直接控制 migration 应用阶段（不通过项目 db 模块），
// 便于在 v11 与 v12 之间插入老格式数据后验证回填。
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations } from '../../src/main/storage/migrations';

/** 应用从 v1 到 targetVersion 的全部 migration。
 *  按 schema_migrations 跳过已应用版本（支持在同一 DB 上多次调用追加新版本）。 */
function applyUpToVersion(db: DB, targetVersion: number): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
  const migrations = loadMigrations().filter((m) => m.version <= targetVersion);
  const checkApplied = db.prepare(
    'SELECT 1 FROM schema_migrations WHERE version = ?',
  );
  const markApplied = db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)',
  );
  for (const m of migrations) {
    if (checkApplied.get(m.version)) continue; // 跳过已应用
    db.exec(m.sql);
    markApplied.run(m.version);
  }
}

/** 读取 agent_definitions 的列名集合 */
function columnsOf(db: DB, table: 'agent_definitions' | 'agent_assignments'): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((r) => r.name);
}

describe('migration v12 — agent role separation', () => {
  let db: DB;

  function reopen(): void {
    if (db) db.close();
    db = new Database(':memory:');
  }

  it('v11 schema 有 type/parent_agent_id/model_provider/model_base_url 列', () => {
    reopen();
    applyUpToVersion(db, 11);
    const cols = columnsOf(db, 'agent_definitions');
    expect(cols).toContain('type');
    expect(cols).toContain('parent_agent_id');
    expect(cols).toContain('model_provider');
    expect(cols).toContain('model_base_url');
  });

  it('v12 加 workspace_id 和 model_provider_id 列到 agent_definitions', () => {
    reopen();
    applyUpToVersion(db, 12);
    const cols = columnsOf(db, 'agent_definitions');
    expect(cols).toContain('workspace_id');
    expect(cols).toContain('model_provider_id');
    expect(cols).toContain('model_name'); // 复用旧列
  });

  it('v12 删除 agent_definitions 的 type / parent_agent_id / model_provider / model_base_url', () => {
    reopen();
    applyUpToVersion(db, 12);
    const cols = columnsOf(db, 'agent_definitions');
    expect(cols).not.toContain('type');
    expect(cols).not.toContain('parent_agent_id');
    expect(cols).not.toContain('model_provider');
    expect(cols).not.toContain('model_base_url');
  });

  it('v12 加 role / parent_instance_id / has_api_key_override 列到 agent_assignments', () => {
    reopen();
    applyUpToVersion(db, 12);
    const cols = columnsOf(db, 'agent_assignments');
    expect(cols).toContain('role');
    expect(cols).toContain('parent_instance_id');
    expect(cols).toContain('has_api_key_override');
  });

  it('v12 回填 assignment.role 从老 def.type', () => {
    reopen();
    applyUpToVersion(db, 11);
    // 插入老格式 def（含 type 列）+ workspace + assignment
    db.prepare(
      `INSERT INTO agent_definitions (id, name, slug, version, type, runtime, system_prompt, model_provider, model_name, source)
       VALUES ('def-1', 'PM', 'pm', '1', 'main', 'declarative', 'x', 'openai', 'gpt-4o', 'custom')`,
    ).run();
    db.prepare(
      `INSERT INTO workspaces (id, name, description, directory_path, matrix_space_id, git_initialized, owner_id, icon_emoji, team_room_id)
       VALUES ('ws-1', 'WS', '', '/tmp', '!s:localhost', 0, '@u:localhost', '📁', '!t:localhost')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id)
       VALUES ('inst-1', 'ws-1', 'def-1', '@bot:localhost')`,
    ).run();

    // 应用 v12
    applyUpToVersion(db, 12);

    const row = db
      .prepare('SELECT role FROM agent_assignments WHERE instance_id = ?')
      .get('inst-1') as { role: string };
    expect(row.role).toBe('main');
  });

  it('v12 回填 parent_instance_id（同 ws 父 assignment 存在）', () => {
    reopen();
    applyUpToVersion(db, 11);
    db.prepare(
      `INSERT INTO agent_definitions (id, name, slug, version, type, parent_agent_id, runtime, system_prompt, model_provider, model_name, source)
       VALUES
         ('main-def', 'PM', 'pm', '1', 'main', NULL, 'declarative', 'x', 'openai', 'gpt-4o', 'custom'),
         ('sub-def', 'Coder', 'coder', '1', 'sub', 'main-def', 'declarative', 'x', 'openai', 'gpt-4o', 'custom')`,
    ).run();
    db.prepare(
      `INSERT INTO workspaces (id, name, description, directory_path, matrix_space_id, git_initialized, owner_id, icon_emoji, team_room_id)
       VALUES ('ws-1', 'WS', '', '/tmp', '!s:localhost', 0, '@u:localhost', '📁', '!t:localhost')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id)
       VALUES
         ('main-inst', 'ws-1', 'main-def', '@main:localhost'),
         ('sub-inst', 'ws-1', 'sub-def', '@sub:localhost')`,
    ).run();

    applyUpToVersion(db, 12);

    const sub = db
      .prepare('SELECT parent_instance_id FROM agent_assignments WHERE instance_id = ?')
      .get('sub-inst') as { parent_instance_id: string };
    expect(sub.parent_instance_id).toBe('main-inst');
  });

  it('v12 父 ws 不同时 parent_instance_id 留 NULL（孤儿 sub）', () => {
    reopen();
    applyUpToVersion(db, 11);
    db.prepare(
      `INSERT INTO agent_definitions (id, name, slug, version, type, parent_agent_id, runtime, system_prompt, model_provider, model_name, source)
       VALUES
         ('main-def', 'PM', 'pm', '1', 'main', NULL, 'declarative', 'x', 'openai', 'gpt-4o', 'custom'),
         ('sub-def', 'Coder', 'coder', '1', 'sub', 'main-def', 'declarative', 'x', 'openai', 'gpt-4o', 'custom')`,
    ).run();
    db.prepare(
      `INSERT INTO workspaces (id, name, description, directory_path, matrix_space_id, git_initialized, owner_id, icon_emoji, team_room_id)
       VALUES
         ('ws-1', 'WS1', '', '/tmp', '!s1:localhost', 0, '@u:localhost', '📁', '!t1:localhost'),
         ('ws-2', 'WS2', '', '/tmp', '!s2:localhost', 0, '@u:localhost', '📁', '!t2:localhost')`,
    ).run();
    // main 在 ws-1，sub 在 ws-2（不同 ws，应留 NULL）
    db.prepare(
      `INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id)
       VALUES
         ('main-inst', 'ws-1', 'main-def', '@main:localhost'),
         ('sub-inst', 'ws-2', 'sub-def', '@sub:localhost')`,
    ).run();

    applyUpToVersion(db, 12);

    const sub = db
      .prepare('SELECT parent_instance_id FROM agent_assignments WHERE instance_id = ?')
      .get('sub-inst') as { parent_instance_id: string | null };
    expect(sub.parent_instance_id).toBeNull();
  });
});
