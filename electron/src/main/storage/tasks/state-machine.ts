// electron/src/main/storage/tasks/state-machine.ts
//
// Task 状态机——9 个状态 + 合法转换表。
//
// 设计要点：
//   - 9 状态：draft / pending / assigned / session_queued / in_progress / paused / completed / failed / cancelled
//   - 三终态：completed / failed / cancelled——isTerminal 返回 true，不可转出
//   - 转换语义：
//       draft      → 用户刚创建 / 暂存任务，可直接指派（assigned）或丢弃（cancelled）
//       pending    → 调度器已接管但 scheduled_at 未到；到时由调度器推到 assigned
//       assigned   → 已分配到 agent 等待 pickup；agent 取走进入 in_progress；
//                    放行前目标校验失败（agent 已移除/团队解散/会话不存在）直接转
//                    failed 带明示 errorMessage（任务执行运行时 spec §5.1/§9）
//       session_queued → executor 放行时目标会话车道被占（v2.3 spec §3）；
//                        车道空闲后放行进 in_progress，也可取消/失败
//       in_progress→ agent 正在跑；可暂停（paused）/ 完成（completed）/ 失败（failed）/ 取消（cancelled）
//       paused     → 被中断或主动暂停；恢复（in_progress）/ 取消（cancelled）
//   - 非法跳跃（如 draft → in_progress、paused → completed）由 canTransition 拒绝，
//     调度器 / agent runtime 调 transitionTaskStatus 时若状态机拒绝会抛错。
//   - 状态机是纯函数表，与 DB / 时间戳无关。startedAt / completedAt 等时间戳由调用方
//     在 extraPatch 内传入（repo.transitionTaskStatus 自动合并）。

export type TaskStatus =
  | 'draft'
  | 'pending'
  | 'assigned'
  | 'session_queued'
  | 'in_progress'
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
 * paused 只能恢复或取消，不能跳跃到 completed（需先 in_progress 再完成）。
 */
const LEGAL_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  draft: new Set(['pending', 'assigned', 'cancelled']),
  pending: new Set(['assigned', 'cancelled']),
  assigned: new Set(['in_progress', 'session_queued', 'failed', 'cancelled']),
  session_queued: new Set(['in_progress', 'failed', 'cancelled']),
  in_progress: new Set(['paused', 'completed', 'failed', 'cancelled']),
  paused: new Set(['in_progress', 'cancelled']),
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