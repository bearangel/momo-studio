// electron/src/main/agent/runtime-status.ts
//
// agent 运行状态查询（Task 13 从 runtime-manager.ts 迁出——v1 双轨删除后
// 仅剩 DB 语义）。查询 agent_assignments.last_running 字段：用户启动/停止意图
// （startAgentRuntime 写 1，stopAgentRuntime 写 0），UI 据此显示在线/离线。

import { getDb } from '../storage/db';

/**
 * 指定 instanceId 的 agent 是否正在运行（用户标记为运行）。
 * 语义：查询 DB last_running 字段，不探测子进程存活——task-driven 架构下
 * runtime 由 WarmPool 按需拉起，last_running 即对外一致的运行态。
 */
export function isAgentRunning(instanceId: string): boolean {
  const row = getDb()
    .prepare('SELECT last_running FROM agent_assignments WHERE instance_id = ?')
    .get(instanceId) as { last_running: number } | undefined;
  return row?.last_running === 1;
}
