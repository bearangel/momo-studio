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

/**
 * MCP 子进程环境变量白名单——与 agent 工具的 buildSandboxEnv（shell-tools.ts）
 * 同一防线：MCP server 可能来自 marketplace/p2p 第三方，不能继承主进程全部
 * 环境变量（LLM API key 等敏感值）。白名单成员 = 进程运行必需项（npx 类
 * server 依赖 PATH/HOME）+ 本地化；config.env 显式配置在白名单之上再覆盖。
 */
const MCP_ALLOWED_ENV = new Set([
  'PATH',
  'HOME',
  'USER',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'WINDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
]);

// ---------------------------------------------------------------------------
// win32 shell 分支 + spawn 豁免清单（v2.10.0 Windows 全平台化 Task 3）
//
// 背景：Node 的 child_process.spawn 在无 shell 模式下直接走 CreateProcess，
// 只解析 .exe（PATHEXT 不参与）——而 MCP server 的主流启动形态是裸命令
// `npx -y @scope/server`，npx 在 Windows 上实为 npx.cmd 批处理 shim，
// CreateProcess 找不到 npx.exe → spawn ENOENT，MCP server 永远起不来。
//
// 修正：win32 下 spawn opts 加 shell: true（经 cmd.exe 解析 .cmd/.bat shim），
// 并对 command 与 args 逐元素做引号转义（shell 模式下 args 与 command 拼接成
// 一条命令行，不转义的空格/元字符会被 cmd 二次切分或解释——含空格的
// command 本体同样会中招，故同走转义）。
//
// 全仓 spawn 点审计豁免清单（仅 MCP client 需要 shell 分支，其余各点理由）：
//   1. journal/detector.ts defaultGitRunner（spawn 'git'）——git 在 win32 是
//      真 PE（git.exe），CreateProcess 直寻 .exe 可执行，无 shim 解析问题；
//   2. agent/runtime-spawner.ts spawnForAgent（fork runtime-entry）+ WarmPool
//      注入的 spawn——fork 用 process.execPath（node/Electron 绝对路径，真
//      PE），agent-runner 的 runtime 全部经此路径拉起；
//   3. sandbox/probe.ts——win32 分支被平台门天然豁免（不 spawn bwrap）；
//      pwsh 探测走 windows.ts 的 'pwsh.exe'（显式 .exe 后缀真 PE 直寻）；
//   4. scripts/dev.mjs——开发编排器自带 shell: isWin 分支（killAll 的
//      taskkill 亦是真 PE），不在生产链路。
// ---------------------------------------------------------------------------

/** escapeWinArg 白名单：字母数字与对 cmd 解析、argv 切分均无歧义的常见符号
 *  （覆盖包名 @scope/pkg、flag -y/--port=3000、版本 1.2.0、路径 C:/x/y.js） */
const WIN_SAFE_ARG_RE = /^[A-Za-z0-9\-_./:=@+]+$/;

/**
 * win32 shell 模式下的单个参数转义（导出仅为测试锁契约）。
 *
 * 规则：
 *   - 内嵌 `"` → 直接抛错拒绝启动：引号无法穿过「cmd 命令行 + .cmd shim 批
 *     处理」双层解析保真传递，静默转义反而制造难排查的参数破损；
 *   - 白名单安全字符 → 原样返回；
 *   - 其余（含空格，或含 & ^ % ( ) < > | , ; ! 等 cmd 元字符）→ 双引号
 *     包裹——双引号内 cmd 对上述元字符与空格全部字面化。
 *
 * 已知边界（文档化不追防）：`%` 在 cmd 双引号内仍可能被环境变量展开
 * （%VAR% 形态且 VAR 恰有定义时）。参数来自用户本机 MCP 配置（非对抗性
 * 输入），实际 arg 形态（包名/版本号/路径）不含 %；确需传 % 字面量时建议
 * 改用 config.env 段传递。
 */
export function escapeWinArg(arg: string): string {
  if (arg.includes('"')) {
    throw new Error(`MCP 参数包含双引号（"），Windows shell 模式下无法安全转义，已拒绝启动：${arg}`);
  }
  if (WIN_SAFE_ARG_RE.test(arg)) return arg;
  return `"${arg}"`;
}

function buildMcpEnv(configEnv: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) {
    if (MCP_ALLOWED_ENV.has(key)) env[key] = process.env[key];
  }
  return { ...env, ...configEnv };
}

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
    // win32 shell 分支：无 shell 的 spawn 不解析 .cmd/.bat shim（npx 实为
    // npx.cmd），裸命令必 ENOENT——豁免清单与转义规则见模块头部总说明。
    // command 本体与 args 同走 escapeWinArg（终审 I3）：shell 模式下含空格的
    // command（如 C:\Program Files\nodejs\npx.cmd）不转义会被 cmd 切分。
    // linux 下 opts 不含 shell 键（undefined）——非 win32 行为零变化。
    const isWin = process.platform === 'win32';
    this.proc = spawn(
      isWin ? escapeWinArg(this.config.command) : this.config.command,
      isWin ? this.config.args.map(escapeWinArg) : this.config.args,
      {
        env: buildMcpEnv(this.config.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(isWin ? { shell: true } : {}),
      },
    );

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
      clientInfo: { name: 'Momo Studio', version: '0.1.0' },
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
