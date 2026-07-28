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

import { fork, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { logger } from '../logger';

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

  runtimes.set(opts.instanceId, child);
  logger.info('Agent 子进程已启动', { instanceId: opts.instanceId, bot: opts.botUserId });
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
