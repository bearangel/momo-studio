// electron/src/main/lsp/manager.ts
// 多语言 LSP 客户端管理器——自 agent/tools/lsp-tools.ts 的内嵌实现迁移并按语言
// 参数化（spec §6）。迁移纪律：除以下七处参数化外与原实现逐行一致——
// JSON-RPC 分帧 / pending 表 / 诊断代数等待 / didOpen·didChange 同步 /
// 闲置 shutdown / 意外退出恢复 / 单飞启动，均原样保留。
//   (1) 构造注入 LanguageServerSpec（语言规格，取代 TS 专用硬编码）
//   (2) 二进制探测改 findBinaryInPath(spec.binaries)（原 node_modules/.bin 向上查找）
//   (3) initializationOptions 取 spec.initOverrides（原恒空对象）
//   (4) 文档同步 languageId 取 spec.languageId（原按扩展名推断）
//   (5) 单例表键控 workspaceId:languageId + 每 workspace 并发上限 + 启动失败驱逐
//   (6) isIdle 三态查询（run-state.ts 消费）
//   (7) 单飞启动语义保留（类内 startingPromise，并发调用复用同一启动）
// 旧内嵌实现（agent/tools/lsp-tools.ts）本任务不删——Task 5 切 IPC 时移除。

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { findBinaryInPath, type LanguageServerSpec } from './registry';

// ────────────────────────────────────────────────────────────────────────────
// 常量（与原实现一致）
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

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}
export interface LspLocation {
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

/** file:// URI → 绝对路径（解码百分号转义）。导出供 IPC/工具层复用，避免重复定义 */
export function fileUriToPath(uri: string): string {
  if (uri.startsWith('file://')) return decodeURIComponent(uri.slice('file://'.length));
  return uri;
}

// ────────────────────────────────────────────────────────────────────────────
// LspManager：per-workspace per-language 单例，封装 LSP 子进程生命周期
// ────────────────────────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * 单个 workspace 单门语言的 LSP server 管理。
 *
 * 生命周期：
 *   未启动 → ensureStarted() spawn + initialize 握手 → started=true
 *   调用 getDiagnostics/findReferences 触发文档同步 + 请求
 *   闲置 5 分钟 / 显式 shutdown() → 杀进程 → started=false（单例对象保留，可再次 ensureStarted）
 */
export class LspManager {
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
  /** 当前是否已计入 workspace 活跃计数（shutdown/意外退出幂等释放的守卫标记） */
  private slotCounted = false;

  constructor(
    private readonly workspaceId: string,
    private readonly workspaceDir: string,
    private readonly spec: LanguageServerSpec,
  ) {}

  /** server 是否已启动（initialize 握手完成） */
  isStarted(): boolean {
    return this.started;
  }

  /** 是否闲置（已启动且 60s 无活动）——run-state 三态查询消费（spec §9） */
  isIdle(): boolean {
    return this.started && Date.now() - this.lastActivity > 60_000;
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
    const bin = findBinaryInPath(this.spec.binaries);
    if (!bin) {
      throw new Error(`语言服务 ${this.spec.label} 未安装——${this.spec.installHint}`);
    }
    const proc = spawn(bin, this.spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // 探测已解析出可执行路径（含相对形态，spawn 按 cwd 解析），直接 spawn
      shell: false,
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
      initializationOptions: this.spec.initOverrides ?? {},
    });

    // initialized 通知——LSP 规范要求握手收尾，params 必须是空对象。
    this.sendNotification('initialized', {});

    this.started = true;
    this.lastActivity = Date.now();
    // server 转入 running 才占活跃槽：spawn 失败 / 握手超时的实例不计数，
    // 与 ensureLspManager 的失败驱逐语义对齐（驱逐后不留悬空计数）。
    this.occupySlotIfAbsent();
    this.startIdleTimer();
  }

  /** 获取某文件的诊断。仅在实际同步（didOpen/didChange）后等待 server 回送诊断；
   *  内容未变时直接返回缓存（避免无谓 15s 等待）。 */
  async getDiagnostics(absPath: string, content: string): Promise<LspDiagnostic[]> {
    await this.ensureStarted();
    const uri = pathToFileUri(absPath);
    this.touchActivity();
    const synced = await this.syncDocument(uri, content);
    if (synced) {
      // 记录同步前的诊断代数；等待代数增长（说明 server 已对本次同步回送诊断）。
      const genBefore = this.diagGen.get(uri) ?? 0;
      await this.waitForDiagnostics(uri, genBefore);
    }
    return this.diagCache.get(uri) ?? [];
  }

  /** 查找符号引用。line0/char0 为 0-based（工具层已把 1-based 行号转成 0-based）。
   *  首次/变更同步后需等 server 完成项目加载分析，否则跨文件引用会漏报。 */
  async findReferences(absPath: string, line0: number, char0: number): Promise<LspLocation[]> {
    await this.ensureStarted();
    const uri = pathToFileUri(absPath);
    this.touchActivity();
    const content = await fs.promises.readFile(absPath, 'utf-8');
    const synced = await this.syncDocument(uri, content);
    if (synced) {
      // 等待 publishDiagnostics 到达——它标志 server 已加载并分析文档（及项目），
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
      this.releaseSlotIfCounted();
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
    this.releaseSlotIfCounted();
    this.stopIdleTimer();
    this.resetState();
    // 不抛错——由 pending 请求的 reject 把错误传给调用方；这里只标记状态。
    void reason;
  }

  // ── 活跃计数（workspace 级并发保险丝，spec §6） ──────────────────────────

  /** 占活跃槽（幂等：restart 场景由 slotCounted 防重复计数） */
  private occupySlotIfAbsent(): void {
    if (this.slotCounted) return;
    occupySlot(this.workspaceId);
    this.slotCounted = true;
  }

  /** 释放活跃槽（幂等；计数下限 0） */
  private releaseSlotIfCounted(): void {
    if (!this.slotCounted) return;
    releaseSlot(this.workspaceId);
    this.slotCounted = false;
  }

  // ── 文档同步 ────────────────────────────────────────────────────────────

  /** 首次 didOpen；内容变更才 didChange（content hash 比对，避免无谓重算）。
   *  返回是否实际同步——调用方据此决定是否等 server 分析完成。 */
  private async syncDocument(uri: string, content: string): Promise<boolean> {
    const languageId = this.spec.languageId;
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
    // server → client 请求（带 method + id）：不支持，忽略。
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
// per-workspace per-language 单例 Map + 并发上限（spec §6）
// ────────────────────────────────────────────────────────────────────────────

/** workspaceId:languageId → LspManager（主进程单例——冷启动全 app 一次，spec §6） */
const managers = new Map<string, LspManager>();
/** 每 workspace 活跃 server 上限（资源保险丝——超限报错不静默杀，spec §6） */
export const MAX_ACTIVE_SERVERS_PER_WS = 3;
/** 每 workspace 活跃 server 计数（server 转 running 占、转 stopped 释） */
const activeCount = new Map<string, number>();

function occupySlot(workspaceId: string): void {
  activeCount.set(workspaceId, (activeCount.get(workspaceId) ?? 0) + 1);
}

function releaseSlot(workspaceId: string): void {
  activeCount.set(workspaceId, Math.max(0, (activeCount.get(workspaceId) ?? 0) - 1));
}

/** 测试钩子：预占活跃槽（不 spawn，只占计数） */
export async function __testOccupySlot(workspaceId: string): Promise<void> {
  occupySlot(workspaceId);
}

/** 查询某 workspace 某语言的 manager（测试 + 生命周期观测用） */
export function getLspManager(workspaceId: string, languageId: string): LspManager | undefined {
  return managers.get(`${workspaceId}:${languageId}`);
}

/** 取或建 LspManager 并确保启动（含上限检查与失败驱逐） */
export async function ensureLspManager(
  workspaceId: string,
  workspaceDir: string,
  spec: LanguageServerSpec,
): Promise<LspManager> {
  const key = `${workspaceId}:${spec.languageId}`;
  let mgr = managers.get(key);
  if (!mgr) {
    // 上限检查仅在 Map miss 分支：并发窗口内多个新语言同时 miss（server 尚未
    // 起来、计数未及增）可能双双过闸——上限是资源保险丝不是硬配额，此竞态可接受。
    if ((activeCount.get(workspaceId) ?? 0) >= MAX_ACTIVE_SERVERS_PER_WS) {
      throw new Error(
        `活跃语言服务已达上限（${MAX_ACTIVE_SERVERS_PER_WS} 门）：请等待闲置回收或减少并行语言任务`,
      );
    }
    mgr = new LspManager(workspaceId, workspaceDir, spec);
    managers.set(key, mgr);
  }
  try {
    await mgr.ensureStarted();
  } catch (err) {
    // 启动失败驱逐单例：下次调用重新尝试（spawn 失败不得毒化 Map——死实例
    // 恒 started=false，每次调用都拿到同一个必败对象且无从恢复）
    managers.delete(key);
    throw err;
  }
  return mgr;
}

/** 关闭全部 manager 并清空 Map 与计数（应用退出 / 测试 teardown 用） */
export async function shutdownAllLspManagers(): Promise<void> {
  await Promise.all([...managers.values()].map((m) => m.shutdown()));
  managers.clear();
  activeCount.clear();
}

// run-state 三态查询实装于 run-state.ts（detect.ts 消费同一路径）；
// 此处转发导出，供 Task 4 IPC 统一从 manager 域引入。
export { getLspRunState } from './run-state';
export type { LspRunState } from './run-state';
