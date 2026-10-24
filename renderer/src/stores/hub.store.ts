// renderer/src/stores/hub.store.ts
//
// 节点互联设置面板数据源（momo-hub M0 Task 11）：status 快照 + 两推送订阅 + 在线节点表维护。
// - init() 先订阅后快照（controller ruling：订阅先于快照防丢事件）；快照在途期间到达的
//   stateChanged 暂存 pending、快照落地后重放——事件可能新于快照，重放方向恒为事件覆盖
//   快照，两序皆幂等安全
// - enroll 成功用返回的 HubStatus 覆盖本地快照（ipc 代理层已剥 IPC 错误包装前缀，rejection
//   message 即主进程原文，直接抛给调用方展示）
// - forget 后重拉快照：主进程 forget 广播只带 state/lastError，configured 仍是旧值——必须
//   重拉才能让面板回到未接入表单
// - 在线节点表纯事件增量维护（M0 无补拉；冷启动为空属预期，面板文案注明上线通知驱动）
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type {
  HubEnrollInput,
  HubNodePresenceEvent,
  HubStateChangedEvent,
  HubStatus,
} from '../ipc/types.d';

export interface HubNodeRow {
  nodeId: string;
  nodeName: string;
}

interface HubState {
  status: HubStatus | null;
  nodes: HubNodeRow[];
  /** 挂载时调用：订阅两推送 + 拉取 status 快照；返回解订阅函数（卸载时调用） */
  init(): () => void;
  /** 接入（hub:enroll）；成功后 status 覆盖为返回快照，rejection 原样抛给调用方展示 */
  enroll(input: HubEnrollInput): Promise<void>;
  /** 断开并忘记（hub:forget）；成功后重拉快照 + 清空节点表 */
  forget(): Promise<void>;
}

export const useHubStore = create<HubState>((set, get) => ({
  status: null,
  nodes: [],

  init() {
    let pendingState: HubStateChangedEvent | null = null;
    const disposeState = ipc.hub.onStateChanged((e) => {
      if (get().status === null) {
        // 快照未落地：暂存待重放（直接 set 会用 null status 丢掉完整身份字段）
        pendingState = e;
        return;
      }
      set((s) =>
        s.status
          ? { status: { ...s.status, state: e.state, lastError: e.lastError } }
          : {},
      );
    });
    const disposePresence = ipc.hub.onNodePresence((e: HubNodePresenceEvent) => {
      set((s) => {
        if (e.kind === 'online') {
          const row: HubNodeRow = { nodeId: e.nodeId, nodeName: e.nodeName ?? '' };
          return { nodes: [...s.nodes.filter((n) => n.nodeId !== e.nodeId), row] };
        }
        return { nodes: s.nodes.filter((n) => n.nodeId !== e.nodeId) };
      });
    });
    void ipc.hub
      .getStatus()
      .then((status) => {
        const pending = pendingState;
        pendingState = null;
        set(
          pending
            ? { status: { ...status, state: pending.state, lastError: pending.lastError } }
            : { status },
        );
      })
      .catch(() => {
        // 快照失败保持 null——面板停留加载占位；后续 stateChanged 推送仍可点亮徽章
      });
    return () => {
      disposeState();
      disposePresence();
    };
  },

  async enroll(input) {
    const status = await ipc.hub.enroll(input);
    // 重接入即换 hub 身份：旧节点表一并作废
    set({ status, nodes: [] });
  },

  async forget() {
    await ipc.hub.forget();
    set({ status: await ipc.hub.getStatus(), nodes: [] });
  },
}));
