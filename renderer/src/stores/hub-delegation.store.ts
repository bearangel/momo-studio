// renderer/src/stores/hub-delegation.store.ts
//
// 委派任务数据源（momo-hub M2e T12 建立；M2.1 Task 5 随 DelegationPanel/Wizard
// 退役收敛为纯状态层，spec §5.3）：
// - 列表：taskList 权威拉取 + hub:task* 四推送驱动状态迁移（progress/completed/
//   failed/interrupted；cancelled 无 leader 推送——由 taskCancel 回执本地落，下次
//   load 对账），事件只迁移本机已知行、未知行等 load 兜底（不凭空造行）
// - 进度流：task.progress 500ms 批合并（同窗多拍并为一条增量——count/excerpt 取末拍、
//   lastSeq 取最大）；终态到达即冲刷在途批，末条增量不丢
// - 取消：taskCancel 成功 → 本机落 cancelled + 重拉对账（hub 无 cancelled 推送）
// - 消费方（T5 后）：工作组侧栏负载徽标 / 监控台节点卡在跑行；M2.1 T8/T9 起新建
//   弹窗与看板融合接手「创建委派」入口与任务全生命周期展示（prompts/agentSlugs/
//   streams 等展示态为其预留，本任务保留不删——最小退役裁定）
// - 向导态已随 DelegationWizard 退役删除（openWizard 等仅向导消费，零存量引用）
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type {
  HubDelegationStatus,
  HubTaskProgressEvent,
  HubTaskRecord,
  HubTaskTerminalEvent,
} from '../ipc/types';

/** 进度流条目：一个 500ms 合并批 = 一条增量 */
export interface DelegationStreamEntry {
  /** 批内合并的 task.progress 拍数（批次分隔展示） */
  count: number;
  lastSeq: number;
  excerpt: string;
  at: number;
}

interface HubDelegationState {
  tasks: HubTaskRecord[];
  loading: boolean;
  /** 最近一次拉取/动作失败的呈现文案；成功即清 */
  error: string | null;
  /** 进度流（taskId → 已冲刷的合并条目，时间升序） */
  streams: Record<string, DelegationStreamEntry[]>;
  /** 本机创建时记录的任务书（taskId → prompt；owner 气泡与重新委派预填，未知则降级） */
  prompts: Record<string, string>;
  /** 本机创建时记录的 agentSlug（taskId → slug；'' = 未指定用默认 agent） */
  agentSlugs: Record<string, string>;
  /** 委派会话 id（taskId → sessionId；progress 拍携带时记录） */
  sessionIds: Record<string, string>;
  /** failed 附因（taskId → reason 原文；人话解释在组件层渲染） */
  reasons: Record<string, string>;
  /** 等待确认标志（taskId → kind waiting-input 拍；恢复拍/终态清除——监控台在跑行 T12 徽标） */
  waiting: Record<string, boolean>;

  /** 挂载时调用：订阅四推送 + 拉取；返回解订阅函数 */
  init(): () => void;
  load(): Promise<void>;
  cancel(taskId: string): Promise<void>;
}

/** 进度批合并窗口（与目标侧节流窗同值——展示侧再合并一次，覆盖直转连拍） */
const PROGRESS_MERGE_MS = 500;

interface PendingBatch {
  entry: DelegationStreamEntry;
  timer: ReturnType<typeof setTimeout>;
}
const pendingBatches = new Map<string, PendingBatch>();

function appendEntry(taskId: string, entry: DelegationStreamEntry): void {
  const list = useHubDelegationStore.getState().streams[taskId] ?? [];
  useHubDelegationStore.setState({
    streams: { ...useHubDelegationStore.getState().streams, [taskId]: [...list, entry] },
  });
}

/** 冲刷在途批（终态到达 / 批窗口到期） */
function flushBatch(taskId: string): void {
  const pending = pendingBatches.get(taskId);
  if (!pending) return;
  pendingBatches.delete(taskId);
  clearTimeout(pending.timer);
  appendEntry(taskId, pending.entry);
}

function disposeAllBatches(): void {
  for (const [, p] of pendingBatches) clearTimeout(p.timer);
  pendingBatches.clear();
}

/** task.progress → 500ms 批合并缓冲 */
function bufferProgress(evt: HubTaskProgressEvent): void {
  const existing = pendingBatches.get(evt.taskId);
  if (existing) {
    existing.entry.count += 1;
    existing.entry.excerpt = evt.excerpt;
    existing.entry.lastSeq = Math.max(existing.entry.lastSeq, evt.lastSeq);
    return;
  }
  const timer = setTimeout(() => flushBatch(evt.taskId), PROGRESS_MERGE_MS);
  pendingBatches.set(evt.taskId, {
    timer,
    entry: { count: 1, lastSeq: evt.lastSeq, excerpt: evt.excerpt, at: Date.now() },
  });
}

function patchTask(taskId: string, patch: Partial<HubTaskRecord>): void {
  const st = useHubDelegationStore.getState();
  if (!st.tasks.some((t) => t.taskId === taskId)) return; // 未知行不凭空造——load 兜底
  useHubDelegationStore.setState({
    tasks: st.tasks.map((t) => (t.taskId === taskId ? { ...t, ...patch } : t)),
  });
}

/** 终态清等待标志（徽标不粘滞） */
function clearWaiting(taskId: string): void {
  useHubDelegationStore.setState((s) => ({ waiting: { ...s.waiting, [taskId]: false } }));
}

export const useHubDelegationStore = create<HubDelegationState>((set) => {
  const refresh = async (): Promise<void> => {
    set({ loading: true });
    try {
      const { tasks } = await ipc.hub.taskList();
      set({ tasks, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  return {
    tasks: [],
    loading: false,
    error: null,
    streams: {},
    prompts: {},
    agentSlugs: {},
    sessionIds: {},
    reasons: {},
    waiting: {},

    init() {
      const disposers = [
        ipc.hub.onTaskProgress((evt) => {
          bufferProgress(evt);
          set((s) => ({ sessionIds: { ...s.sessionIds, [evt.taskId]: evt.sessionId } }));
          patchTask(evt.taskId, { status: 'running', updatedAt: Date.now() });
          // T12：等待标志随 kind 翻转（恢复拍无 kind 自然清除）
          set((s) => ({ waiting: { ...s.waiting, [evt.taskId]: evt.kind === 'waiting-input' } }));
        }),
        ipc.hub.onTaskCompleted((evt: HubTaskTerminalEvent) => {
          flushBatch(evt.taskId);
          patchTask(evt.taskId, { status: 'done', updatedAt: Date.now() });
          clearWaiting(evt.taskId);
        }),
        ipc.hub.onTaskFailed((evt: HubTaskTerminalEvent) => {
          flushBatch(evt.taskId);
          set((s) => (evt.reason !== undefined ? { reasons: { ...s.reasons, [evt.taskId]: evt.reason } } : s));
          patchTask(evt.taskId, { status: 'failed', updatedAt: Date.now() });
          clearWaiting(evt.taskId);
        }),
        ipc.hub.onTaskInterrupted((evt: HubTaskTerminalEvent) => {
          flushBatch(evt.taskId);
          patchTask(evt.taskId, { status: 'interrupted', updatedAt: Date.now() });
          clearWaiting(evt.taskId);
        }),
      ];
      void refresh();
      return () => disposers.forEach((d) => d());
    },

    load: refresh,

    async cancel(taskId) {
      try {
        await ipc.hub.taskCancel({ taskId });
        patchTask(taskId, { status: 'cancelled', updatedAt: Date.now() });
      } catch (err) {
        // hub conflict（已终态）等：先重拉对账再呈现错误（hub-group 同款纪律）
        await refresh();
        set({ error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      await refresh();
    },
  };
});

/** 测试/卸载清理：冲掉全部在途批计时器 */
export function __resetDelegationBatchesForTest(): void {
  disposeAllBatches();
}

/** 状态七态 → 展示元数据（label / Badge tone / 12px 图标名）——组件层消费 */
export const DELEGATION_STATUS_META: Record<HubDelegationStatus, { label: string; tone: 'warning' | 'accent' | 'success' | 'error' | 'neutral' }> = {
  pending: { label: '待执行', tone: 'warning' },
  running: { label: '执行中', tone: 'accent' },
  // M3.1 七态：waiting=running 中等待用户确认的中间态（等待角标仍由 progress
  // waiting 标志驱动——本条只是 task.list 对账到 waiting 时的展示兜底）
  waiting: { label: '等待节点确认', tone: 'warning' },
  done: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'error' },
  interrupted: { label: '已中断', tone: 'warning' },
  cancelled: { label: '已取消', tone: 'neutral' },
};

/**
 * failed reason 人话化（T10 declined 附因约定 + T11 约定值）：
 * `declined:<detail>` → 目标拒绝；`local_session_lost` → 会话丢失；其余原文透传。
 */
export function humanizeDelegationReason(reason: string): { headline: string; body: string } {
  if (reason.startsWith('declined:')) {
    return {
      headline: '目标节点拒绝受理，任务没有开始',
      body: reason.slice('declined:'.length),
    };
  }
  if (reason === 'local_session_lost') {
    return {
      headline: '目标节点上的委派会话已丢失',
      body: '目标节点本地找不到该任务的会话（可能已被清理或重置），需要重新委派。',
    };
  }
  if (reason.startsWith('执行失败:') || reason.startsWith('已中止')) {
    return { headline: '目标节点执行失败', body: reason };
  }
  return { headline: '任务失败', body: reason };
}
