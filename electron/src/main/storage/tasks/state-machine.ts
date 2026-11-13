// electron/src/main/storage/tasks/state-machine.ts
//
// Task 状态机——11 个状态 + 合法转换表，及 run 状态机（spec 2026-11-13-task-lifecycle-v2 §5.1/§5.2）。
//
// 设计要点：
//   - 11 状态：draft / pending / assigned / session_queued / in_progress / waiting_human /
//     submitted / paused / completed / failed / cancelled（v2 新增 waiting_human、submitted）
//   - 三终态：completed / failed / cancelled——isTerminal 返回 true，不可转出
//   - 两条不变量（v2 语义）：
//       ① completed 只能由 submitted 进入（完成必须经人工/自动验收）——
//          in_progress → completed 直达边已删除，回归锁见 task-state-machine.test.ts
//       ② paused = 用户停止/抢占，不是等人；等人走 waiting_human（HITL 挂起）
//   - 转换语义：
//       draft      → 用户刚创建 / 暂存任务，可直接指派（assigned）或丢弃（cancelled）
//       pending    → 调度器已接管但 scheduled_at 未到；到时由调度器推到 assigned
//       assigned   → 已分配到 agent 等待 pickup；agent 取走进入 in_progress；
//                    放行前目标校验失败（agent 已移除/团队解散/会话不存在）直接转
//                    failed 带明示 errorMessage（任务执行运行时 spec §5.1/§9）
//       session_queued → executor 放行时目标会话车道被占（v2.3 spec §3）；
//                        车道空闲后放行进 in_progress，也可取消/失败
//       in_progress→ agent 正在跑；可挂人（waiting_human）/ 提交验收（submitted）/
//                    暂停（paused）/ 失败（failed）/ 取消（cancelled）
//       waiting_human → 等人工输入（HITL）；答复后回 in_progress 续跑，也可暂停/失败/取消
//       submitted  → 交付已提交待验收；验收通过 completed；打回走 assigned 重启；
//                    验收期也可取消/失败
//       paused     → 用户停止/抢占（非等人）；恢复（in_progress）/ 挂人（waiting_human）/
//                    取消（cancelled）
//   - 非法跳跃（如 draft → in_progress、paused → completed）由 canTransition 拒绝，
//     调度器 / agent runtime 调 transitionTaskStatus 时若状态机拒绝会抛错。
//   - 状态机是纯函数表，与 DB / 时间戳无关。startedAt / completedAt 等时间戳由调用方
//     在 extraPatch 内传入（repo.transitionTaskStatus 自动合并）。
//
// run 状态机（§5.2）：一次执行尝试（task_runs 行）的生命周期，与 task 状态正交——
// running / waiting_human / submitted 为活跃态（ACTIVE_TASK_RUN_STATUSES），
// accepted / rejected / failed / cancelled 为终态；打回（rejected）= 新 run，不可转回 running。

export type TaskStatus =
  | 'draft'
  | 'pending'
  | 'assigned'
  | 'session_queued'
  | 'in_progress'
  | 'waiting_human'
  | 'submitted'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'cancelled']);

/**
 * 合法转换表：from → Set<to>
 *
 * 终态（completed / failed / cancelled）的 Set 为空，表示不可转出。
 * pending 不允许直接转 in_progress（必须先 assigned 由调度器升级），
 * draft 也不允许直接转 in_progress（同理）。
 * in_progress → completed 已删除：完成必须经 submitted 验收（v2 不变量①）。
 * paused → waiting_human 允许（停止后补挂 HITL），语义区分见不变量②。
 */
const LEGAL_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  draft: new Set(['pending', 'assigned', 'cancelled']),
  pending: new Set(['assigned', 'cancelled']),
  assigned: new Set(['in_progress', 'session_queued', 'failed', 'cancelled']),
  session_queued: new Set(['in_progress', 'failed', 'cancelled']),
  in_progress: new Set(['waiting_human', 'submitted', 'paused', 'failed', 'cancelled']),
  waiting_human: new Set(['in_progress', 'paused', 'failed', 'cancelled']),
  submitted: new Set(['completed', 'assigned', 'cancelled', 'failed']),
  paused: new Set(['in_progress', 'waiting_human', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

/**
 * 判断 from → to 是否为合法转换。终态的 to 集合为空，故任何转出均返回 false。
 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return LEGAL_TRANSITIONS[from].has(to);
}

/**
 * 强制断言 from → to 合法。非法时抛 Error（含 from/to 信息便于排错）。
 * 用于 repo.transitionTaskStatus 和调度器 / agent runtime 的状态转换入口。
 */
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`非法 task 状态转换: ${from} → ${to}`);
  }
}

/**
 * 判断 status 是否为终态。终态不可转出。
 */
export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

// ── run 状态机（spec §5.2）──

/** run 状态：一次执行尝试（task_runs 行）的生命周期，与 task 状态正交 */
export type TaskRunStatus =
  | 'running'
  | 'waiting_human'
  | 'submitted'
  | 'accepted'
  | 'rejected'
  | 'failed'
  | 'cancelled';

/** 活跃 run 三态（task_runs 部分索引 idx_task_runs_active 同值域；Task 6/9 消费） */
export const ACTIVE_TASK_RUN_STATUSES: readonly TaskRunStatus[] = [
  'running',
  'waiting_human',
  'submitted',
];

const RUN_LEGAL: Record<TaskRunStatus, ReadonlySet<TaskRunStatus>> = {
  running: new Set(['waiting_human', 'submitted', 'failed', 'cancelled']),
  waiting_human: new Set(['running', 'failed', 'cancelled']),
  submitted: new Set(['accepted', 'rejected', 'cancelled', 'failed']),
  accepted: new Set(),
  rejected: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

/**
 * 判断 run from → to 是否合法。打回（rejected）不是转回 running——
 * 打回意味着本次 run 终结，重启执行是新 run。
 */
export function canTransitionRun(from: TaskRunStatus, to: TaskRunStatus): boolean {
  return RUN_LEGAL[from].has(to);
}
