// electron/src/main/agent/runtime-manager.ts
//
// Agent runtime 子进程生命周期管理。每个 agent 实例（instanceId）在独立的
// Node 子进程中运行，主进程通过进程池（Map<instanceId, ChildProcess>）跟踪。
// 子进程入口是同目录编译后的 runtime-entry.js，配置通过环境变量
// AGENT_CONFIG（JSON）传入——这样既避免把敏感字段（token/apiKey）暴露在
// 进程 argv（ps 可见）中，也绕过 IPC 初始化竞态。
//
// 注意：本模块只负责 spawn/stop 骨架。完整的 chat loop（LLM 调用、工具执行）
// 在后续任务（T14+T15）实现；当前 runtime-entry 只做登录 + 发"已上线"消息。

import { fork, spawn, type ChildProcess, type Serializable } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BrowserWindow, ipcMain } from 'electron';
import { logger } from '../logger';
import { getDb } from '../storage/db';
import { getOrStartMcp, listMcpTools, callMcpTool, getMcpConfig } from '../mcp/host-manager';
import { resolveMaxToolCalls } from '../settings/crud';
import type { SubAgentRef, RuntimeSkillRef } from './builtin-tools';
import type { StreamChunk } from './stream-chunk';

/** 启动 agent 子进程所需的全部配置，会以 JSON 序列化后通过 AGENT_CONFIG 传递 */
export interface AgentRuntimeOpts {
  instanceId: string;
  workspaceId: string;
  workspaceDir: string;
  botUserId: string;
  botAccessToken: string;
  homeserverUrl: string;
  systemPrompt: string;
  /** v1.3：仅传 modelName + modelBaseUrl + llmApiKey；platform 由 createLLMProvider 按 baseUrl 自动检测 */
  modelName: string;
  modelBaseUrl?: string;
  llmApiKey: string;
  teamRoomId: string;
  /** workspace owner 的 Matrix userId，子进程据此只接受 owner 邀请（防恶意 room） */
  ownerUserId: string;
  // === v1.3 重命名（原 agentType） ===
  /** agent 角色，决定是否注册 dispatch 工具与监听 dispatch 事件；缺省按 standalone 处理 */
  role?: 'standalone' | 'main' | 'sub';
  /** 主 agent 名下的子 agent 列表（仅 role='main' 时有意义），用于构建 dispatch:<slug> 工具 */
  subAgents?: SubAgentRef[];
  /** 已安装 skill 引用，子进程启动时据此初始化 SkillRegistry */
  skills?: RuntimeSkillRef[];
  /** 该 agent 可用的 MCP server 名列表，工具定义在启动时通过 IPC 向主进程发现 */
  mcpNames?: string[];
  // === M3 工具权限白名单 ===
  /** 允许的工具名列表；空/缺省 = 不启用白名单（全部放行） */
  allowedTools?: string[];
  /** 禁止的工具名列表（优先级高于 allowedTools） */
  deniedTools?: string[];
  // === v1.1 M2 协调 agent ===
  /** 本实例是否为所属 workspace 的协调 agent（团队群非@消息由其接待） */
  isCoordinator?: boolean;
  /** dev 模式标志（由 doSpawnAgent 根据 !app.isPackaged 自动注入） */
  devMode?: boolean;
  // === v1.4 嵌套流式 ===
  /** bot 展示名（子 agent 嵌套时 chip 头部显示，来自 agent_definitions.name） */
  botName?: string;
  /** bot emoji 头像（来自 agent_definitions.icon_emoji） */
  botAvatar?: string;
}

// runtime 进程池：instanceId → 子进程句柄
const runtimes = new Map<string, ChildProcess>();

// === v1.4 流式转发状态 ===

/**
 * 活跃流式会话：roomId → { streamSessionId, child }。
 * 用于 abortStream 按 roomId 定位要中断的子进程会话。
 * start chunk 加入，end chunk / 子进程退出时移除。
 */
const activeStreams = new Map<string, { streamSessionId: string; child: ChildProcess }>();

/**
 * 主窗口引用（由 main/index.ts 通过 setMainWindow 注入）。
 * 流式 chunk 需经 webContents.send('agent:stream') 推到 renderer，
 * 而 runtime-manager 自身不持有窗口，故需外部注入。
 */
let mainWindow: BrowserWindow | null = null;

/** 由 main/index.ts 在创建主窗口后调用，注册窗口引用用于推送流式 chunk */
export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

/** 转发流式 chunk 到 renderer（窗口未就绪/已销毁时静默跳过） */
function relayStreamChunk(chunk: StreamChunk): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('agent:stream', chunk);
  }
}

/**
 * 中断指定房间的活跃流式会话。
 * 通过 IPC 向子进程发送 { type:'abort', streamSessionId }，
 * 子进程的 abortListener（runtime-entry.ts）据此触发 AbortController.abort()。
 */
export function abortStream(roomId: string): void {
  const entry = activeStreams.get(roomId);
  if (!entry) return;
  safeChildSend(entry.child, { type: 'abort', streamSessionId: entry.streamSessionId });
}

/** 注册流式相关 IPC handler（agent:abortStream） */
export function registerStreamIpc(): void {
  ipcMain.handle('agent:abortStream', (_event, roomId: string) => {
    abortStream(roomId);
  });
}

// 测试钩子：非 null 时用指定 argv 代替真实 runtime-entry.js（参考
// conduit/manager 的 setBinaryOverride，使单测能 fork 一个可控的假脚本）。
let runtimeEntryOverride: string[] | null = null;

/** 测试钩子：用给定 argv 替换真实 runtime 入口；传 null 恢复生产行为 */
export function setRuntimeEntryOverride(cmd: string[] | null): void {
  runtimeEntryOverride = cmd;
}

// === 崩溃自动重启 + Circuit Breaker ===

/** 最多自动重启次数（超过后 circuit breaker 触发，不再重启） */
const MAX_RESTART_ATTEMPTS = 3;
/** 递增延迟：第 1 次重启等 2s，第 2 次等 5s，第 3 次等 10s */
const RESTART_DELAYS_MS = [2000, 5000, 10000];

/** 每个 agent 实例的重启计数 + 待触发的定时器句柄 */
interface RestartState {
  count: number;
  timer: NodeJS.Timeout | null;
}

/** instanceId → 重启状态 */
const restartCounts = new Map<string, RestartState>();

/**
 * 标记被主动停止的实例（stopAgent/stopAllAgents 调用时添加）。
 * exit handler 检查此集合：若存在则跳过自动重启——SIGTERM 导致的退出
 * code 通常是 null（≠ 0），若不拦截会被误判为崩溃而触发重启。
 */
const stoppedManually = new Set<string>();

/** 测试钩子：覆盖重启延迟数组，使单测不必等待真实的 2s/5s/10s */
let restartDelaysOverride: number[] | null = null;

/** 测试钩子：设置重启延迟覆盖（传 null 恢复默认） */
export function setRestartDelaysOverride(delays: number[] | null): void {
  restartDelaysOverride = delays;
}

/** 测试钩子：获取某实例当前的重启次数 */
export function getRestartCount(instanceId: string): number {
  return restartCounts.get(instanceId)?.count ?? 0;
}

/** 测试钩子：某实例是否有挂起的重启定时器（用于测试区分"等待重启"和"circuit breaker 已触发"） */
export function hasPendingRestart(instanceId: string): boolean {
  return restartCounts.get(instanceId)?.timer != null;
}

/** 测试钩子：清空全部重启状态（清 timer + 清计数 + 清 stopped 标记） */
export function __resetRestartState(): void {
  for (const state of restartCounts.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  restartCounts.clear();
  stoppedManually.clear();
}

/**
 * 处理 agent 子进程退出事件：
 *   - 正常退出（code=0）或被主动停止 → 清理计数，不重启
 *   - 崩溃（code≠0 且非主动停止）→ 按递增延迟自动重启，最多 MAX_RESTART_ATTEMPTS 次
 *   - 超过上限 → circuit breaker 触发，不再重启（避免无限崩溃-重启循环）
 */
function handleAgentExit(
  instanceId: string,
  code: number | null,
  opts: AgentRuntimeOpts,
  child: ChildProcess,
): void {
  runtimes.delete(instanceId);
  logger.warn('Agent 子进程退出', { instanceId, code });

  // v1.4：清理该子进程名下的活跃流式会话，并向 renderer 发 end(error) 兜底
  // （正常结束时子进程已发过 end chunk，此处 activeStreams 已空，不会重复发）
  for (const [roomId, entry] of activeStreams) {
    if (entry.child === child) {
      relayStreamChunk({
        type: 'end',
        streamSessionId: entry.streamSessionId,
        finishReason: 'error',
        error: 'Agent 进程退出',
      });
      activeStreams.delete(roomId);
    }
  }

  const wasStoppedManually = stoppedManually.has(instanceId);
  stoppedManually.delete(instanceId);

  // 正常退出或手动停止 → 不重启
  if (code === 0 || wasStoppedManually) {
    restartCounts.delete(instanceId);
    return;
  }

  // Circuit breaker 检查
  const state = restartCounts.get(instanceId) ?? { count: 0, timer: null };
  if (state.count >= MAX_RESTART_ATTEMPTS) {
    logger.error('Agent 达到崩溃重启上限，不再自动重启', {
      instanceId,
      attempts: state.count,
    });
    // TODO: 通过 IPC 通知 UI
    return;
  }

  const delays = restartDelaysOverride ?? RESTART_DELAYS_MS;
  const delay = delays[state.count] ?? delays[delays.length - 1] ?? 10000;
  state.count++;
  logger.info('Agent 将在崩溃后重启', {
    instanceId,
    attempt: state.count,
    delayMs: delay,
  });

  state.timer = setTimeout(() => {
    state.timer = null;
    try {
      doSpawnAgent(opts);
      logger.info('Agent 重启成功', { instanceId, attempt: state.count });
    } catch (err) {
      logger.error('Agent 重启失败', { instanceId, error: (err as Error).message });
    }
  }, delay);

  restartCounts.set(instanceId, state);
}

/**
 * 手动重置 circuit breaker。用户在 UI 点"重启"时调用——清除挂起重启定时器
 * + 重置计数，使后续崩溃能重新走完整的重启流程。
 */
export function resetRestartCount(instanceId: string): void {
  const state = restartCounts.get(instanceId);
  if (state?.timer) clearTimeout(state.timer);
  restartCounts.delete(instanceId);
}

/**
 * 启动一个 agent 子进程（公共入口）。用户主动启动时重置 circuit breaker，
 * 确保不是从之前的崩溃恢复状态开始。
 */
export function spawnAgent(opts: AgentRuntimeOpts): void {
  stoppedManually.delete(opts.instanceId);
  resetRestartCount(opts.instanceId);
  doSpawnAgent(opts);
}

/**
 * 实际的 spawn 逻辑。生产路径用 fork() 拉起编译后的 runtime-entry.js；测试路径
 * 在 runtimeEntryOverride 设置时改用 spawn() 拉起假脚本。崩溃重启时直接调用
 * 本函数（不经过 spawnAgent 包装，避免重置正在递增的计数）。
 */
function doSpawnAgent(opts: AgentRuntimeOpts): void {
  const config = { ...opts, devMode: process.env.NODE_ENV !== 'production' };
  const env = { ...process.env, AGENT_CONFIG: JSON.stringify(config) };

  let child: ChildProcess;
  if (runtimeEntryOverride) {
    const [command, ...args] = runtimeEntryOverride;
    if (!command) {
      throw new Error('runtimeEntryOverride argv 为空');
    }
    child = spawn(command, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
  } else {
    // __dirname 在编译后指向 dist/main/agent，runtime-entry.js 同目录。
    const entryPath = path.join(__dirname, 'runtime-entry.js');
    child = fork(entryPath, [], {
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
  }

  // 把子进程 stdout/stderr 转发到主进程日志，便于排查 agent 运行问题。
  child.stdout?.on('data', (chunk) => {
    logger.info(`[agent:${opts.instanceId}] ${String(chunk).trimEnd()}`);
  });
  child.stderr?.on('data', (chunk) => {
    logger.warn(`[agent:${opts.instanceId}] ${String(chunk).trimEnd()}`);
  });
  child.on('exit', (code) => {
    handleAgentExit(opts.instanceId, code, opts, child);
  });
  // spawn 在无法启动二进制（ENOENT 等）时 emit 'error' 而非 'exit'；
  // 不监听会变成未捕获异常，故在此兜底并清理进程池。
  child.on('error', (err) => {
    logger.error('Agent 子进程启动失败', err);
    runtimes.delete(opts.instanceId);
  });
  // 子进程 → 主进程的 MCP 工具调用桥接（MCP Host 在主进程，agent 子进程通过 IPC 请求）
  child.on('message', (msg: unknown) => {
    handleChildMessage(child, opts, msg);
  });

  runtimes.set(opts.instanceId, child);
  logger.info('Agent 子进程已启动', { instanceId: opts.instanceId, bot: opts.botUserId });
}

/**
 * 处理 agent 子进程发来的 IPC 消息。当前响应三类消息：
 *   - mcp:listTools / mcp:callTool：MCP Host 在主进程，子进程通过 IPC 转发
 *   - audit:toolCall：工具调用审计日志，写入 tool_calls 表
 * 未知消息类型静默忽略，便于未来扩展其它 IPC 协议而不破坏旧子进程。
 */
function handleChildMessage(child: ChildProcess, opts: AgentRuntimeOpts, msg: unknown): void {
  const m = msg as {
    type?: string;
    id?: string;
    mcpName?: string;
    toolName?: string;
    args?: Record<string, unknown>;
    inputSummary?: string;
    outputSummary?: string;
    success?: boolean;
    durationMs?: number;
    // v1.4 流式 chunk 字段
    streamSessionId?: string;
    roomId?: string;
    botUserId?: string;
    delta?: string;
    result?: string;
    finishReason?: 'stop' | 'budget_exhausted' | 'interrupted' | 'error';
    error?: string;
    // v1.4 预算解析请求字段
    maxToolCalls?: number;
  };
  if (!m.type) return;

  // v1.4：流式 chunk → 转发到 renderer + 维护 activeStreams
  if (
    m.type === 'start' ||
    m.type === 'thinking' ||
    m.type === 'text' ||
    m.type === 'tool_call' ||
    m.type === 'tool_result' ||
    m.type === 'end'
  ) {
    relayStreamChunk(msg as StreamChunk);
    if (m.type === 'start' && m.streamSessionId && m.roomId) {
      activeStreams.set(m.roomId, { streamSessionId: m.streamSessionId, child });
    }
    if (m.type === 'end' && m.streamSessionId) {
      // end chunk 只带 streamSessionId，按它反查 roomId 删除
      for (const [roomId, entry] of activeStreams) {
        if (entry.streamSessionId === m.streamSessionId) {
          activeStreams.delete(roomId);
          break;
        }
      }
    }
    return;
  }

  // v1.4：预算解析请求（子进程无法直接读 DB，向主进程请求房间级 maxToolCalls）
  if (m.type === 'settings:resolveMaxToolCalls' && m.id && m.roomId) {
    const maxToolCalls = resolveMaxToolCalls(m.roomId);
    safeChildSend(child, { type: 'settings:resolved', id: m.id, maxToolCalls });
    return;
  }

  if (m.type === 'mcp:listTools' && m.id && m.mcpName) {
    void handleChildListTools(child, opts.workspaceId, m.id, m.mcpName);
  } else if (m.type === 'mcp:callTool' && m.id && m.mcpName && m.toolName && m.args) {
    void handleChildCallTool(child, opts.workspaceId, m.id, m.mcpName, m.toolName, m.args);
  } else if (m.type === 'audit:toolCall' && typeof m.toolName === 'string') {
    handleAuditToolCall(opts, {
      toolName: m.toolName,
      inputSummary: m.inputSummary,
      outputSummary: m.outputSummary,
      success: m.success,
      durationMs: m.durationMs,
    });
  }
}

/**
 * 审计桥接：把子进程通过 IPC 发来的工具调用审计日志写入 tool_calls 表。
 * 子进程无法直接访问主进程的 DB 连接，故通过 process.send → child.on('message)
 * 转发到此。写入失败只记录日志不抛出（审计不应阻塞 agent 运行）。
 */
function handleAuditToolCall(
  opts: AgentRuntimeOpts,
  m: {
    toolName: string;
    inputSummary?: string;
    outputSummary?: string;
    success?: boolean;
    durationMs?: number;
  },
): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO tool_calls
         (id, workspace_id, agent_bot_user_id, task_id, tool_name, input_summary, output_summary, success, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      opts.workspaceId,
      opts.botUserId,
      null,
      m.toolName,
      m.inputSummary ?? '',
      m.outputSummary ?? '',
      m.success === false ? 0 : 1,
      m.durationMs ?? 0,
    );
  } catch (err) {
    logger.error('审计日志写入失败', { error: (err as Error).message });
  }
}

/**
 * 安全向子进程发 IPC 消息：子进程退出后 channel 关闭，直接 send 会抛 EPIPE
 * 导致主进程崩溃。connected 检查 + try/catch 双保险（处理检查与发送之间的竞态）。
 */
function safeChildSend(child: ChildProcess, msg: Serializable): void {
  if (!child.connected) return;
  try {
    child.send?.(msg);
  } catch {
    // 子进程退出与发送之间的竞态，忽略
  }
}

/** 子进程请求列出某 MCP 的工具（启动时发现工具定义用）；自动确保 MCP 已启动 */
async function handleChildListTools(
  child: ChildProcess,
  workspaceId: string,
  id: string,
  mcpName: string,
): Promise<void> {
  try {
    const config = getMcpConfig(mcpName);
    if (!config) throw new Error(`MCP ${mcpName} 未注册`);
    await getOrStartMcp(workspaceId, config);
    const tools = await listMcpTools(workspaceId, mcpName);
    safeChildSend(child, { type: 'mcp:toolsResult', id, tools });
  } catch (err) {
    safeChildSend(child, { type: 'mcp:toolsError', id, error: (err as Error).message });
  }
}

/** 子进程请求调用某 MCP 工具；自动确保 MCP 已启动（防止 discovery 失败后调用也失败） */
async function handleChildCallTool(
  child: ChildProcess,
  workspaceId: string,
  id: string,
  mcpName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> {
  try {
    const config = getMcpConfig(mcpName);
    if (config) await getOrStartMcp(workspaceId, config);
    const result = await callMcpTool(workspaceId, mcpName, toolName, args);
    safeChildSend(child, { type: 'mcp:result', id, result });
  } catch (err) {
    safeChildSend(child, { type: 'mcp:error', id, error: (err as Error).message });
  }
}

/** 停止指定 instanceId 的 agent 子进程；不存在则 no-op */
export function stopAgent(instanceId: string): void {
  const child = runtimes.get(instanceId);
  if (!child) return;
  // 标记为主动停止，使 exit handler 跳过自动重启
  stoppedManually.add(instanceId);
  resetRestartCount(instanceId);
  child.kill('SIGTERM');
  runtimes.delete(instanceId);
  logger.info('Agent 子进程已请求停止', { instanceId });
}

/** 停止全部运行中的 agent 子进程（应用退出时调用） */
export function stopAllAgents(): void {
  const count = runtimes.size;
  for (const [instanceId, child] of runtimes) {
    stoppedManually.add(instanceId);
    resetRestartCount(instanceId);
    child.kill('SIGTERM');
  }
  runtimes.clear();
  if (count > 0) {
    logger.info('已停止全部 agent 子进程', { count });
  }
}

/** 指定 instanceId 的 agent 是否正在运行 */
export function isAgentRunning(instanceId: string): boolean {
  return runtimes.has(instanceId);
}
