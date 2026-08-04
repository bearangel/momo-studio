// electron/src/main/agent/tools/shared/permission.ts
// 工具权限白/黑名单检查（纯函数）。
// v1.5 扩展：支持通配符后缀（lsp_* / git_* / mcp:github:*）。

export interface ToolPermissionConfig {
  allowedTools: string[];
  deniedTools: string[];
}

function matchToolPattern(toolName: string, pattern: string): boolean {
  if (pattern === toolName) return true;
  if (pattern.endsWith('*')) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  return false;
}

export function assertToolAllowed(name: string, config: ToolPermissionConfig): void {
  for (const pattern of config.deniedTools) {
    if (matchToolPattern(name, pattern)) {
      throw new Error(`工具 ${name} 被禁止使用（匹配 denied 模式 ${pattern}）`);
    }
  }
  if (config.allowedTools.length > 0) {
    const allowed = config.allowedTools.some((p) => matchToolPattern(name, p));
    if (!allowed) {
      throw new Error(`工具 ${name} 不在允许列表中`);
    }
  }
}
