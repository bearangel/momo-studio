// renderer/src/stores/hub.store.ts
//
// 节点互联设置面板数据源（momo-hub M0 Task 11）：status 快照 + 两推送订阅 + 在线节点表维护。
// - init() 先订阅后快照（controller ruling：订阅先于快照防丢事件）；快照在途期间到达的
//   stateChanged 暂存 pending、快照落地后重放——事件可能新于快照，重放方向恒为事件覆盖
//   快照，两序皆幂等安全
// - 快照失败不吞错：置 loadError 交面板呈现错误行 + 重试；refresh() 清 loadError 并复用
//   init 建立的订阅重拉快照（不重复订阅）。status 为 null 期间（含 loadError 态）
//   stateChanged 只进 pending 暂存、待下一次成功快照落地时重放——不会直接点亮徽章
//   （据实修正 fix round 1 前的失实注释）
// - enroll 成功用返回的 HubStatus 覆盖本地快照（ipc 代理层已剥 IPC 错误包装前缀，rejection
//   message 即主进程原文，直接抛给调用方展示）
// - forget 后重拉快照：主进程 forget 广播只带 state/lastError，configured 仍是旧值——必须
//   重拉才能让面板回到未接入表单（重拉 rejection 经 forget() 抛给面板危险区错误行呈现）
// - 在线节点表由 hub:nodePresence 事件维护（连接时 hello 快照种子 + 之后上下线增量；
//   按 nodeId 去重——同节点多条消息只留一行）
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
  /** getStatus 快照失败的呈现文案（非 null 时面板走错误行 + 重试）；成功快照即清 */
  loadError: string | null;
  /** 挂载时调用：订阅两推送 + 拉取 status 快照；返回解订阅函数（卸载时调用） */
  init(): () => void;
  /** 清 loadError 并重拉快照——复用 init 建立的订阅，不重复订阅（面板错误行「重试」调用） */
  refresh(): void;
  /** 接入（hub:enroll）；成功后 status 覆盖为返回快照，rejection 原样抛给调用方展示 */
  enroll(input: HubEnrollInput): Promise<void>;
  /** 断开并忘记（hub:forget）；成功后重拉快照 + 清空节点表 */
  forget(): Promise<void>;
}

// 快照在途期间暂存的状态事件——模块级：init 的订阅回调写入、快照落地时读取重放
// （loadError 态下亦然——重试成功后的快照会带上这段窗口内的最新状态）
let pendingState: HubStateChangedEvent | null = null;

export const useHubStore = create<HubState>((set, get) => {
  const pullStatusSnapshot = (): void => {
    void ipc.hub
      .getStatus()
      .then((status) => {
        const pending = pendingState;
        pendingState = null;
        set(
          pending
            ? {
                status: { ...status, state: pending.state, lastError: pending.lastError },
                loadError: null,
              }
            : { status, loadError: null },
        );
      })
      .catch(() => {
        // 不吞错：置 loadError 交面板呈现 + 重试；status 保持 null——不渲染半吊子状态
        set({ loadError: '状态读取失败' });
      });
  };

  return {
    status: null,
    nodes: [],
    loadError: null,

    init() {
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
      pullStatusSnapshot();
      return () => {
        disposeState();
        disposePresence();
      };
    },

    refresh() {
      set({ loadError: null });
      pullStatusSnapshot();
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
  };
});
