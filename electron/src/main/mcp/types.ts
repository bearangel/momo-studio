// electron/src/main/mcp/types.ts
//
// MCP（Model Context Protocol）相关类型定义。
// 这些类型描述了 MCP server 配置、工具元信息以及工具调用结果，
// 被 McpClient 与上层 agent runtime 共享。

/** MCP server 配置（agent manifest mcp 段或资源库安装链解析而来）。
 *  二态：stdio（command/args/env）或 streamable_http（url/headers）——transport 判别。 */
export interface McpServerConfig {
  id: string;
  name: string;
  version: string;
  /** 传输形态；缺省 'stdio'（存量调用方零改动） */
  transport?: 'stdio' | 'streamable_http';
  /** stdio 启动命令（remote 行写空串占位——DB 列 NOT NULL） */
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** remote 端点（transport='streamable_http' 必填，强制 https） */
  url?: string;
  /** remote 请求头（token 等；不落日志） */
  headers?: Record<string, string>;
  /** 来源标识。缺省按 'marketplace' 处理（modelscope 已于 P2.1 移除） */
  source?: 'marketplace' | 'custom' | 'smithery';
  installedAt?: string;
}

/** listRegistered 返回项（source/installedAt/transport 必填——DB 行必然有值） */
export interface RegisteredMcp {
  id: string;
  name: string;
  version: string;
  transport: 'stdio' | 'streamable_http';
  command: string;
  args: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  source: 'marketplace' | 'custom' | 'smithery';
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
