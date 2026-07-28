// Marketplace 状态管理：
//   - catalog：全部可安装项（远程优先、本地回退，由主进程 client 负责）
//   - items：当前展示的子集（搜索 + 类型过滤后的结果）
//   - installed：已安装包记录（itemId → InstalledPackage），用于卡片/详情按钮状态
//
// loadCatalog 拉取 catalog 并同时刷新已安装列表；search/filterByType 仅在前端
// 过滤 catalog.items，不再触发 IPC（避免每次按键都打主进程）。
// install/uninstall 成功后立即刷新 installed，UI 据此切换按钮态。
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { InstalledPackage, MarketplaceCatalog, MarketplaceItem } from '../ipc/types';

/** 类型过滤选项：'all' 表示不限类型 */
export type TypeFilter = 'all' | MarketplaceItem['type'];

interface MarketplaceState {
  catalog: MarketplaceCatalog | null;
  items: MarketplaceItem[];
  installed: Record<string, InstalledPackage>;
  /** 当前激活的类型 tab */
  typeFilter: TypeFilter;
  /** 当前搜索关键词 */
  query: string;
  loading: boolean;
  error: string | null;
  /** 正在安装的 itemId 集合（按钮置灰用） */
  installing: Record<string, boolean>;

  loadCatalog: () => Promise<void>;
  loadInstalled: () => Promise<void>;
  /** 设置关键词并立即过滤 */
  setQuery: (q: string) => void;
  /** 设置类型 tab 并立即过滤 */
  setTypeFilter: (t: TypeFilter) => void;
  /** 安装一个包，成功后刷新已安装列表 */
  install: (item: MarketplaceItem) => Promise<void>;
  /** 卸载一个包，成功后刷新已安装列表 */
  uninstall: (itemId: string) => Promise<void>;
  reset: () => void;
}

/** 应用当前 query + typeFilter 到 catalog.items，得到展示子集 */
function applyFilter(
  catalog: MarketplaceCatalog | null,
  query: string,
  typeFilter: TypeFilter,
): MarketplaceItem[] {
  if (!catalog) return [];
  const q = query.toLowerCase().trim();
  return catalog.items.filter((item) => {
    if (typeFilter !== 'all' && item.type !== typeFilter) return false;
    if (!q) return true;
    return (
      item.name.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.slug.toLowerCase().includes(q) ||
      item.tags.some((t) => t.toLowerCase().includes(q))
    );
  });
}

export const useMarketplaceStore = create<MarketplaceState>((set, get) => ({
  catalog: null,
  items: [],
  installed: {},
  typeFilter: 'all',
  query: '',
  loading: false,
  error: null,
  installing: {},

  loadCatalog: async () => {
    set({ loading: true, error: null });
    try {
      const catalog = await ipc.marketplace.getCatalog();
      const installed = await ipc.marketplace.listInstalled();
      const installedMap: Record<string, InstalledPackage> = {};
      for (const pkg of installed) installedMap[pkg.itemId] = pkg;
      set({
        catalog,
        installed: installedMap,
        items: applyFilter(catalog, get().query, get().typeFilter),
        loading: false,
      });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  loadInstalled: async () => {
    try {
      const list = await ipc.marketplace.listInstalled();
      const installedMap: Record<string, InstalledPackage> = {};
      for (const pkg of list) installedMap[pkg.itemId] = pkg;
      set({ installed: installedMap });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  setQuery: (q) => {
    set({ query: q, items: applyFilter(get().catalog, q, get().typeFilter) });
  },

  setTypeFilter: (t) => {
    set({ typeFilter: t, items: applyFilter(get().catalog, get().query, t) });
  },

  install: async (item) => {
    set({ error: null, installing: { ...get().installing, [item.id]: true } });
    try {
      await ipc.marketplace.install(item);
      await get().loadInstalled();
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    } finally {
      const next = { ...get().installing };
      delete next[item.id];
      set({ installing: next });
    }
  },

  uninstall: async (itemId) => {
    set({ error: null });
    try {
      await ipc.marketplace.uninstall(itemId);
      await get().loadInstalled();
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  reset: () =>
    set({
      catalog: null,
      items: [],
      installed: {},
      typeFilter: 'all',
      query: '',
      loading: false,
      error: null,
      installing: {},
    }),
}));
