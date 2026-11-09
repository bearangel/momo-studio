// electron/tests/storage/migrations/073-list-workgroups-backfill.test.ts
//
// 迁移 073 回归锁：list_workgroups 只加不减幂等并入 agent 定义 default_tools
// （存量 agent 可见性——2026-11-09 会话实测 defaultOn:false 上线导致工具对
// 全部存量 agent 不可见）。空/已有/畸形三态覆盖。
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../../src/main/storage/db';

const tmpRoot = path.join(os.tmpdir(), `ap-mig073-${Date.now()}-${Math.random().toString(36).slice(2)}`);

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

function insertDef(id: string, defaultTools: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO agent_definitions (id, slug, name, version, runtime, system_prompt, default_tools, default_mcps, default_skills, source, model_provider_id, model_name)
       VALUES (?, ?, ?, '1.0.0', 'declarative', '你是测试', ?, '[]', '[]', 'custom', NULL, 'glm-5.3')`,
    )
    .run(id, id, id, defaultTools);
}

function toolsOf(id: string): string[] {
  const row = getDb()
    .prepare('SELECT default_tools FROM agent_definitions WHERE id = ?')
    .get(id) as { default_tools: string };
  return (JSON.parse(row.default_tools) as Array<{ ref: string }>).map((t) => t.ref);
}

describe('migration073 list_workgroups 回填', () => {
  it('空 default_tools → 回填后恰含 list_workgroups；既有条目保留', () => {
    insertDef('d-empty', '[]'); // schema NOT NULL——NULL 态不可达，COALESCE 仅为迁移期防御
    insertDef('d-rich', JSON.stringify([{ kind: 'builtin', ref: 'read_file' }]));
    getDb().exec(`DELETE FROM schema_migrations WHERE version = 73`);
    runMigrations();
    expect(toolsOf('d-empty')).toContain('list_workgroups');
    expect(toolsOf('d-rich')).toEqual(expect.arrayContaining(['read_file', 'list_workgroups']));
  });

  it('已有 list_workgroups → 幂等不重复（只加不减）', () => {
    insertDef('d-has', JSON.stringify([{ kind: 'builtin', ref: 'list_workgroups' }, { kind: 'builtin', ref: 'grep' }]));
    getDb().exec(`DELETE FROM schema_migrations WHERE version = 73`);
    runMigrations();
    const tools = toolsOf('d-has');
    expect(tools.filter((t) => t === 'list_workgroups')).toHaveLength(1);
    expect(tools).toContain('grep');
  });

  it('畸形条目（无 ref）跳过不炸，合法条目与回填共存', () => {
    insertDef('d-bad', JSON.stringify([{ kind: 'builtin' }])); // 无 ref 条目——json_extract → NULL 被过滤（标量条目会致 json_each 解析错，非合法存量形态）
    getDb().exec(`DELETE FROM schema_migrations WHERE version = 73`);
    expect(() => runMigrations()).not.toThrow();
    expect(toolsOf('d-bad')).toContain('list_workgroups');
  });
});
