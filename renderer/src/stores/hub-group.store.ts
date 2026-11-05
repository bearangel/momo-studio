// renderer/src/stores/hub-group.store.ts
//
// 工作组面板数据源（momo-hub M2b T4）：组列表 + 六操作 + hub:groupChanged 推送。
// - 命名避开 task-board 的 group.store（任务看板组——不同域，一义一名）
// - load()：groupList 权威拉取；动作成功后不本地合成——一律重拉（组状态含他人
//   并发改动，本地合成必失真；hub 是单一真相源）
// - onGroupChanged → 重拉（事件只当失效信号，不当数据源——payload 不带全量）；
//   refresh 重入合并：在途期间新到的失效信号不丢弃（标记补拉一次）
// - 动作失败：先重拉对账、再呈现错误（顺序要紧——refresh 成功分支清 error，
//   后置错误呈现才不被覆盖）
// - 邀请码展示态放 inviteCodes：生成后其他成员再生成会撤销本码，group.changed
//   重拉列表不含码——面板展示的是「本机最近一次生成的码」，刷新即失效由重拉
//   后 list 不含该组时自然淘汰
// - 非 online 期动作由主进程 client.request 拒人话（'hub 未连接…'），rejection
//   原样落 error 交面板呈现
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import { rpcErrorMessage } from '../lib/rpc-error';
import type { HubGroupInfo } from '../ipc/types';

/**
 * create 可选项（1.10.0 平行模式）：mode='peer' 建平行组（hub 建组闸要求
 * 同时带组长绑定空间名）；lf 组两键缺省不带（载荷零变化）。
 */
export interface GroupCreateOptions {
  mode?: 'leader-follower' | 'peer';
  bindWorkspaceName?: string;
}

interface HubGroupState {
  groups: HubGroupInfo[];
  loading: boolean;
  /** 最近一次拉取/动作失败的呈现文案；成功即清 */
  error: string | null;
  /** 本机最近生成的邀请码（groupId → code；仅供展示复制） */
  inviteCodes: Record<string, string>;
  /**
   * 监控台选中的组（M2.1 T3）。null = 未选择（展示层回落第一组——见
   * effectiveSelectedGroup）；store 不回写回落值：选中态是 UI 偏好，组列表
   * 重拉后仍保持用户手选的组，仅在所选组已被移除时由展示层兜底
   */
  selectedGroupId: string | null;
  /** 面板挂载时调用：订阅 groupChanged + 拉取列表；返回解订阅函数 */
  init(): () => void;
  /** 权威拉取组列表（loading 门闸防并发重入） */
  load(): Promise<void>;
  selectGroup(groupId: string): void;
  /** 建组（1.10.0：peer 组带 mode + 组长绑定空间名） */
  create(groupName: string, opts?: GroupCreateOptions): Promise<void>;
  invite(groupId: string): Promise<string>;
  /** 入组；成功返回 groupId（调用方查组列表判定 mode==='peer' 走两步式绑定） */
  join(inviteCode: string): Promise<string>;
  leave(groupId: string): Promise<void>;
  transfer(groupId: string, toNodeId: string): Promise<void>;
  /** 1.10.0 平行组绑定/换绑承接空间（本地 workspaceId——主进程按名登记 hub + 本地落库） */
  bind(groupId: string, workspaceId: string): Promise<void>;
  /** 1.10.0 解绑（hub 登记与本地权威一并清除） */
  unbind(groupId: string): Promise<void>;
  /** 1.10.0 镜像接受开关翻转（须已绑定） */
  setMirrorAccept(groupId: string, accepts: boolean): Promise<void>;
}

/**
 * 展示层生效选中组：手选组在场 → 手选组；否则回落第一组；无组 → null。
 * 侧栏与监控台共用同一推导，保证高亮与主区内容永不劈叉。
 */
export function effectiveSelectedGroup(
  groups: HubGroupInfo[],
  selectedGroupId: string | null,
): HubGroupInfo | null {
  return groups.find((g) => g.groupId === selectedGroupId) ?? groups[0] ?? null;
}

export const useHubGroupStore = create<HubGroupState>((set) => {
  let refreshing = false;
  let rerunAfterRefresh = false;

  const refresh = async (): Promise<void> => {
    if (refreshing) {
      rerunAfterRefresh = true; // 在途：标记补拉，不丢失效信号
      return;
    }
    refreshing = true;
    set({ loading: true });
    try {
      const { groups } = await ipc.hub.groupList();
      set({ groups, loading: false, error: null });
    } catch (err) {
      // hub 通道（M4.1 coded）：剥 `[code]` 传输前缀后呈现
      set({ loading: false, error: rpcErrorMessage(err) });
    } finally {
      refreshing = false;
      if (rerunAfterRefresh) {
        rerunAfterRefresh = false;
        void refresh();
      }
    }
  };

  const runAction = async <T>(op: () => Promise<T>): Promise<T> => {
    let result: T;
    try {
      result = await op();
    } catch (err) {
      // 先重拉对账再呈现错误——refresh 成功分支清 error，顺序颠倒会覆盖错误呈现
      await refresh();
      set({ error: rpcErrorMessage(err) });
      throw err;
    }
    await refresh();
    return result;
  };

  return {
    groups: [],
    loading: false,
    error: null,
    inviteCodes: {},
    selectedGroupId: null,

    init() {
      const dispose = ipc.hub.onGroupChanged(() => {
        void refresh();
      });
      void refresh();
      return dispose;
    },

    load: refresh,

    selectGroup(groupId) {
      set({ selectedGroupId: groupId });
    },

    async create(groupName, opts) {
      await runAction(() =>
        ipc.hub.groupCreate({
          groupName,
          ...(opts?.mode !== undefined ? { mode: opts.mode } : {}),
          ...(opts?.bindWorkspaceName !== undefined ? { bindWorkspaceName: opts.bindWorkspaceName } : {}),
        }),
      );
    },

    async invite(groupId) {
      const { inviteCode } = await ipc.hub.groupInvite({ groupId });
      set((s) => ({ inviteCodes: { ...s.inviteCodes, [groupId]: inviteCode } }));
      return inviteCode;
    },

    async join(inviteCode) {
      const { groupId } = await runAction(() => ipc.hub.groupJoin({ inviteCode }));
      return groupId;
    },

    async leave(groupId) {
      await runAction(() => ipc.hub.groupLeave({ groupId }));
    },

    async transfer(groupId, toNodeId) {
      await runAction(() => ipc.hub.groupTransfer({ groupId, toNodeId }));
    },

    async bind(groupId, workspaceId) {
      await runAction(() => ipc.hub.groupBind({ groupId, workspaceId }));
    },

    async unbind(groupId) {
      await runAction(() => ipc.hub.groupUnbind({ groupId }));
    },

    async setMirrorAccept(groupId, accepts) {
      await runAction(() => ipc.hub.groupSetMirrorAccept({ groupId, accepts }));
    },
  };
});
