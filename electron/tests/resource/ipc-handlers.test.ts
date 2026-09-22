// electron/tests/resource/ipc-handlers.test.ts
//
// Task 5 测试：resource IPC handlers 注册 + 4 通道路由。
// 重点验证 resource:delete 按 source+type 分流到对应底层删除函数。
//
// P3 Task 7 追加：resource:registerMcp（注册 custom mcp + 返回 ResourceItem）与
// resource:uploadSkill（转调 zip-uploader 返回 UploadedSkill[]）——注册面收敛到
// resource:* 命名空间（mcp:register / skill:uploadZip 退役）。
//
// P2 Task 4 追加：resource:registryProviders / resource:registryList（hub provider
// 框架 IPC 面）。hub 模块整体 mock——provider 行为由 tests/resource/hub/* 单测覆盖。

import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock electron 模块（ipcMain.handle 在测试环境不存在）
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

// mock library
vi.mock('../../src/main/resource/library', () => ({
  listResources: vi.fn(),
  resolveResourceById: vi.fn(),
}));

// mock 底层 delete/install
vi.mock('../../src/main/mcp/host-manager', () => ({
  deleteRegistered: vi.fn(),
  registerMcpDefinition: vi.fn(),
}));
vi.mock('../../src/main/skill/zip-uploader', () => ({
  deleteCustomSkill: vi.fn(),
  uploadSkillZip: vi.fn(),
}));
vi.mock('../../src/main/agent/crud', () => ({ deleteDefinition: vi.fn() }));
vi.mock('../../src/main/marketplace/installer', () => ({
  installPackage: vi.fn(),
  uninstallPackage: vi.fn(),
}));

// P2 Task 4：hub provider 模块整体 mock（真实行为由 tests/resource/hub/* 覆盖）。
// vi.mock 工厂会被提升到文件顶部——共享 spy 须经 vi.hoisted 声明，避免 TDZ。
const { smitheryList, modelscopeList } = vi.hoisted(() => ({
  smitheryList: vi.fn(),
  modelscopeList: vi.fn(),
}));
vi.mock('../../src/main/resource/hub/smithery', () => ({
  smitheryProvider: {
    key: 'smithery', label: 'Smithery', region: 'intl', types: ['mcp'], list: smitheryList,
  },
  isSmitheryDegraded: vi.fn(() => false),
  __resetHubBackoffForTest: vi.fn(),
}));
vi.mock('../../src/main/resource/hub/modelscope', () => ({
  modelscopeProvider: {
    key: 'modelscope', label: '魔搭社区', region: 'cn', types: ['mcp'], list: modelscopeList,
  },
  isModelScopeDegraded: vi.fn(() => true),
}));

// mock fetchCatalog（marketplace delete 分支需要）。catalog id 刻意不同于 ResourceItem.id，
// 以回归保护"误传 ResourceItem.id 给 uninstallPackage"的静默 no-op bug。
vi.mock('../../src/main/marketplace/client', () => ({
  fetchCatalog: vi.fn(async () => ({
    version: '1.0',
    updatedAt: '2026-08-11',
    items: [
      {
        id: 'catalog-id-remote',
        type: 'skill',
        slug: 'remote',
        name: 'Remote',
        version: '1',
        author: '@x',
        description: 'd',
        readme: 'r',
        tags: [],
        category: 'c',
        iconEmoji: '📦',
        verificationStatus: 'community',
        downloadUrl: 'http://x',
        checksum: 'x',
        sizeBytes: 0,
        installCount: 0,
      },
    ],
  })),
}));

import { ipcMain } from 'electron';
import { registerResourceHandlers } from '../../src/main/resource/ipc.handlers';
import { listResources, resolveResourceById } from '../../src/main/resource/library';
import { deleteRegistered, registerMcpDefinition } from '../../src/main/mcp/host-manager';
import { deleteCustomSkill, uploadSkillZip } from '../../src/main/skill/zip-uploader';
import { deleteDefinition } from '../../src/main/agent/crud';
import { uninstallPackage } from '../../src/main/marketplace/installer';

describe('registerResourceHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerResourceHandlers();
  });

  it('注册 6 个 IPC 通道', () => {
    const channels = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(channels).toEqual(
      expect.arrayContaining([
        'resource:list',
        'resource:getDetail',
        'resource:install',
        'resource:delete',
        'resource:registerMcp',
        'resource:uploadSkill',
      ]),
    );
  });

  it('resource:list 调 listResources(filter)', async () => {
    (listResources as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const listCall = calls.find((c: unknown[]) => c[0] === 'resource:list');
    const handler = listCall![1] as (evt: unknown, filter: unknown) => Promise<unknown>;
    await handler({}, { type: 'mcp' });
    expect(listResources).toHaveBeenCalledWith({ type: 'mcp' });
  });

  it('resource:delete custom-mcp-* 路由到 deleteRegistered', async () => {
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'custom-mcp-github',
      type: 'mcp',
      source: 'custom',
      slug: 'github',
      removable: true,
      name: 'github',
    });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const deleteCall = calls.find((c: unknown[]) => c[0] === 'resource:delete');
    const handler = deleteCall![1] as (evt: unknown, id: string) => Promise<void>;
    await handler({}, 'custom-mcp-github');
    expect(deleteRegistered).toHaveBeenCalledWith('github');
  });

  it('resource:delete builtin-* 抛错（不可移除）', async () => {
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'builtin-agent-pm',
      source: 'builtin',
      removable: false,
      name: 'PM',
    });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const deleteCall = calls.find((c: unknown[]) => c[0] === 'resource:delete');
    const handler = deleteCall![1] as (evt: unknown, id: string) => Promise<void>;
    await expect(handler({}, 'builtin-agent-pm')).rejects.toThrow(/系统预置不可移除/);
  });

  it('resource:delete custom-skill-* 路由到 deleteCustomSkill', async () => {
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'custom-skill-xlsx',
      type: 'skill',
      source: 'custom',
      slug: 'xlsx',
      removable: true,
      name: 'xlsx',
    });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const deleteCall = calls.find((c: unknown[]) => c[0] === 'resource:delete');
    const handler = deleteCall![1] as (evt: unknown, id: string) => Promise<void>;
    await handler({}, 'custom-skill-xlsx');
    expect(deleteCustomSkill).toHaveBeenCalledWith('xlsx');
  });

  it('resource:delete custom-agent-* 路由到 deleteDefinition', async () => {
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'custom-agent-uuid1',
      type: 'agent',
      source: 'custom',
      slug: 'uuid1',
      removable: true,
      name: 'my agent',
    });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const deleteCall = calls.find((c: unknown[]) => c[0] === 'resource:delete');
    const handler = deleteCall![1] as (evt: unknown, id: string) => Promise<void>;
    await handler({}, 'custom-agent-uuid1');
    expect(deleteDefinition).toHaveBeenCalledWith('uuid1');
  });

  it('resource:delete marketplace-* 路由到 uninstallPackage（传 catalog id，非 ResourceItem.id）', async () => {
    (resolveResourceById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'marketplace-skill-remote',
      type: 'skill',
      source: 'marketplace',
      slug: 'remote',
      removable: true,
      name: 'remote',
    });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const deleteCall = calls.find((c: unknown[]) => c[0] === 'resource:delete');
    const handler = deleteCall![1] as (evt: unknown, id: string) => Promise<void>;
    await handler({}, 'marketplace-skill-remote');
    // 必须传 catalog 的 MarketplaceItem.id（'catalog-id-remote'），不是 ResourceItem.id
    // （'marketplace-skill-remote'）——后者会让 uninstallPackage 查无此行触发静默 no-op。
    expect(uninstallPackage).toHaveBeenCalledWith('catalog-id-remote');
  });

  it('resource:registerMcp 转调 registerMcpDefinition（source=custom，id/version 主进程补全）', async () => {
    const item = {
      id: 'custom-mcp-github',
      type: 'mcp',
      source: 'custom',
      slug: 'github',
      name: 'github',
      description: '自定义 MCP（npx）',
      installed: true,
      installable: false,
      removable: true,
    };
    (listResources as ReturnType<typeof vi.fn>).mockResolvedValueOnce([item]);
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const registerCall = calls.find((c: unknown[]) => c[0] === 'resource:registerMcp');
    const handler = registerCall![1] as (
      evt: unknown,
      config: { name: string; command: string; args?: string[]; env?: Record<string, string> },
    ) => Promise<unknown>;
    const result = await handler({}, {
      name: 'github',
      command: 'npx',
      args: ['-y', 'server.js'],
      env: { API_KEY: 'secret' },
    });
    expect(registerMcpDefinition).toHaveBeenCalledTimes(1);
    const config = (registerMcpDefinition as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(config).toMatchObject({
      name: 'github',
      command: 'npx',
      args: ['-y', 'server.js'],
      env: { API_KEY: 'secret' },
      source: 'custom',
    });
    expect(typeof config.id).toBe('string');
    expect((config.id as string).length).toBeGreaterThan(0);
    expect(typeof config.version).toBe('string');
    expect((config.version as string).length).toBeGreaterThan(0);
    expect(result).toBe(item);
  });

  it('resource:registerMcp 用 filter={type:mcp, source:custom} 从 custom 映射取回条目', async () => {
    (listResources as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const registerCall = calls.find((c: unknown[]) => c[0] === 'resource:registerMcp');
    const handler = registerCall![1] as (
      evt: unknown,
      config: { name: string; command: string },
    ) => Promise<unknown>;
    await expect(handler({}, { name: 'gone', command: 'c' })).rejects.toThrow(/gone/);
    expect(listResources).toHaveBeenCalledWith({ type: 'mcp', source: 'custom' });
  });

  it('resource:uploadSkill 转调 uploadSkillZip（Uint8Array 转 Buffer）并返回 UploadedSkill[]', async () => {
    const uploaded = [{ slug: 'demo', name: 'Demo', description: '示例 skill' }];
    (uploadSkillZip as ReturnType<typeof vi.fn>).mockReturnValueOnce(uploaded);
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const uploadCall = calls.find((c: unknown[]) => c[0] === 'resource:uploadSkill');
    const handler = uploadCall![1] as (
      evt: unknown,
      data: Uint8Array,
      filename: string,
    ) => Promise<unknown>;
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const result = await handler({}, bytes, 'demo.zip');
    expect(uploadSkillZip).toHaveBeenCalledTimes(1);
    const [buf, filename] = (uploadSkillZip as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Buffer,
      string,
    ];
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.equals(Buffer.from(bytes))).toBe(true);
    expect(filename).toBe('demo.zip');
    expect(result).toBe(uploaded);
  });

  it('注册 registryProviders / registryList 通道', () => {
    const channels = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(channels).toEqual(
      expect.arrayContaining(['resource:registryProviders', 'resource:registryList']),
    );
  });

  it('resource:registryProviders 返回 builtin + 两 hub（degraded 取各自封装）', async () => {
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const metaCall = calls.find((c: unknown[]) => c[0] === 'resource:registryProviders');
    const handler = metaCall![1] as () => Promise<unknown>;
    const providers = (await handler()) as Array<{
      key: string; label: string; region: string; types: string[]; degraded: boolean;
    }>;
    expect(providers.map((p) => p.key)).toEqual(['builtin', 'smithery', 'modelscope']);
    expect(providers[0]).toMatchObject({ region: 'local', degraded: false });
    expect(providers[0]!.types).toEqual(['agent', 'mcp', 'skill']);
    expect(providers[1]).toMatchObject({ label: 'Smithery', region: 'intl', degraded: false });
    expect(providers[2]).toMatchObject({ label: '魔搭社区', region: 'cn', degraded: true });
  });

  it('resource:registryList builtin 分支：marketplace 源 + 前端同款过滤排序映射', async () => {
    const items = [
      {
        id: 'marketplace-mcp-installed', type: 'mcp', source: 'marketplace', slug: 'installed',
        name: '已装服务', description: 'd1', installed: true, installable: false,
        marketplace: { author: 'a', readme: 'r', downloadUrl: '', checksum: '', verificationStatus: 'community', tags: ['t'], category: 'c1' },
      },
      {
        id: 'marketplace-mcp-fs', type: 'mcp', source: 'marketplace', slug: 'fs-tool',
        name: 'File System', description: '文件系统', installed: false, installable: true,
        marketplace: { author: 'a', readme: 'r', downloadUrl: '', checksum: '', verificationStatus: 'community', tags: [], category: 'c2' },
      },
      {
        id: 'marketplace-mcp-other', type: 'mcp', source: 'marketplace', slug: 'other',
        name: 'Other', description: '无关条目', installed: false, installable: true,
        marketplace: { author: 'a', readme: 'r', downloadUrl: '', checksum: '', verificationStatus: 'community', tags: [], category: 'c3' },
      },
    ];
    (listResources as ReturnType<typeof vi.fn>).mockResolvedValueOnce(items);
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const listCall = calls.find((c: unknown[]) => c[0] === 'resource:registryList');
    const handler = listCall![1] as (
      evt: unknown,
      providerKey: string,
      type: string,
      query?: string,
    ) => Promise<{ entries: Array<{ id: string; tags: string[]; category?: string }>; degraded: boolean }>;
    const result = await handler({}, 'builtin', 'mcp', 'file');
    expect(listResources).toHaveBeenCalledWith({ type: 'mcp', source: 'marketplace' });
    expect(result.degraded).toBe(false);
    // 「file」只命中 File System（name 模糊）；installed 排序垫底语义由下方无 query 用例覆盖
    expect(result.entries.map((e) => e.id)).toEqual(['marketplace-mcp-fs']);
    expect(result.entries[0]!.tags).toEqual([]);
    expect(result.entries[0]!.category).toBe('c2');

    // 无 query：全量返回且未安装在前、已安装垫底（与 renderer catalog provider 同语义）
    (listResources as ReturnType<typeof vi.fn>).mockResolvedValueOnce(items);
    const all = await handler({}, 'builtin', 'mcp');
    expect(all.entries.map((e) => e.id)).toEqual([
      'marketplace-mcp-fs', 'marketplace-mcp-other', 'marketplace-mcp-installed',
    ]);
  });

  it('resource:registryList hub 分支委托对应 provider.list', async () => {
    smitheryList.mockResolvedValueOnce({ entries: [], degraded: false });
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const listCall = calls.find((c: unknown[]) => c[0] === 'resource:registryList');
    const handler = listCall![1] as (
      evt: unknown,
      providerKey: string,
      type: string,
      query?: string,
    ) => Promise<unknown>;
    const result = await handler({}, 'smithery', 'mcp', 'weather');
    expect(smitheryList).toHaveBeenCalledWith('mcp', 'weather');
    expect(result).toEqual({ entries: [], degraded: false });

    await handler({}, 'modelscope', 'mcp');
    expect(modelscopeList).toHaveBeenCalledWith('mcp', undefined);
  });

  it('resource:registryList 未知 provider 抛错', async () => {
    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
    const listCall = calls.find((c: unknown[]) => c[0] === 'resource:registryList');
    const handler = listCall![1] as (
      evt: unknown,
      providerKey: string,
      type: string,
    ) => Promise<unknown>;
    await expect(handler({}, 'mcphub', 'mcp')).rejects.toThrow(/未知 registry provider/);
  });
});
