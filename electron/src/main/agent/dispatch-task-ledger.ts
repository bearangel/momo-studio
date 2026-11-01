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
import type { TaskStatus } from '../storage/tasks/state-machine';
import { logger } from '../logger';

/** register 投影入参（routeDispatch 调用点手边的全部事实） */
export interface DispatchLedgerInput {
  taskId: string;
  /** dispatch 消息 body——子任务描述（title 截断 80） */
  body: string;
  pmAssignmentId: string;
  subAssignmentId: string;
  sessionId: string;
  subStreamSessionId?: string;
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
 * delete+reinsert：completed 终态不可逆转换，簿记行无自有依赖，删插最干净。
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
      updateTask(input.taskId, {
        status: 'in_progress',
        title: input.body.slice(0, 80),
        errorMessage: null,
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
    });
  } catch (err) {
    logger.warn('dispatch 账本投影失败（不影响运行链）', {
      taskId: input.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** settle 投影：completed/failed/needs_input → completed/failed/paused */
export function ledgerSettleDispatch(taskId: string, outcome: 'completed' | 'failed' | 'needs_input', body?: string): void {
  try {
    const row = getTask(taskId);
    if (!row || row.origin !== 'dispatch') return;
    if (row.status === SETTLE_STATUS[outcome]) return; // 幂等（迟到重复钩子）
    transitionTaskStatus(taskId, SETTLE_STATUS[outcome], {
      ...(outcome === 'failed' && body ? { errorMessage: body.slice(0, 200) } : {}),
    });
  } catch (err) {
    logger.warn('dispatch 账本 settle 投影失败（不影响运行链）', {
      taskId,
      outcome,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** cancel 投影（routeAbortDispatch / stopAll / cancelChain 三入口共用） */
export function ledgerCancelDispatch(taskId: string): void {
  try {
    const row = getTask(taskId);
    if (!row || row.origin !== 'dispatch') return;
    if (row.status === 'cancelled') return;
    transitionTaskStatus(taskId, 'cancelled');
  } catch (err) {
    logger.warn('dispatch 账本 cancel 投影失败（不影响运行链）', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** sweepDead 判死投影 → failed + 判死原因 */
export function ledgerFailDispatch(taskId: string, reason: string): void {
  try {
    const row = getTask(taskId);
    if (!row || row.origin !== 'dispatch') return;
    if (row.status === 'failed') return;
    transitionTaskStatus(taskId, 'failed', { errorMessage: reason.slice(0, 200) });
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
        // paused→failed 越过状态机（paused 只许 in_progress/cancelled）——启动
        // 对账是权威复位而非生命周期转换，直接 updateTask（spec §3.4 修正）
        updateTask(r.id, { status: 'failed', errorMessage: '应用重启，编排链丢失' });
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
