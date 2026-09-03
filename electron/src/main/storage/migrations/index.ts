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
  {
    version: 17,
    sql: `
-- A 子系统：消息源统一——SQLite 升为唯一真相源
-- 1. messages：所有 IM 消息统一表（user / agent / dispatch / task_reply）
-- 2. message_events：事件溯源表（所有 stream chunk 落一行）
-- 详见 docs/specs/2026-08-13-platform-redesign-overview.md

CREATE TABLE IF NOT EXISTS messages (
  id                       TEXT PRIMARY KEY NOT NULL,
  room_id                  TEXT NOT NULL,
  sender                   TEXT NOT NULL,
  event_type               TEXT NOT NULL,
  body                     TEXT NOT NULL DEFAULT '',
  stream_session_id        TEXT,
  parent_stream_session_id TEXT,
  segment_of               TEXT,
  segment_index            INTEGER,
  status                   TEXT NOT NULL DEFAULT 'done',
  source                   TEXT NOT NULL DEFAULT 'local',
  matrix_event_id          TEXT,
  workspace_id             TEXT,
  task_id                  TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_stream       ON messages(stream_session_id);
CREATE INDEX IF NOT EXISTS idx_messages_parent       ON messages(parent_stream_session_id);
CREATE INDEX IF NOT EXISTS idx_messages_task         ON messages(task_id);

CREATE TABLE IF NOT EXISTS message_events (
  id           TEXT PRIMARY KEY NOT NULL,
  message_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  event_type   TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  UNIQUE(message_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_events_msg_seq ON message_events(message_id, seq);
`.trim(),
  },
  {
    version: 18,
    sql: `
-- A 子系统：删除 agent_meta 表（已废弃，富元数据统一在 message_events）
DROP TABLE IF EXISTS agent_meta;
`.trim(),
  },
  {
    version: 19,
    sql: `
-- B 子系统：任务模型——tasks 表 + conflict_strategy + agent_definitions 扩展
-- 详见 docs/specs/2026-08-13-platform-redesign-overview.md
--
-- tasks 表是"双模型"的 Task 侧真相源：
--   - 用户在 IM 房间内 @ 一个 agent 时，IM dispatch 协议层把意图升级为 Task
--   - 调度器按 priority / scheduled_at 把 task 派发到执行 room
--   - agent 完成 task 后回写 status + actual_tokens + completed_at
--   - 25 字段覆盖：身份 / 来源（哪个房间哪条消息触发）/ 执行（哪个 agent 在哪个 room）/
--     调度（priority / 定时 / 重复 / 截止）/ D 子系统扩展（D 任务看板用）/
--     C 子系统扩展（C P2P 路由用 source_node_id）/ 时间戳

CREATE TABLE IF NOT EXISTS tasks (
  id                    TEXT PRIMARY KEY NOT NULL,
  workspace_id          TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'draft',

  source_room_id        TEXT,
  source_message_id     TEXT,
  creator_user_id       TEXT NOT NULL,

  execution_room_id     TEXT,
  assignee_agent_id     TEXT,

  priority              INTEGER NOT NULL DEFAULT 0,
  scheduled_at          INTEGER,
  recurrence_rule       TEXT,
  deadline_at           INTEGER,

  queue_position        INTEGER,
  runtime_instance_id   TEXT,
  estimated_tokens      INTEGER,
  actual_tokens         INTEGER,
  tool_calls_used       INTEGER DEFAULT 0,
  error_message         TEXT,
  source_node_id        TEXT,

  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  started_at            INTEGER,
  completed_at          INTEGER,

  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- 索引：四类热查询路径
--   - workspace 列表 + 按 status 过滤（任务看板主视图）
--   - 按执行 room 找任务（dispatch 完成后查询子任务结果）
--   - 按 agent 查当前活跃任务（concurrency 控制 max_concurrent_tasks）
--   - 按 scheduled_at 找待调度任务（调度器轮询）
CREATE INDEX IF NOT EXISTS idx_tasks_ws_status ON tasks(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_exec_room ON tasks(execution_room_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee  ON tasks(assignee_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_scheduled ON tasks(scheduled_at) WHERE scheduled_at IS NOT NULL;

-- messages.task_id 已在 v17 加为普通列；SQLite 不支持 ALTER TABLE ADD CONSTRAINT，
-- 故此处用 trigger 模拟 ON DELETE SET NULL：删除 task 时把 messages.task_id 自动置 NULL，
-- 比 drop + recreate messages 表轻量得多（messages 是 A 子系统的核心表，重建风险大）。
CREATE TRIGGER IF NOT EXISTS messages_task_id_null_on_delete
  AFTER DELETE ON tasks
  FOR EACH ROW
  BEGIN
    UPDATE messages SET task_id = NULL WHERE task_id = OLD.id;
  END;

-- room_settings.conflict_strategy：当 agent 在已运行任务的房间里被 @ 时如何处理。
--   ask（默认）= 询问用户要不要中断旧任务；
--   queue      = 排队等旧任务完成；
--   preempt    = 直接中断旧任务接新任务；
--   reject     = 拒绝新任务。
ALTER TABLE room_settings ADD COLUMN conflict_strategy TEXT NOT NULL DEFAULT 'ask';

-- agent_definitions.max_concurrent_tasks：单个 agent 实例最多同时运行的任务数。
--   默认 1（v1.x 行为：每个 agent 同时只跑一个任务）；
--   C 子系统会让某些 agent 设更高值（如 dispatch router）。
ALTER TABLE agent_definitions ADD COLUMN max_concurrent_tasks INTEGER NOT NULL DEFAULT 1;

-- agent_definitions.default_conflict_strategy：与 room_settings.conflict_strategy 同语义，
-- 房间级未配置时继承 agent 定义。
ALTER TABLE agent_definitions ADD COLUMN default_conflict_strategy TEXT NOT NULL DEFAULT 'ask';
`.trim(),
  },
  {
    version: 21,
    sql: `
-- D 子系统：并发控制字段
-- 详见 docs/plans/2026-08-13-platform-redesign-d-task-board-concurrency.md Task D1
--
-- 1. global_settings 从 kv_store JSON 升为独立单行配置表
--    v1.4 当时只用 JSON blob 存唯一字段 maxToolCalls（key='global_settings' in kv_store）；
--    v2.0 D 子系统需要 SQL 级默认值 + 按字段查询/索引（并发控制器
--    SELECT max_concurrent_tasks FROM global_settings WHERE id=1）。
--    单行配置表：id 固定 1（CHECK 约束保证），新增列都是 NOT NULL DEFAULT，避免
--    并发控制器热路径做 NULL 判断。新代码从此表读，老代码（settings/crud.ts）继续
--    读 kv_store 不冲突——v21 暂不迁移老数据，预留 v2.x 把 maxToolCalls 也迁入。
-- 2. model_providers 加 max_rpm / max_tpm（限流字段）
--    v2 D 子系统由 ProviderTokenBucket（Task D2）按 provider 限流，limit 字段持久化到
--    model_providers 行（用户按 provider 一次性配置）。nullable = 未配置 = 不限流，
--    兼容 v1.x 的"无限制"默认行为。

CREATE TABLE IF NOT EXISTS global_settings (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  max_concurrent_tasks INTEGER NOT NULL DEFAULT 3,
  warm_pool_size       INTEGER NOT NULL DEFAULT 2,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 插入默认行（id=1）。schema_migrations 保证 v21 只跑一次；防御编程，
-- INSERT OR IGNORE 让重复跑（理论上不会发生）不会因 PK 冲突炸掉。
INSERT OR IGNORE INTO global_settings (id, max_concurrent_tasks, warm_pool_size) VALUES (1, 3, 2);

ALTER TABLE model_providers ADD COLUMN max_rpm INTEGER;
ALTER TABLE model_providers ADD COLUMN max_tpm INTEGER;
`.trim(),
  },
  {
    version: 22,
    sql: `
-- task-driven runtime 切换：agent_definitions 加 task_driven 字段
-- 1 = task-driven（v2 默认，runtime 自动用 task-based loop）
-- 0 = v1 runtime-manager（fallback，留 v1 版本兼容老 agent）
-- 存量数据（老 builtin / 自定义 agent）默认 1：新建 agent 一律走 task-driven，
-- 老 agent 不主动改这个字段的行为，下一次手动启用 / 启动时由代码读该字段。
-- P1 起恒 1，列保留为历史兼容，v25+ schema 清理时可移除。
ALTER TABLE agent_definitions ADD COLUMN task_driven INTEGER NOT NULL DEFAULT 1;
`.trim(),
  },
  {
    version: 23,
    sql: `
-- ─── v23：2.0.0 P1 会话内核——sessions 取代 Matrix room ────────────────────
-- 设计依据 docs/specs/2026-08-23-v2.0.0-platform-refactor-design.md §5。
-- 全新开始（D5）：不做数据回填，仅 schema 变形。
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'task_execution')),
  settings_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_message_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS session_members (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  assignment_id TEXT NOT NULL REFERENCES agent_assignments(instance_id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, assignment_id)
);

ALTER TABLE messages RENAME COLUMN room_id TO session_id;
ALTER TABLE messages DROP COLUMN matrix_event_id;

ALTER TABLE tasks RENAME COLUMN execution_room_id TO execution_session_id;
ALTER TABLE tasks RENAME COLUMN source_room_id TO source_session_id;

ALTER TABLE agent_assignments RENAME COLUMN bot_matrix_user_id TO agent_user_id;

ALTER TABLE workspaces RENAME COLUMN team_room_id TO team_session_id;
ALTER TABLE workspaces DROP COLUMN matrix_space_id;

DROP TABLE IF EXISTS room_settings;
`.trim(),
  },
  {
    version: 24,
    sql: `
-- ─── v24：2.0.0 P2 供应商平台/模型列表 + 审计配额 + 默认模型 schema ──────────
-- 1. model_providers.platform：显式指定 LLM 协议平台（取代 baseUrl 启发式检测，
--    解决非标准域名的 Anthropic 兼容供应商误判问题）。
--    SQLite ALTER ADD COLUMN 支持 CHECK 约束；DEFAULT 'openai' 使既有行自动回填。
-- 2. provider_models：供应商的模型列表（用户手动维护 + 后续拉取 API 填充）。
--    双主键 (provider_id, model_id) 保证幂等；ON DELETE CASCADE 删供应商时级联清理。
-- 3. workspaces.audit_quota_mb：workspace 级审计日志容量上限（MB）。
--    NULL = 未配置，继承全局 GlobalSettings.auditQuotaMb（默认 100）。
ALTER TABLE model_providers ADD COLUMN platform TEXT NOT NULL DEFAULT 'openai'
  CHECK (platform IN ('openai', 'anthropic'));
CREATE TABLE IF NOT EXISTS provider_models (
  provider_id TEXT NOT NULL REFERENCES model_providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model_id)
);
ALTER TABLE workspaces ADD COLUMN audit_quota_mb INTEGER;
`.trim(),
  },
  {
    version: 25,
    sql: `
-- ─── v25：agent 概念模型更换（spec 2026-08-31 §3）─────────────────────────
-- 去编排：agent_assignments → workspace_agent_members（无 role/parent）
CREATE TABLE workspace_agent_members (
  instance_id         TEXT PRIMARY KEY NOT NULL,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_definition_id TEXT NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  agent_user_id       TEXT NOT NULL,
  api_key_override    INTEGER NOT NULL DEFAULT 0,
  last_running        INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 去重：同 ws 同 def 保留 created_at 最早一条（被删行的 session_members 级联清理）
DELETE FROM agent_assignments WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM agent_assignments GROUP BY workspace_id, agent_definition_id
);
-- 防护：coordinator 指向被去重掉的行时先置 NULL（否则下方直拷 UPDATE 触发 FK 中止，
-- 且迁移 runner 逐句自动提交会让库停在半迁移态无法自愈重试）
UPDATE workspaces SET coordinator_instance_id = NULL
WHERE coordinator_instance_id IS NOT NULL
  AND coordinator_instance_id NOT IN (SELECT instance_id FROM agent_assignments);
INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id, api_key_override, last_running, created_at)
SELECT instance_id, workspace_id, agent_definition_id, agent_user_id, has_api_key_override, last_running, created_at
FROM agent_assignments;
CREATE UNIQUE INDEX idx_wam_unique ON workspace_agent_members(workspace_id, agent_definition_id);
CREATE INDEX idx_wam_agent ON workspace_agent_members(agent_definition_id);

-- 团队（§3.2）
CREATE TABLE teams (
  id                 TEXT PRIMARY KEY NOT NULL,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  icon_emoji         TEXT NOT NULL DEFAULT '👥',
  leader_instance_id TEXT NOT NULL REFERENCES workspace_agent_members(instance_id) ON DELETE CASCADE,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE team_members (
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES workspace_agent_members(instance_id) ON DELETE CASCADE,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (team_id, instance_id)
);

-- sessions / session_members（§3.3；FK 改指需重建表）
ALTER TABLE sessions ADD COLUMN title_auto INTEGER NOT NULL DEFAULT 0;
CREATE TABLE session_members_v25 (
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  instance_id    TEXT NOT NULL REFERENCES workspace_agent_members(instance_id) ON DELETE CASCADE,
  is_leader      INTEGER NOT NULL DEFAULT 0,
  added_at       INTEGER NOT NULL,
  PRIMARY KEY (session_id, instance_id)
);
INSERT INTO session_members_v25 (session_id, instance_id, is_leader, added_at)
SELECT session_id, assignment_id, 0, added_at FROM session_members;
DROP TABLE session_members;
ALTER TABLE session_members_v25 RENAME TO session_members;

-- workspaces：默认会话 agent（coordinator 语义就近迁移）；协调/团队会话列退役。
-- 注意：coordinator_instance_id 与 workspaces 同表，不能写成 UPDATE ... SELECT 自表
-- 子查询（SQLite 不支持），同表列直拷用 SET 新列 = 旧列 形式。
ALTER TABLE workspaces ADD COLUMN default_agent_instance_id TEXT REFERENCES workspace_agent_members(instance_id);
UPDATE workspaces SET default_agent_instance_id = coordinator_instance_id;
ALTER TABLE workspaces DROP COLUMN coordinator_instance_id;
ALTER TABLE workspaces DROP COLUMN team_session_id;

-- agent_definitions 全局化（§3.4）。
-- SQLite DROP COLUMN 拒绝删除带索引的列，v12 建的 idx_agent_definitions_workspace
-- 必须先删（实验验证：不删则报 "error in index ... no such column"）。
DROP INDEX IF EXISTS idx_agent_definitions_workspace;
ALTER TABLE agent_definitions DROP COLUMN workspace_id;

DROP TABLE agent_assignments;
`.trim(),
  },
  {
    version: 26,
    sql: `
-- ─── v26：修复 v25 遗留债务——重建 agent_assignment_capabilities FK ──────────
-- v25 DROP agent_assignments 时未重建本表外键，assignment_id 悬挂引用已删表：
-- foreign_keys=ON 下任何 INSERT 即报 no such table: agent_assignments，
-- 生产写路径 agent:setMemberDeltas 必炸（T10 审查移交债务①）。
-- 修法与 v25 session_members 同款：新建表（FK 改指 workspace_agent_members）
-- + 搬运 + 换名。列清单/PK 与 v16 完全一致，生产读写代码零改动；
-- JOIN 搬运 = instance_id 引用失效的行按级联语义清理（不搬运）。
CREATE TABLE agent_assignment_capabilities_v26 (
  assignment_id   TEXT NOT NULL REFERENCES workspace_agent_members(instance_id) ON DELETE CASCADE,
  capability_type TEXT NOT NULL CHECK (capability_type IN ('tool','mcp','skill')),
  mode            TEXT NOT NULL CHECK (mode IN ('add','remove')),
  ref             TEXT NOT NULL,
  PRIMARY KEY (assignment_id, capability_type, mode, ref)
);
INSERT INTO agent_assignment_capabilities_v26 (assignment_id, capability_type, mode, ref)
SELECT c.assignment_id, c.capability_type, c.mode, c.ref
FROM agent_assignment_capabilities c
JOIN workspace_agent_members m ON m.instance_id = c.assignment_id;
DROP TABLE agent_assignment_capabilities;
ALTER TABLE agent_assignment_capabilities_v26 RENAME TO agent_assignment_capabilities;
`.trim(),
  },
  {
    version: 27,
    sql: `
      -- v2.2 三层记忆（spec 2026-09-03-v2.2-agent-memory-design §5）：
      -- scope 列分层（global/workspace/session）；session 级联删除；
      -- pinned=常驻注入；source 决定主权（user 条目 agent 工具只读）。
      CREATE TABLE memories (
        id            TEXT PRIMARY KEY,
        scope         TEXT NOT NULL,
        workspace_id  TEXT,
        session_id    TEXT,
        kind          TEXT NOT NULL,
        pinned        INTEGER NOT NULL DEFAULT 0,
        content       TEXT NOT NULL,
        tags          TEXT NOT NULL DEFAULT '[]',
        source        TEXT NOT NULL,
        source_detail TEXT,
        confidence    REAL NOT NULL DEFAULT 1.0,
        use_count     INTEGER NOT NULL DEFAULT 0,
        last_used_at  INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        CHECK (scope IN ('global','workspace','session')),
        CHECK (kind IN ('rule','preference','knowledge','summary')),
        CHECK (source IN ('user','agent','auto')),
        CHECK ((scope='global'     AND workspace_id IS NULL     AND session_id IS NULL)
            OR (scope='workspace'  AND workspace_id IS NOT NULL AND session_id IS NULL)
            OR (scope='session'    AND workspace_id IS NOT NULL AND session_id IS NOT NULL)),
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_memories_ws      ON memories(workspace_id) WHERE scope IN ('workspace','session');
      CREATE INDEX idx_memories_session ON memories(session_id)   WHERE scope='session';
      CREATE INDEX idx_memories_pinned  ON memories(scope, workspace_id) WHERE pinned=1;

      -- 长会话压缩滚动摘要（覆盖式更新，covered_until 为增量压缩游标）
      CREATE TABLE session_summaries (
        session_id    TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        summary       TEXT NOT NULL,
        covered_until INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      -- FTS5 派生索引（external content 表；应用层双写，见 storage/memories/repo.ts）
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content, tags,
        content='memories', content_rowid='rowid',
        tokenize='unicode61'
      );
    `.trim(),
  },
];

export function loadMigrations(): Migration[] {
  return [...MIGRATIONS].sort((a, b) => a.version - b.version);
}

export function readMigrationSql(migration: Migration): string {
  return migration.sql;
}
