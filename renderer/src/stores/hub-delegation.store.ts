// renderer/src/stores/hub-delegation.store.ts
//
// 委派面板数据源（momo-hub M2e T12，leader 侧，spec §5.3）：
// - 列表：taskList 权威拉取 + hub:task* 四推送驱动状态迁移（progress/completed/
//   failed/interrupted；cancelled 无 leader 推送——由 taskCancel 回执本地落，下次
//   load 对账），事件只迁移本机已知行、未知行等 load 兜底（不凭空造行）
// - 进度流：task.progress 500ms 批合并（同窗多拍并为一条增量——count/excerpt 取末拍、
//   lastSeq 取最大，预览批次语义）；终态到达即冲刷在途批，末条增量不丢
// - 取消：taskCancel 成功 → 本机落 cancelled + 重拉对账（hub 无 cancelled 推送）
// - 向导（三步，预览获批稿）：openWizard 绑定组 + 可选预填（重新委派同任务书新建）；
//   受理即终态（accepted），进度在列表消费——向导无长驻执行态
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type {
  HubDelegationStatus,
  HubTaskDelegateInput,
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

/** 领导侧新建委派预填（重新委派：以同任务书新建，新 taskId） */
export interface DelegationWizardPrefill {
  targetNodeId?: string;
  workspaceName?: string;
  title?: string;
  prompt?: string;
  agentSlug?: string;
}

interface HubDelegationState {
  tasks: HubTaskRecord[];
  loading: boolean;
  /** 最近一次拉取/动作失败的呈现文案；成功即清 */
  error: string | null;
  expandedTaskId: string | null;
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

  /** 面板挂载时调用：订阅四推送 + 拉取；返回解订阅函数 */
  init(): () => void;
  load(): Promise<void>;
  toggleExpand(taskId: string): void;
  cancel(taskId: string): Promise<void>;

  // ── 向导态 ──
  wizardOpen: boolean;
  wizardStep: 1 | 2 | 3;
  wizardGroupId: string | null;
  wizardGroupName: string | null;
  wizardTargetNodeId: string | null;
  wizardWorkspaceId: string | null;
  wizardWorkspaceName: string | null;
  wizardAgentSlug: string;
  wizardTitle: string;
  wizardPrompt: string;
  wizardSubmitting: boolean;
  wizardSubmitError: string | null;
  /** 受理回执（taskId）——非 null 即受理态，向导可安全关闭 */
  wizardAcceptedTaskId: string | null;

  openWizard(groupId: string, groupName: string, prefill?: DelegationWizardPrefill): void;
  closeWizard(): void;
  selectTarget(nodeId: string): void;
  selectWorkspace(workspaceId: string, workspaceName: string): void;
  setWizardAgentSlug(slug: string): void;
  setWizardTitle(title: string): void;
  setWizardPrompt(prompt: string): void;
  gotoWizardStep2(): void;
  backWizardStep1(): void;
  submitWizard(): Promise<void>;
  /** 受理态「查看任务进度」：关向导 + 展开该任务行 */
  viewAccepted(): void;
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

export const useHubDelegationStore = create<HubDelegationState>((set, get) => {
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
    expandedTaskId: null,
    streams: {},
    prompts: {},
    agentSlugs: {},
    sessionIds: {},
    reasons: {},

    init() {
      const disposers = [
        ipc.hub.onTaskProgress((evt) => {
          bufferProgress(evt);
          set((s) => ({ sessionIds: { ...s.sessionIds, [evt.taskId]: evt.sessionId } }));
          patchTask(evt.taskId, { status: 'running', updatedAt: Date.now() });
        }),
        ipc.hub.onTaskCompleted((evt: HubTaskTerminalEvent) => {
          flushBatch(evt.taskId);
          patchTask(evt.taskId, { status: 'done', updatedAt: Date.now() });
        }),
        ipc.hub.onTaskFailed((evt: HubTaskTerminalEvent) => {
          flushBatch(evt.taskId);
          set((s) => (evt.reason !== undefined ? { reasons: { ...s.reasons, [evt.taskId]: evt.reason } } : s));
          patchTask(evt.taskId, { status: 'failed', updatedAt: Date.now() });
        }),
        ipc.hub.onTaskInterrupted((evt: HubTaskTerminalEvent) => {
          flushBatch(evt.taskId);
          patchTask(evt.taskId, { status: 'interrupted', updatedAt: Date.now() });
        }),
      ];
      void refresh();
      return () => disposers.forEach((d) => d());
    },

    load: refresh,

    toggleExpand(taskId) {
      const cur = get().expandedTaskId;
      // 展开新行前冲刷其在途批（进入详情即见最新增量）
      if (cur !== taskId) flushBatch(taskId);
      set({ expandedTaskId: cur === taskId ? null : taskId });
    },

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

    wizardOpen: false,
    wizardStep: 1,
    wizardGroupId: null,
    wizardGroupName: null,
    wizardTargetNodeId: null,
    wizardWorkspaceId: null,
    wizardWorkspaceName: null,
    wizardAgentSlug: '',
    wizardTitle: '',
    wizardPrompt: '',
    wizardSubmitting: false,
    wizardSubmitError: null,
    wizardAcceptedTaskId: null,

    openWizard(groupId, groupName, prefill) {
      // 预填：目标节点按名重挂（重新委派来自既有任务行——targetNodeId 直接可用）
      set({
        wizardOpen: true,
        wizardStep: 1,
        wizardGroupId: groupId,
        wizardGroupName: groupName,
        wizardTargetNodeId: prefill?.targetNodeId ?? null,
        // 工作空间按名回挂 id（S1 Select 以 id 为值；找不到则清空待重选）
        wizardWorkspaceId: null,
        wizardWorkspaceName: prefill?.workspaceName ?? null,
        wizardAgentSlug: prefill?.agentSlug ?? '',
        wizardTitle: prefill?.title ?? '',
        wizardPrompt: prefill?.prompt ?? '',
        wizardSubmitting: false,
        wizardSubmitError: null,
        wizardAcceptedTaskId: null,
      });
    },

    closeWizard() {
      if (get().wizardSubmitting) return; // 发送在途防误关（与镜像向导同款二道闸）
      set({ wizardOpen: false });
    },

    selectTarget(nodeId) {
      set({ wizardTargetNodeId: nodeId });
    },

    selectWorkspace(workspaceId, workspaceName) {
      set({ wizardWorkspaceId: workspaceId, wizardWorkspaceName: workspaceName });
    },

    setWizardAgentSlug(slug) {
      set({ wizardAgentSlug: slug });
    },
    setWizardTitle(title) {
      set({ wizardTitle: title });
    },
    setWizardPrompt(prompt) {
      set({ wizardPrompt: prompt });
    },

    gotoWizardStep2() {
      const s = get();
      if (!s.wizardTargetNodeId || !s.wizardWorkspaceId) return;
      set({ wizardStep: 2 });
    },
    backWizardStep1() {
      set({ wizardStep: 1 });
    },

    async submitWizard() {
      const s = get();
      if (s.wizardSubmitting || s.wizardAcceptedTaskId !== null) return;
      if (!s.wizardGroupId || !s.wizardTargetNodeId || !s.wizardWorkspaceName) return;
      if (s.wizardTitle.trim() === '' || s.wizardPrompt.trim() === '') return;
      const input: HubTaskDelegateInput = {
        groupId: s.wizardGroupId,
        targetNodeId: s.wizardTargetNodeId,
        workspaceName: s.wizardWorkspaceName,
        title: s.wizardTitle.trim(),
        prompt: s.wizardPrompt.trim(),
        ...(s.wizardAgentSlug.trim() !== '' ? { agentSlug: s.wizardAgentSlug.trim() } : {}),
      };
      set({ wizardSubmitting: true, wizardSubmitError: null });
      try {
        const { taskId } = await ipc.hub.taskDelegate(input);
        set((cur) => ({
          wizardSubmitting: false,
          wizardAcceptedTaskId: taskId,
          prompts: { ...cur.prompts, [taskId]: input.prompt },
          agentSlugs: { ...cur.agentSlugs, [taskId]: input.agentSlug ?? '' },
        }));
        await refresh();
      } catch (err) {
        set({
          wizardSubmitting: false,
          wizardSubmitError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    viewAccepted() {
      const id = get().wizardAcceptedTaskId;
      if (id === null) return;
      set({ wizardOpen: false, expandedTaskId: id });
    },
  };
});

/** 测试/卸载清理：冲掉全部在途批计时器 */
export function __resetDelegationBatchesForTest(): void {
  disposeAllBatches();
}

/** 状态六态 → 展示元数据（label / Badge tone / 12px 图标名）——组件层消费 */
export const DELEGATION_STATUS_META: Record<HubDelegationStatus, { label: string; tone: 'warning' | 'accent' | 'success' | 'error' | 'neutral' }> = {
  pending: { label: '待执行', tone: 'warning' },
  running: { label: '执行中', tone: 'accent' },
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
