// electron/tests/plugin/ipc-handlers.test.ts
//
// IPC 边界锁：通道注册 / 参数透传 / Uint8Array→Buffer / 中文异常透传。
// 真实安装链由 installer.test.ts / install-dev-dir.test.ts 覆盖，本文件
// mock 安装函数只锁 handler 调用形状（仓库既有分工惯例，同 resource/ipc-handlers.test.ts）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { appGetVersion } = vi.hoisted(() => ({ appGetVersion: vi.fn() }));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getVersion: appGetVersion },
}));

const installFns = vi.hoisted(() => ({
  installPluginZip: vi.fn(),
  installPluginDevDir: vi.fn(),
  uninstallPlugin: vi.fn(),
}));
vi.mock('../../src/main/plugin/installer', () => installFns);

const registryFns = vi.hoisted(() => ({
  setPluginEnabled: vi.fn(),
}));
vi.mock('../../src/main/plugin/registry', () => registryFns);

import { ipcMain } from 'electron';
import { registerPluginHandlers } from '../../src/main/plugin/ipc.handlers';

function handlerOf(channel: string): (...args: unknown[]) => unknown {
  const call = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find(
    (c: unknown[]) => c[0] === channel,
  );
  if (!call) throw new Error(`通道未注册: ${channel}`);
  return call[1] as (...args: unknown[]) => unknown;
}

describe('registerPluginHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appGetVersion.mockReturnValue('2.1.0');
    registerPluginHandlers();
  });

  it('注册 4 个 plugin 通道', () => {
    const channels = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(channels).toEqual(
      expect.arrayContaining([
        'plugin:installZip',
        'plugin:installDevDir',
        'plugin:setEnabled',
        'plugin:uninstall',
      ]),
    );
  });

  it('installZip：Uint8Array 转 Buffer 后透传 + 传当前版本 + 摘要形状', async () => {
    installFns.installPluginZip.mockResolvedValueOnce({
      id: 'cg',
      version: '0.1.0',
      manifestJson: JSON.stringify({
        id: 'cg',
        name: 'Codegraph',
        version: '0.1.0',
        description: '图谱',
        components: { tools: './tools' },
      }),
      state: 'active',
      source: 'zip',
      sourcePath: null,
      installedAt: 'x',
    });
    const summary = (await handlerOf('plugin:installZip')({}, new Uint8Array([1, 2, 3]), 'cg.zip')) as {
      id: string;
      components: string[];
    };
    const [buf, version] = installFns.installPluginZip.mock.calls[0] as [Buffer, string];
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(version).toBe('2.1.0');
    expect(summary.id).toBe('cg');
    expect(summary.components).toEqual(['tools']);
  });

  it('installZip 安装函数抛错 → handler reject（中文透传）', async () => {
    installFns.installPluginZip.mockRejectedValueOnce(new Error('解压总量超限'));
    await expect(handlerOf('plugin:installZip')({}, new Uint8Array(), 'x.zip')).rejects.toThrow(
      /解压总量超限/,
    );
  });

  it('installDevDir 路径与版本透传', async () => {
    installFns.installPluginDevDir.mockReturnValueOnce({
      id: 'cg',
      version: '0.1.0',
      manifestJson: '{}',
      state: 'active',
      source: 'dev',
      sourcePath: '/x',
      installedAt: 'x',
    });
    const summary = (await handlerOf('plugin:installDevDir')({}, '/dev/cg')) as { source: string };
    expect(installFns.installPluginDevDir).toHaveBeenCalledWith('/dev/cg', '2.1.0');
    expect(summary.source).toBe('dev');
  });

  it('setEnabled 三参透传', async () => {
    await handlerOf('plugin:setEnabled')({}, 'cg', 'ws1', false);
    expect(registryFns.setPluginEnabled).toHaveBeenCalledWith('cg', 'ws1', false);
  });

  it('uninstall 两参透传', async () => {
    await handlerOf('plugin:uninstall')({}, 'cg', true);
    expect(installFns.uninstallPlugin).toHaveBeenCalledWith('cg', true);
  });

  it('uninstall 抛错 → reject（中文透传）', async () => {
    installFns.uninstallPlugin.mockImplementationOnce(() => {
      throw new Error('插件不存在: nope');
    });
    await expect(handlerOf('plugin:uninstall')({}, 'nope', true)).rejects.toThrow(/不存在/);
  });
});
