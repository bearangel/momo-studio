// electron/src/main/agent/runtime-spawner.ts
//
// task-driven runtime spawn 适配层——v2 完整实现。
// 提供 WarmPool 需要的 spawn 接口。
//
// 流程：
//   1. buildSpawnOpts 构造完整 AgentRuntimeOpts（复用 spawn-helpers）
//   2. fork runtime-entry.js（AGENT_CONFIG 环境变量传 config）
//   3. 注册 message handler（chunk 转发 → onChunk 回调；audit:toolCall →
//      审计落库 + 周期性配额巡检，P2 Task 8 恢复 v1 被删的审计桥；
//      mcp:listTools / mcp:callTool → 复用 host-manager 按 id 回写响应，
//      P2 Task 9 恢复 task-driven 路径的 MCP 工具可用性）
//   4. 注册 exit handler（→ onExit 回调）
//   5. 返回 SpawnedRuntime 给 WarmPool

import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { logger } from '../logger';
import type { StreamChunk } from './stream-chunk';
import { handleChildMessage } from './internal-event-bridge';
import { insertToolCall } from '../audit/insert';
import { enforceAuditQuota } from '../audit/quota';
import { getOrStartMcp, getMcpConfig, listMcpTools, callMcpTool } from '../mcp/host-manager';
import type { McpToolInfo } from '../mcp/types';
import { generateCompaction, upsertSessionCompaction, type CompactionResultMsg } from '../compaction/service';
import { getMessageByStreamSessionId } from '../storage/messages/repo';
import { nextSeqForMessage, insertEvent } from '../storage/messages/events-repo';

import type { AgentRuntimeOpts } from './runtime-config';

export interface SpawnedRuntime {
  child: ChildProcess;
  assignmentId: string;
  spawnedAt: number;
}

export interface SpawnOpts {
  assignmentId: string;
  runtimeConfig: AgentRuntimeOpts;
  onChunk: (chunk: StreamChunk) => void;
  onExit: (code: number | null) => void;
  /**
   * P0 boot 握手超时（毫秒）：spawnForAgent 等待子进程 runtime-ready 信号的上限，
   * 超时 kill 子进程并以中文错误 reject。缺省 30s；测试可注入小值。
   */
  readyTimeoutMs?: number;
}

const RUNTIME_ENTRY_PATH = path.join(__dirname, 'runtime-entry.js');
const SHUTDOWN_TIMEOUT_MS = 5000;
/** 审计巡检周期：每 200 次 audit:toolCall 写入触发一次 enforceAuditQuota */
const AUDIT_ENFORCE_INTERVAL = 200;

/** boot 握手默认超时——子进程 boot（含 MCP 发现 IPC 往返）远短于此值 */
const RUNTIME_READY_TIMEOUT_MS = 30_000;

/**
 * 测试钩子：覆写 runtime-entry fork 路径。vitest 下 __dirname 指向 src 源码目录
 * （无 .js 产物），fork 级测试用它指向 dist 编译产物；传 null 还原缺省路径。
 */
let runtimeEntryPathOverride: string | null = null;

export function __setRuntimeEntryPathForTest(p: string | null): void {
  runtimeEntryPathOverride = p;
}

/**
 * boot 完成握手 gate（P0 修复）：spawnForAgent resolve 前必须等到子进程的
 * {type:'runtime-ready'}——子进程在注册完 task-config 监听器后发的一次性信号。
 * 未等握手即把 child 交给 AgentRunner.send(task-config) 会把消息丢在监听器
 * 注册前的事件循环窗口内（静默回合丢失，见 tests/agent/runtime-boot-handshake*）。
 *
 * settle 幂等（ready / 超时 / 握手期退出三种终态先到先得）：
 *   - ready        → resolve
 *   - 超时          → kill 子进程 + 中文错误 reject（防孤儿、防静默悬挂）
 *   - 握手期 exit  → 中文错误 reject（exit handler 调 settle(err)，ready 后 no-op）
 */
interface ReadyGate {
  promise: Promise<void>;
  settle: (err: Error | null) => void;
}

function makeReadyGate(child: ChildProcess, timeoutMs: number): ReadyGate {
  let settled = false;
  let resolveFn!: () => void;
  let rejectFn!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    try {
      child.kill();
    } catch {
      // 子进程已退出
    }
    rejectFn(
      new Error(
        `runtime 启动握手超时（${Math.round(timeoutMs / 1000)}s 内未收到 runtime-ready 信号），` +
          '子进程已终止，本次派发中止',
      ),
    );
  }, timeoutMs);
  timer.unref?.();
  return {
    promise,
    settle(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) rejectFn(err);
      else resolveFn();
    },
  };
}

/** 审计写入计数器（模块级，跨全部 runtime 共享——配额是 per-workspace 全局资源） */
let auditToolCallCounter = 0;

/** 测试专用：重置审计写入计数器 */
export function __resetAuditCounterForTest(): void {
  auditToolCallCounter = 0;
}

/**
 * 子进程 audit:toolCall 消息的宽松形状。子进程 tools/shared/audit.ts 的载荷
 * 只含工具字段（无 workspace/agent 身份），身份由 spawn 闭包的 runtimeConfig
 * 补全；字段类型未校验，消费侧经 String()/Number()/=== true 收敛。
 */
interface AuditToolCallChildMsg {
  type?: string;
  toolName?: unknown;
  inputSummary?: unknown;
  outputSummary?: unknown;
  success?: unknown;
  durationMs?: unknown;
}

/**
 * 子进程 mcp 请求消息的宽松形状（mcp-bridge.ts 定型的线协议）。
 * 响应按 id 回写且不带 type 字段——子进程只按 m.id 配对，不检查 type。
 */
interface McpChildRequestMsg {
  type?: string;
  id?: unknown;
  workspaceId?: unknown;
  mcpName?: unknown;
  toolName?: unknown;
  args?: unknown;
}

/** mcp 桥回写响应的线协议形状（与子进程 mcp-bridge.ts 的配对解析对齐） */
type McpBridgeResponse =
  | { id: string; tools?: McpToolInfo[] }
  | { id: string; result?: string; isError?: boolean }
  | { id: string; error?: string };

/**
 * 收敛任意 throwable 为消息文本。string rejection 等非 Error 抛出物的
 * `(err as Error).message` 是 undefined，子进程 `m.error !== undefined` 检查
 * 会误判为成功空载荷——必须显式 String() 化（与 audit 分支的防御风格一致）。
 */
function throwableText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 子进程 compaction:request 消息的宽松形状（runtime-entry.requestCompaction 定型
 * 的线协议，spec §4.4）。coveredUntil 可能经 IPC 类型漂移为字符串，消费侧收敛。
 */
interface CompactionRequestChildMsg {
  type?: string;
  streamSessionId?: unknown;
  sessionId?: unknown;
  conversation?: unknown;
  coveredUntil?: unknown;
}

/**
 * 消费子进程 compaction:request（spec §4.4 主进程侧分支）：
 *   generateCompaction 成功 → upsertSessionCompaction（covered_until 用请求自带值）
 *   → 回写 { type:'compaction:result', ok:true, summary }；异常回写 ok:false + error。
 *
 * 独立导出（respond 注入）而非内联在 messageHandler——契约测试不经真实 fork
 * 直接锁线协议两端形状。返回 false 表示消息不属于本分支（messageHandler 继续
 * 走后续 chunk 转发路径）。
 */
export async function handleCompactionRequestMsg(
  msg: unknown,
  respond: (payload: CompactionResultMsg) => void,
): Promise<boolean> {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as CompactionRequestChildMsg;
  if (m.type !== 'compaction:request') return false;
  const streamSessionId = m.streamSessionId;
  const sessionId = m.sessionId;
  // 配对键/落库键缺失即线协议破坏——无法回写结果（无 streamSessionId 可寻址），
  // 与 mcp 分支「id 非字符串无法配对即忽略」同款处置；子进程 10s 超时兜底
  if (typeof streamSessionId !== 'string' || typeof sessionId !== 'string') return false;

  const rawCovered = Number(m.coveredUntil);
  const coveredUntil = Number.isFinite(rawCovered) ? Math.trunc(rawCovered) : Date.now();
  const conversation = typeof m.conversation === 'string' ? m.conversation : String(m.conversation ?? '');

  try {
    const { summary } = await generateCompaction({ sessionId, conversation });
    upsertSessionCompaction(sessionId, summary, coveredUntil);
    respond({ type: 'compaction:result', streamSessionId, ok: true, summary });
  } catch (err) {
    respond({
      type: 'compaction:result',
      streamSessionId,
      ok: false,
      error: throwableText(err),
    });
  }
  return true;
}

/**
 * 惰性启动（或复用）workspace 进程池内的指定 MCP server。task-driven 路径没有
 * v1 的 eager 预启动环节（池为空时 listMcpTools/callMcpTool 直接抛「未启动」），
 * 响应 mcp 请求前先按 mcp_definitions 定义拉起；已在池中且连接存活时
 * getOrStartMcp 是廉价 no-op。未注册 / 启动失败抛错，由调用分支回写 {id, error}。
 */
async function ensureMcpStarted(workspaceId: string, mcpName: string): Promise<void> {
  const config = getMcpConfig(mcpName);
  if (!config) throw new Error(`MCP ${mcpName} 未注册`);
  await getOrStartMcp(workspaceId, config);
}

export async function spawnForAgent(opts: SpawnOpts): Promise<SpawnedRuntime> {
  const { assignmentId, runtimeConfig, onChunk, onExit } = opts;

  // AGENT_CONFIG 环境变量传递 runtime config
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_CONFIG: JSON.stringify(runtimeConfig),
  };

  // fork runtime-entry.js
  // win32 shell 豁免（v2.10 spawn 审计）：fork 经 process.execPath（node/
  // Electron 自身绝对路径，真 PE）启动——无裸命令 .cmd shim 解析问题，不会
  // ENOENT；WarmPool 注入的 spawn 同源本路径（agent-runner 的 runtime 全部
  // 经此拉起），故不加 shell 分支（对照 mcp/client.ts 的裸命令 npx 问题）。
  const child = fork(runtimeEntryPathOverride ?? RUNTIME_ENTRY_PATH, [], {
    env,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });

  // P0 boot 握手 gate：fork 后立即创建（监听器注册与 fork 同一同步块，不存在
  // 信号先于监听器到达的竞态窗口）
  const readyGate = makeReadyGate(child, opts.readyTimeoutMs ?? RUNTIME_READY_TIMEOUT_MS);

  // 按线协议回写 MCP 响应。子进程可能已在 await 期间死亡（release kill / 中止
  // 竞态）——通道关闭时 send 同步抛 ERR_IPC_CHANNEL_CLOSED；吞掉避免 async
  // listener reject 成 unhandledRejection 崩溃主进程（响应本就无法送达）。
  const sendMcpResponse = (payload: McpBridgeResponse): void => {
    try {
      child.send(payload);
    } catch {
      // 通道已关闭，无法回写
    }
  };

  // 压缩结果回写（同款通道关闭防御；spec §4.4）
  const sendCompactionResult = (payload: CompactionResultMsg): void => {
    try {
      child.send(payload);
    } catch {
      // 通道已关闭，无法回写——子进程 10s 超时兜底
    }
  };

  // P1 MCP 发现失败可观测性：per-child 待发列表（事件流渲染入口）
  // 子进程 mcp-bridge discoverMcpTools 单 server 失败时发
  // {type:'mcp-discovery-failed', serverName, error}；主进程累积到首个 start
  // chunk 时一次性 flush 为 status_change 事件挂到该消息行（message_events 表
  // 即事件流渲染入口——renderer 已有事件流渲染，无需新增 UI）。
  const pendingDiscoveryFailures: Array<{ serverName: string; error: string }> = [];

  // wrappedOnChunk：流 chunk 转给调用方（routeChunkToBuffer）前先尝试 flush
  // 待发发现失败。flush 时机 = start chunk 之后（此时消息行已 INSERT，可解析
  // messageId 挂事件）。messageId 不可解析 → 不崩，pending 保留待下次 start 重发。
  //
  // 直接 insertEvent（绕过 MessageEventBuffer）：一次性事件量极小（≤ 几个 MCP），
  // 避免 buffer 的 50ms 聚合延迟 + onFlush 回调在非 Electron 环境的兼容复杂度。
  // 失败保留 pending，下次 start 重试（与 segment_boundary 即时落库一致）。
  const flushPendingDiscoveryFailures = (streamSessionId: string): void => {
    if (pendingDiscoveryFailures.length === 0) return;
    let messageId: string | null | undefined;
    try {
      messageId = getMessageByStreamSessionId(streamSessionId)?.id ?? null;
    } catch (err) {
      logger.warn('flushPendingDiscoveryFailures 解析 messageId 失败（DB 故障？）', {
        assignmentId,
        streamSessionId,
        error: throwableText(err),
      });
      return;
    }
    if (!messageId) return; // 待下次 start
    let succeeded = 0;
    for (const f of pendingDiscoveryFailures) {
      try {
        insertEvent({
          messageId,
          seq: nextSeqForMessage(messageId),
          eventType: 'status_change',
          payload: {
            status: 'streaming',
            notice: `MCP "${f.serverName}" 工具发现失败：${f.error}；本次回合该 MCP 工具不可用`,
            mcpDiscoveryFailed: { serverName: f.serverName, error: f.error },
          },
        });
        succeeded++;
      } catch (err) {
        logger.error('mcp-discovery-failed 落库失败（pending 保留待下次 start）', {
          assignmentId,
          streamSessionId,
          serverName: f.serverName,
          error: throwableText(err),
        });
      }
    }
    if (succeeded === pendingDiscoveryFailures.length) {
      pendingDiscoveryFailures.length = 0;
    }
  };
  const wrappedOnChunk = (chunk: StreamChunk): void => {
    if (chunk.type === 'start') {
      opts.onChunk(chunk);
      // start chunk 经 routeChunkToBuffer 已同步插入 messages 行——此处 flush 安全
      flushPendingDiscoveryFailures(chunk.streamSessionId);
      return;
    }
    opts.onChunk(chunk);
  };

  // 注册 message handler（chunk 转发）。handler 为 async：仅 mcp 分支含 await，
  // handleChildMessage / audit 分支仍同步执行，优先语义与 T8 行为不变。
  const messageHandler = async (msg: unknown): Promise<void> => {
    // 内部事件（dispatch/task_reply/abort_dispatch）优先转给桥处理；已消费则不进 chunk 通道
    if (handleChildMessage(msg)) return;
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as AuditToolCallChildMsg & McpChildRequestMsg;
    // P0 boot 握手：子进程监听器注册完毕的一次性信号——resolve readyGate
    if (m.type === 'runtime-ready') {
      readyGate.settle(null);
      return;
    }
    // P1 MCP 发现失败：子进程逐 server 上报，主进程 warn + 入待发列表
    if (m.type === 'mcp-discovery-failed') {
      const mm = m as { serverName?: unknown; error?: unknown };
      const serverName = String(mm.serverName ?? '');
      const error = String(mm.error ?? '');
      pendingDiscoveryFailures.push({ serverName, error });
      logger.warn('MCP tool discovery failed（已累积待首个 start chunk 落库）', {
        assignmentId,
        serverName,
        error,
      });
      return;
    }
    // 审计桥（P2 Task 8，恢复 v1 被删的桥接）：子进程 audit.ts 的 process.send
    // 载荷无 workspace/agent 身份，用 spawn 闭包的 runtimeConfig 补全。
    // durationMs 可能是字符串/浮点/NaN（IPC 类型漂移），收敛为安全整数。
    if (m.type === 'audit:toolCall') {
      // 审计桥 + 配额巡检包 try/catch——DB 锁/表满/巡检失败不应让 message handler
      // reject 触发 unhandledRejection（child 'message' 事件是 EventEmitter 路径，
      // 抛错即进程级风险）。失败仅记 warn，与下方 MCP 分支防御风格一致。
      try {
        const rawDuration = Number(m.durationMs ?? 0);
        insertToolCall({
          workspaceId: runtimeConfig.workspaceId,
          agentBotUserId: runtimeConfig.agentUserId,
          toolName: String(m.toolName ?? ''),
          inputSummary: String(m.inputSummary ?? ''),
          outputSummary: String(m.outputSummary ?? ''),
          success: m.success === true,
          durationMs: Number.isFinite(rawDuration) ? Math.trunc(rawDuration) : 0,
        });
        // 每 200 次写入触发一次配额巡检（模块级计数器）
        if (++auditToolCallCounter % AUDIT_ENFORCE_INTERVAL === 0) {
          enforceAuditQuota(runtimeConfig.workspaceId);
        }
      } catch (err) {
        logger.warn('audit:toolCall 写入或配额巡检失败（已吞错，不污染 chunk 通道）', {
          assignmentId,
          error: throwableText(err),
        });
      }
      return;
    }
    // 压缩桥（spec §4.4）：子进程 requestCompaction 的 compaction:request——
    // 主进程 CompactionService 生成结构化摘要并落库后回写配对结果
    if (m.type === 'compaction:request') {
      await handleCompactionRequestMsg(m, sendCompactionResult);
      return;
    }
    // MCP 桥（P2 Task 9）：子进程 mcp-bridge.ts 的工具发现/调用请求，复用
    // 主进程 host-manager 进程池，按 id 回写配对响应（字段经 String() 收敛，
    // 与 audit 分支同样容忍 IPC 类型漂移）。id 非字符串时无法配对，落入下方忽略。
    if (m.type === 'mcp:listTools' && typeof m.id === 'string') {
      try {
        // 惰性填充进程池（task-driven 路径无预启动；已启动时为廉价 no-op）
        await ensureMcpStarted(String(m.workspaceId), String(m.mcpName));
        const tools = await listMcpTools(String(m.workspaceId), String(m.mcpName));
        sendMcpResponse({ id: m.id, tools });
      } catch (err) {
        sendMcpResponse({ id: m.id, error: throwableText(err) });
      }
      return;
    }
    if (m.type === 'mcp:callTool' && typeof m.id === 'string') {
      try {
        // 同上：防御 discovery 被跳过时池为空的调用路径
        await ensureMcpStarted(String(m.workspaceId), String(m.mcpName));
        // P2 修复：callMcpTool 返回 {text, isError}——同步透传到子进程 mcp-bridge
        // requestMcpCall（doExecuteTool 据 isError 置 tool_call_result success=
        // false，模型仍收到 text 内容）
        const outcome = await callMcpTool(
          String(m.workspaceId),
          String(m.mcpName),
          String(m.toolName),
          (m.args as Record<string, unknown>) ?? {},
        );
        sendMcpResponse({ id: m.id, result: outcome.text, isError: outcome.isError });
      } catch (err) {
        sendMcpResponse({ id: m.id, error: throwableText(err) });
      }
      return;
    }
    // StreamChunk 类型的消息转发给 wrappedOnChunk（先触发下游 routeChunkToBuffer，
    // 再 flush 待发的 MCP 发现失败事件挂到该消息行——P1 注入点）
    if (m.type && ['start', 'thinking', 'text', 'tool_call', 'tool_result', 'todo_update', 'end', 'segment_boundary', 'message_roll'].includes(m.type)) {
      wrappedOnChunk(msg as StreamChunk);
    }
    // 其他类型的消息（task-end 等）由调用方在 child.on('message') 内处理
  };
  child.on('message', messageHandler);

  // 注册 exit handler。握手期退出同时 settle readyGate（err）——spawnForAgent
  // 以中文错误 reject 而非悬挂；ready 之后的 exit 对已 settle 的 gate 是 no-op。
  const exitHandler = (code: number | null): void => {
    logger.info('runtime 退出', { assignmentId, code });
    readyGate.settle(
      new Error(`runtime 子进程在启动握手完成前退出（exit code=${code ?? 'null'}）`),
    );
    onExit(code);
  };
  child.on('exit', exitHandler);

  logger.info('runtime 已 spawn（等待 boot 握手）', { assignmentId, pid: child.pid });

  // P0 boot 握手：等子进程 runtime-ready（= task-config 监听器已注册）后才算
  // spawn 完成。WarmPool 据此保证 acquire 返回的 runtime 可立即接收 task-config。
  await readyGate.promise;

  return {
    child,
    assignmentId,
    spawnedAt: Date.now(),
  };
}

export async function stopRuntime(child: ChildProcess, opts?: { timeoutMs?: number }): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;

  // 1. 发 shutdown 消息（让 runtime 优雅退出）
  if (child.connected) {
    child.send({ type: 'shutdown' });
  }

  // 2. 等待 timeoutMs
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 1000);
      }
      resolve();
    }, timeoutMs);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
