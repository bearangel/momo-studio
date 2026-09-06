// renderer/src/lib/describe-tool-call.ts
//
// 工具调用「摘要行」纯函数（同构 opencode getToolInfo）：已知工具按语义提炼
// 关键参数（路径只显文件名 / bash 显命令 / grep 显 pattern），未知与 mcp:*
// 工具按优先级键回退。供 ToolCallChip 与 ContextGroupChip 共用。
//
// 注意：list_files 走 FILE_TOOLS 的 path 键（显示目录名），无需特判。

/** 未知工具回退时按优先级挑「这个调用是关于什么」的键 */
const PRIORITY_KEYS = ['description', 'query', 'url', 'filePath', 'path', 'pattern', 'name'] as const;

export interface ToolCallSummary {
  /** 主摘要（折叠行 secondary 部分） */
  summary: string;
  /** 未知工具的次要 k=v（最多 2 个，主摘要用过的键不重复） */
  extraArgs: string[];
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter((s) => s !== '');
  return parts[parts.length - 1] ?? p;
}

function firstString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function truncate(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const FILE_TOOLS = new Set([
  'read_file', 'write_file', 'edit_file', 'mkdir', 'rm', 'mv', 'exists', 'lsp_diagnostics',
  'list_files',
]);

export function describeToolCall(toolName: string, args: Record<string, unknown>): ToolCallSummary {
  if (toolName === 'bash') {
    const cmd = typeof args.command === 'string' ? args.command.split('\n')[0] ?? '' : '';
    return { summary: cmd !== '' ? truncate(cmd) : '', extraArgs: [] };
  }
  if (toolName === 'grep') {
    const pattern = typeof args.pattern === 'string' ? `"${args.pattern}"` : '';
    const path = typeof args.path === 'string' ? ` in ${args.path}` : '';
    const combined = `${pattern}${path}`;
    return { summary: combined !== '' ? truncate(combined) : '', extraArgs: [] };
  }
  if (toolName === 'glob') {
    return {
      summary: typeof args.pattern === 'string' ? truncate(args.pattern) : '',
      extraArgs: [],
    };
  }
  if (FILE_TOOLS.has(toolName)) {
    const p = firstString(args, ['filePath', 'path']);
    return { summary: p !== undefined ? truncate(basename(p)) : '', extraArgs: [] };
  }
  // 未知 / mcp:* 工具：优先级键回退 + 最多 2 个次要标量参数
  const main = firstString(args, PRIORITY_KEYS);
  const usedKey = PRIORITY_KEYS.find((k) => args[k] === main);
  const extraArgs: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (extraArgs.length >= 2) break;
    if (k === usedKey) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      extraArgs.push(`${k}=${String(v)}`);
    }
  }
  return { summary: main !== undefined ? truncate(main) : '', extraArgs };
}
