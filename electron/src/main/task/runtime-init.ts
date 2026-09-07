// electron/src/main/task/runtime-init.ts
//
// task-driven runtime 调度层初始化：TaskScheduler（定时升级）+ TaskExecutor（队列放行）。
// executor 的 kickoff 依赖在此注入（sendUserMessage 包装）——避免 executor
// → im/session-service → task/activation → executor 的 import 环。
import { TaskScheduler } from './scheduler';
import { taskExecutor, type ExecutorDeps } from './executor';
import { sendUserMessage } from '../im/session-service';
import { logger } from '../logger';

let scheduler: TaskScheduler | null = null;

export interface InitTaskRuntimeOpts {
  intervalMs?: number;
  /** 测试注入 kickoff（缺省 sendUserMessage 包装） */
  kickoff?: ExecutorDeps['sendKickoff'];
  /** 测试注入全局并发上限 */
  getGlobalMax?: () => number;
}

export function initTaskRuntime(opts?: InitTaskRuntimeOpts): void {
  if (scheduler) scheduler.stop();
  taskExecutor.stop();

  scheduler = new TaskScheduler({
    // 到点升级（pending → assigned）后通知 executor 立即评估放行
    scanPickup: async (): Promise<boolean> => {
      taskExecutor.notify();
      return true;
    },
    intervalMs: opts?.intervalMs,
  });

  taskExecutor.init({
    sendKickoff: opts?.kickoff ?? (async (input) => {
      await sendUserMessage({
        sessionId: input.sessionId,
        body: input.body,
        mentionedInstanceIds: input.mentionedInstanceIds,
        // kickoff 是系统消息：跳过冲突检测与 #T 激活（正文天然含 #T id，
        // 不跳过会误报冲突弹窗 + 误激活描述里提及的任务）
        systemKickoff: true,
      });
    }),
    getGlobalMax: opts?.getGlobalMax,
  });

  scheduler.start();
  taskExecutor.start();
  taskExecutor.notify(); // boot 恢复：assigned 池立即评估一轮
  logger.info('task runtime 已启动（scheduler + executor）');
}

export function stopTaskRuntime(): void {
  scheduler?.stop();
  scheduler = null;
  taskExecutor.stop();
}
