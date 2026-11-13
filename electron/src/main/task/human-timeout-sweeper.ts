// electron/src/main/task/human-timeout-sweeper.ts
//
// 人工请求超时 sweeper（任务生命周期 v2 Task 12，spec §6 HITL 超时策略）。
// 纯函数 sweepHumanTimeouts(now?)——interval 注册点在 Task 16 IPC 聚合处（60s），
// 本模块不自起定时器（可测性：时刻经入参注入）。
//
// 五策略到期处置（timeout_policy，deadline 已过的 pending 行由 listDue 命中）：
//   - deny_and_wrap：以 'system:timeout' 身份走 answerHuman deny——原子落库 +
//     tool_gate 回调派发拒绝；run 不失败，agent 收到拒绝后自行收尾
//   - keep_waiting：状态不变，仅写 lastRemindedAt（同一 deadline 周期内提醒一次；
//     deadline 后移（晚于上次提醒）后可再提醒）
//   - escalate：P1 与 keep_waiting 同构（仅本地提醒；跨节点 authority 上抛 P2 接）
//   - fail：请求 expired + failRun(taskId, '人工请求超时')
//   - cancel：请求 expired + cancelActiveRun(taskId, '人工请求超时')
//
// 竞态防线（markExpired/markReminded 均带 WHERE status='pending' 原子守卫）：
//   - fail/cancel 先翻请求再动任务——markExpired 未命中（返回 0）即 sweep 窗口内
//     已被人工答复，任务动作跳过（防已答请求反被 failRun/cancel 连坐）
//   - 任务动作前置 getActiveRun 检查：无活动 run（任务终态 / 未绑 run 的窗口态
//     请求，见 lifecycle-runs-human.test.ts 用例 7）时只翻请求本身，
//     requireActiveRun 的人话抛错不进 sweeper 主循环
//   - task_id 为 null 的会话级请求：只 markExpired，任务侧无可结算对象
import { logger } from '../logger';
import { listDue, markExpired, markReminded } from '../storage/tasks/human-requests-repo';
import type { HumanRequestRow } from '../storage/tasks/human-requests-repo';
import { getActiveRun } from '../storage/tasks/runs-repo';
import { answerHuman, cancelActiveRun, failRun } from './lifecycle-runs';

/** 超时自动答复者标识（answered_by_node_id 落账，与人答区分） */
const TIMEOUT_ANSWERER = 'system:timeout';
/** fail/cancel 策略的任务侧原因 */
const TIMEOUT_REASON = '人工请求超时';

/** 是否需要补提醒：尚无提醒记录，或 deadline 后移到上次提醒之后（新提醒周期） */
function needsReminder(req: HumanRequestRow): boolean {
  return req.lastRemindedAt === null || req.lastRemindedAt < (req.deadlineAt ?? 0);
}

/** fail/cancel 的任务侧收尾：无任务或无活动 run 时跳过（无可结算对象） */
function settleTask(taskId: string | null, action: 'fail' | 'cancel'): void {
  if (!taskId || !getActiveRun(taskId)) return;
  if (action === 'fail') {
    failRun(taskId, TIMEOUT_REASON);
  } else {
    cancelActiveRun(taskId, TIMEOUT_REASON);
  }
}

/**
 * 扫描到期人工请求并按 timeout_policy 处置。
 * @param now 当前时刻（注入便于测试；生产缺省 Date.now()）
 * @returns processed = 本轮命中的到期请求数（含仅提醒与竞态幂等跳过者）
 */
export function sweepHumanTimeouts(now: number = Date.now()): { processed: number } {
  const due = listDue(now);
  for (const req of due) {
    switch (req.timeoutPolicy) {
      case 'deny_and_wrap': {
        const disp = answerHuman(req.id, { decision: 'deny' }, TIMEOUT_ANSWERER);
        if (disp.disposition === 'stale') {
          logger.info('人工请求超时 deny 到达时已被并发处置——幂等跳过', { requestId: req.id });
        }
        break;
      }
      case 'keep_waiting':
      case 'escalate': {
        // 提醒一次后在同一 deadline 周期内不再提醒（needsReminder 判重）
        if (needsReminder(req)) markReminded(req.id, now);
        break;
      }
      case 'fail': {
        if (markExpired(req.id) > 0) settleTask(req.taskId, 'fail');
        break;
      }
      case 'cancel': {
        if (markExpired(req.id) > 0) settleTask(req.taskId, 'cancel');
        break;
      }
    }
  }
  return { processed: due.length };
}
