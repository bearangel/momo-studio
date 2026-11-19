// renderer/src/lib/is-local-execution.ts
//
// 本机执行判定（2026-11-19 任务会话形态分流）：
//   执行节点 == 委派目标节点（本节点）⟺ 本机执行 → 会话用本地形态渲染。
// 判定看「数据在哪」而非派发方式——自动调度（group）/指定节点（node）落到
// 本节点自己的任务，执行数据全在本地库，同样是「本地任务执行效果」；
// 只有目标为其它节点（本地仅镜像）才走远程跟踪面板。
// 与 electron/src/main/task/is-local-execution.ts 同语义双实现（跨 workspace
// 源码不可共享——两侧单测锁同一矩阵）。
import type { TaskRow } from '../ipc/types';

/**
 * @param task 任务行（仅用 routing）
 * @param selfNodeId 本节点 id（hub 配置；未配置/null 时仅 mode local 判定——
 *        不会把远端任务误判为本机）
 */
export function isLocalExecution(
  task: Pick<TaskRow, 'routing'>,
  selfNodeId: string | null,
): boolean {
  if (task.routing.mode === 'local') return true;
  if (selfNodeId === null || selfNodeId === '') return false;
  return task.routing.targetNodeId === selfNodeId;
}
