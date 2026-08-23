// electron/src/main/agent/runtime-spawner.ts
//
// task-driven runtime spawn 适配层——v2 完整实现。
// 提供 WarmPool 需要的 spawn 接口。
//
// 流程：
//   1. buildSpawnOpts 构造完整 AgentRuntimeOpts（复用 spawn-helpers）
//   2. fork runtime-entry.js（AGENT_CONFIG 环境变量传 config）
//   3. 注册 message handler（chunk 转发 → onChunk 回调）
//   4. 注册 exit handler（→ onExit 回调）
//   5. 返回 SpawnedRuntime 给 WarmPool

import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { logger } from '../logger';
import type { StreamChunk } from './stream-chunk';
import { handleChildMessage } from './internal-event-bridge';

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
    // StreamChunk 类型的消息转发给 onChunk
    const m = msg as { type?: string };
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
