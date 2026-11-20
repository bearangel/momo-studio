// electron/src/main/storage/migrations/085_momo_git_tools_removal.ts
// Momo（builtin slug='general-assistant'）default_tools 全集回填缩减：72 → 62。
//
// 背景（git 工具域下线，2026-11-20 拍板）：git 专用工具组（repos/status/diff/
// log/show/add/commit/branch/checkout/stash 共 10 个）整体退役，git 全量操作
// （含 reset/revert/push 等）改经 bash 执行（bash 黑名单同步移除 git commit
// 拦截条目，命令级审计兜底）。按 074/077/078/080/083 同式做「整列替换」——
// catalog 全集为唯一真相源，git 旧引用不保留。
//
// 用户自建 agent 的 default_tools 若残留 git_* ref：capability-merger 对未知
// ref 静默丢弃（kept/dropped 过滤），无需数据清洗；本迁移只回填 builtin 行。
//
// forward-only：083 的 SQL 与冻结名单（72 项）已不可变；本文件同样一次写定，
// 未来工具集再变更时按先例追加新迁移 + 更新 074 系测试用例指向与冻结名单。
//
// 一致性：冻结名单与 catalog.ts 的 ALL_BUILTIN_TOOLS 由 074 系测试共同守护
// （排序后严格相等）；这里刻意不 import catalog——迁移 SQL 必须自包含纯字符串。
import type { Migration } from './index';

/** Momo 默认工具全集（62 个 = 083 的 72 个 − git 工具域 10 个，顺序即落库顺序，供测试 import 断言）。 */
export const MOMO_V25_ALL_BUILTIN_TOOL_REFS = [
  // 文件（9）
  'read_file', 'write_file', 'list_files', 'edit_file', 'mkdir', 'rm', 'mv', 'exists', 'apply_patch',
  // 搜索（2）
  'grep', 'glob',
  // Shell / 进程（4）——git 操作经 bash（git 工具域 2026-11-20 下线）
  'bash', 'process_list', 'process_keep', 'process_kill',
  // Web / Todo / 委派（3）
  'webfetch', 'todowrite', 'list_delegation_targets',
  // 任务（11）
  'read_task', 'read_task_history', 'read_task_progress', 'create_task', 'request_human',
  'submit_task', 'complete_task', 'fail_task', 'list_tasks', 'list_task_groups', 'list_workgroups',
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
  // 资源创建（7）
  'resource_list', 'create_agent', 'add_agent_member', 'create_skill', 'create_mcp', 'create_team', 'list_models',
  // 资源管理（5）
  'describe_agent', 'update_agent_capabilities', 'update_agent_profile', 'update_skill', 'update_mcp',
] as const;

/** 预计算 JSON：SQL 单引号字面量内可安全包含 JSON 的双引号（工具名无单引号）。 */
const TOOLS_JSON = JSON.stringify([...MOMO_V25_ALL_BUILTIN_TOOL_REFS]);

export const migration085: Migration = {
  version: 85,
  sql: `
-- Momo git 工具域下线整列替换回填（只命中 builtin + general-assistant）
-- 083 缩减版：72 项 → 62 项（−= git 域 10 工具）。同替换语义——
-- catalog 全集为唯一真相源，git 旧引用不保留。幂等：无条件重算同一数组，重复执行结果不变。
-- 新装库此迁移为无害 no-op（迁移先于内置定义落库执行，命中 0 行）。
UPDATE agent_definitions
SET default_tools = (
  SELECT json_group_array(json_object('kind', 'builtin', 'ref', value))
  FROM json_each('${TOOLS_JSON}')
)
WHERE source = 'builtin' AND slug = 'general-assistant'
`,
};
