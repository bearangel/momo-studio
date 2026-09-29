// renderer/src/components/task-board/TaskDetailPanel.tsx
//
// 任务详情面板（D 子系统 D7-D9；K4/K6 重写）：
//   - 数据：打开时 + 每 5s 轮询 ipc.task.get（旧实现只拉一次，任务被调度器
//     推进后面板永远显示旧状态）；操作成功后立即刷新
//   - 展示：状态徽标（taskStatusStyle，不再裸显 draft 枚举）/ 优先级中文 /
//     指派 agent·团队·会话名称（useTaskEntityNames，不再显示 ID 片段）/
//     errorMessage 错误条 / 创建·开始·结束时间
//   - 操作（按状态机合法转换全集，旧实现只有 pending/assigned 启动 +
//     in_progress 取消，draft/paused 是无按钮死任务）：
//       draft(有目标)/pending/assigned → 启动（startTask 支持有目标 draft）
//       draft(无目标) → 提示条引导编辑指派
//       in_progress → 暂停（transition paused；K7-4 后端联动中断 agent 流）
//       paused → 恢复（task:resume——K7-5 后端转 in_progress + kickoff 重注入）
//       非终态 → 取消 + 编辑（EditTaskDialog）
//       已归档（archivedAt 非 null）→ 只读：操作栏/编辑入口整体隐藏
//   - "进入执行会话"：selectSession(executionSessionId) + setActiveView('im')
import { useEffect, useState } from 'react';
import {
  Bot,
  Calendar,
  Clock,
  MessagesSquare,
  Users,
  X,
} from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useSessionStore } from '../../stores/session.store';
import { useStreamStore } from '../../stores/stream.store';
import { useTaskStore } from '../../stores/task.store';
import { useUiStore } from '../../stores/ui.store';
import type { TaskRow } from '../../ipc/types';
import { PENDING_WRAP_UP_STYLE, taskStatusStyle } from '../../lib/task-status';
import { buildTurnReconcileNotice, collectOpenTodoItems } from '../../lib/turn-reconcile';
import { humanizeRecurrence } from '../../lib/recurrence';
import { Button } from '../ui/Button';
import { showToast } from '../ui/Toast';
import { EditTaskDialog } from './EditTaskDialog';
import { TaskChangesPanel } from './TaskChangesPanel';
import { useTaskEntityNames } from './useTaskEntityNames';
import { usePendingWrapUp } from './usePendingWrapUp';

interface TaskDetailPanelProps {
  taskId: string;
  onClose: () => void;
}

/** 面板自身轮询间隔——与 TaskBoardView 列表轮询同节奏（5s） */
const DETAIL_REFRESH_INTERVAL_MS = 5000;

/** 终态判定（与 electron state-machine TERMINAL 集合同步） */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

const PRIORITY_LABEL: Record<number, string> = { 0: '无', 1: '低', 5: '中', 10: '高' };

function formatTime(ms: number | null): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

export function TaskDetailPanel({ taskId, onClose }: TaskDetailPanelProps) {
  const [task, setTask] = useState<TaskRow | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const refreshTask = (): void => {
    void ipc.task
      .get(taskId)
      .then((t) => {
        if (t) setTask(t);
      })
      .catch(() => {
        // get 失败保持现状——下一轮轮询兜底
      });
  };

  useEffect(() => {
    let cancelled = false;
    setTask(null);
    setActionError(null);
    void ipc.task.get(taskId).then((t) => {
      if (!cancelled) setTask(t);
    });
    const interval = setInterval(() => {
      if (!cancelled) refreshTask();
    }, DETAIL_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const names = useTaskEntityNames(task?.workspaceId ?? null);
  // 派生「待收尾」（spec §3.5）：徽标与催收尾按钮共用谓词
  const pendingWrapUp = usePendingWrapUp(task);

  if (!task) {
    return <div className="flex-1 p-4 text-sm text-tertiary">加载中...</div>;
  }

  const status = taskStatusStyle(task.status);
  const priorityLabel = PRIORITY_LABEL[task.priority] ?? String(task.priority);
  // 只读模式：归档任务详情一律只读（archivedAt 单源派生，不依赖调用方传参——
  // 任何入口打开归档任务都自动只读）；隐藏全部任务操作按钮与编辑入口
  const readOnly = task.archivedAt !== null;
  const hasTarget =
    task.assigneeAgentId != null || task.targetTeamId != null || task.targetSessionId != null;
  const terminal = TERMINAL_STATUSES.has(task.status);
  // 启动资格：pending/assigned，或有委派目标的 draft（K2 后端快捷路径）
  const canStart =
    task.status === 'pending' || task.status === 'assigned' || (task.status === 'draft' && hasTarget);
  const canPause = task.status === 'in_progress';
  const canResume = task.status === 'paused';

  const runAction = (action: () => Promise<unknown>): void => {
    setActionError(null);
    action()
      .then(refreshTask)
      .catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : String(err));
      });
  };

  const handleStart = (): void => {
    runAction(() => ipc.task.start(taskId, {}));
  };

  const handlePause = (): void => {
    runAction(() => ipc.task.transition(taskId, 'paused'));
  };

  const handleResume = (): void => {
    runAction(() => ipc.task.resume(taskId));
  };

  const handleCancel = (): void => {
    runAction(async () => {
      await ipc.task.cancel(taskId);
      onClose();
    });
  };

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

  /**
   * 催收尾（spec §3.6）：向宿主会话注入与 electron F1 同一模板文本（镜像逐字同步）。
   * 点击瞬间从 store 快读取数（非响应式）——待办来自宿主会话最新带 todos 的流聚合；
   * 拿不到待办数据时退化为不含列表项的版本（按钮 title 已说明）。
   */
  const handleUrgeWrapUp = (): void => {
    const sessionId = task.executionSessionId;
    if (!sessionId) return;
    const messages = useSessionStore.getState().messagesBySession.get(sessionId);
    const items = collectOpenTodoItems(messages, useStreamStore.getState().streams);
    const body = buildTurnReconcileNotice(task.id, items ?? []);
    ipc.session
      .send(sessionId, body)
      .then(() => showToast('已向执行会话发送收尾提醒'))
      .catch((err: unknown) => {
        showToast(`催收尾发送失败: ${err instanceof Error ? err.message : String(err)}`);
      });
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col overflow-y-auto">
      <div className="flex items-center justify-between p-3 border-b border-subtle">
        <span className="font-medium">#{task.id}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="text-tertiary hover:text-primary leading-none px-1 rounded"
          >
            <X size={14} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      </div>
      <div className="flex-1 p-4 text-sm space-y-3">
        <div>
          <div className="text-base font-medium text-primary">{task.title}</div>
        </div>
        {task.description && (
          <div className="whitespace-pre-wrap text-secondary">{task.description}</div>
        )}
        <div className="flex items-center gap-2">
          <span className={status.className}>{status.label}</span>
          {readOnly && <span className="text-xs text-tertiary">已归档 · 只读</span>}
          {pendingWrapUp && (
            <span
              className={PENDING_WRAP_UP_STYLE.className}
              title="任务仍在进行，但宿主会话当前没有运行回合"
            >
              {PENDING_WRAP_UP_STYLE.label}
            </span>
          )}
          {task.status === 'assigned' && (
            <span className="text-xs text-status-warning">等待调度放行</span>
          )}
        </div>
        {task.status === 'draft' && !hasTarget && (
          <div className="rounded bg-status-warning-tint px-3 py-2 text-xs text-status-warning">
            任务尚未指派委派目标——点击「编辑」选择 agent / 团队 / 会话后即可启动。
          </div>
        )}
        {task.errorMessage && (
          <div className="rounded bg-status-error-tint px-3 py-2 text-xs text-status-error">
            {task.errorMessage}
          </div>
        )}
        {actionError && (
          <div className="rounded bg-status-error-tint px-3 py-2 text-xs text-status-error">
            操作失败：{actionError}
          </div>
        )}
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <div className="flex flex-col gap-0.5">
            <span className="text-tertiary">优先级</span>
            <span className="text-secondary">{priorityLabel}</span>
          </div>
          {task.assigneeAgentId && (
            <div className="flex flex-col gap-0.5">
              <span className="text-tertiary">指派 agent</span>
              <span className="inline-flex items-center gap-1 text-secondary">
                <Bot size={11} strokeWidth={1.75} aria-hidden />
                {names.agentName(task.assigneeAgentId)}
              </span>
            </div>
          )}
          {task.targetTeamId && (
            <div className="flex flex-col gap-0.5">
              <span className="text-tertiary">目标团队</span>
              <span className="inline-flex items-center gap-1 text-secondary">
                <Users size={11} strokeWidth={1.75} aria-hidden />
                {names.teamName(task.targetTeamId)}
              </span>
            </div>
          )}
          {task.targetSessionId && (
            <div className="flex flex-col gap-0.5">
              <span className="text-tertiary">目标会话</span>
              <span className="inline-flex items-center gap-1 text-secondary">
                <MessagesSquare size={11} strokeWidth={1.75} aria-hidden />
                {names.sessionTitle(task.targetSessionId)}
              </span>
            </div>
          )}
          {task.scheduledAt && (
            <div className="flex flex-col gap-0.5">
              <span className="text-tertiary">计划开始</span>
              <span className="inline-flex items-center gap-1 text-secondary">
                <Calendar size={11} strokeWidth={1.75} aria-hidden />
                {formatTime(task.scheduledAt)}
              </span>
            </div>
          )}
          {task.deadlineAt && (
            <div className="flex flex-col gap-0.5">
              <span className="text-tertiary">截止时间</span>
              <span className="inline-flex items-center gap-1 text-secondary">
                <Clock size={11} strokeWidth={1.75} aria-hidden />
                {formatTime(task.deadlineAt)}
              </span>
            </div>
          )}
          {task.recurrenceRule && (
            <div className="flex flex-col gap-0.5">
              <span className="text-tertiary">循环规则</span>
              <span className="text-secondary">{humanizeRecurrence(task.recurrenceRule)}</span>
            </div>
          )}
          {task.recurrenceParentId && (
            <div className="flex flex-col gap-0.5">
              <span className="text-tertiary">母任务</span>
              <button
                type="button"
                onClick={() => useTaskStore.getState().setSelectedTaskId(task.recurrenceParentId)}
                className="text-left text-accent-600 hover:underline dark:text-accent-300"
              >
                #{task.recurrenceParentId}
              </button>
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            <span className="text-tertiary">创建时间</span>
            <span className="text-secondary">{formatTime(task.createdAt)}</span>
          </div>
          {task.startedAt && (
            <div className="flex flex-col gap-0.5">
              <span className="text-tertiary">开始时间</span>
              <span className="text-secondary">{formatTime(task.startedAt)}</span>
            </div>
          )}
          {task.completedAt && (
            <div className="flex flex-col gap-0.5">
              <span className="text-tertiary">结束时间</span>
              <span className="text-secondary">{formatTime(task.completedAt)}</span>
            </div>
          )}
          {task.archivedAt && (
            <div className="flex flex-col gap-0.5">
              <span className="text-tertiary">归档时间</span>
              <span className="text-secondary">{formatTime(task.archivedAt)}</span>
            </div>
          )}
          {task.status === 'in_progress' && task.startedAt && (
            <div className="flex flex-col gap-0.5">
              <span className="text-tertiary">执行进度</span>
              <span className="text-secondary">
                已用 {Math.round((Date.now() - task.startedAt) / 60000)} min · {task.toolCallsUsed}{' '}
                次工具调用
              </span>
            </div>
          )}
        </div>
        {/* 变更与回滚分区常驻挂载（G1）：分区头与摘要计数由 TaskChangesPanel 自持 */}
        <div className="pt-1">
          <TaskChangesPanel workspaceId={task.workspaceId} taskId={taskId} />
        </div>
        {(task.status === 'in_progress' || task.status === 'paused') && task.executionSessionId && (
          <button
            type="button"
            onClick={handleEnterSession}
            className="text-accent-600 hover:underline dark:text-accent-300"
          >
            进入执行会话 →
          </button>
        )}
      </div>
      {/* 操作栏：归档任务（readOnly）整栏隐藏——只能查看，不能编辑/启动等操作 */}
      {!readOnly && (
        <div className="p-3 border-t border-subtle flex gap-2">
          {!terminal && (
            <Button
              variant="secondary"
              aria-label="编辑任务"
              onClick={() => setEditOpen(true)}
              className="flex-1"
            >
              编辑
            </Button>
          )}
          {canStart && (
            <Button variant="primary" onClick={handleStart} className="flex-1">
              启动
            </Button>
          )}
          {canPause && (
            <Button variant="ghost" onClick={handlePause} className="flex-1">
              暂停
            </Button>
          )}
          {pendingWrapUp && (
            <Button
              variant="ghost"
              onClick={handleUrgeWrapUp}
              className="flex-1"
              title="向执行会话发送回合收尾核对提醒；若当前拿不到待办数据，提醒将不含未清项列表"
            >
              催收尾
            </Button>
          )}
          {canResume && (
            <Button variant="primary" onClick={handleResume} className="flex-1">
              恢复
            </Button>
          )}
          {!terminal && (
            <Button variant="danger" onClick={handleCancel} className="flex-1">
              取消任务
            </Button>
          )}
        </div>
      )}
      {!terminal && !readOnly && (
        <EditTaskDialog
          open={editOpen}
          onClose={() => setEditOpen(false)}
          onSaved={refreshTask}
          task={task}
          workspaceId={task.workspaceId}
        />
      )}
    </div>
  );
}
