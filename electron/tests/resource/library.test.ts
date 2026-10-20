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
// 隔离：vi.mock 替换 fetchCatalog / listCustomResources / installer.listInstalled /
// zip-uploader，避免真实 HTTP + DB + fs 依赖。

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

// mock 插件资源行（plugins 表/开发目录扫描——不 mock 会读到仓库 plugins/codegraph
// 的 agent+skill 两行，测试随仓库插件状态漂移；本文件只测三源纯合并逻辑）
vi.mock('../../src/main/plugin/resources', () => ({
  listPluginResourceRows: vi.fn(() => []),
}));

// mock skill zip-uploader（v2.11：library 直接消费其 listInstalled 的 builtin 分支——
// 本地预置 skill 并入 builtin 源；fixture 含与 marketplace 同 slug 的条目锁去重语义）
const { skillZipMocks } = vi.hoisted(() => ({
  skillZipMocks: {
    listInstalled: vi.fn(),
  },
}));
vi.mock('../../src/main/skill/zip-uploader', () => skillZipMocks);

// mock hub-install（P2 Task 5：hub 已装 MCP 第五源——真实 DB 行为由
// tests/resource/hub-install.test.ts 以真实库覆盖，本文件只测四源合并逻辑）
const { hubInstallMocks } = vi.hoisted(() => ({
  hubInstallMocks: {
    listHubInstalledResources: vi.fn(),
  },
}));
vi.mock('../../src/main/resource/hub-install', () => hubInstallMocks);

beforeEach(() => {
  skillZipMocks.listInstalled.mockReset();
  skillZipMocks.listInstalled.mockReturnValue([
    { slug: 'code-review', name: '代码审查', description: '预置审查技能', source: 'builtin', installedAt: null },
    { slug: 'remote', name: '重复条目', description: '与 marketplace 同 slug', source: 'builtin', installedAt: null },
    { slug: 'my-upload', name: '我的上传', description: 'custom 源应被忽略', source: 'custom', installedAt: '2026-09-16' },
  ]);
  hubInstallMocks.listHubInstalledResources.mockReset();
  hubInstallMocks.listHubInstalledResources.mockReturnValue([]);
});

describe('listResources', () => {
  it('合并三源：builtin + marketplace + custom', async () => {
    const items = await listResources();
    // 4 项 = 1 catalog builtin(agent) + 1 marketplace(skill) + 1 本地预置 builtin(skill)
    //       + 1 custom(mcp)——本地预置并入 builtin 源（v2.11）
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.source).sort()).toEqual(['builtin', 'builtin', 'custom', 'marketplace']);
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

