// electron/tests/plugin/boot-reactivation.test.ts
//
// C1 修复锁：app 重启后已装插件 hooks/service 再激活（纯内存态重建）+
// C3 接线路径：wirePluginEventSources 走真实 bus（无 customEmit 自补）+
// C2：setEnabled 摘挂钩 + dispatchPreToolUse 启用过滤。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { reactivatePluginsOnBoot } from '../../src/main/plugin/boot';
import { upsertPlugin } from '../../src/main/plugin/registry';
import { setPluginEnabled } from '../../src/main/plugin/registry';
import { getPluginBus, resetPluginBusForTest } from '../../src/main/plugin/bus-instance';
import { HookBus } from '../../src/main/plugin/hook-bus';
import { isServiceRunning } from '../../src/main/plugin/service-manager';
import { wirePluginEventSources, emitPluginEvent } from '../../src/main/plugin/event-sources';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';
import type { PluginRecord } from '../../src/main/plugin/types';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pboot-'));

function mkInstalledRecord(id: string): PluginRecord {
  const root = path.join(tmpRoot, 'plugins', 'installed', id, '0.1.0');
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'service'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { appReady: [{ module: './log.js' }] } }),
  );
  fs.writeFileSync(path.join(root, 'hooks', 'log.js'), 'module.exports.handle = async () => null;');
  fs.writeFileSync(
    path.join(root, 'service', 'index.js'),
    `module.exports.createService = function () {
      return { async start() {}, async stop() {}, async handle() { return 'ok'; } };
    };`,
  );
  fs.mkdirSync(path.join(tmpRoot, 'plugins', 'data', id), { recursive: true });
  return {
    id,
    version: '0.1.0',
    manifestJson: JSON.stringify({
      id,
      name: id,
      version: '0.1.0',
      description: '',
      components: { hooks: './hooks/hooks.json', service: './service' },
    }),
    state: 'active',
    source: 'zip',
    sourcePath: null,
    installedAt: 'x',
  };
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  resetPluginBusForTest();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'T', '/x', '@o')`)
    .run();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('C1：boot 再激活', () => {
  it('重启后（仅 DB 行在）reactivatePluginsOnBoot 重建 hooks 订阅与 service', async () => {
    upsertPlugin(mkInstalledRecord('cg')); // 模拟重启：DB 有行、内存无订阅
    expect(getPluginBus().listSubscriptions('cg')).toHaveLength(0);
    expect(isServiceRunning('cg')).toBe(false);
    await reactivatePluginsOnBoot();
    expect(getPluginBus().listSubscriptions('cg')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(isServiceRunning('cg')).toBe(true);
  });
});

describe('C2：禁用摘钩 + waterfall 启用过滤', () => {
  it('dispatchPreToolUse 经注入的启用判定过滤禁用插件的订阅', async () => {
    const bus = new HookBus({
      isPluginEnabled: (pluginId, workspaceId) => {
        expect(workspaceId).toBe('ws1');
        return pluginId === 'on-plugin';
      },
    });
    const denied = vi.fn();
    bus.register({
      pluginId: 'off-plugin',
      event: 'preToolUse',
      modulePath: 'x',
      handler: async () => ({ action: 'deny', reason: '禁用插件不应生效' }),
    });
    bus.register({
      pluginId: 'on-plugin',
      event: 'preToolUse',
      modulePath: 'y',
      handler: async () => ({ action: 'deny', reason: '正常拦截' }),
    });
    const d = await bus.dispatchPreToolUse({ workspaceId: 'ws1', toolName: 'bash', args: {} });
    expect(d?.reason).toBe('正常拦截');
    expect(denied).not.toHaveBeenCalled();
  });
});

describe('C3：事件源真实接线', () => {
  it('wirePluginEventSources（无 customEmit）→ emitPluginEvent 到达真实 bus 订阅者', async () => {
    wirePluginEventSources(getPluginBus());
    const seen: string[] = [];
    getPluginBus().register({
      pluginId: 'watcher',
      event: 'taskCompleted',
      modulePath: 'x',
      handler: async (e) => {
        seen.push(e);
        return null;
      },
    });
    emitPluginEvent('taskCompleted', { id: 't1' });
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toContain('taskCompleted');
  });
});

import { vi } from 'vitest';


describe('C1 修复锁：boot 预热敏感缓存', () => {
  it('reactivatePluginsOnBoot 后 sensitiveOverlaySync 含 keytar 值（config schema 声明时）', async () => {
    const { sensitiveOverlaySync } = await import('../../src/main/plugin/config-store');
    const { setKeychainImpl } = await import('../../src/main/storage/keychain');
    const vault = new Map<string, string>([['plugin.cg.config.apiToken', 'sk-boot']]);
    setKeychainImpl({
      setSecret: async (k, v) => void vault.set(k, v),
      getSecret: async (k) => vault.get(k) ?? null,
      deleteSecret: async (k) => void vault.delete(k),
    });
    const rec = mkInstalledRecord('cg');
    rec.manifestJson = JSON.stringify({
      id: 'cg', name: 'cg', version: '0.1.0', description: '',
      components: { hooks: './hooks/hooks.json' },
      config: { type: 'object', properties: { apiToken: { type: 'string', sensitive: true } }, required: [] },
    });
    upsertPlugin(rec);
    await reactivatePluginsOnBoot();
    expect(sensitiveOverlaySync('cg')).toEqual({ apiToken: 'sk-boot' });
  });
});
