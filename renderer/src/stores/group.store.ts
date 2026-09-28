// renderer/src/stores/group.store.ts
//
// 任务组状态管理（看板重构 Task 10）：
//   - groups：当前 workspace 的活跃组（list 默认 'exclude' 归档组）
//   - load：拉取组列表；动作（create/rename/setColor/reorder/archive/unarchive）
//     全部先 await ipc.taskGroup.* 再本地同步——IPC 返回行是权威值，
//     失败一律 rethrow 且本地不动（上层 toast）
//
// 排序契约：与主进程 repo 镜像——position ASC, created_at ASC。
// reorder 本地同步会镜像 repo 的 (i+1)*1024 重写语义（未列入的组 position 不动），
// 保证后续排序动作（create 追加 / unarchive 塞回）依赖的本地 position 不失真。
//
// 注意：archiveGroup / unarchiveGroup 都会改变组内任务的 task:list 可见性
// （归档级联 / 解档连带恢复，主进程事务），但本 store 不跨 store 联动刷新
// task.store（照 task.store 单一职责先例）——调用方（UI 层）在动作成功后
// 自行触发任务列表 load。
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { GroupRow } from '../ipc/types';

/** 与主进程 listGroups 的 ORDER BY position ASC, created_at ASC 对齐 */
function sortByPosition(groups: GroupRow[]): GroupRow[] {
  return [...groups].sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
}

interface GroupState {
  groups: GroupRow[];
  loading: boolean;
  error: string | null;
  /** 当前 groups 所属的 workspace ID；load 切换 workspace 时据此重置列表 */
  currentWorkspaceId: string | null;
  /** 看板组过滤（UX 修复）：null=不过滤；不持久化，reset / 切 ws 清空 */
  selectedGroupId: string | null;
  setSelectedGroupId: (id: string | null) => void;

  load: (workspaceId: string) => Promise<void>;
  create: (input: Parameters<typeof ipc.taskGroup.create>[0]) => Promise<GroupRow>;
  rename: (id: string, name: string) => Promise<void>;
  setColor: (id: string, color: string) => Promise<void>;
  reorder: (orderedIds: string[]) => Promise<void>;
  /** 归档组（主进程级联取消+归档组内任务）；成功即本地剔除该组 */
  archive: (id: string) => Promise<void>;
  /** 解档组（主进程事务内组+组内归档任务一并恢复）；成功即把返回行按 position 塞回；调用方需自行刷新任务列表 */
  unarchive: (id: string) => Promise<void>;
  /**
   * 删除组（主进程事务：组内任务转移到目标组后删组，moveToGroupId=null 落未分组）；
   * 成功即本地剔除 + 重拉组列表，被删组若正被选中过滤 → 置 null（回「全部」）；
   * 任务列表刷新由调用方承接（照归档组级联承接模式）
   */
  delete: (id: string, moveToGroupId: string | null) => Promise<void>;
  reset: () => void;
}

export const useGroupStore = create<GroupState>((set, get) => ({
  groups: [],
  loading: false,
  error: null,
  currentWorkspaceId: null,
  selectedGroupId: null,
  setSelectedGroupId: (id) => set({ selectedGroupId: id }),

  load: async (workspaceId) => {
    if (get().currentWorkspaceId !== workspaceId) {
      // 切 ws 连带清空组过滤——旧 ws 的选中组在新 ws 无意义
      set({ currentWorkspaceId: workspaceId, groups: [], selectedGroupId: null });
    }
    set({ loading: true, error: null });
    try {
      const groups = await ipc.taskGroup.list(workspaceId);
      set({ groups, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  create: async (input) => {
    const created = await ipc.taskGroup.create(input);
    set((s) => ({ groups: sortByPosition([...s.groups, created]) }));
    return created;
  },

  rename: async (id, name) => {
    const updated = await ipc.taskGroup.update(id, { name });
    set((s) => ({ groups: s.groups.map((g) => (g.id === id ? updated : g)) }));
  },

  setColor: async (id, color) => {
    const updated = await ipc.taskGroup.update(id, { color });
    set((s) => ({ groups: s.groups.map((g) => (g.id === id ? updated : g)) }));
  },

  reorder: async (orderedIds) => {
    await ipc.taskGroup.reorder(orderedIds);
    // 镜像 repo 语义本地同步：第 i 位 → position (i+1)*1024，
    // 未列入的组 position 不动；随后按 (position, createdAt) 重排
    const newPos = new Map(orderedIds.map((id, i) => [id, (i + 1) * 1024]));
    set((s) => ({
      groups: sortByPosition(
        s.groups.map((g) => {
          const pos = newPos.get(g.id);
          return pos !== undefined ? { ...g, position: pos } : g;
        }),
      ),
    }));
  },

  archive: async (id) => {
    await ipc.taskGroup.archive(id); // 组不存在等失败 → 本地不动，错误上抛
    set((s) => ({
      groups: s.groups.filter((g) => g.id !== id),
      // 被归档组若正被选中过滤 → 一并清空（空组过滤无意义）
      ...(s.selectedGroupId === id ? { selectedGroupId: null } : {}),
    }));
  },

  unarchive: async (id) => {
    const restored = await ipc.taskGroup.unarchive(id);
    set((s) => ({ groups: sortByPosition([...s.groups, restored]) }));
  },

  delete: async (id, moveToGroupId) => {
    await ipc.taskGroup.delete(id, moveToGroupId); // 组不存在/目标非法 → 本地不动，错误上抛
    set((s) => ({
      groups: s.groups.filter((g) => g.id !== id),
      // 被删组若正被选中过滤 → 回「全部」（悬空防御兜底已有）
      ...(s.selectedGroupId === id ? { selectedGroupId: null } : {}),
    }));
    // 删除是破坏性操作：重拉组列表取权威值（不做本地推演）
    const ws = get().currentWorkspaceId;
    if (ws) await get().load(ws);
  },

  reset: () =>
    set({ groups: [], loading: false, error: null, currentWorkspaceId: null, selectedGroupId: null }),
}));
