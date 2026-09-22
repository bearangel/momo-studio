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
//     避免 unhandled rejection；成功后 set installNotice 给 View 渲染一次性成功横幅；
//     返回 true/false 表示成功/失败（false 时错误已在 error 字段）
//
// 注意：搜索（query）刻意不进 IPC filter——v1.7 后端 filter 只支持 type/source 两个维度，
// 关键词搜索在前端 in-memory 完成（name/description/slug 模糊匹配，见 View 层）。
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type {
  ResourceItem,
  ResourceFilter,
  ResourceType,
  RegistryProviderMeta,
} from '../ipc/types';

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

  /** 资源库重设计：当前激活的资源页类型（无 'all'——三页结构） */
  activeType: ResourceType;
  /** 页面模式：installed=已安装列表 / registry=网络获取（注册表浏览） */
  mode: 'installed' | 'registry';
  /** 网络获取模式当前 provider（P2 双轨 hub，Task 6）——选择经 localStorage 记忆 */
  registryProviderKey: RegistryProviderMeta['key'];

  /** 按当前 filter 重新拉取列表 */
  load: () => Promise<void>;
  /** 切换 type tab 并刷新 */
  setTypeFilter: (f: ResourceFilter['type'] | 'all') => void;
  /** 切换 source tab 并刷新 */
  setSourceFilter: (f: ResourceFilter['source'] | 'all') => void;
  /** 设置搜索关键词（不触发 IPC）；同时清掉陈旧的成功提示 */
  setQuery: (q: string) => void;
  /** 切换资源页：驱动 typeFilter、持久化、立即刷新；并复位到已安装模式 */
  setActiveType: (t: ResourceType) => void;
  /** 切换页面模式（registry 数据由 RegistryBrowse 自行经 Provider 拉取，不动 items） */
  setMode: (m: 'installed' | 'registry') => void;
  /** 切换网络获取 provider：持久化记忆 + 更新状态（写失败静默——隐私模式等场景不影响内存） */
  setRegistryProvider: (key: RegistryProviderMeta['key']) => void;
  /** 删除/卸载某资源后刷新 */
  deleteResource: (id: string) => Promise<void>;
  /** 安装某资源后刷新；返回是否成功（false 时错误在 error 字段）——marketplace agent 安装引导据此触发 */
  installResource: (id: string) => Promise<boolean>;
}

export const useResourceStore = create<ResourceStore>((set, get) => ({
  items: [],
  loading: false,
  error: null,
  installNotice: null,
  typeFilter: 'all',
  sourceFilter: 'all',
  query: '',
  activeType: 'agent',
  mode: 'installed',
  registryProviderKey: 'builtin',

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

  setActiveType: (t) => {
    // 持久化上次选择（写入失败静默——隐私模式等场景不影响内存状态）
    try {
      localStorage.setItem('momo.resourceLibrary.activeType', t);
    } catch {
      // 忽略
    }
    set({ activeType: t, typeFilter: t, mode: 'installed', installNotice: null });
    void get().load();
  },

  setMode: (m) => set({ mode: m, installNotice: null }),

  setRegistryProvider: (key) => {
    // 持久化上次选择（写入失败静默——隐私模式等场景不影响内存状态）
    try {
      localStorage.setItem('momo.resourceLibrary.providerKey', key);
    } catch {
      // 忽略
    }
    set({ registryProviderKey: key });
  },

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
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: `导入失败：${message}`, loading: false, installNotice: null });
      // 不 rethrow——p2p 导入失败（离线/未找到/超时）必须落到 error 字段给 View 渲染，
      // 避免 unhandled rejection；调用方 await installResource() 拿到 false 语义
      return false;
    }
  },
}));

// 启动恢复上次激活的资源页类型（失效值回退 'agent'；typeFilter 同步对齐）
{
  const persisted = (() => {
    try {
      return localStorage.getItem('momo.resourceLibrary.activeType');
    } catch {
      return null;
    }
  })();
  const valid: ResourceType =
    persisted === 'agent' || persisted === 'mcp' || persisted === 'skill' ? persisted : 'agent';
  useResourceStore.setState({ activeType: valid, typeFilter: valid });
}

// 启动恢复上次选择的网络获取 provider（失效值回退 'builtin'；Task 6 记忆）
{
  const persisted = (() => {
    try {
      return localStorage.getItem('momo.resourceLibrary.providerKey');
    } catch {
      return null;
    }
  })();
  const valid: RegistryProviderMeta['key'] =
    persisted === 'builtin' || persisted === 'smithery' || persisted === 'modelscope'
      ? persisted
      : 'builtin';
  useResourceStore.setState({ registryProviderKey: valid });
}
