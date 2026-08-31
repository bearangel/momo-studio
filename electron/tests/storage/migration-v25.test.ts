// electron/tests/storage/migration-v25.test.ts
// 迁移 v25 测试：agent 概念模型更换——去编排 + 团队 schema（spec 2026-08-31 §3）。
//   1. agent_assignments → workspace_agent_members（无 role/parent_instance_id）
//   2. teams / team_members 新表（团队快照）
//   3. sessions.title_auto / session_members.is_leader（双会话类型）
//   4. workspaces.coordinator_instance_id → default_agent_instance_id（语义就近迁移）
//   5. agent_definitions.workspace_id 退役（定义全局化）+ team_session_id 退役
//
// 模式参照 tests/migrations/023-sessions.test.ts / 024-settings.test.ts：
// 内存 DB + foreign_keys=ON 顺序执行 loadMigrations() 的 SQL；
// 数据搬迁用例先升到 v24 插入 fixture，再应用 v24 之后的迁移。
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations } from '../../src/main/storage/migrations';

const V24 = 24;

/** 在 db 上应用 <= version 的全部迁移并登记 schema_migrations（与 024 测试同法） */
function applyUpTo(db: DB, version: number): void {
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
    if (m.version > version) break;
    db.exec(m.sql);
    markApplied.run(m.version);
  }
}

/** 应用 afterVersion 之后的全部迁移（当前即 v25；无 v25 时为 no-op） */
function applyRemaining(db: DB, afterVersion: number): void {
  const markApplied = db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)',
  );
  for (const m of loadMigrations()) {
    if (m.version <= afterVersion) continue;
    db.exec(m.sql);
    markApplied.run(m.version);
  }
}

/** 全新空库直接升到最新版本（空数据路径：无 assignment 时迁移不炸、表结构就位） */
function buildMigratedDb(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const latest = Math.max(...loadMigrations().map((m) => m.version));
  applyUpTo(db, latest);
  return db;
}

/** v24 库 + fixture 注入 → 升级 v25（数据搬迁用例的公共骨架） */
function buildV24DbWithFixture(seed: (db: DB) => void): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyUpTo(db, V24);
  seed(db);
  applyRemaining(db, V24);
  return db;
}

function tableColumns(db: DB, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

/** v24 fixture 最小集：workspace + agent 定义（assignment 由用例自行插入） */
function seedWorkspaceAndDefinition(db: DB): void {
  db.exec(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES ('ws1', 'WS', '', '/tmp', 0, '@owner:s', '📁')`,
  );
  db.exec(
    `INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_name)
     VALUES ('def-1', 'A', 'a', '1.0.0', 'prompt', 'm1')`,
  );
}

describe('migration v25：去编排 + 团队 schema', () => {
  it('workspace_agent_members 存在且无 role/parent 列；agent_assignments 表消失（空库路径）', () => {
    const db = buildMigratedDb();
    const cols = tableColumns(db, 'workspace_agent_members');
    expect(cols).toContain('instance_id');
    expect(cols).toContain('agent_user_id');
    expect(cols).toContain('workspace_id');
    expect(cols).toContain('agent_definition_id');
    expect(cols).not.toContain('role');
    expect(cols).not.toContain('parent_instance_id');
    expect(cols).not.toContain('enabled');
    // 空 assignment 库升级后 members 为空、旧表彻底消失
    expect(db.prepare('SELECT COUNT(*) c FROM workspace_agent_members').get()).toMatchObject({
      c: 0,
    });
    expect(
      db
        .prepare('SELECT name FROM sqlite_master WHERE name=? AND type=?')
        .get('agent_assignments', 'table'),
    ).toBeUndefined();
    db.close();
  });

  it('assignments 数据按 instance_id 原样搬入 members（role 丢弃）', () => {
    const db = buildV24DbWithFixture((d) => {
      seedWorkspaceAndDefinition(d);
      d.exec(
        `INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, agent_user_id, has_api_key_override, created_at)
         VALUES ('inst-1', 'ws1', 'def-1', '@bot:1', 1, '2026-01-01 00:00:00')`,
      );
      // 会话成员随迁：assignment_id → instance_id，is_leader 落 0
      d.exec(
        `INSERT INTO sessions (id, workspace_id, title, created_at, updated_at)
         VALUES ('sess-1', 'ws1', 'T', 1, 1)`,
      );
      d.exec(`INSERT INTO session_members (session_id, assignment_id, added_at) VALUES ('sess-1', 'inst-1', 42)`);
    });
    const row = db
      .prepare('SELECT * FROM workspace_agent_members WHERE instance_id=?')
      .get('inst-1') as Record<string, unknown>;
    expect(row['workspace_id']).toBe('ws1');
    expect(row['agent_definition_id']).toBe('def-1');
    expect(row['agent_user_id']).toBe('@bot:1');
    expect(row['api_key_override']).toBe(1);
    expect(row['created_at']).toBe('2026-01-01 00:00:00');
    expect(db.prepare('SELECT COUNT(*) c FROM workspace_agent_members').get()).toMatchObject({ c: 1 });
    // session_members 契约：instance_id 指向 members、is_leader 默认 0、added_at 保留
    const sm = db.prepare('SELECT * FROM session_members').get() as Record<string, unknown>;
    expect(sm['session_id']).toBe('sess-1');
    expect(sm['instance_id']).toBe('inst-1');
    expect(sm['is_leader']).toBe(0);
    expect(sm['added_at']).toBe(42);
    db.close();
  });

  it('teams/team_members/default_agent/title_auto/is_leader 就位', () => {
    const db = buildMigratedDb();
    // teams 列齐全，icon_emoji 默认 👥
    const teamCols = db.prepare('PRAGMA table_info(teams)').all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    expect(teamCols.map((c) => c.name)).toEqual(
      expect.arrayContaining(['id', 'workspace_id', 'name', 'icon_emoji', 'leader_instance_id', 'created_at']),
    );
    expect(teamCols.find((c) => c.name === 'icon_emoji')!.dflt_value).toBe("'👥'");
    // team_members 双主键 (team_id, instance_id)
    const tmCols = db.prepare('PRAGMA table_info(team_members)').all() as Array<{
      name: string;
      pk: number;
    }>;
    expect(tmCols.map((c) => c.name)).toEqual(
      expect.arrayContaining(['team_id', 'instance_id', 'added_at']),
    );
    expect(tmCols.filter((c) => c.pk > 0).map((c) => c.name).sort()).toEqual(['instance_id', 'team_id']);
    // sessions.title_auto 就位
    expect(tableColumns(db, 'sessions')).toContain('title_auto');
    // session_members：instance_id/is_leader 就位、assignment_id 消失
    const smCols = tableColumns(db, 'session_members');
    expect(smCols).toContain('instance_id');
    expect(smCols).toContain('is_leader');
    expect(smCols).not.toContain('assignment_id');
    // workspaces：default_agent_instance_id 就位、coordinator/team_session 退役
    const wsCols = tableColumns(db, 'workspaces');
    expect(wsCols).toContain('default_agent_instance_id');
    expect(wsCols).not.toContain('coordinator_instance_id');
    expect(wsCols).not.toContain('team_session_id');
    // agent_definitions 全局化：workspace_id 消失
    expect(tableColumns(db, 'agent_definitions')).not.toContain('workspace_id');
    db.close();
  });

  it('coordinator_instance_id 迁移到 default_agent_instance_id', () => {
    const db = buildV24DbWithFixture((d) => {
      seedWorkspaceAndDefinition(d);
      d.exec(`UPDATE workspaces SET coordinator_instance_id='inst-1' WHERE id='ws1'`);
      d.exec(
        `INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, agent_user_id)
         VALUES ('inst-1', 'ws1', 'def-1', '@bot:1')`,
      );
    });
    const row = db.prepare('SELECT default_agent_instance_id FROM workspaces WHERE id=?').get('ws1') as {
      default_agent_instance_id: string | null;
    };
    expect(row.default_agent_instance_id).toBe('inst-1');
    expect(tableColumns(db, 'workspaces')).not.toContain('coordinator_instance_id');
    db.close();
  });

  it('重复 assignment（同 ws 同 def）去重保留最早一条', () => {
    const db = buildV24DbWithFixture((d) => {
      seedWorkspaceAndDefinition(d);
      d.exec(
        `INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, agent_user_id, created_at)
         VALUES ('inst-1', 'ws1', 'def-1', '@bot:1', '2026-01-01 00:00:00')`,
      );
      d.exec(
        `INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, agent_user_id, created_at)
         VALUES ('inst-2', 'ws1', 'def-1', '@bot:2', '2026-02-02 00:00:00')`,
      );
    });
    expect(db.prepare('SELECT COUNT(*) c FROM workspace_agent_members').get()).toMatchObject({ c: 1 });
    const row = db.prepare('SELECT * FROM workspace_agent_members').get() as Record<string, unknown>;
    expect(row['instance_id']).toBe('inst-1');
    expect(row['created_at']).toBe('2026-01-01 00:00:00');
    db.close();
  });
});
