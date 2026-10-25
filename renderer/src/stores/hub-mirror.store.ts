// renderer/src/stores/hub-mirror.store.ts
//
// 镜像向导状态机（momo-hub M2c T8b，leader 侧四步流——MirrorWizard 消费）：
//   S1 选空间 → S2 构建+上传（snapshotBuildUpload）→ S3 选节点 → S4 两段式执行
//
// 两段式语义：mirrorWorkspace 受理即返 {mirrorId}；终态经 hub:mirrorResult 推送
// （mirrorId 对账——他路镜像的结果不误收）。conflict → execStatus='conflict' 保
// diffSummary，确认覆盖带 confirm:true 重发（新 mirrorId）。
//
// 防误关：execStatus==='running' 时 close() 无效（组件禁用关闭是第一道，store 守
// 是第二道——推送竞态下组件态可能滞后）。
//
// 终态超时：hub 无 pending TTL（T6 Concerns #2），向导侧 300s 兜底——超时转 failed
// 且提示快照仍在 hub 存档可重试。
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type {
  HubMirrorResultEvent,
  HubSnapshotBuildUploadResult,
} from '../ipc/types';

export type MirrorBuildStatus = 'idle' | 'building' | 'done' | 'error';
export type MirrorExecStatus = 'idle' | 'running' | 'conflict' | 'success' | 'failed';

/** 终态等待超时（hub 侧 pending 无 TTL——向导侧兜底结算） */
const MIRROR_RESULT_TIMEOUT_MS = 300_000;

export interface MirrorSnapshotInfo {
  snapshotId: string;
  version: string;
  checksum: string;
  sizeBytes: number;
  excludedPlugins: string[];
  summary: HubSnapshotBuildUploadResult['summary'];
}

export type MirrorTerminalResult =
  | { ok: true; appliedResources: string[]; unresolvedRefs?: string[] }
  | { ok: false; code: string; message: string; diffSummary?: { added: number; removed: number; changed: number } };

interface HubMirrorState {
  open: boolean;
  step: 1 | 2 | 3 | 4;
  /** S1 选定空间（id + 名——mirror RPC 需名） */
  workspaceId: string | null;
  workspaceName: string | null;
  /** S2 */
  buildStatus: MirrorBuildStatus;
  buildError: string | null;
  snapshot: MirrorSnapshotInfo | null;
  /** S3（发起组在入口 GroupPanel 卡片定死） */
  groupId: string | null;
  groupName: string | null;
  targetNodeId: string | null;
  /** S4 */
  execStatus: MirrorExecStatus;
  mirrorId: string | null;
  result: MirrorTerminalResult | null;
  /** 第一段即失败（node_offline/not_found/bad_request/网络——非两段式终态） */
  execError: string | null;

  openWizard(groupId: string, groupName: string): void;
  close(): void;
  selectWorkspace(workspaceId: string, workspaceName: string): void;
  startBuild(): Promise<void>;
  /** S2 完成 → S3 */
  gotoPickNode(): void;
  backToBuild(): void;
  selectTarget(nodeId: string): void;
  startMirror(): Promise<void>;
  /** conflict 确认覆盖（两步按钮第二击消费）——confirm:true 重发 */
  confirmOverride(): Promise<void>;
  /** 失败重试：复用 hub 已存档快照（无需重建） */
  retry(): Promise<void>;
}

interface Subscriptions {
  disposeMirrorResult?: () => void;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}
const subs: Subscriptions = {};

function resetExec(): Pick<HubMirrorState, 'execStatus' | 'mirrorId' | 'result' | 'execError'> {
  return { execStatus: 'idle', mirrorId: null, result: null, execError: null };
}

export const useHubMirrorStore = create<HubMirrorState>((set, get) => {
  const clearSubs = (): void => {
    subs.disposeMirrorResult?.();
    subs.disposeMirrorResult = undefined;
    if (subs.timeoutTimer) {
      clearTimeout(subs.timeoutTimer);
      subs.timeoutTimer = undefined;
    }
  };

  const settleTerminal = (payload: HubMirrorResultEvent): void => {
    const st = get();
    // mirrorId 对账：他路镜像/迟到的旧结果不误收
    if (!st.mirrorId || payload.mirrorId !== st.mirrorId) return;
    if (subs.timeoutTimer) {
      clearTimeout(subs.timeoutTimer);
      subs.timeoutTimer = undefined;
    }
    if (payload.ok) {
      set({
        execStatus: 'success',
        result: {
          ok: true,
          appliedResources: payload.appliedResources ?? [],
          ...(payload.unresolvedRefs ? { unresolvedRefs: payload.unresolvedRefs } : {}),
        },
      });
      return;
    }
    if (payload.code === 'conflict') {
      set({
        execStatus: 'conflict',
        result: {
          ok: false,
          code: 'conflict',
          message: payload.message ?? '目标节点已存在同名工作空间',
          ...(payload.diffSummary ? { diffSummary: payload.diffSummary } : {}),
        },
      });
      return;
    }
    set({
      execStatus: 'failed',
      result: {
        ok: false,
        code: payload.code ?? 'internal',
        message: payload.message ?? '镜像失败',
      },
    });
  };

  /** 发起镜像（confirm 可选）。受理成功 → running 等终态；第一段拒绝 → failed 人话。 */
  const launch = async (confirm?: boolean): Promise<void> => {
    const st = get();
    if (!st.groupId || !st.targetNodeId || !st.workspaceName || !st.snapshot) return;
    set({ ...resetExec(), execStatus: 'running' });
    try {
      const accepted = await ipc.hub.mirrorWorkspace({
        groupId: st.groupId,
        targetNodeId: st.targetNodeId,
        workspaceName: st.workspaceName,
        snapshotId: st.snapshot.snapshotId,
        ...(confirm !== undefined ? { confirm } : {}),
      });
      set({ mirrorId: accepted.mirrorId });
      subs.timeoutTimer = setTimeout(() => {
        if (get().execStatus !== 'running') return;
        set({
          execStatus: 'failed',
          result: {
            ok: false,
            code: 'timeout',
            message: '目标节点应用结果等待超时（快照仍存于 hub 存档，可重试）',
          },
        });
      }, MIRROR_RESULT_TIMEOUT_MS);
    } catch (err) {
      // 第一段失败：hub 人话（node_offline/not_found/mirror_in_progress/网络）直呈
      set({
        execStatus: 'failed',
        result: {
          ok: false,
          code: 'first_stage',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  };

  return {
    open: false,
    step: 1,
    workspaceId: null,
    workspaceName: null,
    buildStatus: 'idle',
    buildError: null,
    snapshot: null,
    groupId: null,
    groupName: null,
    targetNodeId: null,
    ...resetExec(),

    openWizard(groupId, groupName) {
      clearSubs();
      set({
        open: true,
        step: 1,
        workspaceId: null,
        workspaceName: null,
        buildStatus: 'idle',
        buildError: null,
        snapshot: null,
        groupId,
        groupName,
        targetNodeId: null,
        ...resetExec(),
      });
      subs.disposeMirrorResult = ipc.hub.onMirrorResult(settleTerminal);
    },

    close() {
      // 执行中防误关（store 二道闸——组件禁用是第一道）
      if (get().execStatus === 'running') return;
      clearSubs();
      set({ open: false });
    },

    selectWorkspace(workspaceId, workspaceName) {
      // 换空间 = 旧快照作废（版本/计数均不可复用）
      set({ workspaceId, workspaceName, buildStatus: 'idle', buildError: null, snapshot: null });
    },

    async startBuild() {
      const st = get();
      if (!st.workspaceId || st.buildStatus === 'building') return;
      set({ buildStatus: 'building', buildError: null });
      try {
        const r = await ipc.hub.snapshotBuildUpload({ workspaceId: st.workspaceId });
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
        set({
          buildStatus: 'error',
          buildError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    gotoPickNode() {
      if (get().buildStatus !== 'done') return;
      set({ step: 3 });
    },

    backToBuild() {
      set({ step: 2 });
    },

    selectTarget(nodeId) {
      set({ targetNodeId: nodeId });
    },

    async startMirror() {
      if (get().step !== 3) return;
      set({ step: 4 });
      await launch();
    },

    async confirmOverride() {
      if (get().execStatus !== 'conflict') return;
      await launch(true);
    },

    async retry() {
      const st = get();
      if (st.execStatus !== 'failed' || !st.snapshot) return;
      await launch();
    },
  };
});
