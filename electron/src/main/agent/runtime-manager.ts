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
import path from 'node:path';
import { logger } from '../logger';
import { getOrStartMcp, listMcpTools, callMcpTool, getMcpConfig } from '../mcp/host-manager';
import type { SubAgentRef, RuntimeSkillRef } from './builtin-tools';

/** 启动 agent 子进程所需的全部配置，会以 JSON 序列化后通过 AGENT_CONFIG 传递 */
export interface AgentRuntimeOpts {
  instanceId: string;
  workspaceId: string;
  workspaceDir: string;
  botUserId: string;
  botAccessToken: string;
  homeserverUrl: string;
  systemPrompt: string;
  modelProvider: string;
  modelName: string;
  llmApiKey: string;
  teamRoomId: string;
  /** workspace owner 的 Matrix userId，子进程据此只接受 owner 邀请（防恶意 room） */
  ownerUserId: string;
  // === M2 集成（可选；缺省时 runtime 退化为纯文件工具模式） ===
  /** agent 形态，决定是否注册 dispatch 工具与监听 dispatch 事件；缺省按 standalone 处理 */
  agentType?: 'standalone' | 'main' | 'sub';
  /** 主 agent 名下的子 agent 列表（仅 type='main' 时有意义），用于构建 dispatch:<slug> 工具 */
  subAgents?: SubAgentRef[];
  /** 已安装 skill 引用，子进程启动时据此初始化 SkillRegistry */
  skills?: RuntimeSkillRef[];
  /** 该 agent 可用的 MCP server 名列表，工具定义在启动时通过 IPC 向主进程发现 */
  mcpNames?: string[];
}

// runtime 进程池：instanceId → 子进程句柄
const runtimes = new Map<string, ChildProcess>();

// 测试钩子：非 null 时用指定 argv 代替真实 runtime-entry.js（参考
// conduit/manager 的 setBinaryOverride，使单测能 fork 一个可控的假脚本）。
let runtimeEntryOverride: string[] | null = null;

/** 测试钩子：用给定 argv 替换真实 runtime 入口；传 null 恢复生产行为 */
export function setRuntimeEntryOverride(cmd: string[] | null): void {
  runtimeEntryOverride = cmd;
}

/**
 * 启动一个 agent 子进程，按 instanceId 注册到进程池。
 *
 * 生产路径用 fork() 拉起编译后的 runtime-entry.js；测试路径在
 * runtimeEntryOverride 设置时改用 spawn() 拉起假脚本（argv 形如
 * ['node', '--import', 'tsx', fakeScript]）。两种路径都会建立 IPC 通道
 * （stdio 末位 'ipc'）并把配置塞进 AGENT_CONFIG 环境变量。
 */
export function spawnAgent(opts: AgentRuntimeOpts): void {
  const env = { ...process.env, AGENT_CONFIG: JSON.stringify(opts) };

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
  child.on('exit', (code, signal) => {
    logger.warn('Agent 子进程退出', { instanceId: opts.instanceId, code, signal });
    runtimes.delete(opts.instanceId);
  });
  // spawn 在无法启动二进制（ENOENT 等）时 emit 'error' 而非 'exit'；
  // 不监听会变成未捕获异常，故在此兜底并清理进程池。
  child.on('error', (err) => {
    logger.error('Agent 子进程启动失败', err);
    runtimes.delete(opts.instanceId);
  });
  // 子进程 → 主进程的 MCP 工具调用桥接（MCP Host 在主进程，agent 子进程通过 IPC 请求）
  child.on('message', (msg: unknown) => {
    handleChildMessage(child, opts.workspaceId, msg);
  });

  runtimes.set(opts.instanceId, child);
  logger.info('Agent 子进程已启动', { instanceId: opts.instanceId, bot: opts.botUserId });
}

/**
 * 处理 agent 子进程发来的 IPC 消息。当前仅响应 mcp:listTools / mcp:callTool 两类
 * 请求——MCP Host（进程池）在主进程内，子进程无法直接访问，故通过 IPC 转发。
 * 未知消息类型静默忽略，便于未来扩展其它 IPC 协议而不破坏旧子进程。
 */
function handleChildMessage(child: ChildProcess, workspaceId: string, msg: unknown): void {
  const m = msg as {
    type?: string;
    id?: string;
    mcpName?: string;
    toolName?: string;
    args?: Record<string, unknown>;
  };
  if (!m.type) return;
  if (m.type === 'mcp:listTools' && m.id && m.mcpName) {
    void handleChildListTools(child, workspaceId, m.id, m.mcpName);
  } else if (m.type === 'mcp:callTool' && m.id && m.mcpName && m.toolName && m.args) {
    void handleChildCallTool(child, workspaceId, m.id, m.mcpName, m.toolName, m.args);
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
  child.kill('SIGTERM');
  runtimes.delete(instanceId);
  logger.info('Agent 子进程已请求停止', { instanceId });
}

/** 停止全部运行中的 agent 子进程（应用退出时调用） */
export function stopAllAgents(): void {
  const count = runtimes.size;
  for (const child of runtimes.values()) {
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
