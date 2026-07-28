// electron/src/main/mcp/client.ts
//
// JSON-RPC 2.0 over stdio — MCP 协议的客户端实现。
// 不依赖 @modelcontextprotocol/sdk（避免 ESM/CJS 冲突，主进程是 CommonJS）。
//
// 核心机制：
// - 每个 JSON-RPC 请求带递增 id，响应通过 pending Map 关联到对应 Promise。
// - stdout 按 \n 分割，每行一个 JSON 消息（NDJSON）。
// - 30s 超时防止子进程不响应时永久挂起。
// - 子进程退出时 reject 所有 pending 请求。
// - initialize 握手后发送 notifications/initialized 通知（无 id）。

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from '../logger';
import type { McpServerConfig, McpToolInfo, McpToolResult } from './types';

/** JSON-RPC 2.0 请求（带 id，期望响应） */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 响应（id 与请求配对） */
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** 单个请求的超时时间（毫秒）— 防止子进程无响应时永久挂起 */
const REQUEST_TIMEOUT_MS = 30_000;

/** pending 请求条目：包含 resolver 与超时定时器句柄 */
interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * MCP 客户端 — 通过子进程 stdin/stdout 与 MCP server 通信。
 *
 * 生命周期：connect() -> listTools()/callTool() -> disconnect()
 */
export class McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  /** stdout 未结束的缓冲（最后一个 \n 之后的部分） */
  private buffer = '';
  /** initialize 握手是否完成 */
  private initialized = false;

  constructor(private config: McpServerConfig) {}

  /** 启动子进程并完成 MCP initialize 握手 */
  async connect(): Promise<void> {
    this.proc = spawn(this.config.command, this.config.args, {
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.on('data', (chunk: Buffer) => this.handleData(chunk));
    this.proc.stderr.on('data', (chunk: Buffer) => {
      logger.debug(`[mcp:${this.config.name}] stderr: ${chunk.toString().trim()}`);
    });
    this.proc.on('exit', (code) => {
      logger.warn(`MCP server ${this.config.name} 退出`, { code });
      this.proc = null;
      // 子进程退出时 reject 所有 pending 请求，避免永久挂起
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`MCP server 退出 (code=${code})`));
      }
      this.pending.clear();
    });
    // spawn 失败（ENOENT 等）emit 'error' 而非 'exit'；不监听会变成未捕获异常导致主进程崩溃。
    // 在此兜底：清理 proc + reject 全部 pending（与 'exit' 处理器一致）。
    this.proc.on('error', (err: Error) => {
      logger.error(`MCP ${this.config.name} spawn 错误`, { error: err.message });
      this.proc = null;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`MCP server 启动失败: ${err.message}`));
      }
      this.pending.clear();
    });

    // MCP initialize 握手
    const result = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'AgentPlatform', version: '0.1.0' },
    });
    logger.info(`MCP ${this.config.name} 握手成功`, {
      protocolVersion: (result as { protocolVersion?: string }).protocolVersion,
    });

    // 发 initialized 通知（无 id = notification，server 不回复）
    this.sendNotification('notifications/initialized', {});
    this.initialized = true;
  }

  /** 列出 server 暴露的工具 */
  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.sendRequest('tools/list', {});
    const tools = (result as { tools?: McpToolInfo[] }).tools ?? [];
    return tools;
  }

  /** 调用指定工具 */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.sendRequest('tools/call', { name, arguments: args });
    return result as McpToolResult;
  }

  /** 终止子进程并清理状态 */
  async disconnect(): Promise<void> {
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    // 清理残留 pending（例如尚未超时的请求）
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
    this.initialized = false;
  }

  /** 是否已连接且完成握手 */
  get isConnected(): boolean {
    return this.initialized && this.proc !== null;
  }

  /**
   * 发送 JSON-RPC 请求（带 id），返回响应 result。
   * 超时 30s 自动 reject，防止子进程无响应时永久挂起。
   */
  private async sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.proc) throw new Error(`MCP ${this.config.name} 未连接`);
    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      // 超时定时器：30s 后若仍未响应则 reject
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP 请求超时: ${method} (${REQUEST_TIMEOUT_MS / 1000}s)`));
        }
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.proc.stdin.write(JSON.stringify(request) + '\n');
    return promise;
  }

  /** 发送 JSON-RPC 通知（无 id，不期望响应） */
  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.proc) return;
    const notification = { jsonrpc: '2.0', method, params };
    this.proc.stdin.write(JSON.stringify(notification) + '\n');
  }

  /**
   * 处理 stdout 数据：按 \n 分割，每行一个 JSON 消息。
   * 收到响应时按 id 关联 pending 请求并 resolve/reject。
   */
  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    // 最后一段可能不完整（无结尾 \n），保留到下次拼接
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        logger.warn(`MCP ${this.config.name} JSON 解析失败`, { line: line.slice(0, 100) });
      }
    }
  }
}
