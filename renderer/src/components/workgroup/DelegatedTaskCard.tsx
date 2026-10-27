// renderer/src/components/workgroup/DelegatedTaskCard.tsx
//
// 外派看板卡（M2.1 T9，视觉合同 S1/S6——.omo/previews/hub-ia-fullapp.html）。
// routing≠local 的看板行由 BoardCanvas 分发到本卡（local 卡零改动）：
//   - 双视角（routing/byNode 驱动）：leader=节点徽标（Bot+目标节点名，ledger
//     targetNodeId 解析；待派发=「组内调度 · 待派发」在待处理列）；worker=
//     「来自 {来源}」徽标（Zap+byNode）+ mono #T-id（S6：被委派任务画进看板）
//   - 六态徽标：spinner 执行中 / CircleCheck 已完成 / CircleX 失败 /
//     CircleHelp 等待节点确认（waiting）；待派发（delegationId 空）无状态徽标
//   - 左 3px 状态色边：默认 status-violet（.routed）/ waiting status-warning（.routed-w）
//   - 进度行：surface-2 圆角摘要（kv 持久 + hub:taskProgress 推送合并）；
//     waiting 态 warning tint + worker 侧加粗「打开会话批准/拒绝」引导
//   - waiting 点亮（T12）：摘要由上下文派生——leader=progress.waiting（kind
//     waiting-input 拍）/ worker=localWaiting 命中 received.sessionId；prop
//     waitingSummary 保留为直注入覆盖（测试）
//   - 操作菜单：取消（可取消态；已派发走 hub cancel 既有链、待派发走本地行取消）/
//     重试派发（仅待派发，RM-M21-5 手动驱动）/ 失败重派（仅 failed，主进程换
//     delegation_id）
// 外派卡不接拖拽（useSortable 零注册）：行状态由 hub 账本驱动，本地 move 会
// 与远端真相打架——列间迁移只能经委派事件回写。
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bot, CircleCheck, CircleHelp, CircleX, RefreshCw, RotateCcw, X, Zap } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type {
  DelegationBoardResult,
  HubDelegationProgressEntry,
  HubDelegationStatus,
  HubGroupListResult,
  HubReceivedDelegation,
  HubStatus,
  HubTaskRecord,
  TaskRow,
} from '../../ipc/types';
import { Badge } from '../ui/Badge';
import { showToast } from '../ui/Toast';

/** nodeId 短码（NodeCard 同款——名称不可解析时的兜底呈现） */
function shortNodeId(nodeId: string): string {
  return nodeId.length > 8 ? `${nodeId.slice(0, 4)}…${nodeId.slice(-4)}` : nodeId;
}

/** 看板外派投影上下文（DelegationBoardProvider 注入；缺省空值=离线降级渲染） */
export interface DelegationBoardContextValue {
  selfNodeId: string | null;
  /** nodeId → 节点名（组清单成员合成；缺失由卡片短码兜底） */
  nodeNames: Record<string, string>;
  /** hub 委派账本（delegationId → 行——leader 侧六态/目标节点权威） */
  ledger: Record<string, HubTaskRecord>;
  /** 进度摘要（delegationId → 最新条目；kv 持久 + 推送 live 合并；waiting=T12 等待标志） */
  progress: Record<string, HubDelegationProgressEntry>;
  /** worker 侧本地委派记录（delegationId → byNode 来源） */
  received: Record<string, HubReceivedDelegation>;
  /** 本机等待确认会话（sessionId → 摘要——worker 等待卡数据源，T12） */
  localWaiting: Record<string, string>;
  /** 动作后刷新看板任务行（5s 轮询之外的即时对账） */
  refreshTasks: () => void;
}

const EMPTY_BOARD: DelegationBoardContextValue = {
  selfNodeId: null,
  nodeNames: {},
  ledger: {},
  progress: {},
  received: {},
  localWaiting: {},
  refreshTasks: () => {},
};

const DelegationBoardContext = createContext<DelegationBoardContextValue>(EMPTY_BOARD);

/** localWaiting 拉取节拍：5s 轮询（grant/deny 处置无推送通道，轮询兜底去态） */
const LOCAL_WAITING_POLL_MS = 5000;

/**
 * 看板级外派数据 Provider：value 直注入（测试）；缺省内部拉取——delegationBoard
 * 引导读 + hub 账本 + 组成员名表 + 本机 nodeId，订阅 progress/终态推送（终态即
 * 时刷新任务行）+ localWaiting 轮询（T12 worker 等待卡）。全部 IPC 失败降级空值
 * （外派卡退化为行状态反推渲染）。
 */
export function DelegationBoardProvider({
  value,
  refreshTasks,
  children,
}: {
  value?: DelegationBoardContextValue;
  refreshTasks?: () => void;
  children: ReactNode;
}): ReactNode {
  if (value !== undefined) {
    return <DelegationBoardContext.Provider value={value}>{children}</DelegationBoardContext.Provider>;
  }
  return (
    <InternalDelegationBoardProvider refreshTasks={refreshTasks}>{children}</InternalDelegationBoardProvider>
  );
}

function InternalDelegationBoardProvider({
  refreshTasks,
  children,
}: {
  refreshTasks?: () => void;
  children: ReactNode;
}): ReactNode {
  const internal = useDelegationBoardData(refreshTasks);
  return <DelegationBoardContext.Provider value={internal}>{children}</DelegationBoardContext.Provider>;
}

function useDelegationBoardData(refreshTasks?: () => void): DelegationBoardContextValue {
  const [board, setBoard] = useState<DelegationBoardResult | null>(null);
  const [ledger, setLedger] = useState<Record<string, HubTaskRecord>>({});
  const [nodeNames, setNodeNames] = useState<Record<string, string>>({});
  const [selfNodeId, setSelfNodeId] = useState<string | null>(null);
  const [liveProgress, setLiveProgress] = useState<Record<string, HubDelegationProgressEntry>>({});
  const [localWaiting, setLocalWaiting] = useState<Record<string, string>>({});

  // T12 Low-2：终态推送回调用 refreshTasks 闭包——空依赖订阅若直捕会在切
  // workspace 后仍调旧闭包（刷旧 ws 行、新 ws 不对账）。经 ref 实时取最新。
  const refreshRef = useRef(refreshTasks);
  useEffect(() => {
    refreshRef.current = refreshTasks;
  });

  const fetchLocalWaiting = useCallback(async (): Promise<void> => {
    try {
      const rows = await ipc.hub.localWaiting();
      setLocalWaiting(Object.fromEntries(rows.map((r) => [r.sessionId, r.summary])));
    } catch {
      setLocalWaiting({});
    }
  }, []);

  // hub 账本重拉（D5：挂载后新派发的委派不在初始快照——终态推送与动作后
  // 对账刷新，配合行内 routing.targetNodeId 消解「未知节点」）
  const refreshLedger = useCallback((): void => {
    void ipc.hub
      .taskList()
      .then((r) => {
        const map: Record<string, HubTaskRecord> = {};
        for (const t of r.tasks) map[t.taskId] = t;
        setLedger(map);
      })
      .catch(() => {});
  }, []);

  // 任务行刷新 + 账本对账合并面（终态推送与卡片动作共用）
  const refreshAll = useCallback((): void => {
    refreshRef.current?.();
    refreshLedger();
  }, [refreshLedger]);

  useEffect(() => {
    const disposers = [
      ipc.hub.onTaskProgress((evt) => {
        setLiveProgress((prev) => ({
          ...prev,
          [evt.taskId]: {
            excerpt: evt.excerpt,
            lastSeq: evt.lastSeq,
            at: Date.now(),
            waiting: evt.kind === 'waiting-input',
          },
        }));
      }),
      // 终态：即时刷新任务行（主进程 delegation-sync 已回写）+ 账本对账
      ipc.hub.onTaskCompleted(refreshAll),
      ipc.hub.onTaskFailed(refreshAll),
      ipc.hub.onTaskInterrupted(refreshAll),
      // writeBlocked 推送（T12）：新等待登记即时上卡（不等轮询窗）
      ipc.sandbox.onWriteBlocked(() => void fetchLocalWaiting()),
    ];
    void ipc.hub.delegationBoard().then(setBoard).catch(() => {});
    void ipc.hub
      .taskList()
      .then((r) => {
        const map: Record<string, HubTaskRecord> = {};
        for (const t of r.tasks) map[t.taskId] = t;
        setLedger(map);
      })
      .catch(() => {});
    void ipc.hub
      .getStatus()
      .then((s: HubStatus) => setSelfNodeId(s.nodeId))
      .catch(() => {});
    void ipc.hub
      .groupList()
      .then((r: HubGroupListResult) => {
        const names: Record<string, string> = {};
        for (const g of r.groups) for (const m of g.members) names[m.nodeId] = m.name;
        setNodeNames(names);
      })
      .catch(() => {});
    void fetchLocalWaiting();
    const pollTimer = window.setInterval(() => void fetchLocalWaiting(), LOCAL_WAITING_POLL_MS);
    return () => {
      disposers.forEach((d) => d());
      window.clearInterval(pollTimer);
    };
    // 数据拉取只在挂载时做一次（ipc 调用非响应式依赖）；refreshTasks 经 ref 实时取（订阅不重建）
  }, [fetchLocalWaiting, refreshAll]);

  return useMemo(
    () => ({
      selfNodeId,
      nodeNames,
      ledger,
      progress: { ...(board?.progress ?? {}), ...liveProgress },
      received: Object.fromEntries((board?.received ?? []).map((r) => [r.taskId, r])),
      localWaiting,
      refreshTasks: refreshTasks ?? refreshAll,
    }),
    [board, ledger, nodeNames, selfNodeId, liveProgress, localWaiting, refreshTasks, refreshAll],
  );
}

// ── 六态推导 ────────────────────────────────────────────────────────────────

/** 行状态 → hub 六态反推（ledger 缺席时的兜底：重启/离线对账前） */
function inferHubStatus(t: TaskRow): HubDelegationStatus | null {
  switch (t.status) {
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      // pending（含 interrupted 回落——中断事实在摘要行呈现）/ 其他态：
      // delegationId 空 = 待派发（null），有 = 账本 pending
      return t.delegationId != null ? 'pending' : null;
  }
}

const RECEIVED_STATE_TO_HUB: Record<HubReceivedDelegation['state'], HubDelegationStatus> = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

interface DelegatedTaskCardProps {
  task: TaskRow;
  onSelect: () => void;
  selected?: boolean;
  /**
   * 等待确认摘要覆盖（leader「等待节点确认」/ worker「等你确认」）。
   * 缺省时由上下文派生（T12 点亮）：leader=progress.waiting 条目 / worker=
   * localWaiting 命中 received.sessionId；null=无覆盖（走派生）。
   */
  waitingSummary?: string | null;
}

export function DelegatedTaskCard({ task, onSelect, selected = false, waitingSummary = null }: DelegatedTaskCardProps): ReactNode {
  const board = useContext(DelegationBoardContext);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // D6 取消两步确认：armed 态菜单项变「再次点击确认取消」，3s 无操作回落
  //（组头「退出工作组」同款范式）；菜单关闭即复位
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  useEffect(() => {
    if (menu === null) {
      setConfirmingCancel(false);
      return;
    }
    if (!confirmingCancel) return;
    const timer = window.setTimeout(() => setConfirmingCancel(false), 3000);
    return () => window.clearTimeout(timer);
  }, [menu, confirmingCancel]);

  const isWorkerView =
    task.routing.mode === 'node' && board.selfNodeId != null && task.routing.targetNodeId === board.selfNodeId;
  const delegationId = task.delegationId;
  const received = delegationId != null ? (board.received[delegationId] ?? null) : null;

  const hubStatus = useMemo<HubDelegationStatus | null>(() => {
    if (delegationId != null && board.ledger[delegationId]) return board.ledger[delegationId].status;
    if (isWorkerView && received) return RECEIVED_STATE_TO_HUB[received.state];
    return inferHubStatus(task);
  }, [board.ledger, delegationId, isWorkerView, received, task]);

  // 等待摘要派生（T12）：leader 消费 progress 等待拍（kind waiting-input → kv
  // waiting 标志，恢复拍清除）；worker 消费本机 write-blocked 登记清单（grant/
  // deny 处置即去态）。prop 直注入优先（测试直注入路径）。
  const progressEntry = delegationId != null ? (board.progress[delegationId] ?? null) : null;
  const derivedWaitingSummary =
    progressEntry?.waiting === true
      ? progressEntry.excerpt
      : isWorkerView && received != null
        ? (board.localWaiting[received.sessionId] ?? null)
        : null;
  const effectiveWaitingSummary = waitingSummary !== null ? waitingSummary : derivedWaitingSummary;
  const waiting = effectiveWaitingSummary != null && (hubStatus === 'running' || hubStatus === 'pending');
  const terminal = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';

  const nodeName = (nodeId: string | null | undefined): string =>
    nodeId == null ? '未知节点' : (board.nodeNames[nodeId] ?? shortNodeId(nodeId));

  // leader 节点徽标：待派发=「组内调度 · 待派发」/「{node} · 待派发」（S1）；
  // 已派发=目标节点名。解析序（D5）：行内已解析目标（group 派发回执回写的
  // routing.targetNodeId——持久、无时序依赖）→ hub 账本（行内缺失时兜底：
  // 旧行/他路径派发）→ null（「未知节点」，正常不可达）
  const routingTargetNodeId =
    task.routing.mode === 'local' ? null : task.routing.targetNodeId ?? null;
  const leaderTargetNodeId =
    routingTargetNodeId ??
    (delegationId != null ? (board.ledger[delegationId]?.targetNodeId ?? null) : null);
  const leaderBadge =
    delegationId == null
      ? task.routing.mode === 'group'
        ? '组内调度 · 待派发'
        : `${nodeName(leaderTargetNodeId)} · 待派发`
      : nodeName(leaderTargetNodeId);

  const progressExcerpt =
    (delegationId != null ? (board.progress[delegationId]?.excerpt ?? null) : null) ??
    (task.status === 'failed' && task.errorMessage != null ? task.errorMessage : null);

  const canCancel = delegationId != null
    ? hubStatus === 'pending' || hubStatus === 'running' || hubStatus === 'interrupted'
    : task.status === 'pending';
  const canRetry = delegationId == null && task.status === 'pending';
  const canRedispatch = task.status === 'failed';

  const handleCancel = async (): Promise<void> => {
    if (delegationId != null) {
      try {
        await ipc.hub.taskCancel({ taskId: delegationId });
      } catch (err) {
        showToast(`取消失败: ${(err as Error).message}`);
        return;
      }
    } else {
      try {
        await ipc.task.transition(task.id, 'cancelled');
      } catch (err) {
        showToast(`取消失败: ${(err as Error).message}`);
        return;
      }
    }
    board.refreshTasks();
  };

  const handleRetry = async (): Promise<void> => {
    try {
      const r = await ipc.hub.retryDispatch({ taskId: task.id });
      showToast(r.dispatched ? `已派发给 ${nodeName(r.nodeId)}` : '暂无可用节点，任务保留待派发');
    } catch (err) {
      showToast(`重派失败: ${(err as Error).message}`);
      return;
    }
    board.refreshTasks();
  };

  return (
    <>
      <button
        type="button"
        aria-pressed={selected}
        aria-label={task.title}
        onClick={onSelect}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        className={`w-full cursor-pointer rounded-md border border-subtle border-l-[3px] bg-canvas px-2.5 py-2 text-left transition-colors hover:border-strong hover:bg-surface-1 ${
          waiting ? 'border-l-status-warning' : 'border-l-status-violet'
        } ${terminal ? 'opacity-80' : ''} ${selected ? 'border-focus' : ''}`}
      >
        <div className="text-xs font-medium leading-relaxed text-primary">{task.title}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-tertiary">
          {isWorkerView && received ? (
            <>
              <Badge tone="accent" className="h-auto gap-1 px-1.5 py-0.5 text-[10px] leading-none">
                <Zap size={12} strokeWidth={1.75} aria-hidden />
                来自 {nodeName(received.byNode)}
              </Badge>
              {delegationId != null && (
                <span className="font-mono text-[10.5px] text-tertiary">#{delegationId.slice(0, 8)}</span>
              )}
            </>
          ) : (
            <Badge tone="accent" className="h-auto gap-1 px-1.5 py-0.5 text-[10px] leading-none">
              <Bot size={12} strokeWidth={1.75} aria-hidden />
              {leaderBadge}
            </Badge>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {waiting ? (
              <Badge tone="warning" className="h-auto gap-1 px-1.5 py-0.5 text-[10px] leading-none">
                <CircleHelp size={12} strokeWidth={1.75} aria-hidden />
                {isWorkerView ? '等你确认' : '等待节点确认'}
              </Badge>
            ) : (
              <StatusBadge status={hubStatus} />
            )}
          </span>
        </div>
        {(waiting || progressExcerpt != null) && (
          <div
            data-progress-line
            className={`mt-1.5 flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] leading-[1.5] ${
              waiting ? 'bg-status-warning-tint text-status-warning' : 'bg-surface-2 text-tertiary'
            }`}
          >
            {!waiting && hubStatus === 'running' && (
              <span
                role="img"
                aria-label="执行中"
                className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-status-violet border-t-transparent"
              />
            )}
            {/* P2-3：摘要/失败原因截断显示，title 悬浮全文（reason 链：hub failed 载荷 → errorMessage 列 → 此行） */}
            <span
              className="min-w-0 flex-1 truncate"
              title={waiting ? (effectiveWaitingSummary ?? undefined) : (progressExcerpt ?? undefined)}
            >
              {waiting ? effectiveWaitingSummary : progressExcerpt}
              {waiting && isWorkerView && (
                <b className="font-semibold"> · 打开会话批准/拒绝</b>
              )}
            </span>
          </div>
        )}
      </button>
      {menu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <ul
            aria-label={`任务菜单 ${task.title}`}
            className="fixed z-50 min-w-[120px] rounded border border-subtle bg-surface-1 py-1 text-sm text-secondary shadow-lg"
            style={{ left: menu.x, top: menu.y }}
          >
            {canCancel && (
              <li>
                {confirmingCancel ? (
                  <button
                    type="button"
                    data-testid="cancel-confirm"
                    onClick={() => {
                      setMenu(null);
                      void handleCancel();
                    }}
                    className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-status-error hover:bg-surface-3"
                  >
                    <X size={12} strokeWidth={1.75} aria-hidden />
                    再次点击确认取消
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid="cancel-arm"
                    onClick={() => setConfirmingCancel(true)}
                    className="flex w-full items-center gap-1.5 px-3 py-1 text-left hover:bg-surface-3"
                  >
                    <X size={12} strokeWidth={1.75} aria-hidden />
                    取消任务
                  </button>
                )}
              </li>
            )}
            {canRetry && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setMenu(null);
                    void handleRetry();
                  }}
                  className="flex w-full items-center gap-1.5 px-3 py-1 text-left hover:bg-surface-3"
                >
                  <RefreshCw size={12} strokeWidth={1.75} aria-hidden />
                  重试派发
                </button>
              </li>
            )}
            {canRedispatch && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setMenu(null);
                    void handleRetry();
                  }}
                  className="flex w-full items-center gap-1.5 px-3 py-1 text-left hover:bg-surface-3"
                >
                  <RotateCcw size={12} strokeWidth={1.75} aria-hidden />
                  失败重派
                </button>
              </li>
            )}
          </ul>
        </>
      )}
    </>
  );
}

/** 六态徽标（待派发 null → 不渲染——节点槽已带「待派发」文案，S1） */
function StatusBadge({ status }: { status: HubDelegationStatus | null }): ReactNode {
  if (status == null) return null;
  switch (status) {
    case 'running':
      return (
        <Badge tone="violet" className="h-auto gap-1 px-1.5 py-0.5 text-[10px] leading-none">
          <span
            role="img"
            aria-label="执行中"
            className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-status-violet border-t-transparent"
          />
          执行中
        </Badge>
      );
    case 'done':
      return (
        <Badge tone="success" className="h-auto gap-1 px-1.5 py-0.5 text-[10px] leading-none">
          <CircleCheck size={12} strokeWidth={1.75} aria-hidden />
          已完成
        </Badge>
      );
    case 'failed':
      return (
        <Badge tone="error" className="h-auto gap-1 px-1.5 py-0.5 text-[10px] leading-none">
          <CircleX size={12} strokeWidth={1.75} aria-hidden />
          失败
        </Badge>
      );
    case 'cancelled':
      return (
        <Badge className="h-auto px-1.5 py-0.5 text-[10px] leading-none">已取消</Badge>
      );
    case 'interrupted':
      return (
        <Badge tone="warning" className="h-auto px-1.5 py-0.5 text-[10px] leading-none">
          已中断
        </Badge>
      );
    case 'pending':
      return (
        <Badge tone="warning" className="h-auto px-1.5 py-0.5 text-[10px] leading-none">
          待执行
        </Badge>
      );
  }
}
