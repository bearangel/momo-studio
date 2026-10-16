// electron/tests/plugin/mcp-config-substitution.test.ts
//
// T6：${config.KEY} 注入（spec 决策 112 行）——
// 单元（替换/缺失保留字面量）+ 集成（mcp.json args/env 经 syncPluginMcps 落
// mcp_definitions 时已展开，敏感值经 config-store 缓存供给）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { substituteConfigTemplate, syncPluginMcps } from '../../src/main/plugin/mcp-sync';
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

describe('substituteConfigTemplate', () => {
  it('替换单处与多处占位符', () => {
    const cfg = { indexCommand: 'codegraph index', n: 3 };
    expect(substituteConfigTemplate('${config.indexCommand}', cfg, 'cg')).toBe('codegraph index');
    expect(substituteConfigTemplate('run ${config.indexCommand} -j ${config.n}', cfg, 'cg')).toBe(
      'run codegraph index -j 3',
    );
  });

  it('缺失键保留字面量；非占位符文本不动', () => {
    expect(substituteConfigTemplate('${config.ghost}', {}, 'cg')).toBe('${config.ghost}');
    expect(substituteConfigTemplate('plain ${HOME} text', {}, 'cg')).toBe('plain ${HOME} text');
  });
});

describe('syncPluginMcps 集成（args/env 展开 + 敏感经缓存）', () => {
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

  it('args/env 中的 ${config.KEY} 全部替换（含 keytar 敏感值）', async () => {
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
    expect(row?.args).toEqual(['-y', 'cg-server', 'index --inc']);
    expect(row?.env).toEqual({ CG_TOKEN: 'sk-live', CG_MODE: 'local' });
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
