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
import type { HubGroupInfo } from '../ipc/types';

interface HubGroupState {
  groups: HubGroupInfo[];
  loading: boolean;
  /** 最近一次拉取/动作失败的呈现文案；成功即清 */
  error: string | null;
  /** 本机最近生成的邀请码（groupId → code；仅供展示复制） */
  inviteCodes: Record<string, string>;
  /** 面板挂载时调用：订阅 groupChanged + 拉取列表；返回解订阅函数 */
  init(): () => void;
  /** 权威拉取组列表（loading 门闸防并发重入） */
  load(): Promise<void>;
  create(groupName: string): Promise<void>;
  invite(groupId: string): Promise<string>;
  join(inviteCode: string): Promise<void>;
  leave(groupId: string): Promise<void>;
  transfer(groupId: string, toNodeId: string): Promise<void>;
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
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      refreshing = false;
      if (rerunAfterRefresh) {
        rerunAfterRefresh = false;
        void refresh();
      }
    }
  };

  const runAction = async (op: () => Promise<unknown>): Promise<void> => {
    try {
      await op();
    } catch (err) {
      // 先重拉对账再呈现错误——refresh 成功分支清 error，顺序颠倒会覆盖错误呈现
      await refresh();
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    await refresh();
  };

  return {
    groups: [],
    loading: false,
    error: null,
    inviteCodes: {},

    init() {
      const dispose = ipc.hub.onGroupChanged(() => {
        void refresh();
      });
      void refresh();
      return dispose;
    },

    load: refresh,

    async create(groupName) {
      await runAction(() => ipc.hub.groupCreate({ groupName }));
    },

    async invite(groupId) {
      const { inviteCode } = await ipc.hub.groupInvite({ groupId });
      set((s) => ({ inviteCodes: { ...s.inviteCodes, [groupId]: inviteCode } }));
      return inviteCode;
    },

    async join(inviteCode) {
      await runAction(() => ipc.hub.groupJoin({ inviteCode }));
    },

    async leave(groupId) {
      await runAction(() => ipc.hub.groupLeave({ groupId }));
    },

    async transfer(groupId, toNodeId) {
      await runAction(() => ipc.hub.groupTransfer({ groupId, toNodeId }));
    },
  };
});
