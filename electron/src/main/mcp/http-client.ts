// electron/src/main/mcp/http-client.ts
//
// 远程 MCP 客户端（streamable_http 传输，spec 2026-09-22 §4.2 决策 D6）。
// JSON-RPC 2.0 over HTTP POST——与 client.ts 的手写 stdio 客户端同风格、零新依赖。
// 表面对齐 McpClient：connect / isConnected / listTools / callTool / disconnect，
// host-manager.getOrStartMcp 按 transport 分流，进程池逻辑无需感知传输差异。
// SSE 流式响应解析（2026-09-23 context7 官方端点实测修，streamable-HTTP 合规）：
//   - Accept 双声明 application/json, text/event-stream——spec 允许服务器以两种
//     媒体类型回应，只声明 json 会被严格服务器 406 拒绝（context7 实测）
//   - 响应按 content-type 分流：application/json 走整体 json()（现行路径）；
//     text/event-stream 流式逐帧解析，取 id 匹配当前请求的 JSON-RPC 消息
//     （同一 SSE 流上可能夹杂服务器推送的通知与其他请求的响应，均跳过）
//   - initialize 响应 MAY 带 Mcp-Session-Id，客户端须在后续请求回显；
//     无状态服务器（context7）不发此头，则不带
//
// 与 McpClient 的返回值差异（P2 修复）：callTool 改为返回原始 McpToolResult
// （含 content+isError），由 host-manager.callMcpTool 统一提取 isError + 拼接文本。
// 旧实现直接返回拼接文本导致 typeof string 分支与 isError 静默丢失（缺陷 #3）
// ——两端 client 现统一返回 McpToolResult，提取层只在 host-manager 一处。

import { logger } from '../logger';
import type { McpServerConfig, McpToolInfo, McpToolResult } from './types';

/** 单请求超时——对齐 stdio 客户端 REQUEST_TIMEOUT_MS */
const REQUEST_TIMEOUT_MS = 30_000;

/** JSON-RPC 响应消息的最小消费面（result / error 二选一） */
interface JsonRpcResponseShape {
  result?: unknown;
  error?: { message: string };
}

export class HttpMcpClient {
  private nextId = 1;
  private connected = false;
  /** initialize 握手返回的服务器会话 id；无状态服务器不发（null = 后续请求不回显） */
  private sessionId: string | null = null;

  constructor(private readonly config: McpServerConfig) {
    if (!config.url) throw new Error('远程 MCP 缺少 url');
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** initialize 握手 + initialized 通知（两次 POST）。失败置 disconnected 并抛错。 */
  async connect(): Promise<void> {
    // 走 rpc 而非 post：initialize 还要读响应头里的 Mcp-Session-Id
    const { response, message } = await this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'momo-studio', version: '2.1.0' },
    });
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    if (message.error) throw new Error(`远程 MCP initialize 错误：${message.error.message}`);
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

  /** 单次 JSON-RPC 请求（带 id）；error 响应抛错 */
  private async post(method: string, params: Record<string, unknown>): Promise<unknown> {
    const { message } = await this.rpc(method, params);
    if (message.error) throw new Error(`远程 MCP ${method} 错误：${message.error.message}`);
    return message.result;
  }

  /** 发送带 id 的请求并读回响应消息；同时返回原始 Response（initialize 读会话头用） */
  private async rpc(
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ response: Response; message: JsonRpcResponseShape }> {
    const id = this.nextId++;
    const response = await this.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    if (!response.ok) {
      this.connected = false;
      throw new Error(`远程 MCP ${method} 失败：HTTP ${response.status}`);
    }
    const message = await this.readMessage(response, id, method);
    return { response, message };
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

  /**
   * 响应体分流：按 content-type 决定解析方式（近似匹配——服务器常带 charset 后缀）。
   * text/event-stream → SSE 流式逐帧取 id 匹配消息；其余 → 现行整体 json() 路径。
   */
  private async readMessage(
    response: Response,
    id: number,
    method: string,
  ): Promise<JsonRpcResponseShape> {
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      return (await response.json()) as JsonRpcResponseShape;
    }
    return this.readSseMessage(response, id, method);
  }

  /**
   * SSE 流解析（context7 实测形态：`event: message\ndata: {...}\n\n`）：
   * 逐行读 body，data: 行累积进当前帧，空行即帧结束；帧 data 解析为 JSON-RPC
   * 消息后与当前请求 id 对比——命中即为响应（result/error），读到后 cancel
   * 释放连接。event:/id:/retry:/`:` 注释行、非 JSON data 行、id 不匹配的消息
   * （服务器推送的通知 / 其他请求的响应）一律跳过；流结束仍无匹配 → 抛错。
   */
  private async readSseMessage(
    response: Response,
    id: number,
    method: string,
  ): Promise<JsonRpcResponseShape> {
    if (!response.body) {
      throw new Error(`远程 MCP ${method} 响应流提前结束`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = ''; // 尾部未读完的半行（跨 chunk 拼接）
    let dataLines: string[] = []; // 当前帧累积的 data 行（帧内多行以 \n 连接）

    /** 帧结束：把累积 data 解析为 JSON-RPC 消息并对 id；不匹配 / 非 JSON 回 null */
    const takeFrame = (): JsonRpcResponseShape | null => {
      const data = dataLines.join('\n');
      dataLines = [];
      if (!data) return null;
      try {
        const msg = JSON.parse(data) as JsonRpcResponseShape & { id?: unknown };
        return msg.id === id ? msg : null;
      } catch {
        return null;
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }); // stream:true 处理跨 chunk 多字节 UTF-8
        let newlineAt = buffer.indexOf('\n');
        while (newlineAt !== -1) {
          const line = buffer.slice(0, newlineAt).replace(/\r$/, ''); // 兼容 CRLF
          buffer = buffer.slice(newlineAt + 1);
          if (line === '') {
            const hit = takeFrame();
            if (hit) return hit;
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).replace(/^ /, '')); // SSE 规范：冒号后至多去一个前导空格
          }
          newlineAt = buffer.indexOf('\n');
        }
      }
      // 流关闭：冲刷残留（服务端可能未以空行收尾）+ 解码器尾部字节
      buffer += decoder.decode();
      if (buffer.startsWith('data:')) {
        dataLines.push(buffer.slice(5).replace(/^ /, '').replace(/\r$/, ''));
      }
      const hit = takeFrame();
      if (hit) return hit;
      throw new Error(`远程 MCP ${method} 响应流提前结束`);
    } finally {
      // 命中提前 return / 抛错路径都要释放连接（流已自然结束时 cancel 为 no-op）
      void reader.cancel().catch(() => undefined);
    }
  }

  /** 共用 POST 管道：统一 headers + 30s 超时，返回原始响应 */
  private async send(body: string): Promise<Response> {
    return fetch(this.config.url!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // streamable HTTP：服务器 MAY 以 json 或 SSE 回应，Accept 必须双声明
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...this.config.headers,
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }
}
