// electron/tests/resource/ipc-handlers.test.ts
//
// Task 5 测试：resource IPC handlers 注册 + 4 通道路由。
// 重点验证 resource:delete 按 source+type 分流到对应底层删除函数。

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
vi.mock('../../src/main/mcp/host-manager', () => ({ deleteRegistered: vi.fn() }));
vi.mock('../../src/main/skill/zip-uploader', () => ({ deleteCustomSkill: vi.fn() }));
vi.mock('../../src/main/agent/crud', () => ({ deleteDefinition: vi.fn() }));
vi.mock('../../src/main/marketplace/installer', () => ({
  installPackage: vi.fn(),
  uninstallPackage: vi.fn(),
}));

import { ipcMain } from 'electron';
import { registerResourceHandlers } from '../../src/main/resource/ipc.handlers';
import { listResources, resolveResourceById } from '../../src/main/resource/library';
import { deleteRegistered } from '../../src/main/mcp/host-manager';
import { deleteCustomSkill } from '../../src/main/skill/zip-uploader';
import { deleteDefinition } from '../../src/main/agent/crud';
import { uninstallPackage } from '../../src/main/marketplace/installer';

describe('registerResourceHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerResourceHandlers();
  });

  it('注册 4 个 IPC 通道', () => {
    const channels = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(channels).toEqual(
      expect.arrayContaining([
        'resource:list',
        'resource:getDetail',
        'resource:install',
        'resource:delete',
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

  it('resource:delete marketplace-* 路由到 uninstallPackage', async () => {
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
    expect(uninstallPackage).toHaveBeenCalledWith('marketplace-skill-remote');
  });
});
