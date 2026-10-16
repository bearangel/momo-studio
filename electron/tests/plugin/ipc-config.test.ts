// electron/tests/plugin/ipc-config.test.ts
//
// T6：P4 IPC 面边界锁——listPanels / callService / getConfig / setConfig
// 通道注册与联动（MCP 重装配 + service 重启）。存储层真跑（config-store 真文件），
// 安装/服务面 mock（仓库 ipc 测试分工惯例）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  getPlugin: vi.fn(),
}));
vi.mock('../../src/main/plugin/registry', () => ({
  ...registryFns,
  isPluginEnabled: vi.fn().mockReturnValue(true),
}));

const reloadFns = vi.hoisted(() => ({ reloadPlugin: vi.fn() }));
vi.mock('../../src/main/plugin/reload', () => reloadFns);

const svcFns = vi.hoisted(() => ({
  callPluginService: vi.fn(),
  isServiceRunning: vi.fn(),
  stopPluginService: vi.fn().mockResolvedValue(undefined),
  startPluginService: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../src/main/plugin/service-manager', () => svcFns);

const mcpFns = vi.hoisted(() => ({ syncPluginMcps: vi.fn() }));
vi.mock('../../src/main/plugin/mcp-sync', () => mcpFns);

const panelFns = vi.hoisted(() => ({ listPluginPanels: vi.fn(), notifyPanelsChanged: vi.fn() }));
vi.mock('../../src/main/plugin/panel-sync', () => panelFns);

import { ipcMain } from 'electron';
import { registerPluginHandlers } from '../../src/main/plugin/ipc.handlers';
import { setKeychainImpl } from '../../src/main/storage/keychain';
import { resetPluginConfigCacheForTest } from '../../src/main/plugin/config-store';
import { closeDb as closeDbForIpc } from '../../src/main/storage/db';

// keychain 隔离：真机冒烟可能在本机真实钥匙串留有同名键（一次性假值）——
// 不 mock 会串扰 sensitiveConfigured 断言（内存 vault 保真 set/get/delete 语义）
const ipcVault = new Map<string, string>();
setKeychainImpl({
  setSecret: async (k, v) => void ipcVault.set(k, v),
  getSecret: async (k) => ipcVault.get(k) ?? null,
  deleteSecret: async (k) => void ipcVault.delete(k),
});

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pipc-'));

function handlerOf(channel: string): (...args: unknown[]) => unknown {
  const call = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find(
    (c: unknown[]) => c[0] === channel,
  );
  if (!call) throw new Error(`通道未注册: ${channel}`);
  return call[1] as (...args: unknown[]) => unknown;
}

const CG_REC = {
  id: 'cg',
  version: '0.4.0',
  manifestJson: JSON.stringify({
    id: 'cg',
    name: 'Codegraph',
    version: '0.4.0',
    description: '',
    components: {},
    config: {
      type: 'object',
      properties: {
        indexCommand: { type: 'string', title: '索引构建命令' },
        apiToken: { type: 'string', title: 'API Token', sensitive: true },
      },
      required: ['indexCommand'],
    },
  }),
  state: 'active' as const,
  source: 'zip' as const,
  sourcePath: null,
  installedAt: 'x',
};

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  resetPluginConfigCacheForTest();
  vi.clearAllMocks();
  appGetVersion.mockReturnValue('2.1.0');
  panelFns.listPluginPanels.mockReturnValue([]);
  registryFns.getPlugin.mockReturnValue(CG_REC);
  registerPluginHandlers();
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('P4 通道注册', () => {
  it('listPanels / callService / getConfig / setConfig 全注册', () => {
    const channels = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(channels).toEqual(
      expect.arrayContaining([
        'plugin:listPanels',
        'plugin:callService',
        'plugin:getConfig',
        'plugin:setConfig',
      ]),
    );
  });

  it('listPanels 透传 workspaceId', () => {
    panelFns.listPluginPanels.mockReturnValue([{ pluginId: 'cg', panelId: 'graph' }]);
    const out = handlerOf('plugin:listPanels')(null, 'ws1');
    expect(panelFns.listPluginPanels).toHaveBeenCalledWith('ws1');
    expect(out).toEqual([{ pluginId: 'cg', panelId: 'graph' }]);
  });

  it('callService 透传三参（身份由调用方绑定）', async () => {
    svcFns.callPluginService.mockResolvedValue({ ok: 1 });
    const out = await handlerOf('plugin:callService')(null, 'cg', 'query', { q: 'x' });
    expect(svcFns.callPluginService).toHaveBeenCalledWith('cg', 'query', { q: 'x' });
    expect(out).toEqual({ ok: 1 });
  });

  it('getConfig：无 config 声明 → null；插件不存在 → throw', async () => {
    registryFns.getPlugin.mockReturnValueOnce({ ...CG_REC, manifestJson: JSON.stringify({ id: 'cg', name: 'x', version: '0.4.0', description: '', components: {} }) });
    expect(await handlerOf('plugin:getConfig')(null, 'cg')).toBeNull();
    registryFns.getPlugin.mockReturnValueOnce(null);
    await expect(handlerOf('plugin:getConfig')(null, 'ghost')).rejects.toThrow('插件不存在');
  });

  it('getConfig：敏感只出在场布尔（明文不外泄）', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'plugins', 'data', 'cg'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'plugins', 'data', 'cg', 'config.json'),
      JSON.stringify({ indexCommand: 'codegraph index' }),
    );
    const view = (await handlerOf('plugin:getConfig')(null, 'cg')) as {
      values: Record<string, unknown>;
      sensitiveConfigured: Record<string, boolean>;
    };
    expect(view.values).toEqual({ indexCommand: 'codegraph index' });
    expect(view.sensitiveConfigured).toEqual({ apiToken: false });
  });
});

describe('setConfig 保存即生效联动', () => {
  it('写入 → MCP 重装配 → 运行中 service 重启 → 返回新视图', async () => {
    svcFns.isServiceRunning.mockReturnValue(true);
    const view = await handlerOf('plugin:setConfig')(null, 'cg', {
      indexCommand: 'codegraph index --inc',
      apiToken: 'sk-9',
    });
    expect(mcpFns.syncPluginMcps).toHaveBeenCalledWith(CG_REC);
    expect(svcFns.stopPluginService).toHaveBeenCalledWith('cg');
    await vi.waitFor(() => expect(svcFns.startPluginService).toHaveBeenCalledWith(CG_REC));
    expect((view as { sensitiveConfigured: Record<string, boolean> }).sensitiveConfigured.apiToken).toBe(true);
    expect(JSON.stringify(view)).not.toContain('sk-9');
  });

  it('service 未运行（注册期启动失败）→ 保存配置后拉起（P5 §8.2 真机语义）', async () => {
    svcFns.isServiceRunning.mockReturnValue(false);
    await handlerOf('plugin:setConfig')(null, 'cg', { indexCommand: 'x' });
    await vi.waitFor(() => expect(svcFns.startPluginService).toHaveBeenCalledWith(CG_REC));
  });

  it('I2 回归锁：全 workspace 禁用的插件 setConfig 不拉起 service（§8.6）', async () => {
    // 用真实 DB 播种 enablement（ipc.handlers 的 gate 直查 plugin_enablements）
    const { closeDb: _c, runMigrations, getDb } = await import('../../src/main/storage/db');
    runMigrations();
    getDb()
      .prepare(`INSERT OR IGNORE INTO workspaces (id, name, directory_path, owner_id) VALUES ('wsD', 'T', '/x', '@o')`)
      .run();
    // FK：plugin_enablements.plugin_id 引用 plugins 表——先落 CG_REC 行再禁用
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO plugins (id, version, manifest_json, state, source, source_path, installed_at)
         VALUES ('cg', ?, ?, 'active', 'zip', NULL, 'x')`,
      )
      .run(CG_REC.version, CG_REC.manifestJson);
    getDb()
      .prepare(`INSERT OR REPLACE INTO plugin_enablements (workspace_id, plugin_id, enabled) VALUES ('wsD', 'cg', 0)`)
      .run();
    // registryFns.getPlugin 被 mock——gate 走 getDb（真实）→ wsD 禁用 + 无其他 ws → n=0
    await handlerOf('plugin:setConfig')(null, 'cg', { indexCommand: 'x' });
    await new Promise((r) => setTimeout(r, 50));
    expect(svcFns.startPluginService).not.toHaveBeenCalled();
    closeDbForIpc();
  });

  it('校验失败 → throw 且不触发联动', async () => {
    await expect(
      handlerOf('plugin:setConfig')(null, 'cg', { hacker: 'x' }),
    ).rejects.toThrow('未知键');
    expect(mcpFns.syncPluginMcps).not.toHaveBeenCalled();
  });
});
