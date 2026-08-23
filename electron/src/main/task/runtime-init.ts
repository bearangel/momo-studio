// electron/src/main/task/runtime-init.ts
//
// task-driven runtime 调度层初始化（I1 最小骨架）。
//
// 当前仅启动 TaskScheduler——定时扫描 pending + scheduled_at <= now 的任务，
// 把它们提升到 assigned 状态（让看板 UI 可见、可手动启动）。
//
// scanPickup 当前是 no-op（返回 false）——完整的 pickup → executeTask 链路需要
// runtime-spawner + runtime-entry task-config 协议（v2 架构迁移）。
// 现阶段：调度层启用（scheduled 任务能自动提升状态），执行层由 task-driven runtime 承载。
import { TaskScheduler } from './scheduler';
import { logger } from '../logger';

let scheduler: TaskScheduler | null = null;

/**
 * 启动 TaskScheduler（调度层）。
 *
 * scanPickup 为 no-op——完整 task-driven 执行链路是 v2 增量。
 * 调用安全：重复调用会先停旧实例再建新实例。
 */
export function initTaskRuntime(opts?: { intervalMs?: number }): void {
  if (scheduler) {
    scheduler.stop();
  }

  scheduler = new TaskScheduler({
    scanPickup: async (_assigneeAgentId: string): Promise<boolean> => {
      // v2 占位：pickup 链路（dispatcher.tryPickup → runner.executeTask）未接线。
      // task 保持 assigned 状态，等待看板手动启动或 v2 自动 pickup。
      return false;
    },
    intervalMs: opts?.intervalMs,
  });
  scheduler.start();
  logger.info('TaskScheduler 已启动（调度层；task-driven 执行链路为 v2 增量）');
}

/**
 * 停止 TaskScheduler，释放定时器。幂等。
 */
export function stopTaskRuntime(): void {
  scheduler?.stop();
  scheduler = null;
}
