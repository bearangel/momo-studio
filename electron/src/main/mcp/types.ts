// electron/src/main/mcp/types.ts
//
// MCP（Model Context Protocol）相关类型定义。
// 这些类型描述了 MCP server 配置、工具元信息以及工具调用结果，
// 被 McpClient 与上层 agent runtime 共享。

/** MCP server 配置（从 agent manifest 的 mcp 段解析而来） */
export interface McpServerConfig {
  id: string;
  name: string;
  version: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** v1.6：来源标识。'marketplace' 装的不可删（需走卸载按钮），'custom' 可删。缺省按 'marketplace' 处理 */
  source?: 'marketplace' | 'custom';
  /** v1.6：注册时间 ISO 字符串。缺省时由 DB 列默认值 datetime('now') 填充 */
  installedAt?: string;
}

/**
 * v1.6：listRegistered 返回的项。与 McpServerConfig 的区别是 source / installedAt 在
 * DB 中都有 NOT NULL DEFAULT，从 DB 读出的行这两个字段必然有值，故用独立类型表达「必填」。
 * renderer 端的 RegisteredMcp 与此结构对齐。
 */
export interface RegisteredMcp {
  id: string;
  name: string;
  version: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  source: 'marketplace' | 'custom';
  installedAt: string;
}

/** MCP 工具信息（从 tools/list 响应解析） */
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP 工具调用结果（tools/call 响应） */
export interface McpToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
  }>;
  isError: boolean;
}
