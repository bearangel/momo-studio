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
  // 插件系统 P2（spec §4.2）：插件工具可见性 = 装配面（pluginTools ref 在
  // buildSpawnOpts 已按 workspace 启停过滤）——allowed 精确白名单不再筛
  // plugin: 前缀名；denied 全量生效（含 plugin:<id>/* 整插件前缀禁用）
  if (name.startsWith('plugin:')) return;
  if (config.allowedTools.length > 0) {
    const allowed = config.allowedTools.some((p) => matchToolPattern(name, p));
    if (!allowed) {
      throw new Error(`工具 ${name} 不在允许列表中`);
    }
  }
}

export interface ToolDefLike {
  name: string;
  description: string;
  inputSchema: unknown;
}

/**
 * 可见面过滤（chatStream 工具目录收敛，P2 审查 I1 抽取纯函数化）：
 *  - denied（含通配后缀，matchToolPattern 同执行期语义）优先剔除——含插件工具
 *  - plugin: 前缀豁免 allowed 精确白名单（可见性=装配面，spec §4.2）
 *  - 其余按 allowed 白名单（空 = 全放行）
 */
export function filterVisibleToolDefs<T extends ToolDefLike>(
  tools: T[],
  allowedTools: string[],
  deniedTools: string[],
): T[] {
  return tools.filter(
    (t) =>
      !deniedTools.some((p) => matchToolPattern(t.name, p)) &&
      (t.name.startsWith('plugin:') ||
        allowedTools.length === 0 ||
        allowedTools.some((p) => matchToolPattern(t.name, p))),
  );
}
