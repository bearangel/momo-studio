// renderer/src/lib/tool-catalog.ts
//
// v1.6 能力配置的 renderer 端常量副本（与 electron/src/main/agent/tools/catalog.ts 同步）。
// 因 electron 是 CommonJS 主进程、renderer 是 ESM 浏览器进程，跨 workspace 直接引用会破坏
// 构建，故在 renderer 端维护一份结构完全一致的镜像。
//
// 修改本文件时必须同步修改 electron 端 catalog.ts（两份定义需手工保持一致，
// 由 docs/plans/2026-08-11-v1.6-capability-config.md 约束）。

/**
 * v1.5 全部 24 个内置工具的名称全集。
 * 必须与 electron 端 ALL_BUILTIN_TOOLS 一一对应（同名同顺序）。
 */
export const ALL_BUILTIN_TOOLS: string[] = [
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
];

/**
 * 安全最小集：新建 custom agent 时默认勾选的工具。
 * 仅包含读写编辑、搜索、todo——不含 Shell / Git 写 / Web / LSP，
 * 避免新 agent 在用户未审查情况下拿到 bash 或 git_commit 权限。
 */
export const SAFE_MINIMUM_TOOLS: string[] = [
  'read_file', 'write_file', 'list_files', 'edit_file',
  'grep', 'glob', 'todowrite',
];

/**
 * 工具按类别分组，CapabilityTabs 渲染勾选区块用。
 * 类别顺序即 UI 显示顺序（文件 → 搜索 → Shell → Git → Web → Todo → LSP）。
 * 每个类别的 tools 并集必须等于 ALL_BUILTIN_TOOLS，且无重复。
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
