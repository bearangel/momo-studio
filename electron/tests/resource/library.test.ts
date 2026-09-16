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

// mock skill zip-uploader（v2.11：library 直接消费其 listInstalled 的 builtin 分支——
// 本地预置 skill 并入 builtin 源；fixture 含与 marketplace 同 slug 的条目锁去重语义）
const { skillZipMocks } = vi.hoisted(() => ({
  skillZipMocks: {
    listInstalled: vi.fn(),
  },
}));
vi.mock('../../src/main/skill/zip-uploader', () => skillZipMocks);

beforeEach(() => {
  p2pShareMocks.getSharedResources.mockReset();
  p2pShareMocks.getSharedResources.mockReturnValue([]);
  skillZipMocks.listInstalled.mockReset();
  skillZipMocks.listInstalled.mockReturnValue([
    { slug: 'code-review', name: '代码审查', description: '预置审查技能', source: 'builtin', installedAt: null },
    { slug: 'remote', name: '重复条目', description: '与 marketplace 同 slug', source: 'builtin', installedAt: null },
    { slug: 'my-upload', name: '我的上传', description: 'custom 源应被忽略', source: 'custom', installedAt: '2026-09-16' },
  ]);
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
    // 5 项 = 1 catalog builtin(agent) + 1 marketplace(skill) + 1 本地预置 builtin(skill)
    //       + 1 custom(mcp) + 1 p2p(agent)——本地预置并入 builtin 源（v2.11）
    expect(items).toHaveLength(5);
    expect(items.map((i) => i.source).sort()).toEqual(['builtin', 'builtin', 'custom', 'marketplace', 'p2p']);
  });

  it('本地预置 skill 并入 builtin 源（catalog 优先去重，custom 源条目忽略）', async () => {
    const skills = await listResources({ type: 'skill' });
    // code-review（本地预置）出现在 builtin 源，四态正确
    const local = skills.find((i) => i.slug === 'code-review');
    expect(local).toBeDefined();
    expect(local).toMatchObject({
      id: 'builtin-skill-code-review',
      type: 'skill',
      source: 'builtin',
      installed: true,
      installable: false,
      removable: false,
      name: '代码审查',
    });
    // slug='remote' 与 marketplace 同名——catalog 优先，本地条目丢弃，不重复
    const remotes = skills.filter((i) => i.slug === 'remote');
    expect(remotes).toHaveLength(1);
    expect(remotes[0]!.source).toBe('marketplace');
    // listInstalled 的 custom 源条目不属于 builtin 合并面（custom 走 custom.ts，本测试其 mock 无 skill）
    expect(skills.some((i) => i.slug === 'my-upload')).toBe(false);
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

  it('fetchCatalog 失败时 marketplace 返回空，但 custom 与本地预置 builtin 仍工作', async () => {
    const { fetchCatalog } = await import('../../src/main/marketplace/client');
    (fetchCatalog as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network'));
    const items = await listResources();
    // 本地预置 skill 是装机面扫描，不依赖 catalog 网络——网络失败仍可见（v2.11 语义）。
    // 此时去重集为空（catalog 缺席），fixture 的同 slug 'remote' 本地条目也合法出现（本地兜底）
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.source).sort()).toEqual(['builtin', 'builtin', 'custom']);
    expect(items.find((i) => i.slug === 'code-review')).toBeDefined();
    expect(items.find((i) => i.slug === 'remote')?.source).toBe('builtin');
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
