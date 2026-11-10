// electron/src/main/storage/migrations/077_momo_resource_creation_tools.ts
// Momo（builtin slug='general-assistant'）default_tools 全集回填升级：58 → 64。
//
// 背景（spec 2026-11-09-resource-creation-skills）：内置 YAML 升级 v2.1.0，
// defaultTools += resource_list / create_agent / add_agent_member / create_skill /
// create_mcp / create_team 六工具。新建 / 重装只影响新落库的定义；存量库里
// Momo 行仍停留在 074 回填后的 58 项，重启也无感。本迁移按 074 同式做
// 「整列替换」（Momo 语义为替换而非只加不减——以 catalog 全集为唯一真相源）。
//
// forward-only：074 的 SQL 与冻结名单（58 项）已不可变；本文件同样一次写定，
// 未来工具集再扩容时按 052 先例追加新迁移 + 更新 074 测试用例 D指向与冻结名单，
// 不改本文件。
//
// 一致性：冻结名单与 catalog.ts 的 ALL_BUILTIN_TOOLS 由 074/077 测试共同守护
// （排序后严格相等）；这里刻意不 import catalog——迁移 SQL 必须自包含纯字符串。
import type { Migration } from './index';

/** Momo 默认工具全集（64 个 = 074 的 58 个 + 资源创建六工具，顺序即落库顺序，供测试 import 断言）。 */
export const MOMO_V21_ALL_BUILTIN_TOOL_REFS = [
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
  // 资源创建（6）
  'resource_list', 'create_agent', 'add_agent_member', 'create_skill', 'create_mcp', 'create_team',
] as const;

/** 预计算 JSON：SQL 单引号字面量内可安全包含 JSON 的双引号（工具名无单引号）。 */
const TOOLS_JSON = JSON.stringify([...MOMO_V21_ALL_BUILTIN_TOOL_REFS]);

export const migration077: Migration = {
  version: 77,
  sql: `
-- Momo 资源创建工具整列替换回填（只命中 builtin + general-assistant）
-- 074 升级版：58 项 → 64 项（+= 资源创建六工具）。同替换语义——catalog 全集
-- 为唯一真相源，旧引用不保留。幂等：无条件重算同一数组，重复执行结果不变。
-- 新装库此迁移为无害 no-op（迁移先于内置定义落库执行，命中 0 行）。
UPDATE agent_definitions
SET default_tools = (
  SELECT json_group_array(json_object('kind', 'builtin', 'ref', value))
  FROM json_each('${TOOLS_JSON}')
)
WHERE source = 'builtin' AND slug = 'general-assistant'
`,
};
