// electron/src/main/task/lifecycle-runs.ts
//
// 任务生命周期 v2 服务层占位（spec 2026-11-13-task-lifecycle-v2 §5）。
// Task 8 只铺 move() 的路由骨架：本模块签名先立、实现统一抛「未接线」；
// Task 10 替换为真实实现（submit 收口当前 run 为 submitted、accept 验收转
// completed、reject 打回 assigned 并建 rework run——run 读写走 runs-repo）。
//
// 签名契约与 move.ts 路由调用点逐字对齐，Task 10 实现不得漂移：
//   - submitRun(id, { summary })  提交验收：in_progress → submitted
//   - acceptTask(id)              验收通过：submitted → completed
//   - rejectTask(id, reason)      打回：submitted → assigned（reason 必填，move 已先行校验）

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
