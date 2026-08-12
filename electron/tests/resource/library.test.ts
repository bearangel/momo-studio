// electron/tests/resource/library.test.ts
//
// v1.7 Task 4：listResources / resolveResourceById 主入口测试。
// 覆盖：
//   - 合并三源（builtin + marketplace + custom）
//   - filter.type 按类型过滤
//   - filter.source 按来源过滤
//   - filter.source='custom' 短路 fetchCatalog（不发起远程请求）
//   - fetchCatalog 失败时 builtin+marketplace 返回空，但 custom 仍工作
//   - resolveResourceById 合法 id 反查
//   - resolveResourceById 非法 id 返回 null
//
// 隔离：vi.mock 替换 fetchCatalog / listCustomResources / installer.listInstalled，
// 避免真实 HTTP + DB + fs 依赖。

import { describe, it, expect, vi } from 'vitest';
import { listResources, resolveResourceById } from '../../src/main/resource/library';

const mockCatalog = {
  version: '1.0', updatedAt: '2026-08-11',
  items: [
    { id: 'builtin-1', type: 'agent', slug: 'pm', name: 'PM', version: '1',
      author: 'Momo', description: 'd', readme: 'r', tags: [], category: 'c',
      iconEmoji: '👔', verificationStatus: 'official', downloadUrl: '', checksum: '', sizeBytes: 0, installCount: 0 },
    { id: 'marketplace-1', type: 'skill', slug: 'remote', name: 'Remote', version: '1',
      author: '@x', description: 'd', readme: 'r', tags: [], category: 'c',
      iconEmoji: '📦', verificationStatus: 'community', downloadUrl: 'http://x', checksum: 'x', sizeBytes: 0, installCount: 0 },
  ],
};

vi.mock('../../src/main/marketplace/client', () => ({
  fetchCatalog: vi.fn(async () => mockCatalog),
}));

vi.mock('../../src/main/resource/custom', () => ({
  listCustomResources: vi.fn(() => [
    { id: 'custom-mcp-github', type: 'mcp', source: 'custom', slug: 'github',
      name: 'github', description: 'd', installed: true, installable: false, removable: true,
      custom: { installedAt: '2026-08-11' } },
  ]),
}));

// mock marketplace/installer.listInstalled（catalog-adapter 用到）
vi.mock('../../src/main/marketplace/installer', () => ({
  listInstalled: vi.fn(() => []),
  installPackage: vi.fn(),
  uninstallPackage: vi.fn(),
}));

describe('listResources', () => {
  it('合并三源：builtin + marketplace + custom', async () => {
    const items = await listResources();
    expect(items).toHaveLength(3);  // 1 builtin + 1 marketplace + 1 custom
    expect(items.map((i) => i.source).sort()).toEqual(['builtin', 'custom', 'marketplace']);
  });

  it('filter.type 只返回对应类型', async () => {
    const skills = await listResources({ type: 'skill' });
    expect(skills.every((i) => i.type === 'skill')).toBe(true);
  });

  it('filter.source 只返回对应来源', async () => {
    const custom = await listResources({ source: 'custom' });
    expect(custom.every((i) => i.source === 'custom')).toBe(true);
    expect(custom).toHaveLength(1);
  });

  it('filter.source=builtin 不触发 fetchCatalog（短路 Promise.resolve([])）', async () => {
    const { fetchCatalog } = await import('../../src/main/marketplace/client');
    (fetchCatalog as ReturnType<typeof vi.fn>).mockClear();
    await listResources({ source: 'custom' });
    expect(fetchCatalog).not.toHaveBeenCalled();  // 不需要 catalog
  });

  it('fetchCatalog 失败时 builtin+marketplace 返回空，但 custom 仍工作', async () => {
    const { fetchCatalog } = await import('../../src/main/marketplace/client');
    (fetchCatalog as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network'));
    const items = await listResources();
    expect(items).toHaveLength(1);  // 只有 custom
    expect(items[0]!.source).toBe('custom');
  });
});

describe('resolveResourceById', () => {
  it('合法 id 返回对应 ResourceItem', async () => {
    const item = await resolveResourceById('custom-mcp-github');
    expect(item?.slug).toBe('github');
  });

  it('非法 id 返回 null', async () => {
    const item = await resolveResourceById('invalid');
    expect(item).toBeNull();
  });
});
