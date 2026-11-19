// renderer/src/lib/resolve-tracking-task.ts
//
// 跟踪会话 → 任务行解析（spec §12.1 单点）：session summary 的 task 反查排除
// 终态任务（session-ops SQL status NOT IN 终态）——完成后 taskId 投影为 null，
// 故双路解析：taskId 在场直取；缺失按 execution_session_id 从任务列表反查
// （终态任务同样可解析——历史回看入口可达性，2026-11-18 实录）。
import type { TaskRow } from '../ipc/types';
import { ipc } from '../ipc/client';

export async function resolveTrackingTask(session: {
  id: string;
  kind: string;
  taskId: string | null;
  workspaceId: string;
}): Promise<TaskRow | null> {
  if (session.kind !== 'task_execution') return null;
  if (session.taskId != null) {
    try {
      return await ipc.task.get(session.taskId);
    } catch {
      return null;
    }
  }
  try {
    // archived:'all'（2026-11-19）：循环实例验收后自动归档，其执行会话仍须可
    // 解析（归档≠会话历史失效）——默认 exclude 会让历史实例会话全部 miss
    const tasks = await ipc.task.list({ workspaceId: session.workspaceId, archived: 'all' });
    return tasks.find((t) => t.executionSessionId === session.id) ?? null;
  } catch {
    return null;
  }
}
