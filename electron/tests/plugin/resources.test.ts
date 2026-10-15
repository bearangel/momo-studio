// electron/tests/plugin/resources.test.ts
//
// 插件行 → ResourceItem 映射锁（spec §8.1 资源库第四类型页数据源）：
// 三段式 id / plugin namespace 形状 / 启停入行（workspaceId 决定）/ listResources filter 接入。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';
import { upsertPlugin, setPluginEnabled } from '../../src/main/plugin/registry';
import { listPluginResourceRows } from '../../src/main/plugin/resources';
import { listResources } from '../../src/main/resource/library';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pres-'));

function seedWorkspace(id: string): void {
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run(id, 'Test', path.join(tmpRoot, id), '@owner:home');
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

describe('listPluginResourceRows', () => {
  it('映射 ResourceItem：type=plugin / source=custom / id 三段式 / components 列表', () => {
    upsertPlugin({
      id: 'cg',
      version: '0.1.0',
      manifestJson: JSON.stringify({
        id: 'cg',
        name: 'Codegraph',
        version: '0.1.0',
        description: '图谱',
        components: { tools: './tools', panel: './panel' },
      }),
      state: 'active',
      source: 'zip',
      sourcePath: null,
      installedAt: '2026-10-15T00:00:00Z',
    });
    const rows = listPluginResourceRows('ws1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'custom-plugin-cg',
      type: 'plugin',
      source: 'custom',
      slug: 'cg',
      name: 'Codegraph',
      installed: true,
      removable: true,
    });
    expect(rows[0].plugin).toMatchObject({
      state: 'active',
      devSource: false,
      sourcePath: null,
      components: ['tools', 'panel'],
      enabled: true,
    });
  });

  it('workspaceId 传入时 enabled 反映启停；缺省 enabled=true', () => {
    seedWorkspace('ws1');
    upsertPlugin({
      id: 'cg',
      version: '0.1.0',
      manifestJson: '{}',
      state: 'active',
      source: 'zip',
      sourcePath: null,
      installedAt: 'x',
    });
    setPluginEnabled('cg', 'ws1', false);
    expect(listPluginResourceRows('ws1')[0].plugin?.enabled).toBe(false);
    expect(listPluginResourceRows('ws2')[0].plugin?.enabled).toBe(true);
    expect(listPluginResourceRows()[0].plugin?.enabled).toBe(true);
  });

  it('manifest_json 损坏时降级为最小元数据行（不崩列表）', () => {
    upsertPlugin({
      id: 'broken',
      version: '0.1.0',
      manifestJson: 'not json',
      state: 'active',
      source: 'dev',
      sourcePath: '/tmp/somewhere',
      installedAt: 'x',
    });
    const rows = listPluginResourceRows();
    expect(rows[0].name).toBe('broken');
    expect(rows[0].plugin?.components).toEqual([]);
    expect(rows[0].plugin?.devSource).toBe(true);
  });
});

describe('listResources 接入', () => {
  it('filter.type=plugin 返回插件行；workspaceId 透传启停态', async () => {
    seedWorkspace('ws1');
    upsertPlugin({
      id: 'cg',
      version: '0.1.0',
      manifestJson: JSON.stringify({
        id: 'cg',
        name: 'Codegraph',
        version: '0.1.0',
        description: '图谱',
        components: {},
      }),
      state: 'active',
      source: 'zip',
      sourcePath: null,
      installedAt: 'x',
    });
    setPluginEnabled('cg', 'ws1', false);
    const rows = await listResources({ type: 'plugin', workspaceId: 'ws1' });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('custom-plugin-cg');
    expect(rows[0].plugin?.enabled).toBe(false);
  });
});
