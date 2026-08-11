// electron/src/main/agent/tools/catalog.ts
// v1.6 能力配置的共享常量集中地。后续 Migration v16（builtin YAML defaultTools
// 同步）、DefinitionEditor UI（工具勾选）、crud.ts（新建 custom agent 默认工具）
// 都从这里 import，保证 24 工具全集 / 安全最小集 / 类别分组三处定义一致。
//
// 设计依据：docs/plans/2026-08-11-v1.6-capability-config.md「共享常量」块。
// 工具名必须与 v1.5 tools/index.ts 注册中心实际暴露的 name 字段一一对应。

/**
 * v1.5 全部 24 个内置工具的名称全集。
 * 来源：tools/{file,search,shell,git,web,todo,lsp}-tools.ts 中各 ToolDef.name 字段。
 * 修改本数组前，必须先确认对应工具模块已注册。
 */
export const ALL_BUILTIN_TOOLS = [
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

/**
 * 安全最小集：新建 custom agent 时默认勾选的工具。
 * 仅包含读写编辑、搜索、todo——不含 Shell / Git 写 / Web / LSP，
 * 避免新 agent 在用户未审查情况下拿到 bash 或 git_commit 权限。
 */
export const SAFE_MINIMUM_TOOLS = [
  'read_file', 'write_file', 'list_files', 'edit_file',
  'grep', 'glob', 'todowrite',
] as const;

/**
 * 工具按类别分组，DefinitionEditor UI 渲染勾选区块用。
 * 每个类别的 tools 并集必须等于 ALL_BUILTIN_TOOLS，且无重复
 * （由 tests/agent/tools-catalog.test.ts 保证）。
 */
export const TOOL_CATEGORIES: Array<{ label: string; emoji: string; tools: string[] }> = [
  { label: '文件', emoji: '📁', tools: ['read_file', 'write_file', 'list_files', 'edit_file', 'mkdir', 'rm', 'mv', 'exists'] },
  { label: '搜索', emoji: '🔍', tools: ['grep', 'glob'] },
  { label: 'Shell', emoji: '💻', tools: ['bash'] },
  { label: 'Git', emoji: '📋', tools: ['git_status', 'git_diff', 'git_log', 'git_show', 'git_add', 'git_commit', 'git_branch', 'git_checkout', 'git_stash'] },
  { label: 'Web', emoji: '🌐', tools: ['webfetch'] },
  { label: 'Todo', emoji: '✅', tools: ['todowrite'] },
  { label: 'LSP', emoji: '🔧', tools: ['lsp_diagnostics', 'lsp_find_references'] },
];
