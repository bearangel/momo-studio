// renderer/src/services/registry/marketplace-catalog-provider.test.ts
//
// marketplaceCatalogProvider 单测（spec §3 网络获取模式）：
//   - type + source=marketplace 透传 ipc.resource.list
//   - 前端模糊过滤（name/description/slug）
//   - 未安装项排在已安装项之前（浏览目标优先）
//   - 错误原样透传（错误态由 RegistryBrowse 渲染）
//
// mock 方式遵循 resource.store.test.ts 既有形态：不 vi.mock ipc/client 模块，
// 而是把 mock 装到 globalThis.window.api——ipc.client 是真实 Proxy，测试走真通道
// （momo-test-rules：mock 收窄到 IPC 边界 + 仿真真实运行时语义，且免疫 vi.mock 提升时序问题）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { marketplaceCatalogProvider } from './marketplace-catalog-provider';
import type { ResourceItem } from '../../ipc/types';

const resourceList = vi.fn();

const mockApi = {
  resource: {
    list: resourceList,
  },
};

function mkItem(over: Partial<ResourceItem>): ResourceItem {
  return {
    id: 'marketplace-agent-x', type: 'agent', source: 'marketplace', slug: 'x',
    name: 'X', description: 'desc', installed: false, installable: true, removable: false,
    marketplace: {
      author: 'a', readme: '', downloadUrl: '', checksum: '',
      verificationStatus: 'community', tags: ['t1'], category: 'c',
    },
    ...over,
  } as ResourceItem;
}

describe('marketplaceCatalogProvider', () => {
  beforeEach(() => {
    resourceList.mockReset();
    resourceList.mockResolvedValue([] as ResourceItem[]);
    (globalThis as unknown as { window: { api: typeof mockApi } }).window = { api: mockApi };
  });

  it('按 type + source=marketplace 拉取并映射 RegistryEntry', async () => {
    resourceList.mockResolvedValue([mkItem({})]);
    const out = await marketplaceCatalogProvider.list('agent');
    expect(resourceList).toHaveBeenCalledWith({ type: 'agent', source: 'marketplace' });
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ id: 'marketplace-agent-x', name: 'X', tags: ['t1'] });
  });

  it('query 前端模糊过滤（name/description/slug）', async () => {
    resourceList.mockResolvedValue([
      mkItem({ name: 'coder', slug: 'coder' }),
      mkItem({ name: 'writer', description: '写作' }),
    ]);
    const out = await marketplaceCatalogProvider.list('agent', 'cod');
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe('coder');
  });

  it('未安装项排在已安装项之前', async () => {
    resourceList.mockResolvedValue([
      mkItem({ id: 'a1', slug: 'installed-one', installed: true }),
      mkItem({ id: 'a2', slug: 'fresh', installed: false }),
    ]);
    const out = await marketplaceCatalogProvider.list('agent');
    expect(out[0]!.id).toBe('a2');
  });

  it('Provider 抛错原样透传（错误态由 RegistryBrowse 渲染）', async () => {
    resourceList.mockRejectedValue(new Error('catalog 加载失败'));
    await expect(marketplaceCatalogProvider.list('agent')).rejects.toThrow('catalog 加载失败');
  });
});
