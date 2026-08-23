// electron/src/main/task/conflict-executor.ts
//
// 冲突处理的副作用执行器（B 子系统 B9）。
//
// 与 conflict-resolver.ts 的分工：
//   - conflict-resolver.ts 是纯函数，返回 ConflictResolution（无 IO）
//   - 本模块把 resolution 映射到实际副作用（transitionTaskStatus / startTask）
//
// 分离的原因：纯函数好测（5 策略返回结构正确），副作用也好测（DB + Matrix mock 隔离）。
// IPC handler（ipc.handlers.ts）把两者串起来：
//   const resolution = resolveConflict(ctx);
//   const result = await executeConflictResolution(resolution, ctx);

import { transitionTaskStatus } from '../storage/tasks/repo';
import { startTask } from './starter';
import type { ConflictResolution } from './conflict-resolver';

/** 执行上下文：与 ConflictContext 同构（去掉 strategy，执行不需要） */
export interface ExecutionContext {
  newTaskId: string;
  currentTaskId: string;
  currentRoomId: string;
}

/**
 * 执行冲突处理的副作用。
 *
 * - queue / reject：无副作用，直接返回 resolution（queue 等待 D 阶段 pickup；reject 由 UI 提示）
 * - preempt：暂停当前任务 → 在当前会话启动新任务
 * - fork：在新会话启动新任务（createNewRoom: true）
 *
 * @returns 传入的 resolution（便于调用方链式处理 / IPC handler 直接 return）
 */
export async function executeConflictResolution(
  resolution: ConflictResolution,
  ctx: ExecutionContext,
): Promise<ConflictResolution> {
  switch (resolution.action) {
    case 'preempt':
      transitionTaskStatus(ctx.currentTaskId, 'paused');
      await startTask(ctx.newTaskId, { executionSessionId: ctx.currentRoomId });
      return resolution;

    case 'fork':
      // fork 忽略 resolver 返回的占位 newExecutionSessionId——startTask(createNewRoom:true)
      // 会创建真实新会话，返回的 executionSessionId 才是最终值。
      await startTask(ctx.newTaskId, { createNewRoom: true });
      return resolution;

    case 'queue':
    case 'reject':
    default:
      return resolution;
  }
}
