// electron/src/main/storage/migrations/index.ts
//
// Migrations are defined inline as TS string constants rather than shipped as
// `.sql` files. This is deliberate: `tsc` emits only `.js`, so loose `.sql`
// assets would never reach `dist/`, and a `__dirname`/`readdirSync` lookup would
// silently return `[]` in the packaged app, leaving the DB with no tables. By
// keeping the SQL in-source, the compiled module is fully self-contained.

export interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS kv_store (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`.trim(),
  },
  {
    version: 2,
    sql: `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  directory_path TEXT NOT NULL,
  matrix_space_id TEXT NOT NULL,
  git_initialized INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  owner_id TEXT NOT NULL,
  icon_emoji TEXT NOT NULL DEFAULT '📁'
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL,
  matrix_user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, matrix_user_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
`.trim(),
  },
  {
    version: 3,
    sql: `
CREATE TABLE IF NOT EXISTS agent_definitions (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  version TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'standalone',
  runtime TEXT NOT NULL DEFAULT 'declarative',
  system_prompt TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  default_tools TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'custom',
  description TEXT NOT NULL DEFAULT '',
  icon_emoji TEXT NOT NULL DEFAULT '🤖',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_assignments (
  instance_id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_definition_id TEXT NOT NULL,
  bot_matrix_user_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_definition_id) REFERENCES agent_definitions(id) ON DELETE CASCADE
);
`.trim(),
  },
  {
    version: 4,
    sql: `
-- team_room_id：workspace 内的"团队群" room ID。workspace 创建时同时创建一个
-- team room（用户 + 所有 agent bot 都在此 room 内交流），存到这里供后续
-- agent 启动 / 邀请 bot 使用。migration 由 schema_migrations 保证只执行一次，
-- 故直接用 ALTER TABLE ADD COLUMN（无需 IF NOT EXISTS 守卫）。
ALTER TABLE workspaces ADD COLUMN team_room_id TEXT NOT NULL DEFAULT '';
`.trim(),
  },
];

export function loadMigrations(): Migration[] {
  return [...MIGRATIONS].sort((a, b) => a.version - b.version);
}

export function readMigrationSql(migration: Migration): string {
  return migration.sql;
}
