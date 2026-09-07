// electron/src/main/task/activation.ts
//
// #T mention 激活（spec §6）：用户在会话中 #T-xxx 发送 → 任务在当前会话
// 就地执行。挂点：session-service.sendUserMessage 落库后（冲突检测同段）。
//   - 可激活态：draft / pending / assigned
//   - 动作：target_session_id ← 当前会话（覆盖原目标，清空另两列）→ assigned → notify
//   - in_progress / 终态：仅引用语义（现状），不动作
// 单任务失败只 warn——激活是增值路径，不能拖垮消息发送。
import { parseTaskMentions } from './conflict-detector';
import { getTask, updateTask, transitionTaskStatus } from '../storage/tasks/repo';
import { notifyExecutor } from './executor';
import { logger } from '../logger';

const ACTIVATABLE = new Set(['draft', 'pending', 'assigned']);

export function activateMentionedTasks(sessionId: string, body: string): void {
  for (const refId of parseTaskMentions(body)) {
    try {
      const task = getTask(refId);
      if (!task || !ACTIVATABLE.has(task.status)) continue;
      // 用户显式意图覆盖：目标 = 当前会话（三列互斥 → 清空另两列）
      updateTask(refId, { targetSessionId: sessionId, assigneeAgentId: null, targetTeamId: null });
      if (task.status !== 'assigned') transitionTaskStatus(refId, 'assigned');
      notifyExecutor();
      logger.info('#T 任务已激活到当前会话', { taskId: refId, sessionId });
    } catch (err) {
      logger.warn('#T 激活失败（不阻塞消息发送）', {
        refId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
