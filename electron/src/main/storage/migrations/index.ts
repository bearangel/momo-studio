// electron/src/main/storage/migrations/index.ts
//
// Migrations are defined inline as TS string constants rather than shipped as
// `.sql` files. This is deliberate: `tsc` emits only `.js`, so loose `.sql`
// assets would never reach `dist/`, and a `__dirname`/`readdirSync` lookup would
// silently return `[]` in the packaged app, leaving the DB with no tables. By
// keeping the SQL in-source, the compiled module is fully-contained.

export interface Migration {
  version: number;
  sql: string;
}

/**
 * v1.6 builtin agent 的 24 工具全集，序列化为 agent_definitions.default_tools 列的 JSON 格式。
 *
 * 这个常量在模块加载时通过 JSON.stringify 预计算，v16 migration 用模板字符串插值
 * 嵌入 UPDATE 语句（SQL 单引号字面量内可安全包含 JSON 的双引号，无需转义）。
 *
 * 工具列表与 agent/tools/catalog.ts 的 ALL_BUILTIN_TOOLS 必须保持一致——
 * 这里刻意不 import catalog，因为 migration SQL 必须是自包含的纯字符串
 * （打包后 catalog 路径可能变化，但已应用的 migration SQL 写入 schema_migrations
 * 后不可变）。两者的一致性由 tools-catalog.test.ts + 本文件测试共同守护。
 *
 * 导出供 016-assignment-capabilities.test.ts 验证 builtin 修复 UPDATE 的正确性。
 */
const BUILTIN_TOOL_REFS = [
  // 文件（8）
  'read_file', 'write_file', 'list_files', 'edit_file',
  'mkdir', 'rm', 'mv', 'exists',
  // 搜索（2）
  'grep', 'glob',
  // Shell（1）
  'bash',
  // Git（9）
  'git_status', 'git_diff', 'git_log', 'git_show',
  'git_add', 'git_commit', 'git_branch', 'git_checkout', 'git_stash',
  // Web（1）
  'webfetch',
  // Todo（1）
  'todowrite',
  // LSP（2）
  'lsp_diagnostics', 'lsp_find_references',
] as const;

export const BUILTIN_DEFAULT_TOOLS_JSON = JSON.stringify(
  BUILTIN_TOOL_REFS.map((ref) => ({ kind: 'builtin', ref })),
);

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
  {
    version: 12,
    sql: `
-- agent 定义/分配解耦：把角色和父子关系从 definition 剥离到 assignment，
-- definition 改为 workspace-scoped（workspace_id 可空），模型配置改为引用 model_providers 表。
-- 现有 assignment 强制重配 provider（model_provider_id 留 NULL）。

-- 1. agent_definitions 新增列（model_name 已存在，无需重复加）
ALTER TABLE agent_definitions ADD COLUMN workspace_id TEXT;
ALTER TABLE agent_definitions ADD COLUMN model_provider_id TEXT;

-- 2. agent_assignments 新增列
ALTER TABLE agent_assignments ADD COLUMN role TEXT NOT NULL DEFAULT 'standalone';
ALTER TABLE agent_assignments ADD COLUMN parent_instance_id TEXT;
ALTER TABLE agent_assignments ADD COLUMN has_api_key_override INTEGER NOT NULL DEFAULT 0;

-- 3. 索引：按 workspace 过滤定义 / 按 parent 查 subs
CREATE INDEX IF NOT EXISTS idx_agent_definitions_workspace ON agent_definitions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_assignments_parent ON agent_assignments(workspace_id, parent_instance_id);

-- 4. 数据回填：assignment.role 从老 def.type 推导
UPDATE agent_assignments
SET role = (
  SELECT CASE d.type
    WHEN 'main' THEN 'main'
    WHEN 'sub' THEN 'sub'
    ELSE 'standalone'
  END
  FROM agent_definitions d
  WHERE d.id = agent_assignments.agent_definition_id
);

-- 5. 数据回填：assignment.parent_instance_id 从老 def.parent_agent_id + 同 ws 父 assignment 推导
-- SQLite UPDATE 不支持表别名，直接用 outer 表名引用列
UPDATE agent_assignments
SET parent_instance_id = (
  SELECT pa.instance_id
  FROM agent_definitions d
  JOIN agent_assignments pa
    ON pa.agent_definition_id = d.parent_agent_id
    AND pa.workspace_id = agent_assignments.workspace_id
  WHERE d.id = agent_assignments.agent_definition_id
    AND d.parent_agent_id IS NOT NULL
)
WHERE EXISTS (
  SELECT 1 FROM agent_definitions d
  WHERE d.id = agent_assignments.agent_definition_id AND d.parent_agent_id IS NOT NULL
);

-- 6. 删除旧列（SQLite 3.35+ 支持 DROP COLUMN）
ALTER TABLE agent_definitions DROP COLUMN type;
ALTER TABLE agent_definitions DROP COLUMN parent_agent_id;
ALTER TABLE agent_definitions DROP COLUMN model_provider;
ALTER TABLE agent_definitions DROP COLUMN model_base_url;
`.trim(),
  },
  {
    version: 13,
    sql: `
-- v1.4：房间级配置（工具调用上限等）。max_tool_calls 语义：
--   NULL  = 继承全局默认（global_settings.maxToolCalls）
--   0     = 禁用工具调用（纯对话模式）
--   -1    = 无限制
--   N > 0 = 最多 N 次工具调用
CREATE TABLE IF NOT EXISTS room_settings (
  room_id TEXT PRIMARY KEY NOT NULL,
  max_tool_calls INTEGER
);
`.trim(),
  },
  {
    version: 14,
    sql: `
-- v1.5.6：持久化分层——大 thinking/tool_calls/todos 存 SQLite，Matrix event 只存 body + agent_meta_id
-- 解决 PDU 64KB 限制导致的 4-5 级截断丢元数据问题
-- sendFinalMessage 在内容超 ~5KB 时写入此表，Matrix event 引用 meta_id
-- renderer 读消息时如发现 io.momo-studio.agent_meta_id 字段，调 IPC 拉完整元数据
CREATE TABLE IF NOT EXISTS agent_meta (
  meta_id TEXT PRIMARY KEY NOT NULL,
  thinking TEXT,
  tool_calls TEXT,
  todos TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_meta_created ON agent_meta(created_at);
`.trim(),
  },
  {
    version: 15,
    sql: `
-- v1.5.8：记录用户对每个 agent 的「最近运行意图」
--   1 = 用户希望运行（手动上线 / 新分配后默认）
--   0 = 用户主动下线
-- spawnAgent 写 1；stopAgent（手动）写 0；崩溃/退出不改
-- autoStartAgents 查询条件：enabled=1 AND last_running=1
-- 存量数据默认 1（老用户升级后全部自动恢复，与历史期望一致）
ALTER TABLE agent_assignments ADD COLUMN last_running INTEGER NOT NULL DEFAULT 1;
`.trim(),
  },
  {
    version: 16,
    sql: `
-- v1.6 能力配置：per-assignment 能力 delta + mcp_definitions 来源追踪 + builtin 默认工具修复
--
-- 1. agent_assignment_capabilities：Layer 3 能力 delta 表。
--    每个 assignment 可在此基础上 add/remove 具体的 tool/mcp/skill，
--    运行时与 agent_definitions.default_tools 合并生成最终能力集。
--    ON DELETE CASCADE：assignment 删除时 delta 自动清理，无需应用层手动清。
--    依赖 PRAGMA foreign_keys = ON（getDb() 已启用）。
CREATE TABLE IF NOT EXISTS agent_assignment_capabilities (
  assignment_id   TEXT NOT NULL REFERENCES agent_assignments(instance_id) ON DELETE CASCADE,
  capability_type TEXT NOT NULL CHECK (capability_type IN ('tool','mcp','skill')),
  mode            TEXT NOT NULL CHECK (mode IN ('add','remove')),
  ref             TEXT NOT NULL,
  PRIMARY KEY (assignment_id, capability_type, mode, ref)
);

-- 2. mcp_definitions 加 source 列：区分市场安装（'marketplace'）vs 用户自定义（'custom'）。
--    v1.6 marketplace 支持上传自定义 MCP 包，UI 需据此区分展示与卸载逻辑。
ALTER TABLE mcp_definitions ADD COLUMN source TEXT NOT NULL DEFAULT 'marketplace';

-- 3. mcp_definitions 加 installed_at 列：记录实际安装时间（区别于 created_at 的注册时间）。
ALTER TABLE mcp_definitions ADD COLUMN installed_at TEXT NOT NULL DEFAULT (datetime('now'));

-- 4. builtin default_tools 修复：v1.5 builtin YAML 只写了 3 工具到 DB，v1.6 扩展为 24 工具。
--    schema_migrations 保证此 UPDATE 只执行一次；BUILTIN_DEFAULT_TOOLS_JSON 在模块顶部
--    预计算，JSON 双引号在 SQL 单引号字面量内是合法字符，无需转义。
UPDATE agent_definitions
SET default_tools = '${BUILTIN_DEFAULT_TOOLS_JSON}'
WHERE source = 'builtin';
`.trim(),
  },
];

export function loadMigrations(): Migration[] {
  return [...MIGRATIONS].sort((a, b) => a.version - b.version);
}

export function readMigrationSql(migration: Migration): string {
  return migration.sql;
}
