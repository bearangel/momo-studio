// renderer/src/stores/resource.store.ts
//
// v1.7 Task 9：资源库统一 store。把 builtin / marketplace / custom 三源合并后的
// ResourceItem[] 存进 store，并维护双层 tab（typeFilter × sourceFilter）+ 搜索框（query）
// + 加载/错误状态。
//
// 行为约定：
//   - load()：根据当前 typeFilter / sourceFilter 组装 ResourceFilter（'all' 不下发字段）
//     调 ipc.resource.list，结果写 items
//   - setTypeFilter / setSourceFilter：set 新值后立即触发 load（让后端按 AND 过滤）
//   - setQuery：纯前端搜索（无 IPC）；View 层读 query 自行 filter items
//   - deleteResource / installResource：调对应 IPC 后立即 load 刷新
//
// 注意：搜索（query）刻意不进 IPC filter——v1.7 后端 filter 只支持 type/source 两个维度，
// 关键词搜索在前端 in-memory 完成（name/description/slug 模糊匹配，见 View 层）。
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { ResourceItem, ResourceFilter } from '../ipc/types';

interface ResourceStore {
  items: ResourceItem[];
  loading: boolean;
  error: string | null;
  /** 当前 type tab，'all' = 不限 */
  typeFilter: ResourceFilter['type'] | 'all';
  /** 当前 source tab，'all' = 不限 */
  sourceFilter: ResourceFilter['source'] | 'all';
  /** 搜索关键词（前端过滤，无 IPC） */
  query: string;

  /** 按当前 filter 重新拉取列表 */
  load: () => Promise<void>;
  /** 切换 type tab 并刷新 */
  setTypeFilter: (f: ResourceFilter['type'] | 'all') => void;
  /** 切换 source tab 并刷新 */
  setSourceFilter: (f: ResourceFilter['source'] | 'all') => void;
  /** 设置搜索关键词（不触发 IPC） */
  setQuery: (q: string) => void;
  /** 删除/卸载某资源后刷新 */
  deleteResource: (id: string) => Promise<void>;
  /** 安装某资源后刷新 */
  installResource: (id: string) => Promise<void>;
}

export const useResourceStore = create<ResourceStore>((set, get) => ({
  items: [],
  loading: false,
  error: null,
  typeFilter: 'all',
  sourceFilter: 'all',
  query: '',

  load: async () => {
    set({ loading: true, error: null });
    try {
      // 'all' 不下发字段，让后端返回全部
      const filter: ResourceFilter = {};
      const { typeFilter, sourceFilter } = get();
      if (typeFilter !== 'all') filter.type = typeFilter;
      if (sourceFilter !== 'all') filter.source = sourceFilter;
      const items = await ipc.resource.list(filter);
      set({ items, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  setTypeFilter: (f) => {
    set({ typeFilter: f });
    void get().load();
  },

  setSourceFilter: (f) => {
    set({ sourceFilter: f });
    void get().load();
  },

  setQuery: (q) => set({ query: q }),

  deleteResource: async (id) => {
    await ipc.resource.delete(id);
    await get().load();
  },

  installResource: async (id) => {
    await ipc.resource.install(id);
    await get().load();
  },
}));
