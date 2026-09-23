// renderer/src/stores/resource.store.test.ts
//
// 资源库 store 行为契约测试（终审 v2.0.0-p4）：
//   - installResource 成功：error 清空 + installNotice 设值；后续 load 完成后 installNotice 仍在
//     （load 不应清掉成功提示——用户需要看到反馈）
//   - installResource 失败：error 写入「导入失败：...」前缀，installNotice 清空；
//     store 不 rethrow（避免 p2p 离线/未找到/超时 unhandled rejection）
//   - installNotice 在 filter 切换 / setQuery 时清掉（防止陈旧成功提示残留）
//   - registryProviderKey（Task 6）：setRegistryProvider 更新 + 持久化（写失败静默）；
//     启动恢复合法值 / 非法值回退 builtin（模块尾恢复块，vi.resetModules + 动态 import 锁）
//
// 注：view 层的端到端测试见 ResourceLibraryView.test.tsx；本文件锁 store 层契约。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useResourceStore } from './resource.store';
import type { ResourceItem } from '../ipc/types';

const resourceList = vi.fn();
const resourceInstall = vi.fn();

const mockApi = {
  resource: {
    list: resourceList,
    install: resourceInstall,
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
    mode: 'installed',
  });
});

describe('resource.store — install 反馈闭环', () => {
  it('installResource 成功 → error 清空 + installNotice 设置；后续 setQuery 清掉', async () => {
    await useResourceStore.getState().installResource('p2p-agent-x1y2-research');

    const state = useResourceStore.getState();
    expect(state.installNotice).toBe('已导入至「我的上传」');
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
    expect(state.installNotice).toBe('已导入至「我的上传」');
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
    expect(useResourceStore.getState().installNotice).toBe('已导入至「我的上传」');
  });

  it('旧路径返回 undefined（marketplace/p2p）→ 布尔语义不变', async () => {
    resourceInstall.mockResolvedValueOnce(undefined);
    const ok = await useResourceStore.getState().installResource('p2p-agent-x1y2-research');
    expect(ok).toBe(true);
  });
});

describe('resource.store 资源库重设计（activeType + mode）', () => {
  beforeEach(() => {
    resourceList.mockClear();
    localStorage.clear();
    useResourceStore.setState({
      activeType: 'agent',
      mode: 'installed',
      typeFilter: 'all',
      sourceFilter: 'all',
    });
  });

  it('setActiveType 驱动 typeFilter 并按 type 过滤拉取', () => {
    // setActiveType 返回 void（接口契约：Task 7/8 依赖）；load() 内部同步触发 resourceList，
    // 所以无需 await——resourceList 调用发生在 setActiveType 同步段内。
    useResourceStore.getState().setActiveType('mcp');
    expect(useResourceStore.getState().typeFilter).toBe('mcp');
    expect(useResourceStore.getState().mode).toBe('installed');
    expect(resourceList).toHaveBeenLastCalledWith({ type: 'mcp' });
  });

  it('setActiveType 持久化到 localStorage', () => {
    useResourceStore.getState().setActiveType('skill');
    expect(localStorage.getItem('momo.resourceLibrary.activeType')).toBe('skill');
  });

  it('setMode 切换 registry 模式且不动列表数据', () => {
    useResourceStore.setState({ items: [{ id: 'x' } as never] });
    useResourceStore.getState().setMode('registry');
    expect(useResourceStore.getState().mode).toBe('registry');
    expect(useResourceStore.getState().items.length).toBe(1);
  });
});

describe('resource.store — registryProviderKey 记忆（Task 6）', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('setRegistryProvider 更新状态并持久化 localStorage', async () => {
    const { useResourceStore: fresh } = await import('./resource.store');
    fresh.getState().setRegistryProvider('smithery');
    expect(fresh.getState().registryProviderKey).toBe('smithery');
    expect(localStorage.getItem('momo.resourceLibrary.providerKey')).toBe('smithery');
  });

  it('持久化写失败静默（隐私模式等场景不影响内存状态）', async () => {
    const { useResourceStore: fresh } = await import('./resource.store');
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => fresh.getState().setRegistryProvider('smithery')).not.toThrow();
    expect(fresh.getState().registryProviderKey).toBe('smithery');
    spy.mockRestore();
  });

  it('启动恢复：localStorage 记忆 smithery → 模块加载即恢复', async () => {
    localStorage.setItem('momo.resourceLibrary.providerKey', 'smithery');
    const { useResourceStore: fresh } = await import('./resource.store');
    expect(fresh.getState().registryProviderKey).toBe('smithery');
  });

  it('启动恢复：非法值回退 builtin', async () => {
    localStorage.setItem('momo.resourceLibrary.providerKey', 'mcphub');
    const { useResourceStore: fresh } = await import('./resource.store');
    expect(fresh.getState().registryProviderKey).toBe('builtin');
  });

  it('启动恢复：P2.1 移除的 modelscope 记忆回退 builtin（存量迁移）', async () => {
    localStorage.setItem('momo.resourceLibrary.providerKey', 'modelscope');
    const { useResourceStore: fresh } = await import('./resource.store');
    expect(fresh.getState().registryProviderKey).toBe('builtin');
  });
});
