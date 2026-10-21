// electron/tests/plugin/plugin-mcp-autoassign.test.ts
//
// 安装即作用域（spec 2026-10-21 §5，取代 D2「装即所有工作空间」语义）：
//   ① 安装零 allocation：mcp_definitions 注册（能力池）但 workspace_allocations 零写入；
//      enablements 仅 (originWs, plugin, 1) 一行
//   ② 新 ws 不回填：新建工作空间 → 无任何 plugin MCP 注入（backfill 已退役）
//   ③ 卸载级联：卸载插件 → mcp 定义 + 各 ws 对应 allocation 行清除
//   ④ 资源列点亮：resource.list({type:'mcp'}) 含 source='plugin' 行（不可手动删）
//   ⑤ 手动移除持久性：删行后 syncPluginMcps（reload 路径）不回填
//   ⑥ 无 origin ws → 拒装（报错且不落盘）
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

describe('安装即作用域（spec 2026-10-21 §5）', () => {
  it('① 安装于 ws-1 → MCP 定义注册但 allocation 零写入；enablements 仅 origin 一行', () => {
    seedTwoWorkspaces();
    installPluginDevDir(mkDevPlugin(), '2.1.0', 'ws-1');
    const db = getDb();
    const defs = db
      .prepare(`SELECT name FROM mcp_definitions WHERE source='plugin' AND plugin_id='cgp'`)
      .all() as Array<{ name: string }>;
    expect(defs.map((d) => d.name)).toEqual(['cg-server']); // 能力池注册 ✓
    const allocs = db
      .prepare(`SELECT COUNT(*) AS c FROM workspace_allocations WHERE capability_type='mcp' AND capability_ref='cg-server'`)
      .get() as { c: number };
    expect(allocs.c).toBe(0); // 零注入
    const en = db
      .prepare(`SELECT workspace_id, enabled FROM plugin_enablements WHERE plugin_id='cgp'`)
      .all() as Array<{ workspace_id: string; enabled: number }>;
    expect(en).toEqual([{ workspace_id: 'ws-1', enabled: 1 }]); // 仅 origin ws
  });

  it('② 新 ws 不回填：createWorkspace 后无 plugin MCP 注入', async () => {
    seedTwoWorkspaces();
    installPluginDevDir(mkDevPlugin(), '2.1.0', 'ws-1');
    const ws3 = await createWorkspace({ name: 'W3', directoryPath: path.join(tmpRoot, 'w3') }, '@o');
    const db = getDb();
    const rows = db
      .prepare(`SELECT COUNT(*) AS c FROM workspace_allocations WHERE workspace_id=? AND capability_type='mcp'`)
      .get(ws3.id) as { c: number };
    expect(rows.c).toBe(0);
    const en = db
      .prepare(`SELECT COUNT(*) AS c FROM plugin_enablements WHERE workspace_id=? AND plugin_id='cgp'`)
      .get(ws3.id) as { c: number };
    expect(en.c).toBe(0); // 新 ws 默认停用
  });

  it('③ 卸载级联：mcp 定义 + 各 ws allocation 行清除', () => {
    seedTwoWorkspaces();
    installPluginDevDir(mkDevPlugin(), '2.1.0', 'ws-1');
    // 模拟用户显式授权（allocation 行）后卸载
    getDb()
      .prepare(`INSERT INTO workspace_allocations (workspace_id, capability_type, capability_ref) VALUES ('ws-1', 'mcp', 'cg-server')`)
      .run();
    uninstallPlugin('cgp', true);
    const db = getDb();
    expect(
      db.prepare(`SELECT COUNT(*) AS c FROM mcp_definitions WHERE plugin_id='cgp'`).get(),
    ).toMatchObject({ c: 0 });
    expect(
      db.prepare(`SELECT COUNT(*) AS c FROM workspace_allocations WHERE capability_ref='cg-server'`).get(),
    ).toMatchObject({ c: 0 });
  });

  it('④ 资源列点亮：resource.list({type:\'mcp\'}) 含 source=plugin 行', () => {
    seedTwoWorkspaces();
    installPluginDevDir(mkDevPlugin(), '2.1.0', 'ws-1');
    const rows = listCustomResources().filter((r) => r.type === 'mcp' && r.source === 'plugin');
    expect(rows.some((r) => r.slug === 'cg-server' && r.removable === false)).toBe(true);
  });

  it('⑤ 手动移除持久性：删 allocation 行后 syncPluginMcps（reload 路径）不回填', () => {
    seedTwoWorkspaces();
    const rec = installPluginDevDir(mkDevPlugin(), '2.1.0', 'ws-1');
    getDb()
      .prepare(`INSERT INTO workspace_allocations (workspace_id, capability_type, capability_ref) VALUES ('ws-1', 'mcp', 'cg-server')`)
      .run();
    getDb()
      .prepare(`DELETE FROM workspace_allocations WHERE capability_ref='cg-server'`)
      .run();
    syncPluginMcps(rec);
    expect(
      getDb()
        .prepare(`SELECT COUNT(*) AS c FROM workspace_allocations WHERE capability_ref='cg-server'`)
        .get(),
    ).toMatchObject({ c: 0 });
  });

  it('⑥ 无 origin ws → 拒装且不落盘', () => {
    seedTwoWorkspaces();
    expect(() => installPluginDevDir(mkDevPlugin('noWs'), '2.1.0', '')).toThrow('无法确定安装作用域');
    expect(
      getDb().prepare(`SELECT COUNT(*) AS c FROM plugins WHERE id='noWs'`).get(),
    ).toMatchObject({ c: 0 });
  });
});
