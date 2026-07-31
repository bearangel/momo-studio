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
  {
    version: 5,
    sql: `
-- M2 扩展：agent_definitions 加上 parent_agent_id（主子关联）+ default_mcps +
-- default_skills（运行时能力引用）。原 v4 已被 team_room_id 占用，故本迁移用
-- v5 避免 conflict。schema_migrations 表保证每条 migration 只执行一次。

ALTER TABLE agent_definitions ADD COLUMN parent_agent_id TEXT;
ALTER TABLE agent_definitions ADD COLUMN default_mcps TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agent_definitions ADD COLUMN default_skills TEXT NOT NULL DEFAULT '[]';

-- workspace 级能力分配（MCP / Skill），主键三列组合保证同一能力不会被重复加
-- 入同一 workspace。
CREATE TABLE IF NOT EXISTS workspace_allocations (
  workspace_id TEXT NOT NULL,
  capability_type TEXT NOT NULL,
  capability_ref TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, capability_type, capability_ref),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- MCP server 定义：注册到平台后可被 agent 通过 McpRef 引用。name 唯一。
CREATE TABLE IF NOT EXISTS mcp_definitions (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'stdio',
  command TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]',
  env TEXT NOT NULL DEFAULT '{}',
  capabilities TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Skill 定义：注册到平台后可被 agent 通过 SkillRef 引用。slug 唯一。
CREATE TABLE IF NOT EXISTS skill_definitions (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  description TEXT NOT NULL,
  allowed_tools TEXT NOT NULL DEFAULT '[]',
  cache_path TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`.trim(),
  },
  {
    version: 6,
    sql: `
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_bot_user_id TEXT NOT NULL,
  task_id TEXT,
  tool_name TEXT NOT NULL,
  input_summary TEXT NOT NULL DEFAULT '',
  output_summary TEXT NOT NULL DEFAULT '',
  success INTEGER NOT NULL DEFAULT 1,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_workspace_ts ON tool_calls(workspace_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_tool_calls_agent ON tool_calls(agent_bot_user_id);
`.trim(),
  },
  {
    version: 7,
    sql: `
-- M3：Git Policy —— 每个 workspace 一条 commit 规则配置（JSON blob）。
-- 主键 workspace_id 直接对应 workspaces(id)，但不加外键约束：删除 workspace 时
-- 这里残留配置无害（查询按 workspace_id 精确命中），且避免迁移期的级联复杂度。
CREATE TABLE IF NOT EXISTS git_policies (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  config_json TEXT NOT NULL
);
`.trim(),
  },
  {
    version: 8,
    sql: `
-- M4：Marketplace 已安装包登记表。item_id 对应 catalog 内 MarketplaceItem.id
-- （INSERT OR REPLACE 做幂等覆盖），cache_path 指向解压后的本地缓存目录。
-- 不加外键：catalog item 不在 DB 内，是外部数据源。
CREATE TABLE IF NOT EXISTS installed_packages (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  slug TEXT NOT NULL,
  version TEXT NOT NULL,
  cache_path TEXT NOT NULL,
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  checksum TEXT NOT NULL
);
`.trim(),
  },
  {
    version: 9,
    sql: `
-- 补齐 agent_definitions.model_base_url 列。M1 漏建此列，导致自定义 agent 配置的
-- baseUrl 被静默丢弃，运行时全部 fallback 到 OpenAI 默认 endpoint（GLM/DeepSeek
-- 等自定义 baseUrl 永远不生效）。
ALTER TABLE agent_definitions ADD COLUMN model_base_url TEXT;
`.trim(),
  },
  {
    version: 10,
    sql: `
CREATE TABLE IF NOT EXISTS model_providers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  base_url TEXT NOT NULL,
  api_key_ref TEXT NOT NULL,
  default_model TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`.trim(),
  },
  {
    version: 11,
    sql: `
-- coordinator_instance_id：workspace 的"协调 agent"实例 ID。
-- NULL = 未指定（保持 v1.0 行为：团队群消息必须 @）；非空 = 该 assignment 的 instanceId，
-- 团队群里没有 @ 的消息由该实例自动接待（详见 v1.1 设计 3.4）。nullable，无 DEFAULT。
ALTER TABLE workspaces ADD COLUMN coordinator_instance_id TEXT;
`.trim(),
  },
];

export function loadMigrations(): Migration[] {
  return [...MIGRATIONS].sort((a, b) => a.version - b.version);
}

export function readMigrationSql(migration: Migration): string {
  return migration.sql;
}
