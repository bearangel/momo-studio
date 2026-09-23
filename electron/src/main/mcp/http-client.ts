// electron/src/main/mcp/http-client.ts
//
// 远程 MCP 客户端（streamable_http 传输，spec 2026-09-22 §4.2 决策 D6）。
// JSON-RPC 2.0 over HTTP POST——与 client.ts 的手写 stdio 客户端同风格、零新依赖。
// 表面对齐 McpClient：connect / isConnected / listTools / callTool / disconnect，
// host-manager.getOrStartMcp 按 transport 分流，进程池逻辑无需感知传输差异。
// SSE 流式响应留 P3（本实现按简单请求-响应处理）。
//
// 与 McpClient 的返回值差异（P2 修复）：callTool 改为返回原始 McpToolResult
// （含 content+isError），由 host-manager.callMcpTool 统一提取 isError + 拼接文本。
// 旧实现直接返回拼接文本导致 typeof string 分支与 isError 静默丢失（缺陷 #3）
// ——两端 client 现统一返回 McpToolResult，提取层只在 host-manager 一处。

import { logger } from '../logger';
import type { McpServerConfig, McpToolInfo, McpToolResult } from './types';

/** 单请求超时——对齐 stdio 客户端 REQUEST_TIMEOUT_MS */
const REQUEST_TIMEOUT_MS = 30_000;

export class HttpMcpClient {
  private nextId = 1;
  private connected = false;

  constructor(private readonly config: McpServerConfig) {
    if (!config.url) throw new Error('远程 MCP 缺少 url');
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** initialize 握手 + initialized 通知（两次 POST）。失败置 disconnected 并抛错。 */
  async connect(): Promise<void> {
    await this.post('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'momo-studio', version: '2.1.0' },
    });
    await this.notify('notifications/initialized', {});
    this.connected = true;
    logger.info('远程 MCP 已连接', { name: this.config.name }); // 不打 url/headers（含 token）
  }

  async listTools(): Promise<McpToolInfo[]> {
    const res = (await this.post('tools/list', {})) as { tools?: McpToolInfo[] };
    return res.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const res = (await this.post('tools/call', { name, arguments: args })) as McpToolResult;
    return {
      content: res.content ?? [],
      isError: res.isError === true,
    };
  }

  /** 无进程可杀——仅翻状态（进程池语义：下次调用重建） */
  async disconnect(): Promise<void> {
    this.connected = false;
  }

  /** 单次 JSON-RPC 请求（带 id，期望 JSON 响应）；error 响应抛错 */
  private async post(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    if (!response.ok) {
      this.connected = false;
      throw new Error(`远程 MCP ${method} 失败：HTTP ${response.status}`);
    }
    const json = (await response.json()) as {
      result?: unknown;
      error?: { message: string };
    };
    if (json.error) throw new Error(`远程 MCP ${method} 错误：${json.error.message}`);
    return json.result;
  }

  /**
   * JSON-RPC notification（无 id，服务器禁止回应）。MCP streamable HTTP 规范：
   * 纯通知 POST 的合规响应是 202 无 body——只检查 response.ok（202/200 均可），
   * 绝不调用 response.json()（严格服务器回空 body 会让 json() 抛 SyntaxError）。
   */
  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const response = await this.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    if (!response.ok) {
      this.connected = false;
      throw new Error(`远程 MCP ${method} 通知失败：HTTP ${response.status}`);
    }
  }

  /** 共用 POST 管道：统一 headers + 30s 超时，返回原始响应 */
  private async send(body: string): Promise<Response> {
    return fetch(this.config.url!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...this.config.headers,
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }
}
