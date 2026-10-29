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
//     delegation_id）/ 批准·拒绝节点写入（M3.1 远程代答——leader 等待卡且 hub
//     协议 minor ≥ 3，armed-confirm 两段确认，cancel 模板）
//   - 远程代答留痕行（M3.1）：progress.answered 存在且较新（at ≥ 条目拍时刻，
//     非终态）→ 进度线下方 text-xs「已远程批准/已远程拒绝」；后续进度拍自然清除
//   - 组徽标（M4.2 协议 1.6.0）：账本行 TaskRecord.groupId 有值 → leader 徽标旁
//     Users+组名 Badge（组名经 hub-delegation.store 的 group.list 映射缓存解析，
//     缺失降级 groupId 短码）；旧 hub 不发此键 → 零渲染（可选字段门控）
// 外派卡不接拖拽（useSortable 零注册）：行状态由 hub 账本驱动，本地 move 会
// 与远端真相打架——列间迁移只能经委派事件回写。
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Ban, Bot, Check, CircleCheck, CircleHelp, CircleX, Lock, RefreshCw, RotateCcw, Users, X, Zap } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useHubStore } from '../../stores/hub.store';
import { cacheDelegationGroupNames, useHubDelegationStore } from '../../stores/hub-delegation.store';
import { hubSupportsMinor } from '../../lib/hub-capability';
import { parseRpcErrorCode, rpcErrorMessage } from '../../lib/rpc-error';
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
import { useArmedConfirm } from './useArmedConfirm';

/** nodeId 短码（NodeCard 同款——名称不可解析时的兜底呈现） */
function shortNodeId(nodeId: string): string {
  return nodeId.length > 8 ? `${nodeId.slice(0, 4)}…${nodeId.slice(-4)}` : nodeId;
}

/** groupId 短码（M4.2 组徽标——组名映射缺失时的兜底呈现，与 nodeId 短码同格式） */
function shortGroupId(groupId: string): string {
  return groupId.length > 8 ? `${groupId.slice(0, 4)}…${groupId.slice(-4)}` : groupId;
}

/** M3.1 版本过低类错误码（rejection message 前缀 [code]——主进程 ipc.handlers 编码） */
const ANSWER_VERSION_LOW_CODES = new Set(['unsupported_method', 'unknown_method', 'node_unsupported']);

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
 * 远程代答留痕合入进度条目（M3.1）：live 推送路（onTaskAnswered）patch 进
 * liveProgress/kv 合成面——answered 恒为最新一次代答；「较新才显示」由卡片
 * 比较 answered.at 与条目拍时刻判定（后续进度拍 at 更大自然隐藏）。
 */
function withAnswered(
  base: Record<string, HubDelegationProgressEntry>,
  answered: Record<string, { decision: 'approve' | 'deny'; at: number }>,
): Record<string, HubDelegationProgressEntry> {
  if (Object.keys(answered).length === 0) return base;
  const out = { ...base };
  for (const [id, a] of Object.entries(answered)) {
    const entry = out[id];
    if (entry) out[id] = { ...entry, answered: a };
  }
  return out;
}

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
  // M3.1 远程代答留痕（live 路）：taskId → {decision, at}（kv 持久路在主进程
  // delegation-sync handleAnswered——两路经 withAnswered 合成）
  const [liveAnswered, setLiveAnswered] = useState<Record<string, { decision: 'approve' | 'deny'; at: number }>>({});

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
      // 代答落账推送（M3.1）：taskId → answered 留痕合入进度面（卡片即时反馈）
      ipc.hub.onTaskAnswered((evt) => {
        setLiveAnswered((prev) => ({ ...prev, [evt.taskId]: { decision: evt.decision, at: Date.now() } }));
      }),
    ];
    // M3.1 门控输入：hub.store 接线（订阅+快照）——看板可能是首屏（用户直开任务
    // 板未经过工作组/设置页），不 init 则 hubProtoVer 恒 null、代答按钮成死路
    // （生效性≠可见性）。init 返回解订阅函数，随看板卸载释放。
    const disposeHubStore = useHubStore.getState().init();
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
        // M4.2：组名映射就近回写委派 store 共享缓存（直开任务板时工作组视图
        // 未挂载，store 自身的 group.list 拉取不在场——徽标名不降级短码）
        cacheDelegationGroupNames(r.groups);
      })
      .catch(() => {});
    void fetchLocalWaiting();
    const pollTimer = window.setInterval(() => void fetchLocalWaiting(), LOCAL_WAITING_POLL_MS);
    return () => {
      disposers.forEach((d) => d());
      disposeHubStore();
      window.clearInterval(pollTimer);
    };
    // 数据拉取只在挂载时做一次（ipc 调用非响应式依赖）；refreshTasks 经 ref 实时取（订阅不重建）
  }, [fetchLocalWaiting, refreshAll]);

  return useMemo(
    () => ({
      selfNodeId,
      nodeNames,
      ledger,
      progress: withAnswered({ ...(board?.progress ?? {}), ...liveProgress }, liveAnswered),
      received: Object.fromEntries((board?.received ?? []).map((r) => [r.taskId, r])),
      localWaiting,
      refreshTasks: refreshTasks ?? refreshAll,
    }),
    [board, ledger, nodeNames, selfNodeId, liveProgress, liveAnswered, localWaiting, refreshTasks, refreshAll],
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
  // D6 取消两步确认（P2-10 公共臂态 hook）：armed 态菜单项变「再次点击确认取消 · Ns」，
  // 3s 无操作回落 + 剩余秒倒计时明示；菜单关闭即复位
  const cancelConfirm = useArmedConfirm();
  // M3.1 远程代答两步确认（cancel 模板——写授权处置是不可逆动作）
  const approveConfirm = useArmedConfirm();
  const denyConfirm = useArmedConfirm();
  const disarmCancel = cancelConfirm.disarm;
  const disarmApprove = approveConfirm.disarm;
  const disarmDeny = denyConfirm.disarm;
  useEffect(() => {
    if (menu === null) {
      disarmCancel();
      disarmApprove();
      disarmDeny();
    }
  }, [menu, disarmCancel, disarmApprove, disarmDeny]);
  // M3.1 门控输入：hub 协议版本（hub.store 订阅——provider 挂载时已 init 接线）
  const hubProtoVer = useHubStore((s) => s.status?.hubProtoVer ?? null);
  // M4.2 组名映射缓存（hub-delegation.store——init/看板 provider 双路保鲜）
  const groupNames = useHubDelegationStore((s) => s.groupNames);

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
  // M3.1 七态：账本 waiting 是 running 的中间态——等待角标判定逻辑不动（仍由
  // 摘要信号驱动），仅把 waiting 纳入「可点亮」的账本态集合（1.3.0 前 hub 不回此态）
  const waiting =
    effectiveWaitingSummary != null && (hubStatus === 'running' || hubStatus === 'pending' || hubStatus === 'waiting');
  const terminal = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';

  // M3.1 代答留痕行：answered 存在且较新（at ≥ 条目拍时刻）且非终态才显示——
  // 后续进度拍（at 更新）自然隐藏；终态卡不残留
  const answeredEntry = progressEntry?.answered ?? null;
  const answeredLine =
    answeredEntry != null && progressEntry != null && !terminal && answeredEntry.at >= progressEntry.at
      ? answeredEntry.decision === 'approve'
        ? '已远程批准'
        : '已远程拒绝'
      : null;

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

  // M4.2 组徽标：账本行 TaskRecord.groupId（协议 1.6.0 起 hub 从 delegations
  // .group_id 投影；旧 hub 缺席 → null 零渲染）。行内 routing.groupId 不取——
  // 待派发行无账本本就无组归属争议，已派发行以账本（hub 真相）为准
  const ledgerGroupId = delegationId != null ? (board.ledger[delegationId]?.groupId ?? null) : null;
  const groupBadgeLabel =
    ledgerGroupId !== null ? (groupNames[ledgerGroupId] ?? shortGroupId(ledgerGroupId)) : null;

  // P2-3 reason 链优先级：failed 且 errorMessage 在场 → reason 全文压过一切 running 末拍残留
  // （delegation-sync 的 progress 快照停在最后一拍「（无文本增量）」，不压过则失败原因永不露面）
  const progressExcerpt =
    (task.status === 'failed' && task.errorMessage != null ? task.errorMessage : null) ??
    (delegationId != null ? (board.progress[delegationId]?.excerpt ?? null) : null);

  const canCancel = delegationId != null
    ? hubStatus === 'pending' || hubStatus === 'running' || hubStatus === 'waiting' || hubStatus === 'interrupted'
    : task.status === 'pending';
  const canRetry = delegationId == null && task.status === 'pending';
  const canRedispatch = task.status === 'failed';
  // M3.1 远程代答门控：leader 视角的等待卡 + hub 协议 minor ≥ 3（hubSupportsMinor
  // 镜像 protocolSupports；低版本 hub 按钮不出现——spec §3.4，文案级改动授权见
  // spec §5「UI 无人预览」风险行）
  const canAnswer = waiting && !isWorkerView && delegationId != null && hubSupportsMinor(hubProtoVer, 3);

  const handleCancel = async (): Promise<void> => {
    if (delegationId != null) {
      try {
        await ipc.hub.taskCancel({ taskId: delegationId });
      } catch (err) {
        // hub 通道（M4.1 coded）：剥 `[code]` 传输前缀后人话呈现
        showToast(`取消失败: ${rpcErrorMessage(err)}`);
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
      // hub 通道（M4.1 coded）：剥 `[code]` 传输前缀后人话呈现
      showToast(`重派失败: ${rpcErrorMessage(err)}`);
      return;
    }
    board.refreshTasks();
  };

  /**
   * M3.1 远程代答：hub task.answer 转发（leader-only）。错误分类——主进程把
   * RpcRemoteError.code 编入 rejection message 前缀 `[code] 原文`（Electron IPC
   * 只保 message），版本过低三码（hub/worker 任一低于 1.3）给人话降级文案，
   * 其余剥前缀后原文 toast；stale 口径（worker 已无等待）单独提示。
   * M4.1：前缀解析上提 lib/rpc-error.ts parseRpcErrorCode（单源，不再内联正则）。
   */
  const handleAnswer = async (decision: 'approve' | 'deny'): Promise<void> => {
    if (delegationId == null) return;
    let r: { disposition: 'granted' | 'denied' | 'stale' };
    try {
      r = await ipc.hub.taskAnswer({ taskId: delegationId, decision });
    } catch (err) {
      const coded = parseRpcErrorCode(err);
      if (coded !== null && ANSWER_VERSION_LOW_CODES.has(coded.code)) {
        showToast('节点或 hub 版本过低，无法远程代答');
      } else {
        showToast(`远程代答失败: ${coded !== null ? coded.message : err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (r.disposition === 'stale') {
      showToast('节点已无等待中的授权（可能已被处理）');
    } else {
      showToast(`已远程${r.disposition === 'granted' ? '批准' : '拒绝'}（worker：${nodeName(leaderTargetNodeId)}）`);
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
            <>
              <Badge tone="accent" className="h-auto gap-1 px-1.5 py-0.5 text-[10px] leading-none">
                <Bot size={12} strokeWidth={1.75} aria-hidden />
                {leaderBadge}
              </Badge>
              {groupBadgeLabel !== null && (
                /* M4.2 组归属徽标：title 悬浮完整 groupId（名解析降级时可对账） */
                <Badge
                  tone="neutral"
                  className="h-auto gap-1 px-1.5 py-0.5 text-[10px] leading-none"
                  title={ledgerGroupId ?? undefined}
                >
                  <Users size={12} strokeWidth={1.75} aria-hidden />
                  {groupBadgeLabel}
                </Badge>
              )}
            </>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {task.blocked && (
              /* M3.3 阻塞派生角标（spec §2.2 远端委派行同展示）：blockedBy 来自
               * 本地行派生，与状态徽标并列，悬停摘要 */
              <Badge
                tone="warning"
                className="h-auto gap-1 px-1.5 py-0.5 text-[10px] leading-none"
                title={
                  task.blockedBy && task.blockedBy.length > 0
                    ? `等待依赖完成：${task.blockedBy.join('、')}`
                    : '等待未完成依赖'
                }
              >
                <Lock size={16} strokeWidth={1.75} aria-hidden />
                阻塞
              </Badge>
            )}
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
        {answeredLine != null && (
          /* M3.1 代答留痕行：进度线下方一行（spec §3.4 文案级最小改动——非布局变更） */
          <div data-answered-line className="mt-1 px-2 text-xs leading-[1.5] text-tertiary">
            {answeredLine}
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
                {cancelConfirm.armed ? (
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
                    再次点击确认取消 · {cancelConfirm.remainingSec}s
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid="cancel-arm"
                    onClick={() => cancelConfirm.arm()}
                    className="flex w-full items-center gap-1.5 px-3 py-1 text-left hover:bg-surface-3"
                  >
                    <X size={12} strokeWidth={1.75} aria-hidden />
                    取消任务
                  </button>
                )}
              </li>
            )}
            {canAnswer && (
              <li>
                {approveConfirm.armed ? (
                  <button
                    type="button"
                    data-testid="approve-confirm"
                    onClick={() => {
                      setMenu(null);
                      void handleAnswer('approve');
                    }}
                    className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-status-success hover:bg-surface-3"
                  >
                    <Check size={12} strokeWidth={1.75} aria-hidden />
                    再次点击确认批准 · {approveConfirm.remainingSec}s
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid="approve-arm"
                    onClick={() => approveConfirm.arm()}
                    className="flex w-full items-center gap-1.5 px-3 py-1 text-left hover:bg-surface-3"
                  >
                    <Check size={12} strokeWidth={1.75} aria-hidden />
                    批准节点写入
                  </button>
                )}
              </li>
            )}
            {canAnswer && (
              <li>
                {denyConfirm.armed ? (
                  <button
                    type="button"
                    data-testid="deny-confirm"
                    onClick={() => {
                      setMenu(null);
                      void handleAnswer('deny');
                    }}
                    className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-status-error hover:bg-surface-3"
                  >
                    <Ban size={12} strokeWidth={1.75} aria-hidden />
                    再次点击确认拒绝 · {denyConfirm.remainingSec}s
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid="deny-arm"
                    onClick={() => denyConfirm.arm()}
                    className="flex w-full items-center gap-1.5 px-3 py-1 text-left hover:bg-surface-3"
                  >
                    <Ban size={12} strokeWidth={1.75} aria-hidden />
                    拒绝节点写入
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

/** 七态徽标（待派发 null → 不渲染——节点槽已带「待派发」文案，S1；waiting=
 *  M3.1 账本中间态，常态由等待角标（摘要信号驱动）覆盖——本条仅对账滞后/
 *  kv 缺失时兜底呈现等待语义） */
function StatusBadge({ status }: { status: HubDelegationStatus | null }): ReactNode {
  if (status == null) return null;
  switch (status) {
    case 'running':
    case 'waiting':
      return (
        <Badge tone={status === 'running' ? 'violet' : 'warning'} className="h-auto gap-1 px-1.5 py-0.5 text-[10px] leading-none">
          {status === 'running' ? (
            <>
              <span
                role="img"
                aria-label="执行中"
                className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-status-violet border-t-transparent"
              />
              执行中
            </>
          ) : (
            <>
              <CircleHelp size={12} strokeWidth={1.75} aria-hidden />
              等待节点确认
            </>
          )}
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
