// electron/src/main/agent/runtime-spawner.ts
//
// task-driven runtime spawn 适配层——v2 完整实现。
// 提供 WarmPool 需要的 spawn 接口。
//
// 流程：
//   1. buildSpawnOpts 构造完整 AgentRuntimeOpts（复用 spawn-helpers）
//   2. fork runtime-entry.js（AGENT_CONFIG 环境变量传 config）
//   3. 注册 message handler（chunk 转发 → onChunk 回调；audit:toolCall →
//      审计落库 + 周期性配额巡检，P2 Task 8 恢复 v1 被删的审计桥）
//   4. 注册 exit handler（→ onExit 回调）
//   5. 返回 SpawnedRuntime 给 WarmPool

import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { logger } from '../logger';
import type { StreamChunk } from './stream-chunk';
import { handleChildMessage } from './internal-event-bridge';
import { insertToolCall } from '../audit/insert';
import { enforceAuditQuota } from '../audit/quota';

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
}

const RUNTIME_ENTRY_PATH = path.join(__dirname, 'runtime-entry.js');
const SHUTDOWN_TIMEOUT_MS = 5000;
/** 审计巡检周期：每 200 次 audit:toolCall 写入触发一次 enforceAuditQuota */
const AUDIT_ENFORCE_INTERVAL = 200;

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

export async function spawnForAgent(opts: SpawnOpts): Promise<SpawnedRuntime> {
  const { assignmentId, runtimeConfig, onChunk, onExit } = opts;

  // AGENT_CONFIG 环境变量传递 runtime config
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_CONFIG: JSON.stringify(runtimeConfig),
  };

  // fork runtime-entry.js
  const child = fork(RUNTIME_ENTRY_PATH, [], {
    env,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });

  // 注册 message handler（chunk 转发）
  const messageHandler = (msg: unknown): void => {
    // 内部事件（dispatch/task_reply/abort_dispatch）优先转给桥处理；已消费则不进 chunk 通道
    if (handleChildMessage(msg)) return;
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as AuditToolCallChildMsg;
    // 审计桥（P2 Task 8，恢复 v1 被删的桥接）：子进程 audit.ts 的 process.send
    // 载荷无 workspace/agent 身份，用 spawn 闭包的 runtimeConfig 补全。
    // durationMs 可能是字符串/浮点/NaN（IPC 类型漂移），收敛为安全整数。
    if (m.type === 'audit:toolCall') {
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
      return;
    }
    // StreamChunk 类型的消息转发给 onChunk
    if (m.type && ['start', 'thinking', 'text', 'tool_call', 'tool_result', 'todo_update', 'end', 'segment_boundary'].includes(m.type)) {
      onChunk(msg as StreamChunk);
    }
    // 其他类型的消息（task-end / mcp 请求等）由调用方在 child.on('message') 内处理
  };
  child.on('message', messageHandler);

  // 注册 exit handler
  const exitHandler = (code: number | null): void => {
    logger.info('runtime 退出', { assignmentId, code });
    onExit(code);
  };
  child.on('exit', exitHandler);

  logger.info('runtime 已 spawn', { assignmentId, pid: child.pid });

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
