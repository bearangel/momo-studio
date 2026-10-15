// electron/tests/plugin/registry.test.ts
//
// 注册表 CRUD + 启停语义锁（spec §7.1：行缺失 = 启用）+ dev 源 missing 检测。
// 真实 DB 全链（tmpdir + AP_USER_DATA_DIR + runMigrations）——FK 强制开启，
// plugin_enablements 写入前须先种 workspace 行。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';
import {
  listPlugins,
  upsertPlugin,
  getPlugin,
  removePluginRecord,
  isPluginEnabled,
  setPluginEnabled,
} from '../../src/main/plugin/registry';
import type { PluginRecord } from '../../src/main/plugin/types';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-preg-'));

function mkRec(over: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: 'cg',
    version: '0.1.0',
    manifestJson: '{}',
    state: 'active',
    source: 'zip',
    sourcePath: null,
    installedAt: '2026-10-15T00:00:00Z',
    ...over,
  };
}

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

describe('registry CRUD', () => {
  it('upsert 后可 get / list；重复 upsert 同 id 覆盖不重复', () => {
    upsertPlugin(mkRec());
    upsertPlugin(mkRec({ version: '0.2.0' }));
    expect(listPlugins()).toHaveLength(1);
    expect(getPlugin('cg')?.version).toBe('0.2.0');
  });

  it('removePluginRecord 删除行', () => {
    upsertPlugin(mkRec());
    removePluginRecord('cg');
    expect(getPlugin('cg')).toBeNull();
  });
});

describe('启停语义（spec §7.1：行缺失 = 启用）', () => {
  it('无行 → enabled true；置 0 → false；重启用 → true；其他 workspace 不受影响', () => {
    seedWorkspace('ws1');
    seedWorkspace('ws2');
    upsertPlugin(mkRec());
    expect(isPluginEnabled('cg', 'ws1')).toBe(true);
    setPluginEnabled('cg', 'ws1', false);
    expect(isPluginEnabled('cg', 'ws1')).toBe(false);
    expect(isPluginEnabled('cg', 'ws2')).toBe(true);
    setPluginEnabled('cg', 'ws1', true);
    expect(isPluginEnabled('cg', 'ws1')).toBe(true);
  });

  it('插件删除后 enablement 行级联清除（ON DELETE CASCADE）', () => {
    seedWorkspace('ws1');
    upsertPlugin(mkRec());
    setPluginEnabled('cg', 'ws1', false);
    removePluginRecord('cg');
    const rows = getDb()
      .prepare(`SELECT * FROM plugin_enablements WHERE plugin_id = 'cg'`)
      .all();
    expect(rows).toHaveLength(0);
  });
});

describe('dev 源 missing 检测', () => {
  it('sourcePath 目录消失 → listPlugins 标 missing；目录恢复 → 回 active', () => {
    const devDir = path.join(tmpRoot, 'my-plugin');
    fs.mkdirSync(devDir, { recursive: true });
    upsertPlugin(mkRec({ source: 'dev', sourcePath: devDir }));
    expect(listPlugins()[0]!.state).toBe('active');
    fs.rmSync(devDir, { recursive: true, force: true });
    expect(listPlugins()[0]!.state).toBe('missing');
    fs.mkdirSync(devDir, { recursive: true });
    expect(listPlugins()[0]!.state).toBe('active');
  });
});
