// electron/src/main/task/lifecycle.ts
//
// 任务生命周期三动作共享模块（看板重构 Task 4）。
//
// 从 ipc.handlers.ts 三个 handler（task:start / task:resume paused 分支 /
// task:cancel）机械搬运的语义单点——IPC handler 与 Task 5 的 move.ts（跨列
// 移动联动）同源消费，杜绝「IPC 一套语义、看板拖拽另一套」的契约漂移。
//
// 语义来源（搬运前注释随迁，行为逐字节不变）：
//   - startTaskAndKickoff = task:start handler（K9/K10）
//   - resumePausedTask    = task:resume handler 的 paused 分支（K7-5）
//   - cancelTask          = task:cancel handler
//   - abortTaskExecution  = 原 ipc.handlers.ts 私有 abortTaskExecutionIfAny
//     （Task 7 铺路：拆为可独立调用的单任务 abort——只中止运行时流，不携带
//     transition；cancelTask = 先 transition 再调它）
import { getTask, transitionTaskStatus, type TaskRow } from '../storage/tasks/repo';
import { broadcastLocalTaskSnapshot } from '../p2p/task-broadcast';
import { notifyExecutor, buildKickoffBody } from './executor';
import { startTask, type StartTaskOpts, type StartTaskResult } from './starter';
import { abortTasksBySessionEverywhere } from '../agent/runtime-registry';
import { abortTaskStreamByLane } from '../agent/session-lane';
import { sendUserMessage, broadcastSessionListChanged } from '../im/session-service';

export type { StartTaskOpts, StartTaskResult } from './starter';

/**
 * K7-4 + v2.3 精确中止（spec §6）：任务转 paused / cancelled 时联动中断 agent 执行。
 * 优先按 taskId 反查车道流精确 abort——同会话 dispatch 子流（未注册车道）
 * 与其他任务的流不受影响；车道无记录（流未注册的窗口 / 旧数据）回退按
 * executionSessionId 广播（原 K7-4 语义兜底）。
 *
 * Task 7 铺路：只 abort 运行时流，不携带任何 transition——调用方自行决定
 * 状态迁移（cancelTask = transition cancelled 后调它）。
 */
export function abortTaskExecution(taskId: string): void {
  if (abortTaskStreamByLane(taskId)) return;
  const row = getTask(taskId);
  if (!row?.executionSessionId) return;
  abortTasksBySessionEverywhere(row.executionSessionId);
}

/**
 * 启动任务并注入 kickoff（= 原 task:start handler 主体，K9 全语义）。
 *
 * K9：手动启动与 executor 自动放行等价——startTask 只建会话/转状态，
 * kickoff 消息注入才是驱动 agent 开始执行的指令（旧实现漏了这半步，
 * 手动启动后新会话空转无任何执行）。启动前快照区分「新启动」与
 * 「幂等返回」：仅新启动注入，重复点击不重复驱动。
 *
 * kickoff 失败 = 无执行驱动（半启动状态不可恢复）——与 executor
 * failQuietly 同语义转 failed，错误信息透出给 UI。
 */
export async function startTaskAndKickoff(
  id: string,
  opts?: StartTaskOpts,
): Promise<StartTaskResult> {
  const before = getTask(id);
  const result = await startTask(id, opts);
  // K10：新建执行会话 → 通知 renderer 刷新会话列表（停留 IM 视图可见）
  if (result.createdNewRoom) broadcastSessionListChanged();
  const newlyStarted =
    before != null && before.status !== 'in_progress' && result.task.executionSessionId != null;
  if (newlyStarted) {
    try {
      await sendUserMessage({
        sessionId: result.executionSessionId,
        body: buildKickoffBody(result.task),
        mentionedInstanceIds: result.task.assigneeAgentId
          ? [result.task.assigneeAgentId]
          : undefined,
        systemKickoff: true,
      });
    } catch (err) {
      // kickoff 失败 = 无执行驱动（半启动状态不可恢复）——与 executor
      // failQuietly 同语义转 failed，错误信息透出给 UI
      const reason = err instanceof Error ? err.message : String(err);
      try {
        transitionTaskStatus(id, 'failed', { completedAt: Date.now(), errorMessage: `kickoff 注入失败: ${reason}` });
      } catch {
        // 并发改态——终态以先到者为准
      }
      throw err;
    }
  }
  void broadcastLocalTaskSnapshot();
  notifyExecutor();
  return result;
}

/**
 * 恢复 paused 任务（= 原 task:resume handler 的 paused 分支，K7-5 逐字节保持）：
 * transition paused→in_progress + kickoff 重注入执行会话 + broadcast/notify。
 */
export async function resumePausedTask(id: string): Promise<TaskRow> {
  // K7-5 既有行为逐字节保持：transition + kickoff 重注入
  const row = transitionTaskStatus(id, 'in_progress');
  if (row.executionSessionId) {
    await sendUserMessage({
      sessionId: row.executionSessionId,
      body: buildKickoffBody(row),
      mentionedInstanceIds: row.assigneeAgentId ? [row.assigneeAgentId] : undefined,
      systemKickoff: true,
    });
  }
  void broadcastLocalTaskSnapshot();
  notifyExecutor();
  return row;
}

/**
 * 取消任务（= 原 task:cancel handler 主体）：
 * transition cancelled → 联动中止运行时执行 → broadcast/notify。
 */
export async function cancelTask(id: string): Promise<void> {
  transitionTaskStatus(id, 'cancelled');
  abortTaskExecution(id);
  void broadcastLocalTaskSnapshot();
  notifyExecutor();
}
