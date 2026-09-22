// electron/src/main/mcp/http-client.ts
//
// 远程 MCP 客户端（streamable_http 传输，spec 2026-09-22 §4.2 决策 D6）。
// JSON-RPC 2.0 over HTTP POST——与 client.ts 的手写 stdio 客户端同风格、零新依赖。
// 表面对齐 McpClient：connect / isConnected / listTools / callTool / disconnect，
// host-manager.getOrStartMcp 按 transport 分流，进程池逻辑无需感知传输差异。
// SSE 流式响应留 P3（本实现按简单请求-响应处理）。
//
// 与 McpClient 的返回值差异：callTool 直接返回提取后的文本（'\n' 拼接），
// 与 host-manager.callMcpTool 对 stdio 结果的提取语义一致——上层消费同一形态。

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
    await this.post('notifications/initialized', {});
    this.connected = true;
    logger.info('远程 MCP 已连接', { name: this.config.name }); // 不打 url/headers（含 token）
  }

  async listTools(): Promise<McpToolInfo[]> {
    const res = (await this.post('tools/list', {})) as { tools?: McpToolInfo[] };
    return res.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = (await this.post('tools/call', { name, arguments: args })) as McpToolResult;
    return (res.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
  }

  /** 无进程可杀——仅翻状态（进程池语义：下次调用重建） */
  async disconnect(): Promise<void> {
    this.connected = false;
  }

  /** 单次 JSON-RPC POST；error 响应抛错；通知（无 id 期望）也走同一端点 */
  private async post(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const response = await fetch(this.config.url!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...this.config.headers,
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
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
}
