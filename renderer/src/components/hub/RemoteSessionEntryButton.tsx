// renderer/src/components/hub/RemoteSessionEntryButton.tsx
//
// 跟踪会话头部「进入远端会话」入口（入口回归修复：旧 RemoteSessionEntry 随只读
// 抽屉退役后，「点进跟踪会话 → 看远端执行」这条最自然路径成死路——2026-11-18
// 人工验收实录）。门控挂 kind='task_execution'（session summary 的 task 反查
// 排除终态任务——完成后 taskId 投影为 null，不能作门）；点击先 join 锚点、
// 缺失时按 execution_session_id 从任务列表反查，终态任务同样可回看远端历史。
import { Eye } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { SessionSummary } from '../../ipc/types';
import { useUiStore } from '../../stores/ui.store';
import { showToast } from '../ui/Toast';

export function RemoteSessionEntryButton({ session }: { session: SessionSummary }): React.JSX.Element | null {
  if (session.kind !== 'task_execution') return null;
  const onClick = (): void => {
    const resolve = session.taskId != null
      ? ipc.task.get(session.taskId)
      : ipc.task.list({ workspaceId: session.workspaceId }).then((ts) =>
          ts.find((t) => t.executionSessionId === session.id) ?? null);
    void resolve
      .then((task) => {
        if (task === null || task.delegationId == null) {
          showToast('该会话已无关联的委派任务——可能已被回收');
          return;
        }
        useUiStore.getState().openRemoteSession(task);
      })
      .catch(() => {
        showToast('打开远端会话失败：任务读取失败，请稍后重试');
      });
  };
  return (
    <button
      type="button"
      aria-label="进入远端会话"
      data-testid="remote-session-entry-button"
      onClick={onClick}
      className="flex h-[26px] shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-secondary hover:bg-surface-2 hover:text-primary"
    >
      <Eye size={14} strokeWidth={1.75} aria-hidden />
      进入远端会话
    </button>
  );
}
