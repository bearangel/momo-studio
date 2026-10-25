// renderer/src/components/hub/DelegationPanel.tsx
//
// 「委派任务」面板区段（momo-hub M2e T12，spec §5.3 leader 侧，task-12-preview 批准稿）。
// 嵌在 GroupPanel 在线视图下方（非 Dialog 的面板页形态）：
// - 列表：task.list 账本 + hub:task* 事件驱动状态迁移；六态徽标（task-status 语义色映射）
// - 展开详情：会话式进度流——复用本地会话 MessageFrame / ToolCallChip 节律
//   （owner 右对齐 accent 气泡 = 任务书；agent 左对齐 surface-2 气泡 + 批次分隔 +
//   实时尾 seq；工具摘要以 ToolCallChip 呈现）；取消两步确认（running/interrupted）；
//   failed 人话错误行（declined 附因）；interrupted 提示条（重连自动续跑）
// - 入口：区段「新建委派」+ 各组卡「委派任务…」（leader-only）
import { useEffect, useState, type ReactNode } from 'react';
import {
  Ban, ChevronRight, CircleCheck, CircleSlash, CircleX, FileText,
  Hourglass, Pause, RefreshCw, Send, Square, TriangleAlert,
} from 'lucide-react';
import {
  DELEGATION_STATUS_META,
  humanizeDelegationReason,
  useHubDelegationStore,
} from '../../stores/hub-delegation.store';
import { useHubGroupStore } from '../../stores/hub-group.store';
import { useHubStore } from '../../stores/hub.store';
import { MessageFrame } from '../im/MessageFrame';
import { ToolCallChip } from '../im/ToolCallChip';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import type { HubDelegationStatus, HubTaskRecord } from '../../ipc/types';

function formatHHmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** epoch ms → 「今天 14:32 / 昨天 18:47 / 10月12日 09:05」 */
function formatDayTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `今天 ${formatHHmm(ts)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${formatHHmm(ts)}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${formatHHmm(ts)}`;
}

function formatElapsed(fromMs: number): string {
  const mins = Math.max(0, Math.round((Date.now() - fromMs) / 60_000));
  if (mins < 1) return '不到 1 分钟';
  if (mins < 60) return `${mins} 分钟`;
  return `${Math.floor(mins / 60)} 小时 ${mins % 60} 分`;
}

/** 六态徽标（预览 §2 tone 映射；running 内嵌 currentColor spinner） */
function StatusBadge({ status }: { status: HubDelegationStatus }) {
  const meta = DELEGATION_STATUS_META[status];
  return (
    <Badge tone={meta.tone}>
      {status === 'running' ? (
        <span className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" aria-hidden />
      ) : status === 'pending' ? (
        <Hourglass size={12} strokeWidth={1.75} aria-hidden />
      ) : status === 'done' ? (
        <CircleCheck size={12} strokeWidth={1.75} aria-hidden />
      ) : status === 'failed' ? (
        <CircleX size={12} strokeWidth={1.75} aria-hidden />
      ) : status === 'interrupted' ? (
        <CircleSlash size={12} strokeWidth={1.75} aria-hidden />
      ) : (
        <Ban size={12} strokeWidth={1.75} aria-hidden />
      )}
      {meta.label}
    </Badge>
  );
}

export function DelegationPanel() {
  const tasks = useHubDelegationStore((s) => s.tasks);
  const loading = useHubDelegationStore((s) => s.loading);
  const error = useHubDelegationStore((s) => s.error);
  const expandedTaskId = useHubDelegationStore((s) => s.expandedTaskId);
  const init = useHubDelegationStore((s) => s.init);
  const load = useHubDelegationStore((s) => s.load);
  const groups = useHubGroupStore((s) => s.groups);
  const selfNodeId = useHubStore((s) => s.status?.nodeId ?? null);
  const openWizard = useHubDelegationStore((s) => s.openWizard);

  useEffect(() => init(), [init]);

  // 区段级「新建委派」：绑定本机任 leader 的组（多组取首个；无 leader 组禁用）
  const ledGroup = groups.find((g) => g.leaderNodeId === selfNodeId) ?? null;

  return (
    <section className="flex flex-col gap-2" aria-label="委派任务">
      <div className="flex items-center gap-2">
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md bg-surface-active text-accent-600 dark:text-accent-300">
          <Send size={16} strokeWidth={1.75} aria-hidden />
        </span>
        <h4 className="text-[13.5px] font-semibold text-primary">委派任务</h4>
        <Badge>{tasks.length}</Badge>
        <span className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 px-0"
            disabled={loading}
            aria-label="刷新委派列表"
            onClick={() => void load()}
          >
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden />
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={ledGroup === null}
            title={ledGroup === null ? '需为某工作组组长才能新建委派' : undefined}
            onClick={() => ledGroup && openWizard(ledGroup.groupId, ledGroup.groupName)}
          >
            <Send size={12} strokeWidth={1.75} aria-hidden />
            新建委派
          </Button>
        </span>
      </div>
      <p className="text-[11px] text-tertiary">组内委派账本（task.list）· 点击行展开进度流 · 状态经 hub 定向事件实时迁移</p>

      {error !== null && (
        <p className="text-xs text-status-error" role="alert">{error}</p>
      )}

      {tasks.length === 0 ? (
        <p className="rounded-lg border border-subtle bg-surface-1 px-3 py-4 text-center text-xs text-tertiary">
          暂无委派任务{ledGroup ? '——点「新建委派」把任务书派给组内节点' : ''}
        </p>
      ) : (
        <div className="flex flex-col">
          {tasks.map((t) =>
            t.taskId === expandedTaskId ? (
              <TaskDetail key={t.taskId} task={t} />
            ) : (
              <TaskRow key={t.taskId} task={t} />
            ),
          )}
        </div>
      )}
    </section>
  );
}

function nodeNameOf(groups: ReturnType<typeof useHubGroupStore.getState>['groups'], nodeId: string): string {
  for (const g of groups) {
    const hit = g.members.find((m) => m.nodeId === nodeId);
    if (hit) return hit.name;
  }
  return nodeId.slice(0, 10);
}

function TaskRow({ task }: { task: HubTaskRecord }) {
  const toggleExpand = useHubDelegationStore((s) => s.toggleExpand);
  const groups = useHubGroupStore((s) => s.groups);
  return (
    <button
      type="button"
      onClick={() => toggleExpand(task.taskId)}
      aria-label={`展开任务 ${task.title}`}
      className="mb-1.5 flex w-full items-center gap-2.5 rounded-lg border border-subtle bg-surface-1 px-3 py-2.5 text-left"
    >
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[13px] font-medium ${task.status === 'cancelled' ? 'text-secondary' : 'text-primary'}`}>
          {task.title}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-tertiary">
          {nodeNameOf(groups, task.targetNodeId)} · {task.workspaceName} · {formatDayTime(task.createdAt)}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <StatusBadge status={task.status} />
        <ChevronRight size={16} strokeWidth={1.75} className="text-tertiary" aria-hidden />
      </span>
    </button>
  );
}

/** 进度流单条增量：工具摘要 → ToolCallChip（中性 tint——outcome 未知不谎报 success）；其余 → surface-2 文本气泡 */
function StreamEntryBody({ excerpt }: { excerpt: string }) {
  const tool = /^调用工具 (\S+)$/.exec(excerpt);
  if (tool) {
    return (
      <div className="my-0.5">
        <ToolCallChip toolName={tool[1]!} args={{}} success tone="neutral" />
      </div>
    );
  }
  return (
    <div className="my-0.5 rounded-lg bg-surface-2 px-3 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap text-primary">
      {excerpt}
    </div>
  );
}

function TaskDetail({ task }: { task: HubTaskRecord }) {
  const st = useHubDelegationStore();
  const groups = useHubGroupStore((s) => s.groups);
  const selfNodeId = useHubStore((s) => s.status?.nodeId ?? null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  useEffect(() => {
    if (!confirmingCancel) return;
    const timer = setTimeout(() => setConfirmingCancel(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmingCancel]);

  const entries = st.streams[task.taskId] ?? [];
  const prompt = st.prompts[task.taskId];
  const sessionId = st.sessionIds[task.taskId];
  const reason = st.reasons[task.taskId];
  const slugKnown = st.agentSlugs[task.taskId];
  const agentLabel = slugKnown === undefined ? '目标 agent' : slugKnown === '' ? '默认 agent' : slugKnown;
  const nodeName = nodeNameOf(groups, task.targetNodeId);
  const canCancel = task.status === 'running' || task.status === 'interrupted';
  const lastSeq = entries.length > 0 ? entries[entries.length - 1]!.lastSeq : 0;

  const onCancel = async (): Promise<void> => {
    setConfirmingCancel(false);
    try {
      await st.cancel(task.taskId);
    } catch {
      // store.error 已呈现（conflict 等）
    }
  };

  /** 重新委派：目标节点所在、本机任 leader 的组（预填同任务书新建） */
  const redelegateGroup = groups.find(
    (g) => g.leaderNodeId === selfNodeId && g.members.some((m) => m.nodeId === task.targetNodeId),
  );
  const onRedelegate = (): void => {
    if (!redelegateGroup) return;
    st.openWizard(redelegateGroup.groupId, redelegateGroup.groupName, {
      targetNodeId: task.targetNodeId,
      workspaceName: task.workspaceName,
      title: task.title,
      prompt: prompt ?? '',
      ...(slugKnown !== undefined && slugKnown !== '' ? { agentSlug: slugKnown } : {}),
    });
  };

  const runHint: ReactNode =
    task.status === 'pending' ? '已受理 · 等待目标节点开跑'
    : task.status === 'running' ? (
      <span className="flex items-center gap-1.5">
        <Spinner size={12} />
        执行中 · 已运行 {formatElapsed(task.createdAt)}
      </span>
    )
    : task.status === 'done' ? '已完成'
    : task.status === 'failed' ? '已结束 · 失败'
    : task.status === 'cancelled' ? '已取消'
    : (
      <span className="flex items-center gap-1.5 text-status-warning">
        <CircleSlash size={12} strokeWidth={1.75} aria-hidden />
        已中断 · 等待 {nodeName} 重连（自动续跑）
      </span>
    );

  return (
    <div className="mb-1.5 overflow-hidden rounded-lg border border-subtle bg-surface-1" aria-label={`任务详情 ${task.title}`}>
      <div className="flex items-start gap-2.5 border-b border-subtle px-3 py-[11px]">
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-primary">{task.title}</div>
          <div className="mt-[3px] text-[11px] leading-relaxed text-tertiary">
            <span className="font-mono text-[10.5px]">{task.taskId.slice(0, 13)}</span>
            {' · '}{nodeName} · {task.workspaceName} · {agentLabel} · {formatDayTime(task.createdAt)}
            {sessionId !== undefined && (
              <> · 委派会话 <span className="font-mono text-[10.5px]">{sessionId.slice(0, 13)}</span>（目标节点）</>
            )}
          </div>
        </div>
        <StatusBadge status={task.status} />
      </div>

      <div className="py-2.5">
        {task.status === 'interrupted' && (
          <p className="mx-3 mb-2 flex items-start gap-2 rounded-md bg-status-warning-tint px-2.5 py-2 text-[11.5px] leading-relaxed text-status-warning">
            <TriangleAlert size={12} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
            <span><b>目标节点离线，重连后自动续跑</b>——进行中的回合已在 {nodeName} 冻结（断点续跑），节点回到在线即从断点继续并恢复进度回传，无需重新委派。</span>
          </p>
        )}
        <MessageFrame sender="leader" isSelf timestamp={task.createdAt} bubbleClassName="bg-accent-500 text-inverse">
          {prompt ?? `${task.title}（任务书全文经 hub 落档可查）`}
        </MessageFrame>
        <MessageFrame
          sender="delegated-agent"
          isSelf={false}
          senderName={`${agentLabel} · ${task.workspaceName}`}
          fillWidth
          maxWidthPct={86}
          bubbleClassName="bg-transparent px-0 py-0"
        >
          {task.status === 'failed' && reason !== undefined && (
            <FailedCard reason={reason} />
          )}
          {entries.map((e, i) => (
            <div key={`${e.lastSeq}-${i}`}>
              {i > 0 && (
                <div className="flex items-center justify-center gap-1.5 py-1 text-[10.5px] text-tertiary">
                  — 500ms 批次合并 · <span className="font-mono text-[10px]">task.progress</span> {e.count} events —
                </div>
              )}
              <StreamEntryBody excerpt={e.excerpt} />
            </div>
          ))}
          {task.status === 'running' && (
            <div className="flex items-center gap-1.5 px-1 pb-1 pt-1.5 text-[11px] text-secondary">
              <Spinner size={11} />
              {entries.length > 0 ? 'agent 正在生成' : '等待目标节点首个进度拍'}
              <span className="h-[7px] w-[7px] rounded-full bg-status-success" aria-hidden />
              实时 · seq <span className="font-mono text-[10.5px] text-tertiary">{lastSeq}</span> 追加中
            </div>
          )}
          {task.status === 'interrupted' && entries.length > 0 && (
            <div className="flex items-center justify-center gap-1.5 py-1 text-[10.5px] text-tertiary">
              <Pause size={10} strokeWidth={1.75} aria-hidden />
              已冻结于 seq <span className="font-mono text-[10px]">{lastSeq}</span> · 等待节点重连
            </div>
          )}
          {task.status === 'pending' && (
            <div className="flex items-center gap-1.5 px-1 py-1.5 text-[11px] text-tertiary">
              <Hourglass size={12} strokeWidth={1.75} aria-hidden />
              任务书已定向派发，等待目标节点受理开跑
            </div>
          )}
          {task.status === 'done' && entries.length === 0 && (
            <div className="flex items-center gap-1.5 px-1 py-1.5 text-[11px] text-tertiary">
              <CircleCheck size={12} strokeWidth={1.75} className="text-status-success" aria-hidden />
              已完成
            </div>
          )}
        </MessageFrame>
      </div>

      <div className="flex items-center justify-between border-t border-subtle bg-surface-1 px-3 py-2.5">
        <span className="text-[11px] text-tertiary">{runHint}</span>
        <span className="flex items-center gap-2">
          {confirmingCancel ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setConfirmingCancel(false)}>收起确认</Button>
              <Button variant="danger" size="sm" onClick={() => void onCancel()}>
                <Square size={12} strokeWidth={1.75} aria-hidden />
                再击一次 · 确认取消
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => st.toggleExpand(task.taskId)}>收起</Button>
              {canCancel && (
                <Button variant="danger-outline" size="sm" onClick={() => setConfirmingCancel(true)}>
                  <Square size={12} strokeWidth={1.75} aria-hidden />
                  取消任务
                </Button>
              )}
              {task.status === 'failed' && (
                <Button variant="secondary" size="sm" disabled={redelegateGroup === null}
                  title={redelegateGroup === null ? '本机不是目标节点所在组的组长，无法重新委派' : undefined}
                  onClick={onRedelegate}
                >
                  <RefreshCw size={12} strokeWidth={1.75} aria-hidden />
                  重新委派
                </Button>
              )}
            </>
          )}
        </span>
      </div>
    </div>
  );
}

/** failed 人话错误行（T8 errcard 同款；declined 附因平实解释 + 回执码片段） */
function FailedCard({ reason }: { reason: string }) {
  const h = humanizeDelegationReason(reason);
  return (
    <div className="my-1 rounded-lg border border-status-error bg-status-error-tint px-3 py-3">
      <div className="mb-1.5 flex items-center gap-2 text-[13px] font-medium text-status-error">
        <TriangleAlert size={16} strokeWidth={1.75} aria-hidden />
        {h.headline}
      </div>
      <p className="text-xs leading-relaxed text-secondary">
        {h.body}
        <code className="mx-1 rounded border border-subtle bg-surface-2 px-1 py-px font-mono text-[11px]">{reason.slice(0, 60)}</code>
      </p>
      <p className="mt-1.5 flex items-center gap-1 text-[11px] text-tertiary">
        <FileText size={12} strokeWidth={1.75} aria-hidden />
        「重新委派」= 以同一任务书新建委派（新 taskId，历史保留可查）
      </p>
    </div>
  );
}
