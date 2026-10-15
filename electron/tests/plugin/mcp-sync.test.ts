// electron/tests/plugin/mcp-sync.test.ts
//
// 插件 MCP 激活锁（spec §10 P2）：合法 npx 条目注册 source='plugin' + plugin_id
// 归属 / 非法 command 跳过 / 幂等 / removePluginMcps 只删本插件条目并清 agent 引用。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';
import { syncPluginMcps, removePluginMcps } from '../../src/main/plugin/mcp-sync';
import { upsertPlugin } from '../../src/main/plugin/registry';
import type { PluginRecord } from '../../src/main/plugin/types';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pmsync-'));

function mkPlugin(id: string, mcpJson: string): PluginRecord {
  const root = path.join(tmpRoot, 'plugins', 'installed', id, '0.1.0');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'mcp.json'), mcpJson);
  fs.writeFileSync(
    path.join(root, 'momo-plugin.json'),
    JSON.stringify({
      id,
      name: id,
      version: '0.1.0',
      description: '',
      components: { mcp: './mcp.json' },
    }),
  );
  return {
    id,
    version: '0.1.0',
    manifestJson: fs.readFileSync(path.join(root, 'momo-plugin.json'), 'utf-8'),
    state: 'active',
    source: 'zip',
    sourcePath: null,
    installedAt: 'x',
  };
}

function mcpRow(name: string): { source: string; plugin_id: string | null } | undefined {
  return getDb()
    .prepare(`SELECT source, plugin_id FROM mcp_definitions WHERE name = ?`)
    .get(name) as { source: string; plugin_id: string | null } | undefined;
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('syncPluginMcps', () => {
  it('合法 npx 条目注册 source=plugin + plugin_id；非法 command 跳过', () => {
    const rec = mkPlugin(
      'cg',
      JSON.stringify({
        servers: {
          'cg-fetch': { command: 'npx', args: ['-y', 'cg-fetch@1'] },
          'cg-bad': { command: 'rm -rf /', args: [] },
        },
      }),
    );
    upsertPlugin(rec);
    const registered = syncPluginMcps(rec);
    expect(registered).toEqual(['cg-fetch']);
    const row = mcpRow('cg-fetch');
    expect(row).toBeTruthy();
    expect(row!.source).toBe('plugin');
    expect(row!.plugin_id).toBe('cg');
    expect(mcpRow('cg-bad')).toBeUndefined();
  });

  it('重复 sync 幂等（不重复行）', () => {
    const rec = mkPlugin(
      'cg',
      JSON.stringify({ servers: { 'cg-fetch': { command: 'npx', args: ['-y', 'cg-fetch@1'] } } }),
    );
    upsertPlugin(rec);
    syncPluginMcps(rec);
    syncPluginMcps(rec);
    const rows = getDb()
      .prepare(`SELECT id FROM mcp_definitions WHERE name = 'cg-fetch'`)
      .all();
    expect(rows).toHaveLength(1);
  });

  it('manifest 无 mcp 组件 / 坏 JSON → 空列表不抛', () => {
    const plain = path.join(tmpRoot, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    fs.writeFileSync(
      path.join(plain, 'momo-plugin.json'),
      JSON.stringify({ id: 'plain', name: 'p', version: '0.1.0', description: '', components: {} }),
    );
    const rec: PluginRecord = {
      id: 'plain',
      version: '0.1.0',
      manifestJson: fs.readFileSync(path.join(plain, 'momo-plugin.json'), 'utf-8'),
      state: 'active',
      source: 'zip',
      sourcePath: null,
      installedAt: 'x',
    };
    upsertPlugin(rec);
    expect(syncPluginMcps(rec)).toEqual([]);
    const broken = mkPlugin('broken', 'not json');
    upsertPlugin(broken);
    expect(syncPluginMcps(broken)).toEqual([]);
  });
});

describe('removePluginMcps', () => {
  it('只删本插件条目（他插件条目保留）并清 agent 引用', () => {
    const a = mkPlugin(
      'a',
      JSON.stringify({ servers: { 'a-srv': { command: 'npx', args: ['-y', 'a-srv'] } } }),
    );
    const b = mkPlugin(
      'b',
      JSON.stringify({ servers: { 'b-srv': { command: 'npx', args: ['-y', 'b-srv'] } } }),
    );
    upsertPlugin(a);
    upsertPlugin(b);
    syncPluginMcps(a);
    syncPluginMcps(b);
    removePluginMcps('a');
    expect(mcpRow('a-srv')).toBeUndefined();
    expect(mcpRow('b-srv')).toBeTruthy();
    expect(mcpRow('b-srv')!.plugin_id).toBe('b');
  });
});
