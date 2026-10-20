// electron/tests/plugin/plugin-mcp-autoassign.test.ts
//
// 插件 MCP 默认注入（D2 裁定 2026-10-20：装即所有工作空间可用）RED：
//   ① 安装注入：插件装好 → 全部现存 ws 获得 (ws, 'mcp', <server>) allocation
//   ② 新 ws 回填：新建工作空间 → 自动继承全部 plugin source MCP
//   ③ 卸载级联：卸载插件 → 各 ws 对应 allocation 行清除
//   ④ 资源列点亮：resource.list({type:'mcp'}) 含 source='plugin' 行（不可手动删）
//   ⑤ 手动移除持久性：删行后 syncPluginMcps（reload 路径）不回填
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDb, runMigrations, getDb } from '../../src/main/storage/db';
import { installPluginDevDir, uninstallPlugin } from '../../src/main/plugin/installer';
import { syncPluginMcps } from '../../src/main/plugin/mcp-sync';
import { createWorkspace } from '../../src/main/workspace/crud';
import { listCustomResources } from '../../src/main/resource/custom';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pauto-'));

function mkDevPlugin(id = 'cgp'): string {
  const devDir = path.join(tmpRoot, `plugin-${id}`);
  fs.mkdirSync(path.join(devDir, 'mcp'), { recursive: true });
  fs.writeFileSync(
    path.join(devDir, 'momo-plugin.json'),
    JSON.stringify({
      id,
      name: 'P',
      version: '1.0.0',
      description: 'd',
      components: { mcp: './mcp/mcp.json' },
    }),
  );
  fs.writeFileSync(
    path.join(devDir, 'mcp', 'mcp.json'),
    JSON.stringify({ servers: { 'cg-server': { command: 'npx', args: ['-y', 's'] } } }),
  );
  return devDir;
}

function seedTwoWorkspaces(): void {
  const db = getDb();
  for (const [id, name] of [
    ['ws-1', 'W1'],
    ['ws-2', 'W2'],
  ] as const) {
    db.prepare(
      `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, '/tmp/x', '@o')`,
    ).run(id, name);
  }
}

function allocations(): Array<{ workspace_id: string; capability_ref: string }> {
  return getDb()
    .prepare(
      `SELECT workspace_id, capability_ref FROM workspace_allocations WHERE capability_type='mcp' ORDER BY workspace_id`,
    )
    .all() as Array<{ workspace_id: string; capability_ref: string }>;
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

describe('插件 MCP 默认注入（D2：所有工作空间）', () => {
  it('① 安装注入：dev 注册 → 全部现存 ws 获得 allocation', () => {
    seedTwoWorkspaces();
    installPluginDevDir(mkDevPlugin(), '2.1.0');
    expect(allocations()).toEqual([
      { workspace_id: 'ws-1', capability_ref: 'cg-server' },
      { workspace_id: 'ws-2', capability_ref: 'cg-server' },
    ]);
  });

  it('② 新 ws 回填：createWorkspace 自动继承 plugin MCP', async () => {
    seedTwoWorkspaces();
    installPluginDevDir(mkDevPlugin(), '2.1.0');
    const ws = await createWorkspace(
      { name: 'W3', directoryPath: path.join(tmpRoot, 'w3') },
      '@o',
    );
    const refs = allocations().filter((a) => a.workspace_id === ws.id);
    expect(refs).toEqual([{ workspace_id: ws.id, capability_ref: 'cg-server' }]);
  });

  it('③ 卸载级联：uninstallPlugin 清各 ws allocation 行', () => {
    seedTwoWorkspaces();
    installPluginDevDir(mkDevPlugin(), '2.1.0');
    uninstallPlugin('cgp');
    expect(allocations()).toEqual([]);
  });

  it('④ 资源列点亮：resource.list mcp 含 plugin 源（不可手动删）', () => {
    seedTwoWorkspaces();
    installPluginDevDir(mkDevPlugin(), '2.1.0');
    const items = listCustomResources().filter((i) => i.slug === 'cg-server');
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe('plugin');
    expect(items[0]!.removable).toBe(false);
  });

  it('⑤ 手动移除持久性：删行后 syncPluginMcps（reload 路径）不回填', () => {
    seedTwoWorkspaces();
    installPluginDevDir(mkDevPlugin(), '2.1.0');
    const db = getDb();
    db.prepare(`DELETE FROM workspace_allocations WHERE capability_ref='cg-server'`).run();
    const rec = db
      .prepare(`SELECT id, version, manifest_json, state, source, source_path, installed_at FROM plugins WHERE id='cgp'`)
      .get() as Parameters<typeof syncPluginMcps>[0];
    syncPluginMcps(rec);
    expect(allocations()).toEqual([]);
  });
});
