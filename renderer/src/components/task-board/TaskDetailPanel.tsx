// renderer/src/components/task-board/TaskDetailPanel.tsx
//
// 任务详情侧滑面板（D 子系统 D7-D9）：
//   - 进入时按 taskId 拉取完整 TaskRow（ipc.task.get）
//   - 展示标题/描述/状态/优先级/指派/计划/截止
//   - 操作按钮：pending/assigned → 启动；in_progress → 取消
//   - "进入执行会话"按钮：selectSession(executionSessionId) + setActiveView('im')
//
// 并未做轮询——启动/取消后手动 refresh 一次（ipc.task.get）。看板列表的 5s 轮询会兜底同步。
import { useEffect, useState } from 'react';
import { ipc } from '../../ipc/client';
import { useSessionStore } from '../../stores/session.store';
import { useUiStore } from '../../stores/ui.store';
import type { TaskRow } from '../../ipc/types';

interface TaskDetailPanelProps {
  taskId: string;
  onClose: () => void;
}

export function TaskDetailPanel({ taskId, onClose }: TaskDetailPanelProps) {
  const [task, setTask] = useState<TaskRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    void ipc.task.get(taskId).then((t) => {
      if (!cancelled) setTask(t);
    });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  if (!task) {
    return (
      <div className="flex-1 p-4 text-sm text-neutral-500">
        加载中...
      </div>
    );
  }

  // 启动：拉起 execution room + transition 到 in_progress；成功后刷新本面板
  const handleStart = (): void => {
    void ipc.task.start(taskId, {}).then(() => {
      void ipc.task.get(taskId).then(setTask);
    });
  };

  // 取消：transition 到 cancelled；成功后关闭面板（列表轮询会移除）
  const handleCancel = (): void => {
    void ipc.task.cancel(taskId).then(() => onClose());
  };

  // 进入执行会话：先 selectSession（拉消息历史 + 切 activeSessionId），再切 activeView
  // 为 im。失败仅 console——切视图会让用户进入空 IM 区，意义不大。
  const handleEnterSession = (): void => {
    const sessionId = task.executionSessionId;
    if (!sessionId) return;
    useSessionStore
      .getState()
      .selectSession(sessionId)
      .then(() => useUiStore.getState().setActiveView('im'))
      .catch((err: unknown) => {
        console.error('进入执行会话失败', err);
      });
  };

  // P2 Task 3：原 w-96 侧滑面板——拆分后成为看板主区内容，flex-1 占满剩余空间
  return (
    <div className="flex-1 min-w-0 flex flex-col overflow-y-auto">
      <div className="flex items-center justify-between p-3 border-b border-border-subtle">
        <span className="font-medium">#{task.id.slice(0, 8)}</span>
        <button type="button" onClick={onClose} className="text-neutral-400 hover:text-neutral-100">
          ×
        </button>
      </div>
      <div className="flex-1 p-4 text-sm space-y-3">
        <div>
          <div className="text-xs text-neutral-500 mb-1">标题</div>
          <div>{task.title}</div>
        </div>
        {task.description && (
          <div>
            <div className="text-xs text-neutral-500 mb-1">描述</div>
            <div className="whitespace-pre-wrap">{task.description}</div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>状态: {task.status}</div>
          <div>优先级: {task.priority}</div>
          {task.assigneeAgentId && <div>指派: {task.assigneeAgentId.slice(0, 16)}</div>}
          {task.scheduledAt && (
            <div>📅 {new Date(task.scheduledAt).toLocaleString()}</div>
          )}
          {task.deadlineAt && <div>⏰ {new Date(task.deadlineAt).toLocaleString()}</div>}
          {task.executionSessionId && <div>执行房间: {task.executionSessionId.slice(0, 16)}</div>}
        </div>
        {(task.status === 'in_progress' || task.status === 'paused') && task.executionSessionId && (
          <button
            type="button"
            onClick={handleEnterSession}
            className="text-accent-blue hover:underline"
          >
            进入执行会话 →
          </button>
        )}
      </div>
      <div className="p-3 border-t border-border-subtle flex gap-2">
        {(task.status === 'pending' || task.status === 'assigned') && (
          <button
            type="button"
            onClick={handleStart}
            className="flex-1 px-3 py-1 bg-accent-blue text-white rounded"
          >
            启动
          </button>
        )}
        {task.status === 'in_progress' && (
          <button
            type="button"
            onClick={handleCancel}
            className="flex-1 px-3 py-1 border border-border-subtle rounded"
          >
            取消
          </button>
        )}
      </div>
    </div>
  );
}
