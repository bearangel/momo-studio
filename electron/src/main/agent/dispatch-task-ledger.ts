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
import { getTask, insertTask, updateTask } from '../storage/tasks/repo';
import { isTerminal } from '../storage/tasks/state-machine';
import {
  failRun,
  markTaskCancelled,
  markTaskFailed,
  requestHuman,
  authoritativeReset,
  startRun,
  submitRun,
} from '../task/lifecycle-runs';
import {
  handleQuotaFailureSettle,
  isQuotaLimitError,
  resetQuotaRetryCount,
} from '../task/quota-resume';
import { getActiveRun, updateRun } from '../storage/tasks/runs-repo';
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

/** 成员行反查 workspace（投影行 workspace_id 的唯一来源） */
function resolveWorkspaceId(subAssignmentId: string): string | null {
  const row = getDb()
    .prepare('SELECT workspace_id FROM workspace_agent_members WHERE instance_id = ?')
    .get(subAssignmentId) as { workspace_id?: string } | undefined;
  return typeof row?.workspace_id === 'string' ? row.workspace_id : null;
}

/**
 * register 投影：直插 in_progress + run #1 记账 + auto_accept=1（spec §6.9
 * dispatch 簿记行强制自动验收——082 迁移对存量行的口径，spawn 侧同语义）。
 * 绕开 draft→assigned 放行面（executor 只认 assigned/session_queued，天然隔离）。
 * followup 链复用（同 taskId 下一轮派发）时权威复位（completed 终态不可逆转换
 * ——registry 复用是权威重置，authoritativeReset 服务单点；禁 DELETE：迁移 555
 * 触发器会把挂链 messages.task_id 置 NULL 断链）+ 新 run 记账。
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
      // followup 链复用：权威复位（终态不可逆转换——registry 复用是权威重置
      // 而非生命周期转换，经 lifecycle-runs.authoritativeReset 服务单点）。
      // **禁 DELETE+reinsert**：迁移 555 行的触发器会在 tasks 行删除时把挂链
      // messages.task_id 置 NULL——followup 断链（首轮历史从重建器消失，
      // orchestration-e2e 实证）。
      // archivedAt: null（2026-11-12 看板治理）：终态簿记行可能已被手动归档——
      // followup 复活运行链必须连带解除归档，否则复位后的 in_progress 行被归档
      // 隐藏、看板不可见。completedAt/submittedAt/acceptedAt 清上轮终态残值
      //（updateTask 全字段直写）；上轮滞留的活动 run（needs_input 等人后重派）
      // 一并 cancelled 终结——否则 startRun ensure 语义复用旧 run，settle 的
      // submitRun 会撞 run 状态机非法边（waiting_human → submitted 不通）。
      // T15 复核裁定（Task 18 B2）：此处 updateRun 直写不归位 cancelActiveRun——
      // cancelActiveRun 会连带投影任务 cancelled（发 taskStatusChanged/Completed
      // 插件事件）再被下方 authoritativeReset 覆写为 in_progress，产生「先取消
      // 再复活」的假事件序列；且顺序敏感：run 终结必须先于 startRun（单活动 run
      // 唯一索引），拆到服务函数即失去同段顺序保证。保留直写（P2 随 §14 收口重审）
      const lingering = getActiveRun(input.taskId);
      if (lingering) {
        updateRun(lingering.id, {
          status: 'cancelled',
          endedAt: Date.now(),
          rejectReason: 'followup 重派复位',
        });
      }
      authoritativeReset(input.taskId, {
        status: 'in_progress',
        title: input.body.slice(0, 80),
        errorMessage: null,
        startedAt: Date.now(),
        completedAt: null,
        submittedAt: null,
        acceptedAt: null,
        archivedAt: null,
      });
      startRun(input.taskId, { trigger: 'initial', executionSessionId: input.sessionId });
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
      autoAccept: true,
    });
    // run #1 记账（§9.3 行1 前置：settle completed → submitRun 需要活动 run）
    startRun(input.taskId, { trigger: 'initial', executionSessionId: input.sessionId });
  } catch (err) {
    logger.warn('dispatch 账本投影失败（不影响运行链）', {
      taskId: input.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * settle 投影（v2 写路径收敛，§9.3 行3 + 消费面 ①-5）：
 *   - completed → submitRun（origin='dispatch' 行 auto_accept=1：提交即验收，
 *     直达 completed）
 *   - failed → failRun（errorMessage=body）；needs_input → requestHuman
 *     （question 类，body 作 prompt；任务投影 waiting_human——不再落 paused，
 *     等人语义归 HITL 链）
 * 配额受限失败（429 + 配额措辞，2026-11-04 事故）例外：不落终态 failed——
 * handleQuotaFailureSettle 排 assigned + scheduled_at 自动续跑（既有 executor
 * 放行链），连续 3 次预算耗尽后回落终态（人工介入）。
 *
 * R3 真实 token 遥测（2026-11-05）：usage（子 agent 本轮运行累计的 provider
 * 上报值）在两处读-改-写累积进 actual_tokens——服务调用前独立累积与配额排队
 * 分支（排队不落终态，但本轮消耗已发生，不写即随续跑轮丢失）；幂等跳过分支
 * （行已终态/已提交/已等人）不写——那是同一 run 的重复钩子，写入即双计。
 */
export function ledgerSettleDispatch(
  taskId: string,
  outcome: 'completed' | 'failed' | 'needs_input',
  body?: string,
  usage?: { promptTokens: number; completionTokens: number },
): void {
  try {
    const row = getTask(taskId);
    if (!row || row.origin !== 'dispatch') return;
    // paused 行：用户权威态（§6.6）——迟到 settle 不覆盖（含不动 run：
    // submitRun/requestHuman 会推进 run 状态，与旧「canTransition 预检跳过」同效）
    if (row.status === 'paused') {
      logger.info('dispatch 账本 settle：行已暂停（用户权威态），跳过', {
        taskId,
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
    if (isTerminal(row.status)) {
      // 幂等 + 迟到钩子不覆盖先落的权威终态（2026-11-11 会话停止竞速实录：
      // cancel 投影先行落 cancelled，子进程退出前的 failed settle 迟到）——
      // info 跳过；真正的投影异常仍走下方 catch 兜底
      logger.info('dispatch 账本 settle：行状态无法承接本钩子，跳过', {
        taskId,
        rowStatus: row.status,
        outcome,
      });
      return;
    }
    // usage 累积先行（服务函数不透传 extraPatch；非状态副作用字段独立落账——
    // 跳过分支已在上方返回，同一 run 的重复钩子不双计）
    if (usage) {
      updateTask(taskId, {
        actualTokens: (row.actualTokens ?? 0) + usage.promptTokens + usage.completionTokens,
      });
    }
    if (outcome === 'completed') {
      if (row.status === 'submitted') return; // 已提交待验收（agent 工具侧先行）——幂等
      // submitRun async 契约（无 await 点）；迟到/边界拒绝承接为 warn
      void submitRun(taskId, { summary: body?.slice(0, 200) ?? '编排链完成交付' }).catch(
        (err: unknown) => {
          logger.warn('dispatch 账本 settle 提交验收失败（不影响运行链）', {
            taskId,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
      return;
    }
    if (outcome === 'failed') {
      failRun(taskId, body?.slice(0, 200) ?? '编排链失败');
      return;
    }
    // needs_input → requestHuman（question）；run waiting_human 由 requestHuman
    // 内部 enterWaitingHuman 落定；重复钩子幂等（run 已 waiting_human 时跳过）
    const sessionId = row.executionSessionId ?? row.sourceSessionId;
    if (!sessionId) {
      logger.warn('dispatch 账本 settle：needs_input 行无会话，无法生成人工请求', { taskId });
      return;
    }
    if (getActiveRun(taskId)?.status === 'waiting_human') return;
    requestHuman({
      sessionId,
      kind: 'question',
      title: `#${taskId} 等待人工输入`,
      prompt: body ?? '子任务需要人工输入',
      taskId,
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
    if (isTerminal(row.status) || row.status === 'paused') {
      // 同 settle 预检语义（2026-11-11）：迟到取消不覆盖先落的权威终态；
      // paused 是用户权威态（§6.6），取消动作留给用户显式裁决
      logger.info('dispatch 账本 cancel：行状态无法承接本钩子，跳过', {
        taskId,
        rowStatus: row.status,
      });
      return;
    }
    resetQuotaRetryCount(taskId);
    // v2 收敛（§9.3 行10）：markTaskCancelled——有活动 run → cancelActiveRun
    //（run cancelled + 未决请求 superseded），排队行（无 run）直接投影 cancelled
    markTaskCancelled(taskId, '编排链取消');
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
    if (isTerminal(row.status) || row.status === 'paused') {
      // 同 settle 预检语义（2026-11-11）：判死投影不覆盖先落的权威终态；
      // paused 是用户权威态（§6.6）
      logger.info('dispatch 账本判死：行状态无法承接本钩子，跳过', {
        taskId,
        rowStatus: row.status,
      });
      return;
    }
    resetQuotaRetryCount(taskId);
    // v2 收敛（§9.3 行5）：markTaskFailed——有活动 run → failRun，排队行投影 failed
    markTaskFailed(taskId, reason.slice(0, 200));
  } catch (err) {
    logger.warn('dispatch 账本判死投影失败（不影响运行链）', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 启动对账（spec §3.4）：registry 纯内存，重启必空——扫 origin='dispatch' 的
 * in_progress/waiting_human/paused 行统一转 failed（v2：needs_input 落
 * waiting_human，对账面随之扩）。幂等：无目标行时安静返回。
 */
export function reconcileDispatchTasksAtBoot(): void {
  try {
    const rows = getDb()
      .prepare(
        `SELECT id FROM tasks WHERE origin = 'dispatch' AND status IN ('in_progress', 'waiting_human', 'paused')`,
      )
      .all() as Array<{ id: string }>;
    if (rows.length === 0) return;
    for (const r of rows) {
      try {
        const t = getTask(r.id);
        if (!t || t.origin !== 'dispatch') continue;
        if (t.status === 'paused') {
          // paused→failed 越过状态机（§5.1 无此边）——启动对账是权威复位而非
          // 生命周期转换，经 lifecycle-runs.authoritativeReset 服务单点直写
          //（spec §3.4 修正；v2 收敛 Task 15）。082 为 paused 存量行回填的
          // run#1（running）一并终结——权威复位不留活动 run 悬挂（悬挂会令下次
          // spawn 的 startRun ensure 语义复用死 run）。
          // T15 复核裁定（Task 18 B2）：此处 updateRun 直写不归位 failRun——
          // failRun 对 paused 行按 §6.6 跳过任务投影（任务仍 paused），且会
          // supersede 未决请求（行为面变化）并重复落 errorMessage/completedAt；
          // 权威复位语义要求 run 终结与任务直写在同一步落定，拆到服务函数即
          // 引入中间态。保留直写（P2 随 §14 收口重审）
          const active = getActiveRun(r.id);
          if (active) {
            updateRun(active.id, { status: 'failed', endedAt: Date.now() });
          }
          authoritativeReset(r.id, {
            status: 'failed',
            errorMessage: '应用重启，编排链丢失',
            completedAt: Date.now(),
          });
        } else {
          // in_progress/waiting_human → failed 合法转换——走 markTaskFailed
          //（有活动 run → failRun；plugin 事件与旧 transition 路径一致）
          markTaskFailed(r.id, '应用重启，编排链丢失');
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
