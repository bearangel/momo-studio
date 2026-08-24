// electron/tests/resource/library.test.ts
//
// v1.7 Task 4：listResources / resolveResourceById 主入口测试。
// 覆盖：
//   - 合并四源（builtin + marketplace + custom + p2p——P4 Task 4 追加）
//   - filter.type 按类型过滤
//   - filter.source 按来源过滤
//   - filter.source='custom' 短路 fetchCatalog（不发起远程请求）
//   - fetchCatalog 失败时 builtin+marketplace 返回空，但 custom 仍工作
//   - resolveResourceById 合法 id 反查
//   - resolveResourceById 非法 id 返回 null
//   - p2p 源合并（P4 Task 4）：远端目录条目映射 ResourceItem（id 前缀防多节点碰撞 +
//     p2p namespace + installed/installable/removable 三态）+ filter.source='p2p' 短路 +
//     多节点同名 slug id 不碰撞
//
// 隔离：vi.mock 替换 fetchCatalog / listCustomResources / installer.listInstalled /
// p2p.resource-share.getSharedResources，避免真实 HTTP + DB + fs 依赖。

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// mock p2p 资源目录缓存（P4 Task 4——p2p 第四源数据入口；默认空）
const { p2pShareMocks } = vi.hoisted(() => ({
  p2pShareMocks: {
    getSharedResources: vi.fn(),
  },
}));
vi.mock('../../src/main/p2p/resource-share', () => p2pShareMocks);

beforeEach(() => {
  p2pShareMocks.getSharedResources.mockReset();
  p2pShareMocks.getSharedResources.mockReturnValue([]);
});

describe('listResources', () => {
  it('合并四源：builtin + marketplace + custom + p2p', async () => {
    p2pShareMocks.getSharedResources.mockReturnValueOnce([
      {
        nodeId: 'a1b2c3d4e5f6',
        nodeName: '对端A',
        items: [{ type: 'agent', slug: 'helper', name: '助手', description: '远端 agent' }],
        takenAt: 1,
      },
    ]);
    const items = await listResources();
    expect(items).toHaveLength(4);  // 1 builtin + 1 marketplace + 1 custom + 1 p2p
    expect(items.map((i) => i.source).sort()).toEqual(['builtin', 'custom', 'marketplace', 'p2p']);
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

describe('listResources p2p 源合并（P4 Task 4）', () => {
  it('p2p 条目映射：id 带节点前缀 + 三态 installed/installable/removable + p2p namespace', async () => {
    p2pShareMocks.getSharedResources.mockReturnValueOnce([
      {
        nodeId: 'a1b2c3d4e5f6',
        nodeName: '对端A',
        items: [
          { type: 'agent', slug: 'helper', name: '助手', description: '远端 agent', version: '1.2.0' },
          { type: 'mcp', slug: 'weather', name: 'weather', description: '远端 mcp' },
        ],
        takenAt: 1,
      },
    ]);

    const items = await listResources({ source: 'p2p' });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: 'p2p-agent-a1b2c3d4-helper',
      type: 'agent',
      source: 'p2p',
      slug: 'helper',
      name: '助手',
      description: '远端 agent',
      version: '1.2.0',
      installed: false,
      installable: true,
      removable: false,
      p2p: { peerId: 'a1b2c3d4e5f6', peerName: '对端A' },
    });
    expect(items[1]).toMatchObject({ id: 'p2p-mcp-a1b2c3d4-weather' });
    // 远端条目无 version 时字段缺省（不伪造 '1.0.0'）
    expect(items[1]!.version).toBeUndefined();
  });

  it('filter.source=p2p 短路 fetchCatalog（不发起远程请求）', async () => {
    p2pShareMocks.getSharedResources.mockReturnValueOnce([]);
    const { fetchCatalog } = await import('../../src/main/marketplace/client');
    (fetchCatalog as ReturnType<typeof vi.fn>).mockClear();

    const items = await listResources({ source: 'p2p' });

    expect(fetchCatalog).not.toHaveBeenCalled();
    expect(items).toHaveLength(0);
  });

  it('多节点同名 slug：id 以 nodeId 前 8 字符区分，不碰撞', async () => {
    p2pShareMocks.getSharedResources.mockReturnValueOnce([
      {
        nodeId: 'a1b2c3d4e5f6',
        nodeName: '节点A',
        items: [{ type: 'mcp', slug: 'github', name: 'github', description: 'd' }],
        takenAt: 1,
      },
      {
        nodeId: 'zzzz9999aaaa',
        nodeName: '节点B',
        items: [{ type: 'mcp', slug: 'github', name: 'github', description: 'd' }],
        takenAt: 2,
      },
    ]);

    const items = await listResources({ source: 'p2p' });

    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
    expect(items.map((i) => i.id).sort()).toEqual([
      'p2p-mcp-a1b2c3d4-github',
      'p2p-mcp-zzzz9999-github',
    ]);
    expect(items.map((i) => i.p2p?.peerName).sort()).toEqual(['节点A', '节点B']);
  });

  it('filter.type 与 p2p 源 AND 过滤（只留 agent）', async () => {
    p2pShareMocks.getSharedResources.mockReturnValueOnce([
      {
        nodeId: 'a1b2c3d4e5f6',
        nodeName: '对端A',
        items: [
          { type: 'agent', slug: 'helper', name: '助手', description: 'd' },
          { type: 'mcp', slug: 'weather', name: 'weather', description: 'd' },
        ],
        takenAt: 1,
      },
    ]);

    const items = await listResources({ type: 'agent', source: 'p2p' });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'p2p-agent-a1b2c3d4-helper' });
  });
});
