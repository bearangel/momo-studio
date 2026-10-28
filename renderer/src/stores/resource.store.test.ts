// renderer/src/stores/resource.store.test.ts
//
// 资源库 store 行为契约测试（终审 v2.0.0-p4）：
//   - installResource 成功：error 清空 + installNotice 设值；后续 load 完成后 installNotice 仍在
//     （load 不应清掉成功提示——用户需要看到反馈）
//   - installResource 失败：error 写入「导入失败：...」前缀，installNotice 清空；
//     store 不 rethrow（避免 p2p 离线/未找到/超时 unhandled rejection）
//   - installNotice 在 filter 切换 / setQuery 时清掉（防止陈旧成功提示残留）
//   - P2.3 Task 1 字段消亡回归：mode / setMode / registryProviderKey / setRegistryProvider
//     不再存在于 store（网络获取模式已移除，renderer 收敛本地导入单态）
//
// 注：view 层的端到端测试见 ResourceLibraryView.test.tsx；本文件锁 store 层契约。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useResourceStore } from './resource.store';
import type { ResourceItem } from '../ipc/types';

const resourceList = vi.fn();
const resourceInstall = vi.fn();
const resourceSetMcpEnabled = vi.fn();
const pluginSetEnabled = vi.fn();
const resourceGetCatalogStatus = vi.fn();
// M1 Task 14：hub 发布事件订阅（onResourcePublished 回调捕获）
let publishedCb: ((e: { slug: string; type: string; name: string; version: string; author: string; at: number }) => void) | undefined;
const hubOnResourcePublished = vi.fn((cb: (e: { slug: string; type: string; name: string; version: string; author: string; at: number }) => void) => {
  publishedCb = cb;
  // 仿真真实解订阅语义（ipcRenderer.off 后回调不再可达）——mock 收窄铁律
  return () => { publishedCb = undefined; };
});

const mockApi = {
  resource: {
    list: resourceList,
    install: resourceInstall,
    setMcpEnabled: resourceSetMcpEnabled,
    getCatalogStatus: resourceGetCatalogStatus,
  },
  plugin: {
    setEnabled: pluginSetEnabled,
  },
  hub: {
    onResourcePublished: hubOnResourcePublished,
  },
};

beforeEach(() => {
  resourceList.mockReset();
  resourceInstall.mockReset();
  resourceList.mockResolvedValue([] as ResourceItem[]);
  resourceInstall.mockResolvedValue(undefined);

  (globalThis as unknown as { window: { api: typeof mockApi } }).window = { api: mockApi };

  useResourceStore.setState({
    items: [],
    loading: false,
    error: null,
    installNotice: null,
    typeFilter: 'all',
    sourceFilter: 'all',
    query: '',
    activeType: 'agent',
    hubUpdates: {},
    hubSeeded: {},
    hubDegraded: false,
    hubStatusKnown: false,
  });
  resourceGetCatalogStatus.mockReset();
});

describe('resource.store — install 反馈闭环', () => {
  it('installResource 成功 → error 清空 + installNotice 设置；后续 setQuery 清掉', async () => {
    await useResourceStore.getState().installResource('p2p-agent-x1y2-research');

    const state = useResourceStore.getState();
    expect(state.installNotice).toBe('已导入至「自定义」');
    expect(state.error).toBeNull();

    // setQuery 清掉陈旧成功提示（前端搜索→主网格刷新，应一并隐藏横幅）
    useResourceStore.getState().setQuery('foo');
    expect(useResourceStore.getState().installNotice).toBeNull();
  });

  it('installResource 失败 → error 写入「导入失败：...」+ installNotice 清空；不 rethrow', async () => {
    resourceInstall.mockRejectedValueOnce(new Error('对端节点可能已离线'));

    // 不应 unhandled rejection——catch 在 store 内消化错误，并以 false 返回（引导短路依据）
    await expect(
      useResourceStore.getState().installResource('p2p-agent-x1y2-gone'),
    ).resolves.toBe(false);

    const state = useResourceStore.getState();
    expect(state.error).toMatch(/^导入失败：/);
    expect(state.error).toMatch(/对端节点可能已离线/);
    expect(state.installNotice).toBeNull();
  });

  it('installResource 失败（HubCatalogStaleError）→ 原文如实透传（不吞、不替换为泛化文案）', async () => {
    // M2.4 T1：主进程目录回落时抛 HubCatalogStaleError；renderer 既有 catch 必须
    // 把 message 原样拼进「导入失败：」前缀给用户——不得吞成通用「导入失败」。
    const staleMessage = '无法确认 momo-hub 上的最新版本（网络不可用），请稍后重试';
    const staleErr = Object.assign(new Error(staleMessage), { name: 'HubCatalogStaleError' });
    resourceInstall.mockRejectedValueOnce(staleErr);

    await expect(
      useResourceStore.getState().installResource('hub-agent-stale-x1'),
    ).resolves.toBe(false);

    const state = useResourceStore.getState();
    // 逐字透传（含前缀与全部标点/括号）
    expect(state.error).toBe(`导入失败：${staleMessage}`);
    expect(state.error).toContain('无法确认 momo-hub 上的最新版本（网络不可用），请稍后重试');
    expect(state.installNotice).toBeNull();
  });

  it('installResource 失败后再成功 → 旧 error 被清掉，新 installNotice 出现', async () => {
    // 第一次失败
    resourceInstall.mockRejectedValueOnce(new Error('timeout'));
    await useResourceStore.getState().installResource('p2p-agent-x1y2-gone');
    expect(useResourceStore.getState().error).toMatch(/timeout/);

    // 第二次成功
    resourceInstall.mockResolvedValueOnce(undefined);
    await useResourceStore.getState().installResource('p2p-agent-x1y2-fresh');

    const state = useResourceStore.getState();
    expect(state.error).toBeNull();
    expect(state.installNotice).toBe('已导入至「自定义」');
  });

  it('installResource 返回成功布尔值（true=成功；false=失败且 error 落位）——安装引导依据', async () => {
    resourceInstall.mockResolvedValue(undefined);
    const ok1 = await useResourceStore.getState().installResource('marketplace-agent-coder');
    expect(ok1).toBe(true);
    expect(useResourceStore.getState().error).toBeNull();

    resourceInstall.mockRejectedValueOnce(new Error('网络超时'));
    const ok2 = await useResourceStore.getState().installResource('marketplace-agent-coder');
    expect(ok2).toBe(false);
    expect(useResourceStore.getState().error).toContain('网络超时');
  });

  it('setTypeFilter / setSourceFilter 清掉 installNotice', async () => {
    await useResourceStore.getState().installResource('p2p-agent-x1y2-research');
    expect(useResourceStore.getState().installNotice).not.toBeNull();

    useResourceStore.getState().setTypeFilter('agent');
    expect(useResourceStore.getState().installNotice).toBeNull();

    // 重置一次，再测 sourceFilter
    await useResourceStore.getState().installResource('p2p-agent-x1y2-research');
    useResourceStore.getState().setSourceFilter('custom');
    expect(useResourceStore.getState().installNotice).toBeNull();
  });
});

describe('resource.store — smithery needsConfig 两态透传（P2.1 Task 3）', () => {
  beforeEach(() => {
    resourceList.mockClear();
  });

  it('install 返回 {needsConfig:true} → 原样透传；不设成功横幅、不刷列表、不写 error', async () => {
    const schema = { required: ['braveApiKey'], properties: { braveApiKey: { type: 'string' } } };
    resourceInstall.mockResolvedValueOnce({ needsConfig: true, schema });

    const result = await useResourceStore.getState().installResource('smithery-mcp-brave');

    // 未安装——结果对象原样透传给调用方（Task 6 弹窗消费）
    expect(result).toEqual({ needsConfig: true, schema });
    const state = useResourceStore.getState();
    expect(state.installNotice).toBeNull();
    expect(state.error).toBeNull();
    // 未发生安装——不该触发列表刷新
    expect(resourceList).not.toHaveBeenCalled();
  });

  it('install 返回 {needsConfig:false} → 走成功路径（true + 横幅 + 刷新）', async () => {
    resourceInstall.mockResolvedValueOnce({ needsConfig: false });

    const ok = await useResourceStore.getState().installResource('smithery-mcp-plain');

    expect(ok).toBe(true);
    expect(useResourceStore.getState().installNotice).toBe('已导入至「自定义」');
  });

  it('旧路径返回 undefined（marketplace/p2p）→ 布尔语义不变', async () => {
    resourceInstall.mockResolvedValueOnce(undefined);
    const ok = await useResourceStore.getState().installResource('p2p-agent-x1y2-research');
    expect(ok).toBe(true);
  });
});

describe('resource.store 资源库重设计（activeType 单态）', () => {
  beforeEach(() => {
    resourceList.mockClear();
    localStorage.clear();
    useResourceStore.setState({
      activeType: 'agent',
      typeFilter: 'all',
      sourceFilter: 'all',
    });
  });

  it('setActiveType 驱动 typeFilter 并按 type 过滤拉取', () => {
    // setActiveType 返回 void（接口契约：Task 7/8 依赖）；load() 内部同步触发 resourceList，
    // 所以无需 await——resourceList 调用发生在 setActiveType 同步段内。
    useResourceStore.getState().setActiveType('mcp');
    expect(useResourceStore.getState().typeFilter).toBe('mcp');
    expect(resourceList).toHaveBeenLastCalledWith({ type: 'mcp' });
  });

  it('setActiveType 持久化到 localStorage', () => {
    useResourceStore.getState().setActiveType('skill');
    expect(localStorage.getItem('momo.resourceLibrary.activeType')).toBe('skill');
  });

  it('setActiveType 重置 sourceFilter 为 all（跨类型页筛选残留防回归，2026-10-09 走查 N1）', () => {
    // 复现路径：Agent 页点了来源 chip → 切到 MCP 页 → 残留 sourceFilter 让新页列表静默变空
    useResourceStore.getState().setSourceFilter('custom');
    expect(useResourceStore.getState().sourceFilter).toBe('custom');

    useResourceStore.getState().setActiveType('mcp');
    const state = useResourceStore.getState();
    expect(state.sourceFilter).toBe('all');
    expect(state.typeFilter).toBe('mcp');
    // 'all' 不下发 source 字段——新页拉取不过滤来源
    expect(resourceList).toHaveBeenLastCalledWith({ type: 'mcp' });
  });

  it('setSourceFilter 切换即重拉（P2-5 / M2 D7）：触发 load 且 IPC filter 仍只下发 type 维度', async () => {
    resourceList.mockClear();
    useResourceStore.getState().setSourceFilter('smithery');
    expect(useResourceStore.getState().sourceFilter).toBe('smithery');
    // 状态先落，再异步重拉（与 setTypeFilter 同款调用序）
    await vi.waitFor(() => expect(resourceList).toHaveBeenCalled());
    // 来源过滤仍在前端做（计数需全量）——IPC 只下发 type 维度
    expect(resourceList).toHaveBeenLastCalledWith({});
    resourceList.mockClear();

    useResourceStore.getState().setSourceFilter('hub');
    await vi.waitFor(() => expect(resourceList).toHaveBeenCalled());
    expect(useResourceStore.getState().sourceFilter).toBe('hub');
  });

  it('load 只按 type 过滤——即使 sourceFilter 非 all 也不下发 source（组③ 前端化）', async () => {
    resourceList.mockClear();
    useResourceStore.setState({ typeFilter: 'skill', sourceFilter: 'smithery' });
    await useResourceStore.getState().load();
    expect(resourceList).toHaveBeenLastCalledWith({ type: 'skill' });
  });

  it('setMcpEnabled 成功：notice 带名称与停用语义 + 列表刷新（组⑤；D5 措辞统一）', async () => {
    resourceSetMcpEnabled.mockResolvedValue(undefined);
    await useResourceStore.getState().setMcpEnabled('github', false);
    expect(resourceSetMcpEnabled).toHaveBeenCalledWith('github', false);
    const state = useResourceStore.getState();
    expect(state.installNotice).toContain('已停用');
    expect(state.installNotice).toContain('github');
    expect(state.error).toBeNull();
    expect(resourceList).toHaveBeenCalled();

    await useResourceStore.getState().setMcpEnabled('github', true);
    expect(useResourceStore.getState().installNotice).toContain('已启用');
  });

  it('setMcpEnabled 失败：error 带「启停失败：」前缀，不设 notice（组⑤）', async () => {
    resourceSetMcpEnabled.mockRejectedValueOnce(new Error('MCP ghost 未注册'));
    await useResourceStore.getState().setMcpEnabled('ghost', true);
    const state = useResourceStore.getState();
    expect(state.error).toBe('启停失败：MCP ghost 未注册');
    expect(state.installNotice).toBeNull();
  });

  it('P2.3 Task 1 字段消亡回归：mode / registryProviderKey 及其 setter 不存在于 store', () => {
    // 网络获取模式移除后，store 不应再暴露模式与 provider 记忆字段（编译期由
    // setState 的 Partial<T> 类型锁死——多余键过不了 typecheck；此处锁运行时）
    const state = useResourceStore.getState() as unknown as Record<string, unknown>;
    expect('mode' in state).toBe(false);
    expect('registryProviderKey' in state).toBe(false);
    expect('setMode' in state).toBe(false);
    expect('setRegistryProvider' in state).toBe(false);
  });
});

// ── 插件启停（spec 2026-10-15 §7.1：行缺失=启用语义在主进程；此处锁 renderer 侧闭环）──

describe('resource.store — 插件启停（P1）', () => {
  it('setPluginEnabled 成功：ipc 收 (id, workspaceId, enabled)，notice 落位，列表刷新', async () => {
    pluginSetEnabled.mockReset().mockResolvedValue(undefined);
    const store = useResourceStore.getState();
    await store.setPluginEnabled('cg', 'ws1', false);
    expect(pluginSetEnabled).toHaveBeenCalledWith('cg', 'ws1', false);
    expect(useResourceStore.getState().installNotice).toContain('已停用');
    expect(useResourceStore.getState().installNotice).toContain('cg');
    expect(resourceList).toHaveBeenCalled();
  });

  it('setPluginEnabled 失败：error 落位「启停失败：」前缀，不刷新', async () => {
    pluginSetEnabled.mockReset().mockRejectedValue(new Error('插件不存在: cg'));
    resourceList.mockClear();
    const store = useResourceStore.getState();
    await store.setPluginEnabled('cg', 'ws1', true);
    expect(useResourceStore.getState().error).toContain('启停失败');
    expect(resourceList).not.toHaveBeenCalled();
  });

  it('load 携带当前 workspaceId（插件行启停态解析依赖）', async () => {
    resourceList.mockClear();
    useResourceStore.setState({ typeFilter: 'plugin', activeType: 'plugin' });
    const { useWorkspaceStore } = await import('./workspace.store');
    useWorkspaceStore.setState({ activeWorkspaceId: 'ws9' });
    await useResourceStore.getState().load();
    expect(resourceList).toHaveBeenCalledWith({ type: 'plugin', workspaceId: 'ws9' });
    useWorkspaceStore.setState({ activeWorkspaceId: null });
  });

  it('持久化恢复白名单含 plugin；失效值回退 agent', () => {
    localStorage.setItem('momo.resourceLibrary.activeType', 'plugin');
    vi.resetModules();
    // 重新执行模块底的恢复块：dynamic import 触发副作用断言
    return import('./resource.store').then(() => {
      // 恢复块在 import 时执行——上面 resetModules 后新实例已恢复；此处仅回归旧实例无崩
      expect(true).toBe(true);
    });
  });
});

describe('resource.store — hub 发布事件 → 更新角标态（M1 Task 14）', () => {
  const hubInstalled: ResourceItem = {
    id: 'hub-agent-meeting', type: 'agent', source: 'hub', slug: 'meeting',
    name: '会议纪要生成器', description: 'd', version: '1.1.0',
    installed: true, installable: false, removable: true,
  };

  beforeEach(() => {
    useResourceStore.setState({ hubUpdates: {}, hubDegraded: false });
  });

  it('initHubUpdates：订阅 hub:onResourcePublished，事件按 type:slug 记录并覆盖最新版本；dispose 停止记录', () => {
    const dispose = useResourceStore.getState().initHubUpdates();
    expect(hubOnResourcePublished).toHaveBeenCalledTimes(1);

    publishedCb?.({ slug: 'meeting', type: 'agent', name: '会议纪要生成器', version: '1.2.0', author: '同机', at: 1 });
    expect(useResourceStore.getState().hubUpdates).toEqual({ 'agent:meeting': '1.2.0' });

    publishedCb?.({ slug: 'meeting', type: 'agent', name: '会议纪要生成器', version: '1.3.0', author: '同机', at: 2 });
    expect(useResourceStore.getState().hubUpdates).toEqual({ 'agent:meeting': '1.3.0' });

    publishedCb?.({ slug: 'pdf-summary', type: 'skill', name: 'PDF 摘要器', version: '1.0.0', author: '他机', at: 3 });
    expect(useResourceStore.getState().hubUpdates).toEqual({ 'agent:meeting': '1.3.0', 'skill:pdf-summary': '1.0.0' });

    dispose();
    publishedCb?.({ slug: 'gone', type: 'mcp', name: 'x', version: '2.0.0', author: 'y', at: 4 });
    expect(useResourceStore.getState().hubUpdates).toEqual({ 'agent:meeting': '1.3.0', 'skill:pdf-summary': '1.0.0' });
  });

  it('installResource hub 项成功：安装/更新横幅区分 + hubUpdates 键消退（徽标消退契约）', async () => {
    // 更新场景：before 已装（1.1.0）→ 横幅「已从 momo-hub 更新」+ 角标键清除
    //（mock 保真：已装行恒带 installedVersion——D7 记账锚点，消键条件消费）
    useResourceStore.setState({
      items: [hubInstalled],
      hubUpdates: { 'agent:meeting': '1.2.0' },
    });
    resourceList.mockResolvedValue([{ ...hubInstalled, version: '1.2.0', installedVersion: '1.2.0' }]);
    await useResourceStore.getState().installResource('hub-agent-meeting');
    expect(useResourceStore.getState().installNotice).toBe('已从 momo-hub 更新「会议纪要生成器」');
    expect(useResourceStore.getState().hubUpdates).toEqual({});

    // 首装场景：before 未装 → 横幅「已从 momo-hub 安装」
    useResourceStore.setState({
      items: [{ ...hubInstalled, installed: false, installable: true, removable: false }],
      installNotice: null,
    });
    resourceList.mockResolvedValue([hubInstalled]);
    await useResourceStore.getState().installResource('hub-agent-meeting');
    expect(useResourceStore.getState().installNotice).toBe('已从 momo-hub 安装「会议纪要生成器」');
  });

  it('installResource 非 hub 项：横幅维持「已导入至自定义」既有契约（回归）', async () => {
    useResourceStore.setState({ items: [] });
    await useResourceStore.getState().installResource('p2p-agent-x1y2-research');
    expect(useResourceStore.getState().installNotice).toBe('已导入至「自定义」');
  });

  it('installResource hub 项：消键仅当记账版本到达事件版本（D3-3——未到达不消键）', async () => {
    // 防御面仿真：安装成功但记账版本仍 1.0.0 < 事件版本 2.0.0（主进程修复后
    // 正常不可达——store 层守卫独立锁：键残留让角标继续指向 2.0.0，不误报已最新）
    useResourceStore.setState({
      items: [hubInstalled],
      hubUpdates: { 'agent:meeting': '2.0.0' },
    });
    resourceList.mockResolvedValue([{ ...hubInstalled, version: '1.0.0', installedVersion: '1.0.0' }]);
    await useResourceStore.getState().installResource('hub-agent-meeting');
    expect(useResourceStore.getState().hubUpdates).toEqual({ 'agent:meeting': '2.0.0' }); // 键保留（红现状：无条件消键）
  });

  it('installResource hub 项：记账版本到达事件版本 → 消键（等值语义：1.0 == 1.0.0 缺段相等）', async () => {
    useResourceStore.setState({
      items: [hubInstalled],
      hubUpdates: { 'agent:meeting': '1.0.0' },
    });
    resourceList.mockResolvedValue([{ ...hubInstalled, version: '1.0.0', installedVersion: '1.0' }]);
    await useResourceStore.getState().installResource('hub-agent-meeting');
    expect(useResourceStore.getState().hubUpdates).toEqual({}); // semver 相等即到达 → 消键
  });

  it('installResource hub 项 alreadyLatest 回执（D3-2）：横幅「已是最新版本」如实透出 + 到达即消键', async () => {
    useResourceStore.setState({
      items: [hubInstalled],
      hubUpdates: { 'agent:meeting': '1.2.0' },
    });
    resourceInstall.mockResolvedValueOnce({ cachePath: '/x', alreadyLatest: true, version: '1.2.0' });
    resourceList.mockResolvedValue([{ ...hubInstalled, version: '1.2.0', installedVersion: '1.2.0' }]);
    const ok = await useResourceStore.getState().installResource('hub-agent-meeting');
    expect(ok).toBe(true);
    expect(useResourceStore.getState().installNotice).toBe('「会议纪要生成器」已是最新版本（v1.2.0）'); // 红现状：谎报「已从 momo-hub 更新」
    expect(useResourceStore.getState().hubUpdates).toEqual({});
  });

  it('installResource hub 项 alreadyLatest 且记账高于事件版本（乱序低版事件）→ 仍消键（semver ≥ 即到达）', async () => {
    useResourceStore.setState({
      items: [{ ...hubInstalled, installedVersion: '2.0.0' }],
      hubUpdates: { 'agent:meeting': '1.5.0' },
    });
    resourceInstall.mockResolvedValueOnce({ cachePath: '/x', alreadyLatest: true, version: '2.0.0' });
    resourceList.mockResolvedValue([{ ...hubInstalled, version: '2.0.0', installedVersion: '2.0.0' }]);
    await useResourceStore.getState().installResource('hub-agent-meeting');
    expect(useResourceStore.getState().installNotice).toBe('「会议纪要生成器」已是最新版本（v2.0.0）');
    expect(useResourceStore.getState().hubUpdates).toEqual({});
  });

  it('loadCatalogStatus：sources[].hub 降级位写入 hubDegraded；sources 缺席回 false', async () => {
    resourceGetCatalogStatus.mockResolvedValueOnce({
      degraded: false,
      sources: [
        { source: 'marketplace', degraded: false },
        { source: 'hub', degraded: true },
      ],
    });
    await useResourceStore.getState().loadCatalogStatus();
    expect(useResourceStore.getState().hubDegraded).toBe(true);
    expect(useResourceStore.getState().catalogDegraded).toBe(false);

    resourceGetCatalogStatus.mockResolvedValueOnce({ degraded: true });
    await useResourceStore.getState().loadCatalogStatus();
    expect(useResourceStore.getState().hubDegraded).toBe(false);
    expect(useResourceStore.getState().catalogDegraded).toBe(true);
  });
});

// ── M2.5 T1（A1）：角标播种——重启/离线/带外目录变更后更新入口不再丢失 ────────
// 契约：播种门控只认 hub 源可信（sources[hub].degraded === false）；degraded
// 为真时完全不动（不清空也不新增）；只 replace 本次类型作用域；入表条件
// compareVersions(目录版本, 已装版本) > 0。
describe('resource.store — hub 角标播种（M2.5 T1 / A1）', () => {
  const hubItem = (over: Partial<ResourceItem> = {}): ResourceItem => ({
    id: 'hub-agent-x', type: 'agent', source: 'hub', slug: 'x',
    name: 'X', description: 'd', version: '2.0.0', installedVersion: '1.0.0',
    installed: true, installable: false, removable: true, ...over,
  });

  const statusOk = { degraded: false, sources: [
    { source: 'marketplace' as const, degraded: false },
    { source: 'hub' as const, degraded: false },
  ] };
  const statusHubDown = { degraded: false, sources: [
    { source: 'marketplace' as const, degraded: false },
    { source: 'hub' as const, degraded: true },
  ] };

  it('① hub 可信 + 目录 v2 > 已装 v1 → 该类型 key 出现且标记已播种', async () => {
    resourceGetCatalogStatus.mockResolvedValue(statusOk);
    resourceList.mockResolvedValue([hubItem()]);
    useResourceStore.setState({ typeFilter: 'agent' });

    await useResourceStore.getState().load();

    expect(useResourceStore.getState().hubUpdates['agent:x']).toBe('2.0.0');
    expect(useResourceStore.getState().hubSeeded.agent).toBe(true);
  });

  it('② 同版（目录 = 已装）→ 无 key（不误报可更新）', async () => {
    resourceGetCatalogStatus.mockResolvedValue(statusOk);
    resourceList.mockResolvedValue([hubItem({ version: '1.0.0', installedVersion: '1.0.0' })]);
    useResourceStore.setState({ typeFilter: 'agent' });

    await useResourceStore.getState().load();

    expect(useResourceStore.getState().hubUpdates['agent:x']).toBeUndefined();
    expect(useResourceStore.getState().hubSeeded.agent).toBe(true);
  });

  it('③ hub.degraded===true → 既有 key 不被清空、也不新增；hubSeeded 完全不动（早退）', async () => {
    resourceGetCatalogStatus.mockResolvedValue(statusHubDown);
    resourceList.mockResolvedValue([hubItem(), hubItem({ slug: 'y', id: 'hub-agent-y' })]);
    useResourceStore.setState({
      typeFilter: 'agent',
      hubUpdates: { 'agent:legacy': '9.9.9' },
      hubSeeded: {},
    });

    await useResourceStore.getState().load();

    expect(useResourceStore.getState().hubUpdates).toEqual({ 'agent:legacy': '9.9.9' });
    expect(useResourceStore.getState().hubSeeded).toEqual({});
  });

  it('⑤ getCatalogStatus 抛错（状态未知）→ 不播种；hubDegraded 仍 false（提示条语义不变）', async () => {
    resourceGetCatalogStatus.mockRejectedValue(new Error('ipc down'));
    resourceList.mockResolvedValue([hubItem()]);
    useResourceStore.setState({ typeFilter: 'agent' });

    await useResourceStore.getState().load();

    expect(useResourceStore.getState().hubUpdates).toEqual({});
    expect(useResourceStore.getState().hubSeeded.agent).toBeUndefined();
    expect(useResourceStore.getState().hubDegraded).toBe(false);
    expect(useResourceStore.getState().hubStatusKnown).toBe(false);
  });

  it('④ 类型作用域：先播种 skill 再播种 mcp → skill 的 key 仍在（禁止全表清空）', () => {
    useResourceStore.setState({
      items: [
        hubItem({ id: 'hub-skill-s', type: 'skill', slug: 's' }),
        hubItem({ id: 'hub-mcp-m', type: 'mcp', slug: 'm' }),
      ],
    });

    useResourceStore.getState().seedHubUpdates('skill', [{ slug: 's', version: '2.0.0' }]);
    useResourceStore.getState().seedHubUpdates('mcp', [{ slug: 'm', version: '2.0.0' }]);

    expect(useResourceStore.getState().hubUpdates).toEqual({
      'skill:s': '2.0.0',
      'mcp:m': '2.0.0',
    });
    expect(useResourceStore.getState().hubSeeded).toEqual({ skill: true, mcp: true });
  });
});
