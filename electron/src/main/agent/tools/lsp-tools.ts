// electron/src/main/agent/tools/lsp-tools.ts
// TS/JS 语言服务工具：lsp_diagnostics + lsp_find_references。
//
// 实现策略（spec 7.7 + Task 15）：
//   - 通过 typescript-language-server --stdio 子进程做 LSP（JSON-RPC over stdio）。
//   - Content-Length 头分帧；请求/响应按 id 关联；publishDiagnostics 通知按 uri 缓存。
//   - per-workspace 单例 LspManager（多 agent 共享一个 server 进程）。
//   - 懒启动：首次调 lsp_* 才 spawn；5 分钟闲置自动 shutdown（省 ~200MB tsserver 内存）。
//   - content hash 同步：内容没变跳过 didChange（避免重复计算）。
//   - 坐标：工具接口用 1-based 行号（人类友好），LSP 协议用 0-based 行号（内部转换）。
//   - 条件注册：workspace 含 tsconfig.json / jsconfig.json / 顶层 .ts 或 .js 才注册。

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
import { OUTPUT_LIMITS, truncateArray } from './shared/output-truncate';

// ────────────────────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────────────────────

/** 单次 LSP 请求（initialize / references 等）超时——LSP 启动 3-5s，留足裕量 */
const REQUEST_TIMEOUT_MS = 30_000;
/** 同步文档后等待 publishDiagnostics 的最长时间；超时返回当前缓存（尽力而为） */
const DIAGNOSTIC_WAIT_MS = 15_000;
/** 闲置自动 shutdown 阈值——5 分钟无调用即关停 server 进程 */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** 闲置检查间隔——每 60s 巡检一次 lastActivity */
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

// ────────────────────────────────────────────────────────────────────────────
// LSP / JSON-RPC 类型（仅声明用到的字段，避免 any）
// ────────────────────────────────────────────────────────────────────────────

interface LspPosition {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}
interface LspLocation {
  uri: string;
  range: LspRange;
}

/** JSON-RPC 消息（请求 / 响应 / 通知统一形态，按字段存在性区分） */
interface RpcMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ────────────────────────────────────────────────────────────────────────────
// 工具函数
// ────────────────────────────────────────────────────────────────────────────

/** 绝对路径 → file:// URI（Linux/macOS 路径以 / 开头，结果为 file:///abs） */
function pathToFileUri(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  return 'file://' + (normalized.startsWith('/') ? normalized : '/' + normalized);
}

/** file:// URI → 绝对路径（解码百分号转义） */
function fileUriToPath(uri: string): string {
  if (uri.startsWith('file://')) return decodeURIComponent(uri.slice('file://'.length));
  return uri;
}

/** 文件扩展名 → LSP languageId */
function inferLanguageId(absPath: string): string {
  if (absPath.endsWith('.tsx')) return 'typescriptreact';
  if (absPath.endsWith('.ts')) return 'typescript';
  if (absPath.endsWith('.jsx')) return 'javascriptreact';
  if (absPath.endsWith('.js')) return 'javascript';
  return 'plaintext';
}

/** LSP severity 数值 → 文本标签（1=Error 默认） */
function severityLabel(sev: number | undefined): string {
  switch (sev) {
    case 2:
      return 'warning';
    case 3:
      return 'info';
    case 4:
      return 'hint';
    case 1:
    default:
      return 'error';
  }
}

/**
 * 解析 typescript-language-server 可执行文件路径。
 * 优先从 cwd / __dirname 向上查找 node_modules/.bin（兼容 src 调试与 dist 打包布局）；
 * 找不到则返回裸名，交由 spawn 配合 shell 解析（兜底）。
 */
function resolveServerBin(): string {
  const candidates: string[] = [
    path.join(process.cwd(), 'node_modules', '.bin', 'typescript-language-server'),
  ];
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, 'node_modules', '.bin', 'typescript-language-server'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'typescript-language-server';
}

// ────────────────────────────────────────────────────────────────────────────
// LspManager：per-workspace 单例，封装 LSP 子进程生命周期
// ────────────────────────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * 单个 workspace 的 LSP server 管理。
 *
 * 生命周期：
 *   未启动 → ensureStarted() spawn + initialize 握手 → started=true
 *   调用 getDiagnostics/findReferences 触发文档同步 + 请求
 *   闲置 5 分钟 / 显式 shutdown() → 杀进程 → started=false（单例对象保留，可再次 ensureStarted）
 */
class LspManager {
  private proc: ChildProcess | null = null;
  private recvBuf = Buffer.alloc(0);
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  /** uri → 诊断列表（来自 publishDiagnostics 通知） */
  private readonly diagCache = new Map<string, LspDiagnostic[]>();
  /** uri → 诊断更新代数（每次 publish +1，用于等待「新鲜」诊断） */
  private readonly diagGen = new Map<string, number>();
  /** uri → 最近同步的文档内容（content hash 比对） */
  private readonly openDocs = new Map<string, string>();
  /** uri → 文档版本号（didChange 须单调递增） */
  private readonly docVersion = new Map<string, number>();

  private started = false;
  private startingPromise: Promise<void> | null = null;
  /** shutdown 进行中标记——用于区分「主动 shutdown」与「进程意外退出」 */
  private shuttingDown = false;
  private lastActivity = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly workspaceId: string,
    private readonly workspaceDir: string,
  ) {}

  /** server 是否已启动（initialize 握手完成） */
  isStarted(): boolean {
    return this.started;
  }

  /** 确保 server 已启动；并发调用复用同一个 startingPromise，避免重复 spawn */
  async ensureStarted(): Promise<void> {
    if (this.started) return;
    if (this.startingPromise) return this.startingPromise;
    this.startingPromise = this.doInitialize().finally(() => {
      this.startingPromise = null;
    });
    return this.startingPromise;
  }

  /** spawn 子进程 + 发送 initialize 请求 + 发送 initialized 通知 */
  private async doInitialize(): Promise<void> {
    const bin = resolveServerBin();
    // 裸名（兜底）需 shell 解析 PATH；绝对/相对路径直接 spawn（shebang 自执行）。
    const useShell = !bin.includes(path.sep);
    const proc = spawn(bin, ['--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: useShell,
    });
    this.proc = proc;

    // 所有 handler 闭包捕获本次 spawn 的 proc，与 this.proc 比对：
    // 旧进程被 SIGKILL 后仍会异步派发 exit/error 事件，此时 this.proc 已指向新进程，
    // 必须忽略，否则会误重新 reset 新进程的 pending 请求。
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (this.proc === proc) this.onStdoutData(chunk);
    });
    proc.stderr?.on('data', () => {
      // stderr 仅记录，不影响协议；常见输出是 tsserver 的日志/警告。
    });
    proc.on('error', (err) => {
      if (this.proc === proc) this.handleUnexpectedExit(`spawn 失败: ${err.message}`);
    });
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return;
      if (!this.shuttingDown) {
        this.handleUnexpectedExit(`进程退出 code=${code} signal=${signal}`);
      }
    });

    // initialize 请求：声明客户端能力。
    // 关键：必须声明 textDocument.publishDiagnostics，否则 typescript-language-server
    //   会判定 diagnosticsSupport=false，永远不推送诊断（server 源码显式检查此能力）。
    await this.sendRequest('initialize', {
      processId: process.pid,
      clientName: 'momo-studio',
      rootUri: pathToFileUri(this.workspaceDir),
      capabilities: {
        textDocument: {
          synchronization: {
            didOpen: true,
            didChange: true,
            willSave: false,
            willSaveWaitUntil: false,
          },
          publishDiagnostics: { relatedInformation: true },
        },
      },
      initializationOptions: {},
    });

    // initialized 通知——LSP 规范要求握手收尾，params 必须是空对象。
    this.sendNotification('initialized', {});

    this.started = true;
    this.lastActivity = Date.now();
    this.startIdleTimer();
  }

  /** 获取某文件的诊断。仅在实际同步（didOpen/didChange）后等待 tsserver 回送诊断；
   *  内容未变时直接返回缓存（避免无谓 15s 等待）。 */
  async getDiagnostics(absPath: string, content: string): Promise<LspDiagnostic[]> {
    await this.ensureStarted();
    const uri = pathToFileUri(absPath);
    this.touchActivity();
    const synced = await this.syncDocument(uri, absPath, content);
    if (synced) {
      // 记录同步前的诊断代数；等待代数增长（说明 server 已对本次同步回送诊断）。
      const genBefore = this.diagGen.get(uri) ?? 0;
      await this.waitForDiagnostics(uri, genBefore);
    }
    return this.diagCache.get(uri) ?? [];
  }

  /** 查找符号引用。line0/char0 为 0-based（工具层已把 1-based 行号转成 0-based）。
   *  首次/变更同步后需等待 tsserver 完成项目加载分析，否则跨文件引用会漏报。 */
  async findReferences(absPath: string, line0: number, char0: number): Promise<LspLocation[]> {
    await this.ensureStarted();
    const uri = pathToFileUri(absPath);
    this.touchActivity();
    const content = await fs.promises.readFile(absPath, 'utf-8');
    const synced = await this.syncDocument(uri, absPath, content);
    if (synced) {
      // 等待 publishDiagnostics 到达——它标志 tsserver 已加载并分析文档（及项目），
      // 否则紧随其后的 references 请求可能只命中定义处（项目尚未加载完毕）。
      const genBefore = this.diagGen.get(uri) ?? 0;
      await this.waitForDiagnostics(uri, genBefore);
    }
    const result = await this.sendRequest('textDocument/references', {
      textDocument: { uri },
      position: { line: line0, character: char0 },
      context: { includeDeclaration: true },
    });
    return (result as LspLocation[] | null) ?? [];
  }

  /** 主动 shutdown：按 LSP 规范发 shutdown 请求 + exit 通知，再 SIGKILL 兜底。 */
  async shutdown(): Promise<void> {
    this.stopIdleTimer();
    if (!this.started && !this.proc) {
      this.started = false;
      return;
    }
    this.shuttingDown = true;
    try {
      try {
        await this.sendRequest('shutdown', undefined);
      } catch {
        // shutdown 请求超时也继续清理（不阻塞）。
      }
      try {
        this.sendNotification('exit', undefined);
      } catch {
        // stdin 可能已关闭，忽略。
      }
    } finally {
      this.started = false;
      this.shuttingDown = false;
      if (this.proc) {
        try {
          this.proc.kill('SIGKILL');
        } catch {
          // 进程可能已退出，忽略。
        }
        this.proc = null;
      }
      this.resetState();
    }
  }

  /** 清空所有内部状态（文档/诊断/请求），让下次 ensureStarted 干净重启 */
  private resetState(): void {
    this.openDocs.clear();
    this.docVersion.clear();
    this.diagCache.clear();
    this.diagGen.clear();
    this.recvBuf = Buffer.alloc(0);
    for (const [, p] of this.pendingRequests) {
      clearTimeout(p.timer);
      p.reject(new Error('LSP server 已关闭'));
    }
    this.pendingRequests.clear();
  }

  /** 进程意外退出：拒绝所有 pending 请求，重置状态以便重启 */
  private handleUnexpectedExit(reason: string): void {
    if (!this.started && !this.proc) return;
    this.started = false;
    this.proc = null;
    this.stopIdleTimer();
    this.resetState();
    // 不抛错——由 pending 请求的 reject 把错误传给调用方；这里只标记状态。
    void reason;
  }

  // ── 文档同步 ────────────────────────────────────────────────────────────

  /** 首次 didOpen；内容变更才 didChange（content hash 比对，避免无谓重算）。
   *  返回是否实际同步——调用方据此决定是否等待 tsserver 分析完成。 */
  private async syncDocument(uri: string, absPath: string, content: string): Promise<boolean> {
    const languageId = inferLanguageId(absPath);
    const last = this.openDocs.get(uri);
    if (last === undefined) {
      this.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text: content },
      });
      this.openDocs.set(uri, content);
      this.docVersion.set(uri, 1);
      return true;
    }
    if (last !== content) {
      const v = (this.docVersion.get(uri) ?? 1) + 1;
      this.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: v },
        contentChanges: [{ text: content }], // 全量同步（spec 允许，TS LSP 支持）
      });
      this.openDocs.set(uri, content);
      this.docVersion.set(uri, v);
      return true;
    }
    // 内容未变：跳过同步（spec 决策 5）。
    return false;
  }

  /** 轮询等待 uri 的诊断代数超过 genBefore；超时返回（调用方拿当前缓存） */
  private async waitForDiagnostics(uri: string, genBefore: number): Promise<void> {
    const deadline = Date.now() + DIAGNOSTIC_WAIT_MS;
    while (Date.now() < deadline) {
      if ((this.diagGen.get(uri) ?? 0) > genBefore) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // ── JSON-RPC 收发 ────────────────────────────────────────────────────────

  /** 发送请求并等待响应；超时自动 reject 并清理 pending 表 */
  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`LSP 请求超时 (${REQUEST_TIMEOUT_MS}ms): ${method}`));
        }
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.writeMessage({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** 发送通知（无 id，无响应） */
  private sendNotification(method: string, params?: unknown): void {
    this.writeMessage({ jsonrpc: '2.0', method, params });
  }

  /** 序列化消息并按 Content-Length 分帧写入 stdin */
  private writeMessage(msg: object): void {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error('LSP server 未运行，无法发送消息');
    }
    const body = Buffer.from(JSON.stringify(msg), 'utf-8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    this.proc.stdin.write(Buffer.concat([header, body]));
  }

  /** stdout 数据到达：拼接收缓冲并尝试解析所有完整消息 */
  private onStdoutData(chunk: Buffer): void {
    this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
    this.tryParseMessages();
  }

  /** 循环解析缓冲中的完整 JSON-RPC 消息（可能粘包/半包） */
  private tryParseMessages(): void {
    while (true) {
      const headerEnd = this.recvBuf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return; // 头不完整
      const headerStr = this.recvBuf.subarray(0, headerEnd).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(headerStr);
      if (!m) {
        // 头格式异常：丢弃该头，尝试重新同步。
        this.recvBuf = this.recvBuf.subarray(headerEnd + 4);
        continue;
      }
      const bodyLen = parseInt(m[1] ?? '0', 10);
      const bodyStart = headerEnd + 4;
      if (this.recvBuf.length < bodyStart + bodyLen) return; // 体不完整
      const body = this.recvBuf.subarray(bodyStart, bodyStart + bodyLen).toString('utf-8');
      this.recvBuf = this.recvBuf.subarray(bodyStart + bodyLen);
      let msg: RpcMessage;
      try {
        msg = JSON.parse(body) as RpcMessage;
      } catch {
        continue; // JSON 解析失败：跳过该消息
      }
      this.handleMessage(msg);
    }
  }

  /** 分发消息：响应（有 id + result/error）/ 通知（有 method 无 id）/ server 请求（忽略） */
  private handleMessage(msg: RpcMessage): void {
    // 响应：有 id 且有 result 或 error
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) {
          pending.reject(new Error(`LSP 错误 (${msg.error.code}): ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }
    // 通知：有 method 无 id
    if (msg.method !== undefined && msg.id === undefined) {
      if (msg.method === 'textDocument/publishDiagnostics' && msg.params) {
        const p = msg.params as { uri: string; diagnostics: LspDiagnostic[] };
        this.diagCache.set(p.uri, p.diagnostics ?? []);
        this.diagGen.set(p.uri, (this.diagGen.get(p.uri) ?? 0) + 1);
      }
      // 其他通知（window/logMessage 等）忽略。
      return;
    }
    // server → client 请求（带 method + id）：v1.5 不支持，忽略。
  }

  // ── 闲置管理 ────────────────────────────────────────────────────────────

  private startIdleTimer(): void {
    this.stopIdleTimer();
    this.idleTimer = setInterval(() => this.checkIdle(), IDLE_CHECK_INTERVAL_MS);
    // unref：定时器不应阻止 Node 进程退出（Electron 主进程靠窗口生命周期）。
    this.idleTimer.unref();
  }

  private stopIdleTimer(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private checkIdle(): void {
    if (!this.started) return;
    if (Date.now() - this.lastActivity > IDLE_TIMEOUT_MS) {
      // 异步 shutdown，不阻塞定时器回调。
      void this.shutdown().catch(() => {});
    }
  }

  private touchActivity(): void {
    this.lastActivity = Date.now();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// per-workspace 单例 Map
// ────────────────────────────────────────────────────────────────────────────

/** workspaceId → LspManager（多 agent 共享一个 server 进程） */
const managers = new Map<string, LspManager>();

/** 取或建 LspManager（首次访问时懒构造） */
function ensureManager(workspaceId: string, workspaceDir: string): LspManager {
  let mgr = managers.get(workspaceId);
  if (!mgr) {
    mgr = new LspManager(workspaceId, workspaceDir);
    managers.set(workspaceId, mgr);
  }
  return mgr;
}

/** 查询某 workspace 的 manager（测试 + 生命周期观测用） */
export function getLspManager(workspaceId: string): LspManager | undefined {
  return managers.get(workspaceId);
}

/** 关闭某 workspace 的 manager（停进程，保留单例对象以便复用重启） */
export async function shutdownLspManager(workspaceId: string): Promise<void> {
  const mgr = managers.get(workspaceId);
  if (mgr) await mgr.shutdown();
}

/** 关闭全部 manager 并清空 Map（应用退出 / 测试 teardown 用） */
export async function shutdownAllLspManagers(): Promise<void> {
  const all = Array.from(managers.values());
  managers.clear();
  await Promise.all(all.map((m) => m.shutdown()));
}

// ────────────────────────────────────────────────────────────────────────────
// 条件注册 + 工具定义
// ────────────────────────────────────────────────────────────────────────────

/**
 * workspace 是否应注册 LSP 工具。
 * 触发条件（任一）：根目录有 tsconfig.json / jsconfig.json / 顶层存在 .ts 或 .js 文件。
 */
export function shouldRegister(workspaceDir: string): boolean {
  if (fs.existsSync(path.join(workspaceDir, 'tsconfig.json'))) return true;
  if (fs.existsSync(path.join(workspaceDir, 'jsconfig.json'))) return true;
  try {
    const entries = fs.readdirSync(workspaceDir, { withFileTypes: true });
    return entries.some((e) => e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.js')));
  } catch {
    return false;
  }
}

const DIAGNOSTICS_DEF: LLMToolDef = {
  name: 'lsp_diagnostics',
  description:
    '获取 TS/JS 文件的诊断信息（编译错误/类型警告/lint 提示）。仅 TS/JS workspace 可用。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对 workspace 的 TS/JS 文件路径' },
    },
    required: ['path'],
  },
};

const REFERENCES_DEF: LLMToolDef = {
  name: 'lsp_find_references',
  description: '查找某符号在 workspace 内的所有引用位置（含定义）。用于评估改动影响面。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对 workspace 的 TS/JS 文件路径' },
      line: { type: 'number', description: '1-based 行号' },
      character: { type: 'number', description: '0-based 列号' },
    },
    required: ['path', 'line', 'character'],
  },
};

// ────────────────────────────────────────────────────────────────────────────
// LspTools：ToolModule 实现
// ────────────────────────────────────────────────────────────────────────────

/**
 * LSP 工具模块。条件注册：不可注册的 workspace 返回 null（注册中心跳过）。
 * 私有构造 + 静态 create 强制走条件检查，避免误实例化。
 */
export class LspTools implements ToolModule {
  private constructor() {}

  /** 条件工厂：workspace 不含 TS/JS 时返回 null，注册中心据此跳过本模块 */
  static create(ctx: ToolContext): LspTools | null {
    if (!shouldRegister(ctx.workspaceDir)) return null;
    return new LspTools();
  }

  getDefs(): LLMToolDef[] {
    return [DIAGNOSTICS_DEF, REFERENCES_DEF];
  }

  handles(name: string): boolean {
    return name === 'lsp_diagnostics' || name === 'lsp_find_references';
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (name === 'lsp_diagnostics') return executeDiagnostics(args, ctx);
    if (name === 'lsp_find_references') return executeReferences(args, ctx);
    throw new Error(`未知 lsp 工具: ${name}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 参数解析 + 工具执行
// ────────────────────────────────────────────────────────────────────────────

function parseStringArg(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`参数 "${name}" 缺失或不是字符串`);
  return value;
}

function parseNumberArg(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`参数 "${name}" 缺失或不是数字`);
  }
  return value;
}

/** 格式化单条诊断为「line:char - severity [code]: message」 */
function formatDiagnostic(d: LspDiagnostic): string {
  const line = (d.range.start.line ?? 0) + 1;
  const char = (d.range.start.character ?? 0) + 1;
  const sev = severityLabel(d.severity);
  const code = d.code !== undefined ? ` ${d.code}` : '';
  return `${line}:${char} - ${sev}${code}: ${d.message}`;
}

async function executeDiagnostics(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const relPath = parseStringArg(args.path, 'path');
  const absPath = ctx.wsFs.assertInWorkspace(relPath);
  if (!fs.existsSync(absPath)) throw new Error(`文件不存在: ${relPath}`);
  const content = await fs.promises.readFile(absPath, 'utf-8');

  const mgr = ensureManager(ctx.workspaceId, ctx.workspaceDir);
  const diags = await mgr.getDiagnostics(absPath, content);

  if (diags.length === 0) return `✓ ${relPath} 无诊断`;
  const lines = diags.map((d) => `${relPath}:${formatDiagnostic(d)}`);
  return truncateArray(lines, OUTPUT_LIMITS.lsp_diagnostics, (s) => s);
}

async function executeReferences(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const relPath = parseStringArg(args.path, 'path');
  const line = parseNumberArg(args.line, 'line'); // 1-based
  const character = parseNumberArg(args.character, 'character'); // 0-based
  const absPath = ctx.wsFs.assertInWorkspace(relPath);
  if (!fs.existsSync(absPath)) throw new Error(`文件不存在: ${relPath}`);

  const mgr = ensureManager(ctx.workspaceId, ctx.workspaceDir);
  // 工具接口 1-based 行 → LSP 0-based 行
  const locations = await mgr.findReferences(absPath, line - 1, character);

  if (locations.length === 0) return '(无引用)';
  const lines = locations.map((loc) => {
    const locAbs = fileUriToPath(loc.uri);
    const locRel = path.relative(ctx.workspaceDir, locAbs);
    const l = (loc.range.start.line ?? 0) + 1;
    const c = (loc.range.start.character ?? 0) + 1;
    return `${locRel}:${l}:${c}`;
  });
  return truncateArray(lines, OUTPUT_LIMITS.lsp_references, (s) => s);
}
