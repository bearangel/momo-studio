// electron/src/main/agent/runtime-spawner.ts
//
// task-driven runtime spawn 适配层（D 子系统骨架——I1 最小实现）。
//
// v2 完整实现将取代 runtime-manager.ts 成为 task-driven runtime 的 spawn 入口：
//   - WarmPool.spawn(agentId) → 本模块 → fork runtime-entry.js
//   - 注册全局 chunk 转发 handler（子进程 sendStreamChunk → 主进程 → renderer）
//   - 返回 ChildProcess 给 WarmPool 管理
//
// 当前状态（v2.0 alpha）：骨架文件，不替代 v1 runtime-manager。
// runtime-entry.ts 尚未实现 task-config IPC 协议（仅监听 Matrix 事件 + abort IPC），
// 因此 task-driven 执行链路（AgentRunner.executeTask → child.send({type:'task-config'})）
// 无法工作——子进程会忽略 task-config 消息。完整迁移需要：
//   1. runtime-entry.ts 新增 task-config message handler（接收 task 配置 → 跑 chat loop）
//   2. 本模块实现 spawnForAgent（buildSpawnOpts + fork → 返回 ChildProcess）
//   3. 注册全局 chunk 转发 handler
//   4. main/index.ts 实例化 WarmPool + AgentRunner + TaskDispatcher 完整链路
// 以上是 v2 架构迁移任务（非 bounded wiring），留待 v2 增量。
//
// 当前导出的 spawnForAgent 仅用于未来 WarmPool 集成时占位——直接抛错以明确"未实现"语义，
// 防止误调用导致静默失败。
import type { ChildProcess } from 'node:child_process';
import { logger } from '../logger';

/**
 * v2 占位：为指定 agent 实例 spawn 一个 task-driven runtime。
 *
 * 当前未实现——抛错以防止误调用。
 * v2 完整实现：查 assignment + definition + workspace → buildSpawnOpts → fork → 返回 ChildProcess。
 */
export async function spawnForAgent(_agentAssignmentId: string): Promise<ChildProcess> {
  logger.warn('runtime-spawner.spawnForAgent 未实现（v2 task-driven runtime 迁移）', {
    agentAssignmentId: _agentAssignmentId,
  });
  throw new Error(
    'runtime-spawner.spawnForAgent 未实现：task-driven runtime 是 v2 架构迁移任务',
  );
}
