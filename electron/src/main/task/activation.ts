// electron/src/main/task/activation.ts
//
// #T mention 激活（spec §6）：用户在会话中 #T-xxx 发送 → 任务在当前会话
// 就地执行。挂点：session-service.sendUserMessage 落库后（冲突检测同段）。
//   - 可激活态：draft / pending / assigned
//   - in_progress / 终态：仅引用语义（现状），不动作
// 单任务失败只 warn——激活是增值路径，不能拖垮消息发送。
//
// 双驱动修复（2026-09-07 主机报告）：用户消息正文已被路由给接待 agent，
// agent 看到 #T 引用即开始执行；若 activation 再走 executor 注入
// 【任务启动】kickoff，同一任务会被驱动两轮（两轮各自执行并竞速
// complete_task，一轮报 completed→completed）。故：
//   - 并发有余 → 就地 startTask（转 in_progress + 锁定执行房间=当前会话），
//     不注入 kickoff——用户消息是唯一驱动指令
//   - 并发已满 → 入队（target_session_id + assigned + notify），executor
//     放行时注入 kickoff——彼时用户消息语境已过，kickoff 是必要驱动
import { parseTaskMentions } from './conflict-detector';
import { getTask, updateTask, transitionTaskStatus } from '../storage/tasks/repo';
import { startTask } from './starter';
import { getGlobalSettings } from '../settings/crud';
import { getDb } from '../storage/db';
import { notifyExecutor } from './executor';
import { logger } from '../logger';

const ACTIVATABLE = new Set(['draft', 'pending', 'assigned']);

function countInProgress(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status='in_progress'`)
    .get() as { n: number };
  return row.n;
}

export function activateMentionedTasks(sessionId: string, body: string): void {
  for (const refId of parseTaskMentions(body)) {
    try {
      const task = getTask(refId);
      if (!task || !ACTIVATABLE.has(task.status)) continue;
      // 用户显式意图覆盖：目标 = 当前会话（三列互斥 → 清空另两列）
      updateTask(refId, { targetSessionId: sessionId, assigneeAgentId: null, targetTeamId: null });
      if (task.status !== 'assigned') transitionTaskStatus(refId, 'assigned');

      const max = getGlobalSettings().maxConcurrentTasks ?? 3;
      if (countInProgress() < max) {
        // 即时路径：就地启动，不注入 kickoff（用户消息已是驱动指令）。
        // 竞态下 startTask 抛错 → 任务留 assigned，executor 兜底扫描接管。
        startTask(refId, { executionSessionId: sessionId });
        logger.info('#T 任务已就地启动（即时路径，无 kickoff）', { taskId: refId, sessionId });
      } else {
        // 排队路径：放行时由 executor 注入 kickoff（用户消息语境已过）
        notifyExecutor();
        logger.info('#T 任务已激活入队（并发已满）', { taskId: refId, sessionId });
      }
    } catch (err) {
      logger.warn('#T 激活失败（不阻塞消息发送）', {
        refId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
