// electron/src/main/task/runtime-init.ts
//
// task-driven runtime 调度层初始化：TaskScheduler（定时升级）+ TaskExecutor（队列放行）。
// executor 的 kickoff 依赖在此注入（sendUserMessage 包装）——避免 executor
// → im/session-service → task/activation → executor 的 import 环。
import { TaskScheduler } from './scheduler';
import { taskExecutor, type ExecutorDeps } from './executor';
import { sendUserMessage, broadcastSessionListChanged } from '../im/session-service';
import { isQuotaResumePending } from './quota-resume';
import { resumeTask } from './resume';
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
      // 配额受限自动续跑行（routing_json 带 quotaRetryCount 标记）：不走通用
      // kickoff——sendUserMessage → ephemeral 回合无 task-driven 生命周期（无
      // task-end 收尾，续跑轮若再遇配额错误将无人调度、成功也无终态）。改走
      // resumeTask 的 task-driven 续跑：同任务同会话（executionSessionId 已由
      // startTask 锁定为 source 会话），task-end 统一收尾——成功转 completed、
      // 再次配额失败回到 handleQuotaFailureSettle 升级退避。
      if (isQuotaResumePending(input.taskId)) {
        await resumeTask(input.taskId);
        return;
      }
      await sendUserMessage({
        sessionId: input.sessionId,
        body: input.body,
        mentionedInstanceIds: input.mentionedInstanceIds,
        // v2.3 车道透传链（spec §4.4）：taskId → sourceTaskId → 路由层注册车道
        sourceTaskId: input.taskId,
        // kickoff 是系统消息：跳过冲突检测与 #T 激活（正文天然含 #T id，
        // 不跳过会误报冲突弹窗 + 误激活描述里提及的任务）
        systemKickoff: true,
      });
    }),
    getGlobalMax: opts?.getGlobalMax,
    // K10：自动放行新建执行会话 → 通知 renderer 刷新会话列表
    onSessionListChanged: broadcastSessionListChanged,
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
