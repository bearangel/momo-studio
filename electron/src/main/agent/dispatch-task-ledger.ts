// electron/src/main/agent/dispatch-task-ledger.ts
//
// D4 账本与存储包（spec 2026-10-31-ledger-storage-package §3）：dispatch 链的
// tasks 表单向持久化投影。dispatchRegistry 仍是运行时真相源；本模块只把链
// 生命周期事件落为 origin='dispatch' 簿记行——看板可见、agent 三工具
// （read_task/list_tasks/read_task_progress）自动同源、重启后对账有据。
//
// 纪律：
//   - **单向**：registry → DB，DB 行永不反向驱动链
//   - **韧性**：投影失败只 logger.warn 绝不抛错——簿记断不得断运行链
//   - **幂等**：迟到/重复钩子 no-op（行不存在/状态已终态时安静返回）
//   - **id 单点**：行 id = 链 taskId 原样沿用（禁造第二 id——boundary 规则 1）
import { getDb } from '../storage/db';
import { getTask, insertTask, transitionTaskStatus, updateTask } from '../storage/tasks/repo';
import { canTransition, type TaskStatus } from '../storage/tasks/state-machine';
import {
  handleQuotaFailureSettle,
  isQuotaLimitError,
  resetQuotaRetryCount,
} from '../task/quota-resume';
import { logger } from '../logger';

/** register 投影入参（routeDispatch 调用点手边的全部事实） */
export interface DispatchLedgerInput {
  taskId: string;
  /** dispatch 消息 body——子任务描述（title 截断 80） */
  body: string;
  pmAssignmentId: string;
  subAssignmentId: string;
  sessionId: string;
}

/** settle outcome → tasks 状态映射（spec §3.2；needs_input→paused 是自审修正） */
const SETTLE_STATUS: Record<'completed' | 'failed' | 'needs_input', TaskStatus> = {
  completed: 'completed',
  failed: 'failed',
  needs_input: 'paused',
};

/** 成员行反查 workspace（投影行 workspace_id 的唯一来源） */
function resolveWorkspaceId(subAssignmentId: string): string | null {
  const row = getDb()
    .prepare('SELECT workspace_id FROM workspace_agent_members WHERE instance_id = ?')
    .get(subAssignmentId) as { workspace_id?: string } | undefined;
  return typeof row?.workspace_id === 'string' ? row.workspace_id : null;
}

/**
 * register 投影：直插 in_progress（绕开 draft→assigned 放行面——executor 只认
 * assigned/session_queued，天然隔离）。followup 链复用（同 taskId 下一轮派发）时
 * updateTask 权威复位（completed 终态不可逆转换——registry 复用是权威重置；
 * 禁 DELETE：迁移 555 触发器会把挂链 messages.task_id 置 NULL 断链）。
 */
export function ledgerInsertDispatch(input: DispatchLedgerInput): void {
  try {
    const workspaceId = resolveWorkspaceId(input.subAssignmentId);
    if (!workspaceId) {
      logger.warn('dispatch 账本投影跳过：成员行缺失无法解析 workspace', {
        taskId: input.taskId,
        subAssignmentId: input.subAssignmentId,
      });
      return;
    }
    const existing = getTask(input.taskId);
    if (existing) {
      if (existing.origin !== 'dispatch') {
        logger.warn('dispatch 账本投影跳过：id 与非 dispatch 任务行冲突', { taskId: input.taskId });
        return;
      }
      // followup 链复用：updateTask 权威复位（completed 终态不可逆转换——registry
      // 复用是权威重置而非生命周期转换）。**禁 DELETE+reinsert**：迁移 555 行的
      // 触发器会在 tasks 行删除时把挂链 messages.task_id 置 NULL——followup 断链
      // （首轮历史从重建器消失，orchestration-e2e 实证）。
      // archivedAt: null（2026-11-12 看板治理）：终态簿记行可能已被手动归档——
      // followup 复活运行链必须连带解除归档，否则复位后的 in_progress 行被归档
      // 隐藏、看板不可见
      updateTask(input.taskId, {
        status: 'in_progress',
        title: input.body.slice(0, 80),
        errorMessage: null,
        startedAt: Date.now(),
        completedAt: null, // 清上轮终态残值（updateTask 全字段直写）
        archivedAt: null,
      });
      return;
    }
    insertTask({
      id: input.taskId,
      origin: 'dispatch',
      workspaceId,
      title: input.body.slice(0, 80),
      status: 'in_progress',
      // creatorUserId NOT NULL——语义=派发者（PM agent），合成稳定标识即可
      creatorUserId: `agent:${input.pmAssignmentId}`,
      assigneeAgentId: input.subAssignmentId,
      executionSessionId: input.sessionId,
      sourceSessionId: input.sessionId,
      startedAt: Date.now(),
    });
  } catch (err) {
    logger.warn('dispatch 账本投影失败（不影响运行链）', {
      taskId: input.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** settle 投影：completed/failed/needs_input → completed/failed/paused。
 * 配额受限失败（429 + 配额措辞，2026-11-04 事故）例外：不落终态 failed——
 * handleQuotaFailureSettle 排 assigned + scheduled_at 自动续跑（既有 executor
 * 放行链），连续 3 次预算耗尽后回落终态（人工介入）。
 *
 * R3 真实 token 遥测（2026-11-05）：usage（子 agent 本轮运行累计的 provider
 * 上报值）在两处读-改-写累积进 actual_tokens——终态转换 extraPatch 与配额排队
 * 分支（排队不落终态，但本轮消耗已发生，不写即随续跑轮丢失）；幂等跳过分支
 * （行已终态/已排队）不写——那是同一 run 的重复钩子，写入即双计。 */
export function ledgerSettleDispatch(
  taskId: string,
  outcome: 'completed' | 'failed' | 'needs_input',
  body?: string,
  usage?: { promptTokens: number; completionTokens: number },
): void {
  try {
    const row = getTask(taskId);
    if (!row || row.origin !== 'dispatch') return;
    if (row.status === SETTLE_STATUS[outcome]) return; // 幂等（迟到重复钩子）
    if (!canTransition(row.status, SETTLE_STATUS[outcome])) {
      // 2026-11-11 会话停止竞速：cancel 投影先行落 cancelled，子进程退出前的
      // failed settle 迟到——非法转换此前以「投影失败」warn 噪声落场。迟到
      // 钩子不覆盖先落的权威状态（含终态互斥与 paused→completed 等），记
      // info 跳过；真正的投影异常仍走下方 catch 兜底。
      logger.info('dispatch 账本 settle：行状态无法承接本钩子，跳过', {
        taskId,
        rowStatus: row.status,
        outcome,
      });
      return;
    }
    if (outcome === 'failed' && (row.status === 'assigned' || row.status === 'session_queued')) {
      // 另一 settle 入口（task-end）已排配额自动续跑——迟到失败钩子不覆盖排队行
      logger.info('dispatch 账本 settle：行已排队配额自动续跑，忽略失败投影', {
        taskId,
        status: row.status,
      });
      return;
    }
    if (outcome === 'failed' && body !== undefined && isQuotaLimitError(body)) {
      const quotaOutcome = handleQuotaFailureSettle(taskId, row, body);
      if (quotaOutcome !== 'fallthrough') {
        // 配额排队（非终态）：本轮 usage 仍真实发生——独立 updateTask 累积
        // （只触碰 actualTokens，routing_json 原样保留，配额计数不受影响）
        if (usage) {
          updateTask(taskId, {
            actualTokens: (row.actualTokens ?? 0) + usage.promptTokens + usage.completionTokens,
          });
        }
        return; // scheduled / pending：不落终态
      }
    }
    // 非配额结局（成功 / needs_input / 非配额失败 / 配额预算耗尽）——连续计数清零
    resetQuotaRetryCount(taskId);
    transitionTaskStatus(taskId, SETTLE_STATUS[outcome], {
      ...(outcome === 'failed' && body ? { errorMessage: body.slice(0, 200) } : {}),
      // R3：终态转换同笔 UPDATE 携带 usage 累积（(existing ?? 0) + 本轮值）
      ...(usage
        ? { actualTokens: (row.actualTokens ?? 0) + usage.promptTokens + usage.completionTokens }
        : {}),
      completedAt: Date.now(), // D4（Oracle P1-1）：终态时间戳——详情面板/统计消费
    });
  } catch (err) {
    logger.warn('dispatch 账本 settle 投影失败（不影响运行链）', {
      taskId,
      outcome,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** cancel 投影（routeAbortDispatch / stopAll / cancelChain 三入口共用）。
 * 取消是非配额结局——连续配额计数清零。 */
export function ledgerCancelDispatch(taskId: string): void {
  try {
    const row = getTask(taskId);
    if (!row || row.origin !== 'dispatch') return;
    if (row.status === 'cancelled') return;
    if (!canTransition(row.status, 'cancelled')) {
      // 同 settle 预检语义（2026-11-11）：迟到取消不覆盖先落的权威终态
      logger.info('dispatch 账本 cancel：行状态无法承接本钩子，跳过', {
        taskId,
        rowStatus: row.status,
      });
      return;
    }
    resetQuotaRetryCount(taskId);
    transitionTaskStatus(taskId, 'cancelled', { completedAt: Date.now() });
  } catch (err) {
    logger.warn('dispatch 账本 cancel 投影失败（不影响运行链）', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 按任务 ID 计数账本（journal_entries）行——dispatch 回执计数读真的降级数据源
 * （2026-11-04：审计 task_id 接线前的存量链 / 纯文件变更任务，回据账本实数报
 * 「文件变更 N 处」）。永不抛错：查询失败降级返回 0 并 warn（同 countToolCallsForTask 纪律）。
 */
export function countJournalChangesForTask(taskId: string): number {
  try {
    const row = getDb()
      .prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE task_id = ?')
      .get(taskId) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch (err) {
    logger.warn('journal_entries 任务维度计数失败（回执计数降级为 0）', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/** sweepDead 判死投影 → failed + 判死原因（非配额结局——连续配额计数清零） */
export function ledgerFailDispatch(taskId: string, reason: string): void {
  try {
    const row = getTask(taskId);
    if (!row || row.origin !== 'dispatch') return;
    if (row.status === 'failed') return;
    if (!canTransition(row.status, 'failed')) {
      // 同 settle 预检语义（2026-11-11）：判死投影不覆盖先落的权威终态
      logger.info('dispatch 账本判死：行状态无法承接本钩子，跳过', {
        taskId,
        rowStatus: row.status,
      });
      return;
    }
    resetQuotaRetryCount(taskId);
    transitionTaskStatus(taskId, 'failed', {
      errorMessage: reason.slice(0, 200),
      completedAt: Date.now(),
    });
  } catch (err) {
    logger.warn('dispatch 账本判死投影失败（不影响运行链）', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 启动对账（spec §3.4）：registry 纯内存，重启必空——扫 origin='dispatch' 的
 * in_progress/paused 行统一转 failed。孤儿行不复存在（paused 覆盖 needs_input
 * 落态）。幂等：无目标行时安静返回。
 */
export function reconcileDispatchTasksAtBoot(): void {
  try {
    const rows = getDb()
      .prepare(
        `SELECT id FROM tasks WHERE origin = 'dispatch' AND status IN ('in_progress', 'paused')`,
      )
      .all() as Array<{ id: string }>;
    if (rows.length === 0) return;
    for (const r of rows) {
      try {
        const t = getTask(r.id);
        if (!t || t.origin !== 'dispatch') continue;
        if (t.status === 'paused') {
          // paused→failed 越过状态机（paused 只许 in_progress/cancelled）——启动
          // 对账是权威复位而非生命周期转换，直接 updateTask（spec §3.4 修正）
          updateTask(r.id, {
            status: 'failed',
            errorMessage: '应用重启，编排链丢失',
            completedAt: Date.now(),
          });
        } else {
          // in_progress→failed 合法转换——走 transitionTaskStatus 保 plugin 事件一致
          transitionTaskStatus(r.id, 'failed', {
            errorMessage: '应用重启，编排链丢失',
            completedAt: Date.now(),
          });
        }
      } catch (err) {
        logger.warn('启动对账单行失败（继续其余行）', {
          taskId: r.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    logger.info('dispatch 账本启动对账完成', { reconciled: rows.length });
  } catch (err) {
    logger.warn('dispatch 账本启动对账失败（不阻塞启动）', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
