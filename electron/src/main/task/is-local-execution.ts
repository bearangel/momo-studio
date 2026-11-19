// electron/src/main/task/is-local-execution.ts
//
// 本机执行判定（2026-11-19 任务会话形态分流 / task:steer 本机分支共用）：
// 语义与 renderer/src/lib/is-local-execution.ts 逐字同矩阵（跨 workspace 源码
// 不可共享——两侧单测锁同一矩阵）。
import type { TaskRow } from '../storage/tasks/repo';

/** @param selfNodeId 本节点 id（hub config.nodeId；未配置时仅 mode local 判定） */
export function isLocalExecution(
  task: Pick<TaskRow, 'routing'>,
  selfNodeId: string | null,
): boolean {
  if (task.routing.mode === 'local') return true;
  if (selfNodeId === null || selfNodeId === '') return false;
  return task.routing.targetNodeId === selfNodeId;
}
