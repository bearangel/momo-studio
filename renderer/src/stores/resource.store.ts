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
//   - setSourceFilter：P2-5（M2 D7）起切换即重拉列表——纯前端过滤会让 hub 目录
//     等远程源的增量（新发布/下架）不可见，需手动刷新；重拉后来源筛选仍在
//     前端做（IPC filter 只下发 type 维度，计数需全量）。setQuery 维持纯前端
//     （本地关键词匹配无远程增量问题）；两者变化时均清掉 installNotice
//     （防止下一次切换仍显示陈旧的成功提示）
//   - deleteResource / installResource：调对应 IPC 后立即 load 刷新
//   - installResource：包 try/catch——安装失败必须落到 error 字段，
//     避免 unhandled rejection；成功后 set installNotice 给 View 渲染一次性成功横幅；
//     返回 true/false 表示成功/失败（false 时错误已在 error 字段）。
//     P2.1 Task 3：smithery needsConfig:true 时原样透传 SmitheryInstallResult
//     （未安装——不刷列表不设横幅；对象对旧布尔消费方恒真，语义兼容）
//
// 注意：搜索（query）刻意不进 IPC filter——v1.7 后端 filter 只支持 type/source 两个维度，
// 关键词搜索在前端 in-memory 完成（name/description/slug 模糊匹配，见 View 层）。
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import { useWorkspaceStore } from './workspace.store';
import { compareVersions } from '../lib/version-compare';
import { hasKnownErrorPrefix } from '../lib/error-prefix';
import type { ViewKey } from './ui.store';
import type {
  HubResourcePublishedEvent,
  ResourceItem,
  ResourceFilter,
  ResourceType,
  SmitheryInstallResult,
} from '../ipc/types';

/**
 * 一次性成功横幅载荷（D13 扩展）：纯文本（旧形态，存量写入点不变）或带 CTA
 * 的对象——actionView 为 ui.store 的目标视图 key（会话视图 = 'im'），横幅据此
 * 渲染「去会话」按钮。
 */
export type InstallNotice = string | { text: string; actionView?: ViewKey };

interface ResourceStore {
  items: ResourceItem[];
  loading: boolean;
  error: string | null;
  /** 安装成功提示横幅（null = 无；下一次 filter/type 切换清掉，load 不清） */
  installNotice: InstallNotice | null;
  /**
   * D9：市场目录降级标志（agent 预置目录的远程 catalog 部分不可达时 true）。
   * 查询失败按 false——宁可漏报不误报降级。
   */
  catalogDegraded: boolean;
  /**
   * M1 Task 14：momo-hub 目录降级标志（getCatalogStatus sources[].hub）——
   * hub 页签「hub 暂不可达」黄条数据源。失败按 false（同 D9 宁漏报不误报）。
   */
  hubDegraded: boolean;
  /**
   * M2.5 T1 收紧：hub 目录健康状态是否已成功读取（known=false 时占位 false
   * 的 hubDegraded 只是提示条语义，不代表目录可信——播种门控必须另判）。
   */
  hubStatusKnown: boolean;
  /**
   * M1 Task 14：hub 发布事件带来的最新版本表（key `${type}:${slug}` → 版本）。
   * 已装 hub 资源与该表 semver 前进比较（M2.3 T2——lib/version-compare 镜像
   * 单源）得「可更新」角标；installResource 成功且记账版本到达事件版本才消键。
   */
  hubUpdates: Record<string, string>;
  /**
   * M2.5 T1（A1）：某类型是否已成功拉取过 hub 目录（播种基线已建立）。
   * 卡片三态依据——未播种且无事件时不断言「已是最新」（无目录证据）。
   * 仅在 hub 源可信（sources[hub].degraded===false）的 load 成功后置 true。
   */
  hubSeeded: Record<string, boolean>;
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
  /** D9：拉取市场目录健康状态（degraded 写 catalogDegraded；失败静默回 false） */
  loadCatalogStatus: () => Promise<void>;
  /**
   * M1 Task 14：订阅 hub:resourcePublished（含本机与其他节点的发布），按
   * `${type}:${slug}` 记录最新版本到 hubUpdates。返回解订阅函数（View 卸载调用）。
   */
  initHubUpdates: () => () => void;
  /**
   * M2.5 T1（A1）：用目录版本播种某类型的更新基线——只作用于该类型（其他
   * 类型 key 不动），入表条件 compareVersions(目录版本, 已装版本) > 0。
   * hub 源降级时整体早退（既不清空也不新增）。事件路径仍为增量。
   */
  seedHubUpdates: (type: ResourceType, entries: Array<{ slug: string; version: string }>) => void;
  /**
   * 组⑤：MCP 启停——写库 + 禁用时断开运行实例；成功横幅 + 列表刷新，
   * 失败落 error 字段（红色横幅）。name 为 MCP 注册名（item.slug）。
   */
  setMcpEnabled: (name: string, enabled: boolean) => Promise<void>;
  /**
   * 插件启停（spec 2026-10-15 §7.1，workspace 级）：调 plugin.setEnabled 后
   * 刷新列表（启停态经 resource:list 的 workspaceId 解析）。失败落 error。
   */
  setPluginEnabled: (id: string, workspaceId: string, enabled: boolean) => Promise<void>;
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
  catalogDegraded: false,
  hubDegraded: false,
  hubStatusKnown: false,
  hubUpdates: {},
  hubSeeded: {},
  typeFilter: 'all',
  sourceFilter: 'all',
  query: '',
  activeType: 'agent',

  load: async () => {
    set({ loading: true, error: null });
    try {
      // 来源筛选在前端做（计数需要全量）——IPC filter 只下发 type 维度；
      // workspaceId 供插件行启停态解析（无活跃 workspace 时缺省 = 按启用展示）
      const filter: ResourceFilter = {};
      const { typeFilter } = get();
      if (typeFilter !== 'all') filter.type = typeFilter;
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (wsId) filter.workspaceId = wsId;
      const items = await ipc.resource.list(filter);
      set({ items, loading: false });
      // M2.5 T1（A1）：列表成功后按 hub 源健康度播种更新基线——重启/离线/带外
      // 目录变更后不再只依赖 resource.published 事件。degraded 为真时完全不动
      //（不清空既有角标，也不新增）；stale 不影响（浏览链本就是 load）。
      await get().loadCatalogStatus();
      // 仅「状态已知且 hub 未降级」才播种：查询失败 = 状态未知 → 不播种（不清空
      // 也不新增），卡片落回「未拉取」三态；hubDegraded 的 false 占位只服务提示条。
      if (!get().hubStatusKnown || get().hubDegraded) return;
      const seededTypes: ResourceType[] =
        typeFilter === 'all' || typeFilter === undefined
          ? ['agent', 'mcp', 'skill', 'plugin']
          : [typeFilter];
      for (const t of seededTypes) {
        const entries = items.flatMap((i) =>
          i.type === t && i.source === 'hub' && i.version
            ? [{ slug: i.slug, version: i.version }]
            : [],
        );
        get().seedHubUpdates(t, entries);
      }
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
    // P2-5（M2 D7）：切换即重拉——hub 目录等远程源的增量不经重拉不可见。
    // load 仍只下发 type 维度，来源过滤照旧在前端做（计数需全量）。
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
    // 切类型页时重置来源筛选：筛选是页面上下文，跨页残留会让新页列表静默变空
    // （2026-10-09 真机走查 N1：Agent 页点「网络」→ 切 MCP 页空列表被误读为空库）
    set({ activeType: t, typeFilter: t, sourceFilter: 'all', installNotice: null });
    void get().load();
  },

  deleteResource: async (id) => {
    await ipc.resource.delete(id);
    await get().load();
  },

  loadCatalogStatus: async () => {
    try {
      const r = await ipc.resource.getCatalogStatus();
      set({
        catalogDegraded: r.degraded,
        hubDegraded: r.sources?.find((s) => s.source === 'hub')?.degraded ?? false,
        hubStatusKnown: true,
      });
    } catch {
      // 通道未就绪（主进程并行接线）或查询失败——不误报降级（提示条语义不变），
      // 但标记状态未知：播种据此拒绝建基线。
      set({ catalogDegraded: false, hubDegraded: false, hubStatusKnown: false });
    }
  },

  initHubUpdates: () => {
    return ipc.hub.onResourcePublished((e: HubResourcePublishedEvent) => {
      set((s) => ({
        hubUpdates: { ...s.hubUpdates, [`${e.type}:${e.slug}`]: e.version },
      }));
    });
  },

  seedHubUpdates: (type, entries) => {
    if (get().hubDegraded) return;
    const { items, hubUpdates, hubSeeded } = get();
    const prefix = `${type}:`;
    const next = { ...hubUpdates };
    // 本类型作用域内对账：只清理已不成立的键（已装达到/超过键版本），其他类型不碰
    for (const key of Object.keys(next)) {
      if (!key.startsWith(prefix)) continue;
      const item = items.find(
        (i) => i.type === type && i.slug === key.slice(prefix.length) && i.source === 'hub',
      );
      if (!item) continue;
      const current = next[key];
      if (current === undefined) continue;
      const anchor = item.installedVersion ?? item.version;
      if (!item.installed || !anchor || compareVersions(current, anchor) <= 0) {
        delete next[key];
      }
    }
    // 目录基线：仅目录版本高于已装版本才入表；与既有事件版本取高（事件=增量）
    for (const entry of entries) {
      const item = items.find(
        (i) => i.type === type && i.slug === entry.slug && i.source === 'hub',
      );
      if (!item?.installed) continue;
      const anchor = item.installedVersion ?? item.version;
      if (!anchor || compareVersions(entry.version, anchor) <= 0) continue;
      const key = `${type}:${entry.slug}`;
      const current = next[key];
      if (current === undefined || compareVersions(entry.version, current) > 0) {
        next[key] = entry.version;
      }
    }
    set({ hubUpdates: next, hubSeeded: { ...hubSeeded, [type]: true } });
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
        : `已停用「${name}」，正在运行的连接已断开`,
    });
    await get().load();
  },

  setPluginEnabled: async (id, workspaceId, enabled) => {
    set({ error: null });
    try {
      await ipc.plugin.setEnabled(id, workspaceId, enabled);
    } catch (err) {
      set({ error: `启停失败：${(err as Error).message}` });
      return;
    }
    set({ installNotice: enabled ? `已启用插件「${id}」` : `已停用插件「${id}」` });
    await get().load();
  },

  installResource: async (id) => {
    set({ error: null });
    const before = get().items.find((i) => i.id === id);
    try {
      const result = await ipc.resource.install(id);
      // P2.1 Task 3：smithery needsConfig 两态——需要用户补配置时未安装，
      // 不刷列表、不设成功横幅，结果原样透传给调用方（Task 6 弹窗消费）。
      // M2.3 T2：install 返回联合含 HubInstallResult（hub alreadyLatest 回执），
      // 'needsConfig' in 窄化取 smithery 分支；hub 分支落下方横幅逻辑。
      if (result && typeof result === 'object' && 'needsConfig' in result && result.needsConfig) {
        return result;
      }
      await get().load();
      const after = get().items.find((i) => i.id === id);
      if (after?.source === 'hub') {
        // hub 项：横幅区分首装/更新/已是最新 + 消角标键（M1 Task 14 + M2.3 T2
        // D3-2/D3-3 消键条件化：仅记账版本 semver 到达事件版本才消——安装未
        // 达事件版本时键保留，角标继续指向新版本，不误报「已是最新」）
        const { hubUpdates } = get();
        const key = `${after.type}:${after.slug}`;
        const eventVersion = hubUpdates[key];
        if (
          eventVersion !== undefined &&
          after.installedVersion !== undefined &&
          compareVersions(after.installedVersion, eventVersion) >= 0
        ) {
          const next = { ...hubUpdates };
          delete next[key];
          set({ hubUpdates: next });
        }
        // alreadyLatest 回执（主进程 semver 判定 target ≤ 已装——零动作）：
        // 如实报「已是最新版本」，不谎报「已更新」（结构化窄化：install 返回联合
        // 中的 HubInstallResult 分支，见 ipc/types.d.ts）
        const hubResult = result as { alreadyLatest?: boolean; version?: string } | null | undefined;
        const alreadyLatest = hubResult?.alreadyLatest === true;
        set({
          installNotice: alreadyLatest
            ? `「${after.name}」已是最新版本（v${after.installedVersion ?? hubResult?.version ?? ''}）`
            : before?.installed
              ? `已从 momo-hub 更新「${after.name}」`
              : `已从 momo-hub 安装「${after.name}」`,
        });
        return true;
      }
      // 落地 ok → 设置成功横幅；item 在 load 后会出现在「自定义」筛选下
      set({ installNotice: '已导入至「自定义」' });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({
        error: hasKnownErrorPrefix(message) ? message : `导入失败：${message}`,
        loading: false,
        installNotice: null,
      });
      // 不 rethrow——安装失败必须落到 error 字段给 View 渲染，
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
    persisted === 'agent' || persisted === 'mcp' || persisted === 'skill' || persisted === 'plugin'
      ? persisted
      : 'agent';
  useResourceStore.setState({ activeType: valid, typeFilter: valid });
}

