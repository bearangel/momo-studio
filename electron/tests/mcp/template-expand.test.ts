// electron/tests/mcp/template-expand.test.ts
//
// 引擎整合 T3 RED（spec §4.3）：MCP 模板 spawn 期展开——
// ${config.*} 按工作空间层展开（含敏感经缓存）、workspaceRoot 留空 fallback
// 工作区目录（两者皆空拒启）、${engineBin} 解析插件引擎启动器（缺失可读报错）、
// 非插件 source / 无占位符原样返回（存量 MCP 零影响）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { expandMcpTemplate } from '../../src/main/mcp/template-expand';
import type { McpServerConfig } from '../../src/main/mcp/types';
import { setKeychainImpl } from '../../src/main/storage/keychain';
import { closeDb, runMigrations, getDb } from '../../src/main/storage/db';
import { writePluginConfig, normalizeConfigSchema } from '../../src/main/plugin/config-store';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-tpl-'));
const vault = new Map<string, string>();
const PID = 'cg';

const SCHEMA = normalizeConfigSchema({
  type: 'object',
  properties: {
    workspaceRoot: { type: 'string', title: '索引根目录', scope: 'workspace' },
    apiToken: { type: 'string', title: 'API Token', sensitive: true },
  },
  required: [],
});

const MANIFEST = {
  id: PID,
  name: 'cg',
  version: '2.0.0',
  components: { mcp: './mcp/mcp.json' },
  config: {
    type: 'object',
    properties: {
      workspaceRoot: { type: 'string', title: '索引根目录', scope: 'workspace' },
      apiToken: { type: 'string', title: 'API Token', sensitive: true },
    },
  },
};

function mkConfig(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: `plugin-${PID}-cg`,
    name: 'cg',
    version: '0.0.0',
    command: '${engineBin}',
    args: ['serve', '--mcp', '--path', '${config.workspaceRoot}'],
    env: { CODEGRAPH_NO_DOWNLOAD: '1' },
    transport: 'stdio',
    source: 'plugin',
    pluginId: PID,
    ...over,
  };
}

/** dev 形态插件根（resolvePluginRoot 走 sourcePath 分支）+ 引擎启动器文件 */
function seedPlugin(engineBinExists = true): string {
  const root = path.join(tmpRoot, 'plugins-dev', PID);
  const bin = path.join(root, 'engine', 'bin', 'codegraph');
  if (engineBinExists) {
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '#!/bin/sh\n', { encoding: 'utf-8' });
  }
  return root;
}

function seedDb(pluginRoot: string): void {
  runMigrations();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO plugins (id, version, manifest_json, state, source, source_path, installed_at)
       VALUES (?, ?, ?, 'active', 'dev', ?, 'x')`,
    )
    .run(PID, '2.0.0', JSON.stringify(MANIFEST), pluginRoot);
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws-1', 'W1', ?, '@o'),
       ('ws-2', 'W2', '/tmp/ws-two', '@o')`,
    )
    .run('/tmp/ws-one');
}

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
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('expandMcpTemplate', () => {
  it('① ${config.workspaceRoot} 按 per-ws 层展开——两个 ws 各自的 root', async () => {
    const root = seedPlugin();
    seedDb(root);
    await writePluginConfig(PID, SCHEMA, { workspaceRoot: '/right/one' }, 'ws-1');
    await writePluginConfig(PID, SCHEMA, { workspaceRoot: '/right/two' }, 'ws-2');
    const e1 = await expandMcpTemplate(mkConfig(), 'ws-1');
    const e2 = await expandMcpTemplate(mkConfig(), 'ws-2');
    expect(e1.args).toEqual(['serve', '--mcp', '--path', '/right/one']);
    expect(e2.args).toEqual(['serve', '--mcp', '--path', '/right/two']);
    expect(e1.command).toBe(path.join(root, 'engine', 'bin', 'codegraph'));
  });

  it('② workspaceRoot 留空 → fallback 工作区目录', async () => {
    const root = seedPlugin();
    seedDb(root);
    const e = await expandMcpTemplate(mkConfig(), 'ws-1');
    expect(e.args[3]).toBe('/tmp/ws-one');
  });

  it('③ 留空且工作区 directoryPath 也为空 → 拒启（明确报错）', async () => {
    const root = seedPlugin();
    seedDb(root);
    getDb()
      .prepare(`UPDATE workspaces SET directory_path = '' WHERE id = 'ws-1'`)
      .run();
    await expect(expandMcpTemplate(mkConfig(), 'ws-1')).rejects.toThrow(/workspaceRoot|工作区目录/);
  });

  it('④ ${engineBin} 探针：engine 目录缺失 → 报错含重装提示', async () => {
    const root = seedPlugin(false);
    seedDb(root);
    await expect(expandMcpTemplate(mkConfig(), 'ws-1')).rejects.toThrow(/engine.*缺失|重装/);
  });

  it('⑤ 非插件 source / 无占位符 → 原样返回（存量 MCP 零影响）', async () => {
    const plain = mkConfig({
      source: 'custom',
      pluginId: undefined,
      command: 'npx',
      args: ['-y', 'some-server'],
      env: { K: 'v' },
    });
    const e = await expandMcpTemplate(plain, 'ws-1');
    expect(e).toEqual({ command: 'npx', args: ['-y', 'some-server'], env: { K: 'v' } });
  });

  it('⑥ 混合文本与多处占位符 + 敏感值经缓存展开', async () => {
    const root = seedPlugin();
    seedDb(root);
    await writePluginConfig(PID, SCHEMA, { workspaceRoot: '/r', apiToken: 'sk-live' }, 'ws-1');
    const cfg = mkConfig({
      args: ['--root=${config.workspaceRoot}/sub'],
      env: { T: 'token=${config.apiToken}', M: 'plain' },
    });
    const e = await expandMcpTemplate(cfg, 'ws-1');
    expect(e.args).toEqual(['--root=/r/sub']);
    expect(e.env).toEqual({ T: 'token=sk-live', M: 'plain' });
  });

  it('⑦ 无对应 config 键的占位符（manifest 未声明）→ 拒启（可观察）', async () => {
    const root = seedPlugin();
    seedDb(root);
    const cfg = mkConfig({ args: ['${config.unknownKey}'] });
    await expect(expandMcpTemplate(cfg, 'ws-1')).rejects.toThrow(/unknownKey|未声明/);
  });
});
