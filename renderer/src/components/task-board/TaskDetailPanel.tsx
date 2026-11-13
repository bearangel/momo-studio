// renderer/src/components/task-board/TaskDetailPanel.tsx
//
// 任务详情面板（D 子系统 D7-D9；K4/K6 重写）：
//   - 数据：打开时 + 每 5s 轮询 ipc.task.get（旧实现只拉一次，任务被调度器
//     推进后面板永远显示旧状态）；操作成功后立即刷新
//   - 展示：状态徽标（taskStatusStyle，不再裸显 draft 枚举）/ 优先级中文 /
//     指派 agent·团队·会话名称（useTaskEntityNames，不再显示 ID 片段）/
//     errorMessage 错误条 / 创建·开始·结束时间
//   - 操作（2026-09-30 泳道语义重构 §4.2：启动=入队走 store.move 单点）：
//       draft(有目标) → 启动（move 排队中；executor 闸门决定何时真正跑）
//       draft(无目标) → 提示条引导编辑指派（无启动按钮，与拖拽弹框路径区分）
//       assigned/session_queued → 在队列由 executor 管，无启动按钮
//       in_progress → 暂停（transition paused；K7-4 后端联动中断 agent 流）
//       paused → 恢复（task:resume——K7-5 后端转 in_progress + kickoff 重注入）
//       非终态 → 取消；编辑仅 draft/pending（isEditableStatus 单源——进入
//       执行管线即锁定，2026-09-30 用户反馈收敛；pending 随迁移 051 退役）
//       已归档（archivedAt 非 null）→ 只读：操作栏/编辑入口整体隐藏
//   - "进入执行会话"（G2）：locateTaskExecution——全状态可用，完结任务也能回看执行记录
//   - "来源消息定位"（G2）：locateMessage——跳回来源会话并锚定创建任务的原始消息
//   - 任务生命周期 v2（Task 24，预览合同 .omo/previews/2026-11-13-task-lifecycle-board.html
//     第 4 节 / 定值清单 #19-#21）：
//       · run 时间线（#19）：ipc.task.listRuns 按 run_no ASC——run 状态色点
//         （失败/打回红、执行 accent、等待人工 warning+光环、提交 accent 描边、
//         验收绿、取消中性）、起止时间、rejected 行打回理由引用、submitted/
//         accepted 行交付摘要一行；task:runChanged 推送按 taskId 三路刷新
//       · 未决请求聚合（#20）：ipc.human.list({taskId})（缺省 pending）——精简
//         只读列表行 + 「到会话处理」跳转（selectSession + 切 im 视图；不挂
//         T22 卡组件——面板双挂载焦点冲突，Task 24 裁定）；#7 的 N 计数仅此处展示
//       · 验收操作区（#21）：任务 submitted 态显示——通过 task.accept / 打回
//         复用 RejectReasonDialog（#17 空理由禁用）→ task.reject；非 submitted 不显示
import { useEffect, useState } from 'react';
import {
  Bot,
  Calendar,
  Clock,
  MessagesSquare,
  Shield,
  Users,
  X,
} from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useSessionStore } from '../../stores/session.store';
import { useStreamStore } from '../../stores/stream.store';
import { useTaskStore } from '../../stores/task.store';
import { useUiStore } from '../../stores/ui.store';
import type {
  HumanRequestKind,
  HumanRequestRow,
  TaskRow,
  TaskRunRow,
  TaskRunStatus,
  TaskRunTrigger,
} from '../../ipc/types';
import { PENDING_WRAP_UP_STYLE, taskStatusStyle } from '../../lib/task-status';
import { hasDelegationTarget, isEditableStatus } from '../../lib/board';
import { buildTurnReconcileNotice, collectOpenTodoItems } from '../../lib/turn-reconcile';
import { humanizeRecurrence } from '../../lib/recurrence';
import { locateMessage, locateTaskExecution } from '../../lib/locate-message';
import { Badge, type BadgeTone } from '../ui/Badge';
import { Button } from '../ui/Button';
import { showToast } from '../ui/Toast';
import { EditTaskDialog } from './EditTaskDialog';
import { RejectReasonDialog } from './RejectReasonDialog';
import { TaskChangesView } from './TaskChangesView';
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

// ── run 时间线（预览合同 #19）────────────────────────────────────────────────

const RUN_STATUS_LABEL: Record<TaskRunStatus, string> = {
  running: '执行中',
  waiting_human: '等待人工',
  submitted: '已提交待验收',
  accepted: '验收通过',
  rejected: '被打回',
  failed: '失败',
  cancelled: '已取消',
};

/** 非 initial 触发的返工/重试标记徽标文案（initial 首跑无标记，与卡片 #8 同语义） */
const TRIGGER_BADGE: Partial<Record<TaskRunTrigger, string>> = {
  rework: '返工',
  quota_retry: '配额重试',
  manual: '手动',
};

/**
 * run 状态 → 时间线圆点（#19：失败/打回 error 实心、执行 accent-500 实心、
 * 等待人工 warning 实心 + 3px warning-tint 光环、提交 accent 1.5px 描边空心、
 * 验收绿 1.5px 描边空心、取消中性默认色）。返回串为静态字面量——Tailwind 扫描可见。
 */
function runDotClass(status: TaskRunStatus): string {
  switch (status) {
    case 'failed':
    case 'rejected':
      return 'bg-status-error';
    case 'running':
      return 'bg-accent-500';
    case 'waiting_human':
      return 'bg-status-warning shadow-[0_0_0_3px_var(--status-warning-tint)]';
    case 'submitted':
      return 'border-[1.5px] border-accent-500';
    case 'accepted':
      return 'border-[1.5px] border-status-success';
    default:
      return 'bg-strong';
  }
}

function formatRunTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

/** deliverableJson 形状（electron submitTask 落库：{ summary, files, artifacts }）；畸形 → null 降级不渲染 */
function parseDeliverable(raw: string | null): { summary: string; files: string[] } | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { summary?: unknown; files?: unknown };
    if (typeof parsed.summary !== 'string') return null;
    const files =
      Array.isArray(parsed.files) && parsed.files.every((f) => typeof f === 'string')
        ? (parsed.files as string[])
        : [];
    return { summary: parsed.summary, files };
  } catch {
    return null;
  }
}

// ── 未决请求聚合（预览合同 #20）──────────────────────────────────────────────

/** kind 徽标（label/tone 与 T22 HumanRequestPanel KIND_META 同源词表，双向同步） */
const KIND_BADGE: Record<HumanRequestKind, { label: string; tone: BadgeTone }> = {
  tool_gate: { label: '工具门', tone: 'warning' },
  question: { label: '提问', tone: 'accent' },
  manual_action: { label: '人工操作', tone: 'violet' },
  acceptance: { label: '验收', tone: 'success' },
};

/** btn-sm（#20/#21 合同 24px 高）——Button size=sm 基类 28px，按合同覆写 */
const BTN_SM = 'h-6 px-[9px] text-[11.5px]';

export function TaskDetailPanel({ taskId, onClose }: TaskDetailPanelProps) {
  // 首帧初值：task.store 命中行（zustand 单例跨视图保留——切执行会话再切回
  // 看板时抽屉重开，列表已有该行，零等待渲染，消除「空白一段时间」）；
  // fetch 权威行回来再覆盖，轮询语义不变
  const storeTask = useTaskStore((s) => s.tasks.find((t) => t.id === taskId) ?? null);
  const move = useTaskStore((s) => s.move);
  const [task, setTask] = useState<TaskRow | null>(storeTask);
  const [editOpen, setEditOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Task 24：run 时间线 / 未决请求 / 验收打回
  const [runs, setRuns] = useState<TaskRunRow[]>([]);
  const [pendingRequests, setPendingRequests] = useState<HumanRequestRow[]>([]);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [acceptBusy, setAcceptBusy] = useState(false);
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
  const refreshRuns = (): void => {
    void ipc.task
      .listRuns(taskId)
      .then(setRuns)
      .catch(() => {
        // 拉取失败保持现状——runChanged 推送 / 下次打开兜底
      });
  };
  const refreshPending = (): void => {
    // human.list 缺省 status='pending'——只看未决（Task 16 契约）
    void ipc.human
      .list({ taskId })
      .then(setPendingRequests)
      .catch(() => {
        // 同上：瞬时 IPC 错误不清空既有列表
      });
  };

  useEffect(() => {
    let cancelled = false;
    // taskId 切换时先落 store 命中行（同上：零等待防空白），无命中才显示加载中
    setTask(storeTask);
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

  useEffect(() => {
    let cancelled = false;
    // 切任务先清旧数据，防上一任务的 runs/请求闪现
    setRuns([]);
    setPendingRequests([]);
    refreshRuns();
    refreshPending();
    // runChanged（本任务）→ 三路刷新：runs 时间线 / 未决请求（acceptance 顶替、
    // supersede/cancel 只发 runChanged 的兜底路径）/ 任务行（submitted → completed 投影）
    const offRun = ipc.task.onTaskRunChanged((e) => {
      if (cancelled || e.taskId !== taskId) return;
      refreshRuns();
      refreshPending();
      refreshTask();
    });
    // 会话内答复（tool_gate 不改 run 状态、不发 runChanged）→ 单刷未决列表；
    // 事件载荷无 taskId 无法定点，面板打开期间单条 human:list 代价可控
    const offHuman = ipc.human.onChanged(() => {
      if (cancelled) return;
      refreshPending();
    });
    return () => {
      cancelled = true;
      offRun();
      offHuman();
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
  // 编辑资格与 BoardCard 菜单同源（isEditableStatus 单源）：
  // 进入执行管线（assigned/session_queued/in_progress/paused）即锁定编辑
  const canEdit = isEditableStatus(task.status);
  // 谓词单源 lib/board.hasDelegationTarget（与 AssignTargetDialog/拖拽拦截同源）
  const hasTarget = hasDelegationTarget(task);
  const terminal = TERMINAL_STATUSES.has(task.status);
  // 启动资格（2026-09-30 §4.2 收敛）：draft 且有委派目标——「启动」= move 入队
  // （executeMove 单点：目标校验/转 assigned/notify/保组原子）。pending 已随
  // 迁移 051 退役；assigned/session_queued 已在队列由 executor 管，不再显示
  // D4（Oracle MUST FIX 2）：dispatch 簿记行由会话链管理，详情面板只读——
  // 暂停/恢复/取消/启动全部隐藏（主进程 IPC 守卫是执法层，此处防挫败）
  const dispatchReadOnly = task.origin === 'dispatch';
  const canStart = task.status === 'draft' && hasTarget && !dispatchReadOnly;
  const canPause = task.status === 'in_progress' && !dispatchReadOnly;
  const canResume = task.status === 'paused' && !dispatchReadOnly;

  const runAction = (action: () => Promise<unknown>): void => {
    setActionError(null);
    action()
      .then(refreshTask)
      .catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : String(err));
      });
  };

  // 启动 = 入队（§4.2）：走 task.store.move（乐观更新 + 失败回滚内置），
  // 落点排队中列、保持当前组；错误经 runAction 进 actionError
  const handleStart = (): void => {
    runAction(() => move(taskId, { column: 'assigned', groupId: task.groupId }));
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

  /** 验收/打回共通：成功后立即三路刷新（runChanged 推送亦到，显式刷防闪烁） */
  const operateAcceptance = (action: () => Promise<unknown>): void => {
    setActionError(null);
    setAcceptBusy(true);
    action()
      .then(() => {
        refreshTask();
        refreshRuns();
        refreshPending();
      })
      .catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setAcceptBusy(false));
  };

  const handleAccept = (): void => {
    operateAcceptance(() => ipc.task.accept(taskId));
  };

  /** 未决请求「到会话处理」跳转（Task 24 裁定：精简行 + 跳转，不双挂 T22 卡） */
  const handleGoSession = (sessionId: string): void => {
    void useSessionStore.getState().selectSession(sessionId);
    useUiStore.getState().setActiveView('im');
  };

  /** G2：执行会话定位（全状态可用——完结任务也能回看执行记录） */
  const handleEnterSession = (): void => {
    const sessionId = task.executionSessionId;
    if (sessionId === null) return;
    void locateTaskExecution(task.id, sessionId);
  };

  /** G2：来源消息定位（悬空时 locateMessage 内部 toast 降级） */
  const handleLocateSource = (): void => {
    if (task.sourceSessionId === null) return;
    void locateMessage(task.sourceSessionId, task.sourceMessageId);
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
          {task.sourceSessionId && (
            <div className="flex flex-col gap-0.5">
              <span className="text-tertiary">来源</span>
              <button
                type="button"
                onClick={handleLocateSource}
                className="text-left text-accent-600 hover:underline dark:text-accent-300"
              >
                来源消息定位
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
        {/* ── run 时间线（预览合同 #19）——listRuns 按 run_no ASC；无 run 的任务整节不渲染 */}
        {runs.length > 0 && (
          <section data-testid="task-run-timeline" aria-label="run 时间线">
            <div className="mb-2 text-xs font-semibold text-secondary">run 时间线</div>
            <div className="flex flex-col">
              {runs.map((run, i) => {
                const deliverable =
                  run.status === 'submitted' || run.status === 'accepted'
                    ? parseDeliverable(run.deliverableJson)
                    : null;
                return (
                  <div
                    key={run.id}
                    data-testid={`task-run-row-${run.runNo}`}
                    className="relative flex gap-2.5 pb-[11px] last:pb-0"
                  >
                    {i < runs.length - 1 && (
                      <div className="absolute bottom-0 left-[4px] top-[13px] w-px bg-subtle" />
                    )}
                    <span
                      aria-hidden
                      className={`z-[1] mt-1 h-[9px] w-[9px] shrink-0 rounded-full ${runDotClass(run.status)}`}
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] font-medium text-primary">
                        run #{run.runNo} {RUN_STATUS_LABEL[run.status]}
                        {TRIGGER_BADGE[run.trigger] !== undefined && (
                          <Badge tone="neutral">{TRIGGER_BADGE[run.trigger]}</Badge>
                        )}
                      </div>
                      <div className="text-[10px] text-tertiary">
                        {formatRunTime(run.startedAt)} –{' '}
                        {run.endedAt !== null ? formatRunTime(run.endedAt) : '至今'}
                      </div>
                      {run.status === 'rejected' && run.rejectReason !== null && (
                        <div className="mt-0.5 border-l-[3px] border-strong pl-2.5 text-[11px] leading-relaxed text-secondary">
                          {run.rejectReason}
                        </div>
                      )}
                      {deliverable !== null && (
                        <div
                          className="truncate text-[11px] text-tertiary"
                          title={deliverable.summary}
                        >
                          交付：{deliverable.summary}
                          {deliverable.files.length > 0 ? ` · ${deliverable.files.length} 文件` : ''}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
        {/* ── 未决请求聚合（预览合同 #20）——精简只读行 + 跳转；#7 的 N 计数仅此处展示 */}
        {pendingRequests.length > 0 && (
          <section data-testid="task-pending-requests">
            <div className="mb-2 text-xs font-semibold text-secondary">
              未决请求（{pendingRequests.length}）
            </div>
            <PendingRequestBlock rows={pendingRequests} onGoSession={handleGoSession} />
          </section>
        )}
        {/* ── 验收操作区（预览合同 #21）——仅任务 submitted 态显示（Task 24 裁定：
            非 submitted 不渲染，预览的禁用态示意不落地） */}
        {task.status === 'submitted' && (
          <section data-testid="task-acceptance">
            <div className="mb-2 text-xs font-semibold text-secondary">验收操作</div>
            <div className="flex flex-col gap-2 rounded-lg border border-strong p-2.5">
              <div className="text-[11px] leading-relaxed text-tertiary">
                已提交待验收 · 打回必填理由（空理由禁用确认），打回将生成新 run 并回到排队中。
              </div>
              <div className="flex flex-wrap items-center gap-[7px]">
                <Button
                  variant="primary"
                  size="sm"
                  className={BTN_SM}
                  disabled={acceptBusy}
                  onClick={handleAccept}
                >
                  验收通过
                </Button>
                <Button
                  variant="danger-outline"
                  size="sm"
                  className={BTN_SM}
                  disabled={acceptBusy}
                  onClick={() => setRejectOpen(true)}
                >
                  打回返工
                </Button>
              </div>
            </div>
          </section>
        )}
        {/* 变更查看（2026-09-30 预览确认）：纯只读分区替代旧「变更与回滚」——
            视觉与气泡 ChangesChip 同款，回滚统一走气泡右下角 TurnUndoButton
            （仅最后气泡渲染），任务面板不感知回滚资格。会话已删除（悬空
            executionSessionId）→ 置灰不可点（点击链路 toast 降级兜底竞态） */}
        <TaskChangesView workspaceId={task.workspaceId} taskId={taskId} />
        {task.executionSessionId &&
          (names.sessionExists(task.executionSessionId) ? (
            <button
              type="button"
              onClick={handleEnterSession}
              className="text-accent-600 hover:underline dark:text-accent-300"
            >
              进入执行会话 →
            </button>
          ) : (
            <button
              type="button"
              disabled
              title="该任务的执行会话已被删除"
              className="cursor-not-allowed text-tertiary"
            >
              执行会话已删除
            </button>
          ))}
      </div>
      {/* 操作栏：归档任务（readOnly）整栏隐藏——只能查看，不能编辑/启动等操作 */}
      {!readOnly && (
        <div className="p-3 border-t border-subtle flex gap-2">
          {canEdit && (
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
          {!terminal && !dispatchReadOnly && (
            <Button variant="danger" onClick={handleCancel} className="flex-1">
              取消任务
            </Button>
          )}
        </div>
      )}
      {canEdit && !readOnly && (
        <EditTaskDialog
          open={editOpen}
          onClose={() => setEditOpen(false)}
          onSaved={refreshTask}
          task={task}
          workspaceId={task.workspaceId}
        />
      )}
      {rejectOpen && (
        <RejectReasonDialog
          task={task}
          onConfirm={(reason) => {
            setRejectOpen(false);
            operateAcceptance(() => ipc.task.reject(taskId, reason));
          }}
          onClose={() => setRejectOpen(false)}
        />
      )}
    </div>
  );
}

/** 未决请求聚合块（#20：warning 边框 8px 圆角 + warning-tint 头 + kind 徽标行） */
function PendingRequestBlock({
  rows,
  onGoSession,
}: {
  rows: HumanRequestRow[];
  onGoSession: (sessionId: string) => void;
}) {
  // 超时预警提示（#20 头部）：有 deadline 的行里最近的剩余分钟；无 deadline 显示纯计数
  const now = Date.now();
  const earliestRemain = rows.reduce<number | null>((min, r) => {
    if (r.deadlineAt === null) return min;
    const remain = Math.max(0, Math.ceil((r.deadlineAt - now) / 60_000));
    return min === null ? remain : Math.min(min, remain);
  }, null);
  return (
    <div className="overflow-hidden rounded-lg border border-status-warning">
      <div className="flex items-center gap-1.5 bg-status-warning-tint px-2.5 py-[7px] text-[11.5px] font-semibold text-status-warning">
        <Shield size={12} strokeWidth={1.75} aria-hidden />
        {rows.length} 项等待
        {earliestRemain !== null && ` · 最早 ${earliestRemain} 分钟后超时预警`}
      </div>
      {rows.map((req) => (
        <div
          key={req.id}
          data-testid={`task-pending-row-${req.id}`}
          className="flex items-center gap-2 border-t border-subtle px-2.5 py-[9px] text-[11.5px]"
        >
          <Badge tone={KIND_BADGE[req.kind].tone}>{KIND_BADGE[req.kind].label}</Badge>
          <span className="min-w-0 flex-1 truncate text-primary" title={req.prompt}>
            {req.title}
          </span>
          <Button
            size="sm"
            className={BTN_SM}
            onClick={() => onGoSession(req.sessionId)}
            title="跳转到该请求所属会话，在请求面板中处理"
          >
            到会话处理
          </Button>
        </div>
      ))}
    </div>
  );
}
