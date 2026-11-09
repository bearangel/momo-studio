// electron/src/main/storage/migrations/074_momo_all_builtin_tools.ts
// Momo（内置 slug='general-assistant'）默认持有全部内置工具：存量库回填。
//
// 背景：Momo 的内置 YAML 定义改为 default_tools 全量内置工具（58 项），但新建 /
// 重装只影响新落库的定义；存量库里 Momo 行仍停留在旧的 25 项左右默认集，用户
// 重启也无感。本迁移按 052/073 同式做「存量回填」，区别是 Momo 语义为**替换**
// 而非只加不减——Momo 的默认集以 catalog 全集为准，旧引用（如已移除的 LSP 工具）
// 一并清掉。
//
// forward-only：已应用的迁移 SQL 写入 schema_migrations 后不可变；未来工具集
// 再扩容时按 052 先例追加新迁移 + 更新测试断言，不改本文件。
//
// 一致性：冻结名单与 catalog.ts 的 ALL_BUILTIN_TOOLS 由 074 测试守护（排序后
// 严格相等）；这里刻意不 import catalog——迁移 SQL 必须自包含纯字符串。
import type { Migration } from './index';

/** Momo 默认工具全集（58 个，顺序即落库顺序，供测试 import 断言）。 */
export const MOMO_ALL_BUILTIN_TOOL_REFS = [
  // 文件（9）
  'read_file', 'write_file', 'list_files', 'edit_file', 'mkdir', 'rm', 'mv', 'exists', 'apply_patch',
  // 搜索（2）
  'grep', 'glob',
  // Shell / 进程（4）
  'bash', 'process_list', 'process_keep', 'process_kill',
  // Git（10）
  'git_repos', 'git_status', 'git_diff', 'git_log', 'git_show',
  'git_add', 'git_commit', 'git_branch', 'git_checkout', 'git_stash',
  // Web / Todo / 委派（3）
  'webfetch', 'todowrite', 'list_delegation_targets',
  // 任务（9）
  'read_task', 'read_task_history', 'read_task_progress', 'create_task', 'complete_task',
  'fail_task', 'list_tasks', 'list_task_groups', 'list_workgroups',
  // 记忆（4）
  'memory_save', 'memory_search', 'memory_get', 'memory_forget',
  // 浏览器（12）
  'browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_type',
  'browser_press_key', 'browser_hover', 'browser_scroll', 'browser_evaluate',
  'browser_console_messages', 'browser_tabs', 'browser_close',
  // Office（3）
  'office_read', 'office_read_cells', 'office_copy',
  // 会话（2）
  'list_sessions', 'read_session',
] as const;

/** 预计算 JSON：SQL 单引号字面量内可安全包含 JSON 的双引号（工具名无单引号）。 */
const TOOLS_JSON = JSON.stringify([...MOMO_ALL_BUILTIN_TOOL_REFS]);

export const migration074: Migration = {
  version: 74,
  sql: `
-- Momo 全量内置工具替换回填（只命中 builtin + general-assistant）
-- 先构造完整 JSON 数组再整列替换：与只加不减的 052/073 不同，Momo 的默认集
-- 以 catalog 全集为唯一真相源，旧引用不保留。目标行之外一律不动。
-- 幂等：无条件重算同一数组，重复执行结果不变。
UPDATE agent_definitions
SET default_tools = (
  SELECT json_group_array(json_object('kind', 'builtin', 'ref', value))
  FROM json_each('${TOOLS_JSON}')
)
WHERE source = 'builtin' AND slug = 'general-assistant'
`,
};
