// electron/src/main/agent/tools/catalog.ts
// v1.6 能力配置的共享常量集中地。后续 Migration v16（builtin YAML defaultTools
// 同步）、DefinitionEditor UI（工具勾选）、crud.ts（新建 custom agent 默认工具）
// 都从这里 import，保证工具全集 / 安全最小集 / 类别分组三处定义一致。
// v2.3 加入 apply_patch 后全集从 24 扩为 25；安全最小集保持 v1.5 范围不变
// （apply_patch 多文件原子破坏力高，按设计不放进默认勾选集）。
//
// 设计依据：docs/plans/2026-08-11-v1.6-capability-config.md「共享常量」块。
// 工具名必须与 tools/index.ts 注册中心实际暴露的 name 字段一一对应。

/**
 * v2.3 全部 25 个内置工具的名称全集（v1.5 24 + apply_patch）。
 * 来源：tools/{file,search,shell,git,web,todo,lsp,apply-patch}-tools.ts 中各 ToolDef.name 字段。
 * 修改本数组前，必须先确认对应工具模块已注册。
 */
export const ALL_BUILTIN_TOOLS = [
  // 文件（9）— v2.3 加 apply_patch（V4A 多文件原子操作）
  'read_file', 'write_file', 'list_files', 'edit_file', 'apply_patch',
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
 * 仅包含读写编辑、搜索、todo——不含 Shell / Git 写 / Web / LSP / apply_patch，
 * 避免新 agent 在用户未审查情况下拿到高破坏力工具权限。
 * apply_patch 为多文件原子操作，破坏力显著高于单文件 edit_file，故排除。
 */
export const SAFE_MINIMUM_TOOLS = [
  'read_file', 'write_file', 'list_files', 'edit_file',
  'grep', 'glob', 'todowrite',
] as const;

/**
 * 工具按类别分组，DefinitionEditor UI 渲染勾选区块用。
 * 每个类别的 tools 并集必须等于 ALL_BUILTIN_TOOLS，且无重复
 * （由 tests/agent/tools-catalog.test.ts 与 tools-catalog-v2.3.test.ts 保证）。
 */
export const TOOL_CATEGORIES: Array<{ label: string; emoji: string; tools: string[] }> = [
  // v2.3 文件分类加 apply_patch（V4A 多文件原子操作）
  { label: '文件', emoji: '📁', tools: ['read_file', 'write_file', 'list_files', 'edit_file', 'apply_patch', 'mkdir', 'rm', 'mv', 'exists'] },
  { label: '搜索', emoji: '🔍', tools: ['grep', 'glob'] },
  { label: 'Shell', emoji: '💻', tools: ['bash'] },
  { label: 'Git', emoji: '📋', tools: ['git_status', 'git_diff', 'git_log', 'git_show', 'git_add', 'git_commit', 'git_branch', 'git_checkout', 'git_stash'] },
  { label: 'Web', emoji: '🌐', tools: ['webfetch'] },
  { label: 'Todo', emoji: '✅', tools: ['todowrite'] },
  { label: 'LSP', emoji: '🔧', tools: ['lsp_diagnostics', 'lsp_find_references'] },
];
