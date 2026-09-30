// electron/src/main/storage/migrations/052_agent_tools_tier1_backfill.ts
// v2.x 工具分级落地（spec §4.5）：agent_definitions.default_tools 并入 Tier 1
// 公共默认集——只加不减、幂等（UNION 去重）。
//
// Tier 1 名单此处为自包含字面量（与 v16 BUILTIN_DEFAULT_TOOLS_JSON 同模式），
// 刻意不 import catalog 派生常量：catalog → tools/index → task-tools →
// storage/db → migrations/index → 本模块 构成循环依赖，catalog 先行加载的
// 入口（如 builtin YAML 契约测试）会在本模块顶层读到未初始化的
// SAFE_MINIMUM_TOOLS（TDZ 崩溃）。名单与 catalog 的 SAFE_MINIMUM_TOOLS
// （defaultOn=true 派生，17 项）一致性由 052-tier1-backfill.test.ts 锁死：
// 空 default_tools 行回填后必须恰好等于实时派生的 SAFE_MINIMUM_TOOLS。
// 应用时 SQL 冻结进 schema_migrations，之后 catalog 演进不影响已应用库。
// 顺序说明：mergeCapabilities 对 defaultTools 按集合语义去重，条目顺序无语义。
import type { Migration } from './index';

// Tier 1 公共默认集（spec §3.2 / D2：只读 13 + 文件写 4，共 17；不含 rm/bash/git 写）
const TIER1_TOOL_REFS = [
  // 文件（7）
  'read_file', 'write_file', 'list_files', 'edit_file',
  'mkdir', 'mv', 'exists',
  // 搜索（2）
  'grep', 'glob',
  // 任务清单（1）
  'todowrite',
  // 会话（2）
  'list_sessions', 'read_session',
  // 记忆（1）
  'memory_search',
  // 任务读（4）
  'read_task', 'read_task_history', 'read_task_progress', 'list_tasks',
] as const;

const TIER1_JSON = JSON.stringify([...TIER1_TOOL_REFS]);

export const migration052: Migration = {
  version: 52,
  sql: `
-- v2.x Tier 1 公共默认集加法回填（只加不减，幂等）
-- 旧条目解析 ref（NULL/畸形条目跳过）UNION Tier 1 名单，重建为 {kind:'builtin',ref} 数组
UPDATE agent_definitions AS ad
SET default_tools = COALESCE((
  SELECT json_group_array(json_object('kind', 'builtin', 'ref', ref))
  FROM (
    SELECT DISTINCT ref FROM (
      SELECT json_extract(j.value, '$.ref') AS ref
      FROM json_each(COALESCE(ad.default_tools, '[]')) AS j
      WHERE json_extract(j.value, '$.ref') IS NOT NULL
      UNION
      SELECT t.value AS ref
      FROM json_each('${TIER1_JSON}') AS t
    )
  )
), '[]')
`,
};
