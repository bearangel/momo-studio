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
// - configure 换址：主进程换址分支清凭证、nodeId 归零 → 返回快照即换址引导态
//   （configured 仍为 true、nodeId 为 null），面板据此切回预填表单
// - forget 后重拉快照：主进程 forget 广播只带 state/lastError，configured 仍是旧值——必须
//   重拉才能让面板回到未接入表单（重拉 rejection 经 forget() 抛给面板危险区错误行呈现）
// - 在线节点表由 hub:nodePresence 事件维护（连接时 hello 快照种子 + 之后上下线增量；
//   按 nodeId 去重——同节点多条消息只留一行）
// - 非 online 态（connecting/disconnected）→ 节点表清空：断连期间收不到 peer 上下线
//   事件，列表必陈旧；不清则重连后幽灵行复现（面板非 online 本就隐藏列表，重连后
//   由 hello 快照种子重新填充）
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type {
  HubConfigureInput,
  HubEnrollInput,
  HubNodePresenceEvent,
  HubStateChangedEvent,
  HubStatus,
} from '../ipc/types';

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
  /**
   * 节点清单补拉（A6）：取主进程权威在线集合（本机行 + 在线对端）并入节点表。
   * 只增不删——种子与事件两路到达、种子可能旧于事件，删行只归 kind:'offline'。
   */
  pullNodes(): Promise<void>;
  /** 清 loadError 并重拉快照——复用 init 建立的订阅，不重复订阅（面板错误行「重试」调用） */
  refresh(): void;
  /** 接入（hub:enroll）；成功后 status 覆盖为返回快照，rejection 原样抛给调用方展示 */
  enroll(input: HubEnrollInput): Promise<void>;
  /** 换址（hub:configure）；成功后 status 覆盖为返回快照，rejection 原样抛给调用方展示 */
  configure(input: HubConfigureInput): Promise<void>;
  /** 断开并忘记（hub:forget）；成功后重拉快照 + 清空节点表 */
  forget(): Promise<void>;
}

// 快照在途期间暂存的状态事件——模块级：init 的订阅回调写入、快照落地时读取重放
// （loadError 态下亦然——重试成功后的快照会带上这段窗口内的最新状态）
let pendingState: HubStateChangedEvent | null = null;

export const useHubStore = create<HubState>((set, get) => {
  const pullNodes = async (): Promise<void> => {
    try {
      const seed = await ipc.hub.getNodes();
      set((s) => {
        // 种子在前（权威序），事件已到而种子未含者追加——只增不删（删除归 offline 事件）
        const merged = new Map(seed.map((n) => [n.nodeId, { nodeId: n.nodeId, nodeName: n.nodeName }]));
        for (const row of s.nodes) if (!merged.has(row.nodeId)) merged.set(row.nodeId, row);
        return { nodes: [...merged.values()] };
      });
    } catch {
      // 补拉是补给面：失败不翻转 status / 不置 loadError——推送路仍在维护节点表
    }
  };

  const pullStatusSnapshot = (): void => {
    void ipc.hub
      .getStatus()
      .then((status) => {
        const pending = pendingState;
        pendingState = null;
        set(
          pending
            ? {
                // 事件覆盖快照（重放方向恒为事件新于快照）：协议诊断两字段一并覆盖
                status: {
                  ...status,
                  state: pending.state,
                  lastError: pending.lastError,
                  lastErrorCode: pending.lastErrorCode,
                  hubProtoVer: pending.hubProtoVer,
                },
                loadError: null,
              }
            : { status, loadError: null },
        );
        // 快照落地 = 订阅已在位：补齐在线节点清单（冷启动/重连后事件已错过）
        void pullNodes();
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
          // 非 online 态 → 节点表一并作废（断连期间收不到上下线事件，列表必陈旧）
          if (e.state !== 'online') set({ nodes: [] });
          return;
        }
        set((s) =>
          s.status
            ? {
                status: {
                  ...s.status,
                  state: e.state,
                  lastError: e.lastError,
                  lastErrorCode: e.lastErrorCode,
                  hubProtoVer: e.hubProtoVer,
                },
                // 非 online 态 → 节点表作废（重连后由 hello 快照种子重新填充）
                ...(e.state === 'online' ? {} : { nodes: [] }),
              }
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
      // 面板挂载即补拉（不等状态快照成功——订阅已就位，事件路并行维护）
      void pullNodes();
      return () => {
        disposeState();
        disposePresence();
      };
    },

    pullNodes,

    refresh() {
      set({ loadError: null });
      pullStatusSnapshot();
    },

    async enroll(input) {
      const status = await ipc.hub.enroll(input);
      // 重接入即换 hub 身份：旧节点表一并作废
      set({ status, nodes: [] });
    },

    async configure(input) {
      const status = await ipc.hub.configure(input);
      // 换址即换 hub 身份：旧节点表一并作废（换址分支主进程清凭证归零 nodeId）
      set({ status, nodes: [] });
    },

    async forget() {
      await ipc.hub.forget();
      set({ status: await ipc.hub.getStatus(), nodes: [] });
    },
  };
});
