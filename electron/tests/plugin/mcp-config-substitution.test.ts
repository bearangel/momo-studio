// electron/tests/plugin/mcp-config-substitution.test.ts
//
// T6：${config.KEY} 注入（spec 决策 112 行）——
// 单元（替换/缺失保留字面量）+ 集成（mcp.json args/env 经 syncPluginMcps 落
// mcp_definitions 时已展开，敏感值经 config-store 缓存供给）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { syncPluginMcps } from '../../src/main/plugin/mcp-sync';
import { normalizeConfigSchema, writePluginConfig, resetPluginConfigCacheForTest } from '../../src/main/plugin/config-store';
import { setKeychainImpl } from '../../src/main/storage/keychain';
import { getDb, closeDb, runMigrations } from '../../src/main/storage/db';
import { resolvePluginInstalledDir, resolvePluginDataDir } from '../../src/main/paths';
import type { PluginRecord } from '../../src/main/plugin/types';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-psub-'));
const vault = new Map<string, string>();

const SCHEMA = {
  type: 'object',
  properties: {
    indexCommand: { type: 'string' },
    apiToken: { type: 'string', sensitive: true },
  },
  required: [],
};

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  vault.clear();
  setKeychainImpl({
    setSecret: async (k, v) => void vault.set(k, v),
    getSecret: async (k) => vault.get(k) ?? null,
    deleteSecret: async (k) => void vault.delete(k),
  });
});
afterEach(() => {
  closeDb();
  resetPluginConfigCacheForTest(); // 模块级敏感缓存跨用例隔离
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('syncPluginMcps 集成（模板态入库）', () => {
  function installCg(mcpJson: unknown): PluginRecord {
    const root = resolvePluginInstalledDir('cg', '0.4.0');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(resolvePluginDataDir('cg')), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'momo-plugin.json'),
      JSON.stringify({
        id: 'cg',
        name: 'cg',
        version: '0.4.0',
        description: '',
        components: { mcp: './mcp.json' },
      }),
    );
    fs.writeFileSync(path.join(root, 'mcp.json'), JSON.stringify(mcpJson));
    return {
      id: 'cg',
      version: '0.4.0',
      manifestJson: JSON.stringify({
        id: 'cg',
        name: 'cg',
        version: '0.4.0',
        description: '',
        components: { mcp: './mcp.json' },
      }),
      state: 'active',
      source: 'zip',
      sourcePath: null,
      installedAt: 'x',
    };
  }

  function defOf(id: string): { args: string[]; env: Record<string, string> } | undefined {
    const row = getDb()
      .prepare(`SELECT args, env FROM mcp_definitions WHERE id = ?`)
      .get(id) as { args: string; env: string } | undefined;
    return row ? { args: JSON.parse(row.args), env: JSON.parse(row.env) } : undefined;
  }

  // T2 模板态（2026-10-20 引擎整合）：注册期不展开——spawn 期由 host-manager
  // 按工作空间展开（per-ws 值不同）；敏感值同理延迟到 spawn 时刻读取。
  it('args/env 保留 ${config.KEY} 模板原文入库（spawn 期展开）', async () => {
    const rec = installCg({
      servers: {
        cg: {
          command: 'npx',
          args: ['-y', 'cg-server', '${config.indexCommand}'],
          env: { CG_TOKEN: '${config.apiToken}', CG_MODE: 'local' },
        },
      },
    });
    await writePluginConfig('cg', normalizeConfigSchema(SCHEMA), {
      indexCommand: 'index --inc',
      apiToken: 'sk-live',
    });
    const registered = syncPluginMcps(rec);
    expect(registered).toEqual(['cg']);
    const row = defOf('plugin-cg-cg');
    expect(row?.args).toEqual(['-y', 'cg-server', '${config.indexCommand}']);
    expect(row?.env).toEqual({ CG_TOKEN: '${config.apiToken}', CG_MODE: 'local' });
  });

  it('T2 占位符 command（${engineBin}）放行入库——spawn 期才解析', () => {
    const rec = installCg({
      servers: {
        cg: { command: '${engineBin}', args: ['serve', '--mcp'] },
      },
    });
    const registered = syncPluginMcps(rec);
    expect(registered).toEqual(['cg']);
    const row = getDb()
      .prepare(`SELECT command FROM mcp_definitions WHERE id = ?`)
      .get('plugin-cg-cg') as { command: string };
    expect(row.command).toBe('${engineBin}');
  });

  it('T2 普通坏名 command（非占位符、非 npm 名）仍拒收', () => {
    const rec = installCg({
      servers: {
        bad: { command: '../escape/&& rm -rf', args: [] },
      },
    });
    const registered = syncPluginMcps(rec);
    expect(registered).toEqual([]);
  });

  it('未配置的占位符保留字面量（可观察）', () => {
    const rec = installCg({
      servers: {
        cg: { command: 'npx', args: ['${config.indexCommand}'], env: { T: '${config.apiToken}' } },
      },
    });
    syncPluginMcps(rec);
    const row = defOf('plugin-cg-cg');
    expect(row?.args).toEqual(['${config.indexCommand}']);
    expect(row?.env).toEqual({ T: '${config.apiToken}' });
  });
});
