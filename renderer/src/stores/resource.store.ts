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
//   - setQuery：纯前端搜索（无 IPC）；View 层读 query 自行 filter items；filter 变化时
//     清掉 installNotice（防止下一次 filter 切换仍显示陈旧的成功提示）
//   - deleteResource / installResource：调对应 IPC 后立即 load 刷新
//   - installResource：包 try/catch——p2p 导入失败（离线/未找到/超时）必须落到 error 字段，
//     避免 unhandled rejection；成功后 set installNotice 给 View 渲染一次性成功横幅
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
  /** 安装成功提示横幅文本（null = 无；下一次 filter 切换或下一次 load 清掉） */
  installNotice: string | null;
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
  /** 设置搜索关键词（不触发 IPC）；同时清掉陈旧的成功提示 */
  setQuery: (q: string) => void;
  /** 删除/卸载某资源后刷新 */
  deleteResource: (id: string) => Promise<void>;
  /** 安装某资源后刷新；失败时把 message 写入 error，rethrow 不再向上（避免 unhandled） */
  installResource: (id: string) => Promise<void>;
}

export const useResourceStore = create<ResourceStore>((set, get) => ({
  items: [],
  loading: false,
  error: null,
  installNotice: null,
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
    set({ typeFilter: f, installNotice: null });
    void get().load();
  },

  setSourceFilter: (f) => {
    set({ sourceFilter: f, installNotice: null });
    void get().load();
  },

  setQuery: (q) => set({ query: q, installNotice: null }),

  deleteResource: async (id) => {
    await ipc.resource.delete(id);
    await get().load();
  },

  installResource: async (id) => {
    set({ error: null });
    try {
      await ipc.resource.install(id);
      await get().load();
      // 落地 ok → 设置成功横幅；item 在 load 后会出现在「我的上传」tab
      set({ installNotice: '已导入至「我的上传」' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: `导入失败：${message}`, loading: false, installNotice: null });
      // 不 rethrow——p2p 导入失败（离线/未找到/超时）必须落到 error 字段给 View 渲染，
      // 避免 unhandled rejection；调用方 await installResource() 拿不到 reject 语义
    }
  },
}));
