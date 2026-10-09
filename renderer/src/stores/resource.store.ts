// renderer/src/stores/resource.store.ts
//
// v1.7 Task 9：资源库统一 store。把 builtin / marketplace / custom 三源合并后的
// ResourceItem[] 存进 store，并维护双层 tab（typeFilter × sourceFilter）+ 搜索框（query）
// + 加载/错误状态。
//
// 行为约定：
//   - load()：按当前 typeFilter 组装 ResourceFilter 调 ipc.resource.list，结果写 items。
//     来源筛选 2026-10-09 组③起改为前端过滤（工具栏来源下拉需对各来源计数——
//     服务端过滤拿不到全量，同搜索 query 一样在 View 层内存过滤）
//   - setTypeFilter：set 新值后立即触发 load（后端按 type 过滤）
//   - setSourceFilter / setQuery：纯前端筛选状态（无 IPC）；变化时清掉
//     installNotice（防止下一次切换仍显示陈旧的成功提示）
//   - deleteResource / installResource：调对应 IPC 后立即 load 刷新
//   - installResource：包 try/catch——p2p 导入失败（离线/未找到/超时）必须落到 error 字段，
//     避免 unhandled rejection；成功后 set installNotice 给 View 渲染一次性成功横幅；
//     返回 true/false 表示成功/失败（false 时错误已在 error 字段）。
//     P2.1 Task 3：smithery needsConfig:true 时原样透传 SmitheryInstallResult
//     （未安装——不刷列表不设横幅；对象对旧布尔消费方恒真，语义兼容）
//
// 注意：搜索（query）刻意不进 IPC filter——v1.7 后端 filter 只支持 type/source 两个维度，
// 关键词搜索在前端 in-memory 完成（name/description/slug 模糊匹配，见 View 层）。
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type {
  ResourceItem,
  ResourceFilter,
  ResourceType,
  SmitheryInstallResult,
} from '../ipc/types';

interface ResourceStore {
  items: ResourceItem[];
  loading: boolean;
  error: string | null;
  /** 安装成功提示横幅文本（null = 无；下一次 filter/type 切换清掉，load 不清） */
  installNotice: string | null;
  /** 当前 type tab，'all' = 不限 */
  typeFilter: ResourceFilter['type'] | 'all';
  /** 当前 source tab，'all' = 不限 */
  sourceFilter: ResourceFilter['source'] | 'all';
  /** 搜索关键词（前端过滤，无 IPC） */
  query: string;

  /** 资源库重设计：当前激活的资源页类型（无 'all'——三页结构） */
  activeType: ResourceType;

  /** 按当前 filter 重新拉取列表 */
  load: () => Promise<void>;
  /** 切换 type tab 并刷新 */
  setTypeFilter: (f: ResourceFilter['type'] | 'all') => void;
  /** 切换 source tab 并刷新 */
  setSourceFilter: (f: ResourceFilter['source'] | 'all') => void;
  /** 设置搜索关键词（不触发 IPC）；同时清掉陈旧的成功提示 */
  setQuery: (q: string) => void;
  /** 切换资源页：驱动 typeFilter、持久化、立即刷新 */
  setActiveType: (t: ResourceType) => void;
  /** 删除/卸载某资源后刷新 */
  deleteResource: (id: string) => Promise<void>;
  /**
   * 组⑤：MCP 启停——写库 + 禁用时断开运行实例；成功横幅 + 列表刷新，
   * 失败落 error 字段（红色横幅）。name 为 MCP 注册名（item.slug）。
   */
  setMcpEnabled: (name: string, enabled: boolean) => Promise<void>;
  /**
   * 安装某资源后刷新；返回成功布尔（false 时错误在 error 字段）——marketplace
   * agent 安装引导据此触发。P2.1 Task 3：smithery needsConfig:true 时原样透传
   * SmitheryInstallResult（对象对旧布尔消费方恒真，语义兼容）；横幅精修归 Task 6。
   */
  installResource: (id: string) => Promise<boolean | SmitheryInstallResult>;
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

  load: async () => {
    set({ loading: true, error: null });
    try {
      // 来源筛选在前端做（计数需要全量）——IPC filter 只下发 type 维度
      const filter: ResourceFilter = {};
      const { typeFilter } = get();
      if (typeFilter !== 'all') filter.type = typeFilter;
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

  setSourceFilter: (f) => set({ sourceFilter: f, installNotice: null }),

  setQuery: (q) => set({ query: q, installNotice: null }),

  setActiveType: (t) => {
    // 持久化上次选择（写入失败静默——隐私模式等场景不影响内存状态）
    try {
      localStorage.setItem('momo.resourceLibrary.activeType', t);
    } catch {
      // 忽略
    }
    // 切类型页时重置来源筛选：筛选是页面上下文，跨页残留会让新页列表静默变空
    // （2026-10-09 真机走查 N1：Agent 页点「网络」→ 切 MCP 页空列表被误读为空库）
    set({ activeType: t, typeFilter: t, sourceFilter: 'all', installNotice: null });
    void get().load();
  },

  deleteResource: async (id) => {
    await ipc.resource.delete(id);
    await get().load();
  },

  setMcpEnabled: async (name, enabled) => {
    set({ error: null });
    try {
      await ipc.resource.setMcpEnabled(name, enabled);
    } catch (err) {
      set({ error: `启停失败：${(err as Error).message}` });
      return;
    }
    set({
      installNotice: enabled
        ? `已启用「${name}」`
        : `已禁用「${name}」，正在运行的连接已断开`,
    });
    await get().load();
  },

  installResource: async (id) => {
    set({ error: null });
    try {
      const result = await ipc.resource.install(id);
      // P2.1 Task 3：smithery needsConfig 两态——需要用户补配置时未安装，
      // 不刷列表、不设成功横幅，结果原样透传给调用方（Task 6 弹窗消费）
      if (result && typeof result === 'object' && result.needsConfig) {
        return result;
      }
      await get().load();
      // 落地 ok → 设置成功横幅；item 在 load 后会出现在「自定义」筛选下
      set({ installNotice: '已导入至「自定义」' });
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

