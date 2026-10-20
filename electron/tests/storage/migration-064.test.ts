// electron/tests/storage/migration-064.test.ts
//
// 引擎整合 T6 RED（spec §5.2）：codegraph 插件工具门控迁移——
// plugin_tool | remove | plugin:codegraph/* 行改写为 mcp | remove | codegraph
// （INSERT OR IGNORE 防主键冲突）；其他插件的 plugin_tool 行不动；
// down 保守清 codegraph mcp remove 行（语义已在 v2.0 变更，不重建旧行）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDb, runMigrations, getDb } from '../../src/main/storage/db';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-m064-'));

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

function seedRows(): void {
  runMigrations(); // 建库建表（064 对空表=无操作；效果经下方 down/up 重放演练）
  const db = getDb();
  // workspace_agent_members 外键父表（assignment_id 引用 instance_id）
  db.prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('w', 'W', '/tmp', '@o')`,
  ).run();
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools, source, model_name)
     VALUES ('d1', 'A1', 'a1', '1', 'declarative', 'p', '[]', 'custom', 'm')`,
  ).run();
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools, source, model_name)
     VALUES ('d2', 'A2', 'a2', '1', 'declarative', 'p', '[]', 'custom', 'm')`,
  ).run();
  db.prepare(
    `INSERT INTO workspace_agent_members
       (instance_id, workspace_id, agent_definition_id, agent_user_id)
     VALUES ('inst1', 'w', 'd1', '@bot:1'), ('inst2', 'w', 'd2', '@bot:2')`,
  ).run();
  const ins = db.prepare(
    `INSERT INTO agent_assignment_capabilities (assignment_id, capability_type, mode, ref)
     VALUES (?, ?, ?, ?)`,
  );
  // 场景数据：codegraph 整组禁（迁移对象）、codegraph 单工具行（同样迁移面）、
  // 其他插件行（不动）、既有 mcp remove codegraph 行（主键冲突演练）
  ins.run('inst1', 'plugin_tool', 'remove', 'plugin:codegraph/*');
  ins.run('inst1', 'plugin_tool', 'remove', 'plugin:other/*');
  ins.run('inst2', 'plugin_tool', 'remove', 'plugin:codegraph/explore');
  ins.run('inst2', 'mcp', 'remove', 'codegraph');
}

describe('migration 064：codegraph plugin_tool → mcp 门控', () => {
  it('⓪ 注册验证：loadMigrations 含 version 64（终审后补——数组注册曾静默失败）', async () => {
    const { loadMigrations } = await import('../../src/main/storage/migrations');
    expect(loadMigrations().some((m) => m.version === 64)).toBe(true);
  });


  it('up：remove 整组行 → mcp|remove|codegraph；其他插件行不动；冲突行不炸', async () => {
    seedRows();
    const m = (await import('../../src/main/storage/migrations/064_codegraph_plugin_tool_to_mcp')).migration064;
    getDb().exec(m.down); // 回退到 063 语义态（清 mcp remove codegraph 行）
    getDb().exec(m.up); // 重放迁移
    const rows = getDb()
      .prepare(
        `SELECT assignment_id, capability_type, mode, ref FROM agent_assignment_capabilities ORDER BY assignment_id, capability_type, ref`,
      )
      .all() as Array<{ assignment_id: string; capability_type: string; mode: string; ref: string }>;
    expect(rows).toContainEqual({
      assignment_id: 'inst1',
      capability_type: 'mcp',
      mode: 'remove',
      ref: 'codegraph',
    });
    // inst2 已有同主键 mcp 行 → INSERT OR IGNORE 不炸且不重复
    const inst2Mcp = rows.filter(
      (r) => r.assignment_id === 'inst2' && r.capability_type === 'mcp' && r.ref === 'codegraph',
    );
    expect(inst2Mcp).toHaveLength(1);
    // 其他插件行保留
    expect(rows).toContainEqual({
      assignment_id: 'inst1',
      capability_type: 'plugin_tool',
      mode: 'remove',
      ref: 'plugin:other/*',
    });
    // codegraph 的 plugin_tool 行全部清除（整组与单工具）
    const cgPluginTool = rows.filter((r) => r.ref.startsWith('plugin:codegraph/'));
    expect(cgPluginTool).toHaveLength(0);
  });

  it('down：清除 codegraph 的 mcp remove 行（保守，不重建 plugin_tool）', async () => {
    seedRows();
    const m = (
      await import('../../src/main/storage/migrations/064_codegraph_plugin_tool_to_mcp')
    ).migration064;
    const db = getDb();
    db.exec(m.up); // 先到迁移后态
    db.exec(m.down);
    const rows = db
      .prepare(`SELECT ref FROM agent_assignment_capabilities WHERE capability_type='mcp' AND ref='codegraph'`)
      .all() as Array<{ ref: string }>;
    expect(rows).toHaveLength(0);
  });
});
