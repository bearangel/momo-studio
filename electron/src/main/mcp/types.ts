// electron/src/main/mcp/types.ts
//
// MCP（Model Context Protocol）相关类型定义。
// 这些类型描述了 MCP server 配置、工具元信息以及工具调用结果，
// 被 McpClient 与上层 agent runtime 共享。

/** config_schema 列的单字段元数据（Smithery configSchema 消费面形状） */
export interface McpConfigSchemaMeta {
  title?: string;
  description?: string;
  /** 字段注入位置；缺省进 header */
  'x-from'?: 'header' | 'query';
}

/** 远程 MCP 配置表单元数据（mcp_definitions.config_schema 列，JSON 序列化） */
export interface McpConfigSchema {
  required?: string[];
  properties?: Record<string, McpConfigSchemaMeta>;
}

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
  /** stdio 子进程工作目录（DXT/MCPB bundle 类命令需要；缺省 = 继承当前进程，零变化） */
  cwd?: string;
  /** remote 端点（transport='streamable_http' 必填，强制 https） */
  url?: string;
  /** remote 请求头（token 等；不落日志） */
  headers?: Record<string, string>;
  /** 配置表单元数据（安装时 Smithery configSchema 原样落库；'{}' 视为无） */
  configSchema?: McpConfigSchema;
  /** 来源标识。缺省按 'marketplace' 处理（modelscope 已于 P2.1 移除） */
  source?: 'marketplace' | 'custom' | 'smithery';
  installedAt?: string;
}

/**
 * P2.5：全字段编辑入参（resource:updateMcpEntry）——RegisterMcpInput 去 name。
 * name 是 agent 引用键，编辑不可改（改名=破坏引用），由通道第一参单独携带。
 * 与 McpServerConfig 的可编辑字段子集：transport/version/args/env/url/headers/cwd
 * 可选，command 必填（远程形态传空串——落库端给空串占位，与注册同构）。
 */
export interface McpEntryUpdateInput {
  /** 传输形态；缺省 'stdio' */
  transport?: 'stdio' | 'streamable_http';
  /** 可选版本号；缺省存 '1.0.0'（DB 列 version NOT NULL） */
  version?: string;
  /** stdio 启动命令（远程形态空串占位——DB 列 NOT NULL） */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 远程端点（transport='streamable_http' 必填，强制 https） */
  url?: string;
  /** 远程请求头（token 等；不落日志） */
  headers?: Record<string, string>;
  /** stdio 子进程工作目录；缺省清 NULL */
  cwd?: string;
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
  /** stdio 子进程工作目录（DB 行 NULL → undefined；缺省 = 继承当前进程） */
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** 配置表单元数据（DB 行 config_schema='{}' → undefined；编辑功能表单回填源） */
  configSchema?: McpConfigSchema;
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

/**
 * P2 isError 语义透传契约（缺陷 #3）：
 * host-manager.callMcpTool 统一返回该形状——text 是拼接后的文本（上层只关心
 * 文本输出），isError 透传 MCP 规范的失败标位，审计与 UI 据此判定 success。
 * 两端 client（McpClient stdio / HttpMcpClient remote）契约层收敛在本接口：
 * 旧实现 HttpMcpClient 直接返回拼接文本（消除 host-manager 的 typeof string
 * 分支后改为返回原始 McpToolResult，本类型在 host-manager 提取层组装）。
 */
export interface McpToolCallOutcome {
  text: string;
  isError: boolean;
}

/**
 * P2 子进程侧失败标位：isError=true 时 doExecuteTool 抛此异常，message =
 * 服务端返回的错误文本（保留模型可见语义文案）；chat loop catch 据此原样
 * 回填到 tool_result chunk（success=false）而不加「工具执行失败:」前缀。
 */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpToolError';
  }
}
