// electron/tests/plugin/config-store-scope.test.ts
//
// 引擎整合 T1 RED（spec §9.1 病灶 2 修复）：config 合并面 scope 过滤——
// workspace 作用域键只从 per-ws 层取值，不再从全局层 fallback（历史残留
// 泄漏路径：全局 config.json 的 workspaceRoot 污染所有未配置的 ws）。
// global 作用域键行为不变。boot 残留检测（spill）纯函数化——由 boot 组装条目。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  normalizeConfigSchema,
  getPluginConfigView,
  resolvePluginConfig,
  findGlobalLayerWorkspaceSpills,
} from '../../src/main/plugin/config-store';
import { setKeychainImpl } from '../../src/main/storage/keychain';
import { resolvePluginDataDir } from '../../src/main/paths';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-cgscope-'));
const vault = new Map<string, string>();

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  vault.clear();
  setKeychainImpl({
    setSecret: async (k, v) => void vault.set(k, v),
    getSecret: async (k) => vault.get(k) ?? null,
    deleteSecret: async (k) => void vault.delete(k),
  });
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

const SCHEMA = normalizeConfigSchema({
  type: 'object',
  properties: {
    workspaceRoot: { type: 'string', title: '索引根目录', scope: 'workspace' },
    apiKey: { type: 'string', title: 'API Key' }, // 缺省 scope = global
  },
  required: [],
});

const PID = 'scope-test-plugin';
const WS = 'ws-1';

/** 直写文件层模拟状态——全局层 workspace 残留是历史污染产物（写入防线 C2 已
 *  拒新写入），测试不经过 writePluginConfig 才能真实还原该状态。 */
function seedGlobal(layer: Record<string, unknown>): void {
  const dir = resolvePluginDataDir(PID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(layer), 'utf-8');
}
function seedWs(layer: Record<string, unknown>): void {
  const dir = resolvePluginDataDir(PID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `config.${WS}.json`), JSON.stringify(layer), 'utf-8');
}

describe('合并面 scope 过滤（getPluginConfigView）', () => {
  it('全局层残留的 workspace 键不泄漏进任何视图', async () => {
    seedGlobal({ workspaceRoot: '/legacy/root', apiKey: 'k1' });
    const view = getPluginConfigView(PID, SCHEMA, WS);
    expect(view.values).toEqual({ apiKey: 'k1' });
  });

  it('per-ws 层的 workspace 键正常生效', async () => {
    seedGlobal({ workspaceRoot: '/legacy/root', apiKey: 'k1' });
    seedWs({ workspaceRoot: '/right/root' });
    const view = getPluginConfigView(PID, SCHEMA, WS);
    expect(view.values).toEqual({ apiKey: 'k1', workspaceRoot: '/right/root' });
  });

  it('无 wsId 视角：workspace 键不出现（表单空 = 跟随默认语义）', async () => {
    seedGlobal({ workspaceRoot: '/legacy/root', apiKey: 'k1' });
    const view = getPluginConfigView(PID, SCHEMA);
    expect(view.values).toEqual({ apiKey: 'k1' });
    expect(view.scopes).toEqual({ workspaceRoot: 'workspace', apiKey: 'global' });
  });
});

describe('合并面 scope 过滤（resolvePluginConfig）', () => {
  it('异步面同样不吃全局层 workspace 残留', async () => {
    seedGlobal({ workspaceRoot: '/legacy/root', apiKey: 'k1' });
    const values = await resolvePluginConfig(PID, SCHEMA, WS);
    expect(values).toEqual({ apiKey: 'k1' });
  });

  it('per-ws 值经异步面生效', async () => {
    seedWs({ workspaceRoot: '/right/root' });
    const values = await resolvePluginConfig(PID, SCHEMA, WS);
    expect(values).toEqual({ workspaceRoot: '/right/root' });
  });
});

describe('全局层残留检测（findGlobalLayerWorkspaceSpills）', () => {
  it('全局层持有 workspace 键 → 报 spill（即便 per-ws 也有值）', async () => {
    seedGlobal({ workspaceRoot: '/legacy/root' });
    seedWs({ workspaceRoot: '/right/root' });
    const spills = findGlobalLayerWorkspaceSpills([{ pluginId: PID, schema: SCHEMA }]);
    expect(spills).toEqual([{ pluginId: PID, keys: ['workspaceRoot'] }]);
  });

  it('全局层只有 global 键 → 不报', async () => {
    seedGlobal({ apiKey: 'k1' });
    const spills = findGlobalLayerWorkspaceSpills([{ pluginId: PID, schema: SCHEMA }]);
    expect(spills).toEqual([]);
  });

  it('无全局文件 → 不报', () => {
    const spills = findGlobalLayerWorkspaceSpills([{ pluginId: 'ghost-plugin', schema: SCHEMA }]);
    expect(spills).toEqual([]);
  });
});
