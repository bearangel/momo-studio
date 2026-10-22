// electron/tests/storage/migration-067-session-groups.test.ts
//
// 迁移 067 老库升级专项：构造 066 终态库 → 插入 workspace/sessions/session_members
// 既有行 → 应用 067 → 断言：三新列存在且存量回填正确（多成员 chat→collab、
// 单成员 chat→quick、task_execution→NULL）、session_groups 表 5 列、重复应用幂等。
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations } from '../../src/main/storage/migrations';

function applyUpTo(db: DB, version: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const mark = db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)');
  for (const m of loadMigrations()) {
    if (m.version > version) break;
    db.exec(m.sql);
    mark.run(m.version);
  }
}

function migration67(): string {
  const m = loadMigrations().find((x) => x.version === 67);
  if (!m) throw new Error('migration 067 未注册进 MIGRATIONS 数组');
  return m.sql;
}

const WS = 'ws-a';

/** 066 终态夹具：一个 workspace + 三个会话（多成员 chat / 单成员 chat / task_execution） */
function seed066(db: DB): void {
  db.prepare(
    `INSERT INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(WS, 'ws', '', '/tmp/ws', 0, 'u1', '📁');
  // workspace_agent_members 有 UNIQUE(workspace_id, agent_definition_id) 索引 +
  // FK 指向 agent_definitions：两个成员须各配一个 def（对齐 sessions-repo.test.ts 夹具）
  const insDef = db.prepare(
    `INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_name)
     VALUES (?, ?, ?, '1', 'p', 'm')`,
  );
  insDef.run('def-1', 'DEF-1', 'def-1');
  insDef.run('def-2', 'DEF-2', 'def-2');
  const ins = db.prepare(`INSERT INTO sessions (id, workspace_id, title, title_auto, kind, settings_json, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, NULL, ?, ?)`);
  ins.run('s-multi', WS, '多成员', 'chat', 100, 100);
  ins.run('s-single', WS, '单成员', 'chat', 101, 101);
  ins.run('s-task', WS, '任务', 'task_execution', 102, 102);
  const insMember = db.prepare(
    `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id, api_key_override, last_running, created_at)
     VALUES (?, ?, ?, ?, 0, 0, 1)`);
  insMember.run('inst-1', WS, 'def-1', 'au-1');
  insMember.run('inst-2', WS, 'def-2', 'au-2');
  const insSm = db.prepare('INSERT INTO session_members (session_id, instance_id, is_leader, added_at) VALUES (?, ?, 0, 1)');
  insSm.run('s-multi', 'inst-1');
  insSm.run('s-multi', 'inst-2');
  insSm.run('s-single', 'inst-1');
}

describe('migration 067：会话分组/置顶/类型', () => {
  it('三新列存在且存量回填正确；task_execution 保持 NULL', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, 66);
    seed066(db);
    db.exec(migration67());
    const row = (id: string) =>
      db.prepare('SELECT pinned_at, group_id, session_type FROM sessions WHERE id = ?').get(id) as
        { pinned_at: number | null; group_id: string | null; session_type: string | null };
    expect(row('s-multi').session_type).toBe('collab');
    expect(row('s-single').session_type).toBe('quick');
    expect(row('s-task').session_type).toBeNull();
    expect(row('s-multi').pinned_at).toBeNull();
    expect(row('s-multi').group_id).toBeNull();
    db.close();
  });

  it('session_groups 表 5 列 + workspace 索引；重复应用必炸（重放保护由迁移版本标记保证）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, 66);
    db.exec(migration67());
    const cols = (db.prepare('PRAGMA table_info(session_groups)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(['id', 'workspace_id', 'name', 'position', 'created_at']);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_session_groups_ws'").get();
    expect(idx).toBeTruthy();
    expect(() => db.exec(migration67())).toThrow(); // ALTER ADD COLUMN 重复应用必炸 → 幂等由迁移框架的版本标记保证
    db.close();
  });
});
