// electron/src/main/task/lifecycle-runs.ts
//
// 任务生命周期 v2 服务核心（spec 2026-11-13-task-lifecycle-v2 §5.1/§5.2/§6.6）。
//
// 职责：run 生命周期管理（startRun / 等待投影 / failRun / cancel / pause / resume）
// + 任务状态投影单点（不变量 §5.1-6：task.status 只经本服务调 transitionTaskStatus
// 写入，绝不 updateTask({status})；同态与非法边一律跳过不抛）。
//
// 设计要点：
//   - startRun 是 ensure 语义（Review Focus #3）：已有活动 run 直接返回（幂等）；
//     idx_task_runs_active 唯一索引竞态兜底——insertRun 抛 SQLITE_CONSTRAINT 时
//     重新 getActiveRun 返回既有行（双触发 / boot 重扫安全）
//   - 状态写入一律走 transitionTaskStatus（合法边），投影前先判
//     canTransition && current !== target（transitionTaskStatus 对同态会抛）
//   - paused 是用户权威态（spec §6.6）：pauseForTask 只改任务态不动 run；
//     投影（refreshTaskProjection / startRun 的 in_progress 推进）不覆盖 paused
//   - 三步写（插 run + currentRunId 回写 + 任务态转换）包同一事务；
//     被 starter.ts 事务嵌套调用时 better-sqlite3 自动降级为 SAVEPOINT
//   - submitRun / acceptTask / rejectTask 是 Task 10 的接线位——签名与 move.ts
//     路由调用点逐字对齐，本 task 保持占位抛「未接线」
import { getDb } from '../storage/db';
import { getTask, transitionTaskStatus, updateTask } from '../storage/tasks/repo';
import { canTransition, isTerminal, type TaskStatus } from '../storage/tasks/state-machine';
import {
  insertRun,
  getActiveRun,
  updateRun,
  countRuns,
  type TaskRunRow,
  type TaskRunTrigger,
} from '../storage/tasks/runs-repo';
import {
  supersedePendingByRun,
  countPendingNonAcceptance,
} from '../storage/tasks/human-requests-repo';

/** 单任务执行尝试上限（spec §5.2：防打回-重跑死循环） */
export const MAX_RUNS_PER_TASK = 10;

/** 判定 better-sqlite3 唯一索引冲突（idx_task_runs_active 单活动 run 竞态信号） */
function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    String((err as { code?: unknown }).code).startsWith('SQLITE_CONSTRAINT')
  );
}

/**
 * 投影单点守卫：目标态可达才走 transitionTaskStatus（同态 / 非法边跳过）。
 * 只服务本模块内的任务态写入——所有路径都不得绕过此处直写 status。
 */
function projectTaskStatus(taskId: string, target: TaskStatus): void {
  const task = getTask(taskId);
  if (!task) throw new Error(`task ${taskId} 不存在`);
  if (task.status === target) return; // 同态 no-op（transitionTaskStatus 对同态会抛）
  if (!canTransition(task.status, target)) return; // 非法边不抛——投影是纠偏不是断言
  transitionTaskStatus(taskId, target);
}

/**
 * run 记账单点：currentRunId 指向活动 run + 任务态投影 in_progress。
 * 漂移才写（幂等调用零多余 UPDATE）；终态不动（迟到结算）；
 * paused 不覆盖（§6.6 用户权威态）。
 */
function ensureRunBookkeeping(taskId: string, runId: string): void {
  const task = getTask(taskId)!;
  if (task.currentRunId !== runId) {
    updateTask(taskId, { currentRunId: runId });
  }
  if (!isTerminal(task.status) && task.status !== 'paused') {
    projectTaskStatus(taskId, 'in_progress');
  }
}

/**
 * 启动（或幂等复用）任务的当前 run——ensure 语义（Review Focus #3）。
 *
 * 流程：已有活动 run → 补记账后返回既有行；countRuns 达 MAX_RUNS_PER_TASK →
 * 人话抛错；否则事务内三步写：insertRun(running) + updateTask({currentRunId}) +
 * 任务态投影 in_progress（非终态且合法时；starter 先 transition 的时序下同态跳过）。
 *
 * paused 恢复不走 startRun（resumePaused 保留 paused → in_progress 边）；
 * 终态任务不转 in_progress，但 run 记账照常（迟到结算场景）。
 */
export function startRun(
  taskId: string,
  opts?: { trigger?: TaskRunTrigger; executionSessionId?: string | null },
): TaskRunRow {
  // 幂等快路径：已有活动 run（running/waiting_human/submitted）——补记账防漂移
  // （currentRunId 未回写 / 任务态滞留 assigned），不重插不抛
  const existing = getActiveRun(taskId);
  if (existing) {
    ensureRunBookkeeping(taskId, existing.id);
    return existing;
  }

  if (countRuns(taskId) >= MAX_RUNS_PER_TASK) {
    throw new Error(
      `任务 ${taskId} 执行尝试已达上限（${MAX_RUNS_PER_TASK} 次），不能再次启动；` +
        `如需继续请新建任务或清理历史 run`,
    );
  }

  return getDb().transaction((): TaskRunRow => {
    let run: TaskRunRow;
    try {
      run = insertRun({
        taskId,
        status: 'running',
        trigger: opts?.trigger ?? 'manual',
        executionSessionId: opts?.executionSessionId ?? null,
      });
    } catch (err) {
      // 单活动 run 唯一索引竞态兜底：并发双触发时后到者读到既有行返回
      if (isUniqueConstraintError(err)) {
        const raced = getActiveRun(taskId);
        if (raced) {
          ensureRunBookkeeping(taskId, raced.id);
          return raced;
        }
      }
      throw err;
    }
    ensureRunBookkeeping(taskId, run.id);
    return run;
  })();
}

/** 取活动 run；无则人话抛错（服务入口的前置契约，调用方无需自行判空） */
function requireActiveRun(taskId: string): TaskRunRow {
  const active = getActiveRun(taskId);
  if (!active) {
    throw new Error(`任务 ${taskId} 无活动 run，不能执行该操作`);
  }
  return active;
}

/**
 * 进入等待人工（HITL 挂起）：活动 run → waiting_human + 任务 → waiting_human。
 * 任务 paused 时只改 run（paused 是用户权威态，不被等人语义覆盖）。
 */
export function enterWaitingHuman(taskId: string): void {
  const active = requireActiveRun(taskId);
  updateRun(active.id, { status: 'waiting_human' });

  const task = getTask(taskId)!;
  if (task.status !== 'paused') {
    projectTaskStatus(taskId, 'waiting_human');
  }
}

/**
 * 人工答复后恢复执行：活动 run → running + 任务 waiting_human → in_progress。
 * paused 不动（恢复走 resumePaused）。
 */
export function resumeFromWaiting(taskId: string): void {
  const active = requireActiveRun(taskId);
  updateRun(active.id, { status: 'running' });

  const task = getTask(taskId)!;
  if (task.status !== 'paused') {
    projectTaskStatus(taskId, 'in_progress');
  }
}

/**
 * run 失败收尾：活动 run → failed(endedAt) + 未决非验收请求 superseded +
 * 任务 → failed（errorMessage=reason）。
 */
export function failRun(taskId: string, reason: string): void {
  const active = requireActiveRun(taskId);
  updateRun(active.id, { status: 'failed', endedAt: Date.now() });
  supersedePendingByRun(active.id);

  const task = getTask(taskId)!;
  // 失败原因无条件落账（run 终结证据）；paused 下任务态 paused → failed 非法边
  // 由投影守卫跳过（用户恢复时由 resumePaused 重新归位）
  updateTask(taskId, { errorMessage: reason });
  if (task.status !== 'paused') {
    projectTaskStatus(taskId, 'failed');
  }
}

/**
 * 取消活动 run：活动 run → cancelled(endedAt) + 未决非验收请求 superseded +
 * 任务 → cancelled。reason 记入 run 的 reject_reason（取消原因审计）。
 */
export function cancelActiveRun(taskId: string, reason?: string): void {
  const active = requireActiveRun(taskId);
  updateRun(active.id, {
    status: 'cancelled',
    endedAt: Date.now(),
    ...(reason !== undefined ? { rejectReason: reason } : {}),
  });
  supersedePendingByRun(active.id);

  projectTaskStatus(taskId, 'cancelled');
}

/**
 * 用户暂停/抢占（非等人，spec §6.6）：任务 → paused（in_progress / waiting_human
 * 边合法），run 状态不动——执行中断由调用方联动（lifecycle 中止链），此处只落任务态。
 */
export function pauseForTask(taskId: string, errorMessage?: string): void {
  const task = getTask(taskId);
  if (!task) throw new Error(`task ${taskId} 不存在`);
  if (task.status === 'paused') return; // 同态幂等
  if (!canTransition(task.status, 'paused')) {
    throw new Error(`任务 ${taskId} status=${task.status}，不能暂停（必须为 in_progress / waiting_human）`);
  }
  transitionTaskStatus(taskId, 'paused', errorMessage !== undefined ? { errorMessage } : {});
}

/**
 * 恢复暂停任务：paused →（活动 run 有未决非验收请求 ? waiting_human : in_progress）。
 * 有人还等着 → 恢复到等人态而不是直接开跑（答复优先，防答案丢失后盲跑）。
 */
export function resumePaused(taskId: string): void {
  const task = getTask(taskId);
  if (!task) throw new Error(`task ${taskId} 不存在`);
  if (task.status !== 'paused') return; // 非暂停态幂等 no-op

  const active = getActiveRun(taskId);
  const pending = active ? countPendingNonAcceptance(active.id) : 0;
  projectTaskStatus(taskId, pending > 0 ? 'waiting_human' : 'in_progress');
}

/**
 * 投影重算（不变量 §5.1-6 单点）：按活动 run 状态 + paused + 未决请求重算任务态。
 * 已在目标态 no-op；paused / 终态不覆盖（用户权威态优先）。
 */
export function refreshTaskProjection(taskId: string): void {
  const task = getTask(taskId)!;
  // paused（用户权威）与终态（不可转出）都不参与投影重算
  if (task.status === 'paused' || isTerminal(task.status)) return;

  const active = getActiveRun(taskId);
  if (!active) return; // 无 run 无从投影（assigned/pending 等待态保持）

  switch (active.status) {
    case 'running':
      projectTaskStatus(taskId, 'in_progress');
      break;
    case 'waiting_human':
      projectTaskStatus(taskId, 'waiting_human');
      break;
    case 'submitted':
      projectTaskStatus(taskId, 'submitted');
      break;
  }
}

// ── Task 10 接线位：提交验收 / 验收 / 打回（占位，move.ts 路由已对齐签名）──

/** 提交验收（Task 10 接线：结束当前 run 为 submitted、任务转 submitted） */
export async function submitRun(id: string, opts: { summary: string }): Promise<void> {
  void id;
  void opts;
  throw new Error('lifecycle-runs 未接线（Task 10）');
}

/** 验收通过（Task 10 接线：run 转 accepted、任务转 completed + acceptedAt） */
export async function acceptTask(id: string): Promise<void> {
  void id;
  throw new Error('lifecycle-runs 未接线（Task 10）');
}

/** 打回（Task 10 接线：run 转 rejected 带 reason、任务转 assigned 建新 run） */
export async function rejectTask(id: string, reason: string): Promise<void> {
  void id;
  void reason;
  throw new Error('lifecycle-runs 未接线（Task 10）');
}
