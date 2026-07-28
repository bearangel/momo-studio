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
