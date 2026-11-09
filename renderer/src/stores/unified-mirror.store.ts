// renderer/src/stores/unified-mirror.store.ts
//
// 平行组「统一镜像」状态机（spec 2026-11-05 §6 统一镜像对话形态）：
//   打开即构建快照（源=组长绑定空间）→ 成员多选（默认全勾就绪成员）
//   → 逐目标两段式镜像第一段（mirrorWorkspace）→ 终态经 hub:mirrorResult
//   推送按 mirrorId 对账逐行回填 → 失败行可单独重试。
//
// 与 hub-mirror.store（lf 向导）的分工：本 store 只服务平行组批量场景，
// 订阅生命周期随对话框开合（open 注册 / close 注销）；mirrorId 对账按行
// 匹配（向导按单 mirrorId）。此前 GroupMonitor 内联实现的三处结构缺陷由
// 本设计根治：终态黑洞（无人订阅）/ 目标隐形过滤（不达标原因不可见）/
// toast 一闪即逝（无持久呈现面）。
//
// 防误关：任一行在 sending/sent 时 close() 无效（与向导同纪律）。
// 终态超时：hub 无 pending TTL，行级 300s 兜底——到点 sweep 全部 sent 行
// 转 failed（可重试；快照仍在 hub 存档，重试无需重建）。
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import { rpcErrorMessage } from '../lib/rpc-error';
import type { HubGroupMember, HubMirrorResultEvent } from '../ipc/types';
import type { MirrorSnapshotInfo } from './hub-mirror.store';

/** 行级终态等待超时（与 lf 向导 MIRROR_RESULT_TIMEOUT_MS 同值） */
const UNIFIED_MIRROR_TIMEOUT_MS = 300_000;

export type UnifiedRowStatus = 'idle' | 'sending' | 'sent' | 'success' | 'failed';

/** 成员行（打开时按组快照定格——launch 后成员状态变化不回写本表，重开对话框刷新） */
export interface UnifiedMirrorRow {
  nodeId: string;
  name: string;
  online: boolean;
  bound: boolean;
  boundWorkspaceName?: string;
  acceptsMirror: boolean;
  /** 组长行恒 false（源节点不是目标） */
  eligible: boolean;
  /** 不参与原因（展示用；按 离线/未绑定/未接受 逐项列明） */
  ineligibleReasons: string[];
  selected: boolean;
  status: UnifiedRowStatus;
  /** 第一段受理回执的对账键（sent/success/failed-by-result 行有效） */
  mirrorId: string | null;
  /** 终态成功时的补装资源数 */
  appliedCount: number | null;
  /** 终态成功时的软失败引用数（unresolvedRefs） */
  unresolvedCount: number | null;
  /** 第一段拒绝或第二段失败的人话 */
  error: string | null;
}

export interface UnifiedMirrorOpenInput {
  groupId: string;
  groupName: string;
  leaderNodeId: string;
  members: HubGroupMember[];
  /** 组长绑定空间（本机已按名解析出 id——缺失时调用方不打开） */
  sourceWorkspaceId: string;
  sourceWorkspaceName: string;
}

interface UnifiedMirrorState {
  open: boolean;
  groupId: string | null;
  groupName: string | null;
  sourceWorkspaceId: string | null;
  sourceWorkspaceName: string | null;
  buildStatus: 'idle' | 'building' | 'done' | 'error';
  buildError: string | null;
  snapshot: MirrorSnapshotInfo | null;
  rows: UnifiedMirrorRow[];
  /** 发起后冻结勾选（重开对话框才恢复默认全勾） */
  launched: boolean;
  launching: boolean;

  openDialog(input: UnifiedMirrorOpenInput): void;
  close(): void;
  /** 就绪成员勾选翻转（发起后无效） */
  toggleTarget(nodeId: string): void;
  /** 构建失败后手动重试 */
  rebuild(): Promise<void>;
  /** 向全部勾选的就绪成员发起（第一段逐行；受理与拒绝分记） */
  launch(): Promise<void>;
  /** 失败行单独重试（复用已上传快照） */
  retryRow(nodeId: string): Promise<void>;
}

interface Subscriptions {
  disposeMirrorResult?: () => void;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}
const subs: Subscriptions = {};

function buildRows(input: UnifiedMirrorOpenInput): UnifiedMirrorRow[] {
  return input.members
    .filter((m) => m.nodeId !== input.leaderNodeId)
    .map((m) => {
      const reasons: string[] = [];
      if (!m.online) reasons.push('离线');
      if (!m.bound) reasons.push('未绑定承接空间');
      else if (m.acceptsMirror !== true) reasons.push('未接受镜像');
      const eligible = m.online === true && m.bound === true && m.acceptsMirror === true;
      return {
        nodeId: m.nodeId,
        name: m.name,
        online: m.online,
        bound: m.bound === true,
        boundWorkspaceName: m.boundWorkspaceName,
        acceptsMirror: m.acceptsMirror === true,
        eligible,
        ineligibleReasons: reasons,
        selected: eligible,
        status: 'idle' as UnifiedRowStatus,
        mirrorId: null,
        appliedCount: null,
        unresolvedCount: null,
        error: null,
      };
    });
}

function resetBuild(): Pick<UnifiedMirrorState, 'buildStatus' | 'buildError' | 'snapshot'> {
  return { buildStatus: 'idle', buildError: null, snapshot: null };
}

export const useUnifiedMirrorStore = create<UnifiedMirrorState>((set, get) => {
  const clearSubs = (): void => {
    subs.disposeMirrorResult?.();
    subs.disposeMirrorResult = undefined;
    if (subs.timeoutTimer) {
      clearTimeout(subs.timeoutTimer);
      subs.timeoutTimer = undefined;
    }
  };

  /** 有 sent 行时布置 sweep 定时器（已布置则保持——单 timer 覆盖最晚到期行足够） */
  const armTimeout = (): void => {
    if (subs.timeoutTimer) return;
    subs.timeoutTimer = setTimeout(() => {
      subs.timeoutTimer = undefined;
      const st = get();
      if (!st.open) return;
      set({
        rows: st.rows.map((r) =>
          r.status === 'sent'
            ? { ...r, status: 'failed', error: '结果等待超时（快照仍在 hub 存档，可重试）' }
            : r,
        ),
      });
    }, UNIFIED_MIRROR_TIMEOUT_MS);
  };

  /** 终态对账：mirrorId 命中行才回填（他路镜像/向导结果不误收） */
  const settleTerminal = (payload: HubMirrorResultEvent): void => {
    const st = get();
    const idx = st.rows.findIndex((r) => r.mirrorId === payload.mirrorId);
    if (idx === -1) return;
    const row = st.rows[idx]!;
    if (payload.ok) {
      set({
        rows: st.rows.map((r) =>
          r.nodeId === row.nodeId
            ? {
                ...r,
                status: 'success',
                appliedCount: payload.appliedResources?.length ?? 0,
                unresolvedCount: payload.unresolvedRefs?.length ?? 0,
              }
            : r,
        ),
      });
      return;
    }
    set({
      rows: st.rows.map((r) =>
        r.nodeId === row.nodeId
          ? {
              ...r,
              status: 'failed',
              error: payload.message ?? `镜像失败（${payload.code ?? 'internal'}）`,
            }
          : r,
      ),
    });
  };

  /** 单行第一段：受理 → sent + mirrorId + 布置超时；拒绝 → failed 人话 */
  const dispatchRow = async (row: UnifiedMirrorRow): Promise<void> => {
    const st = get();
    if (!st.groupId || !st.sourceWorkspaceName || !st.snapshot) return;
    set({
      rows: st.rows.map((r) =>
        r.nodeId === row.nodeId ? { ...r, status: 'sending', error: null, mirrorId: null } : r,
      ),
    });
    try {
      const accepted = await ipc.hub.mirrorWorkspace({
        groupId: st.groupId,
        targetNodeId: row.nodeId,
        workspaceName: st.sourceWorkspaceName,
        snapshotId: st.snapshot.snapshotId,
      });
      set({
        rows: get().rows.map((r) =>
          r.nodeId === row.nodeId ? { ...r, status: 'sent', mirrorId: accepted.mirrorId } : r,
        ),
      });
      armTimeout();
    } catch (err) {
      set({
        rows: get().rows.map((r) =>
          r.nodeId === row.nodeId ? { ...r, status: 'failed', error: rpcErrorMessage(err) } : r,
        ),
      });
    }
  };

  const build = async (): Promise<void> => {
    const st = get();
    if (!st.open || st.buildStatus === 'building' || !st.sourceWorkspaceId) return;
    set({ buildStatus: 'building', buildError: null });
    try {
      const r = await ipc.hub.snapshotBuildUpload({ workspaceId: st.sourceWorkspaceId });
      set({
        buildStatus: 'done',
        snapshot: {
          snapshotId: r.snapshotId,
          version: r.version,
          checksum: r.checksum,
          sizeBytes: r.sizeBytes,
          excludedPlugins: r.excludedPlugins,
          summary: r.summary,
        },
      });
    } catch (err) {
      // snapshotBuildUpload 非 RPC 通道（本地构建 + HTTP 直传），错误不携协议码
      // ——无 `[code]` 前缀可剥，保留原文（hub-mirror.store 同裁定）
      set({
        buildStatus: 'error',
        buildError: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return {
    open: false,
    groupId: null,
    groupName: null,
    sourceWorkspaceId: null,
    sourceWorkspaceName: null,
    ...resetBuild(),
    rows: [],
    launched: false,
    launching: false,

    openDialog(input) {
      clearSubs();
      set({
        open: true,
        groupId: input.groupId,
        groupName: input.groupName,
        sourceWorkspaceId: input.sourceWorkspaceId,
        sourceWorkspaceName: input.sourceWorkspaceName,
        ...resetBuild(),
        rows: buildRows(input),
        launched: false,
        launching: false,
      });
      subs.disposeMirrorResult = ipc.hub.onMirrorResult(settleTerminal);
      void build();
    },

    close() {
      // 防误关：任一行在途（sending/sent）时拒绝关闭
      if (get().rows.some((r) => r.status === 'sending' || r.status === 'sent')) return;
      clearSubs();
      set({ open: false });
    },

    toggleTarget(nodeId) {
      const st = get();
      if (st.launched) return;
      set({
        rows: st.rows.map((r) =>
          r.nodeId === nodeId && r.eligible ? { ...r, selected: !r.selected } : r,
        ),
      });
    },

    rebuild: build,

    async launch() {
      const st = get();
      if (st.launching || st.buildStatus !== 'done' || st.launched) return;
      const targets = st.rows.filter((r) => r.eligible && r.selected && r.status === 'idle');
      if (targets.length === 0) return;
      set({ launching: true, launched: true });
      // 逐行顺序发起（与旧实现一致的串行纪律——hub 在途登记按工作空间互斥，
      // 并发第一段对同源快照无收益且放大拒绝面）
      for (const row of targets) {
        await dispatchRow(row);
      }
      set({ launching: false });
    },

    async retryRow(nodeId) {
      const st = get();
      if (st.buildStatus !== 'done' || !st.snapshot) return;
      const row = st.rows.find((r) => r.nodeId === nodeId);
      if (!row || row.status !== 'failed') return;
      await dispatchRow(row);
    },
  };
});
