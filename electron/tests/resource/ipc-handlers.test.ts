// electron/tests/resource/ipc-handlers.test.ts
//
// Task 5 测试：resource IPC handlers 注册 + 4 通道路由。
// 重点验证 resource:delete 按 source+type 分流到对应底层删除函数。
//
// P3 Task 7 追加：resource:registerMcp（注册 custom mcp + 返回 ResourceItem）与
// resource:uploadSkill（转调 zip-uploader 返回 UploadedSkill[]）——注册面收敛到
// resource:* 命名空间（mcp:register / skill:uploadZip 退役）。

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
});
