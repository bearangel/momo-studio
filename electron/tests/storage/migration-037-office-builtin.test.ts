// electron/tests/storage/migration-037-office-builtin.test.ts
//
// 迁移 037 测试：builtin agent defaultTools 同步 office 八工具（v2.1）。
// 与 v32 测试（migration-v32.test.ts）同模式，但种子场景更丰富：
//   - builtin 行追加全部 8 个 office 工具（缺失则补，已含则跳过）
//   - custom 行不动（source='custom' 不在 WHERE 守卫内）
//   - 幂等：重复执行 up SQL 不重复插入
//
// 列名 default_tools（v3 建列），元素形态 {"kind":"builtin","ref":"..."}，
// 命中判定看 ref 字段（json_extract(value, '$.ref')）。

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations } from '../../src/main/storage/migrations';
import { migration037 } from '../../src/main/storage/migrations/037_v2_1_office_tools_builtin';

const V36 = 36;

const OFFICE_TOOLS = [
  'office_read', 'office_read_cells', 'office_create_excel', 'office_write_excel',
  'office_create_doc', 'office_create_ppt', 'office_create_pdf', 'office_copy',
] as const;

function applyUpTo(db: DB, version: number): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
  const markApplied = db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)');
  for (const m of loadMigrations()) {
    if (m.version > version) break;
    db.exec(m.sql);
    markApplied.run(m.version);
  }
}

/** 生产写入格式：saveAgentDefinition 落库的 {kind, ref} 对象数组 */
function toolsJson(refs: string[]): string {
  return JSON.stringify(refs.map((ref) => ({ kind: 'builtin', ref })));
}

function seedDef(db: DB, id: string, source: 'builtin' | 'custom', tools: string): void {
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools, source, model_name)
     VALUES (?, ?, ?, ?, 'declarative', 'prompt', ?, ?, 'm')`,
  ).run(id, id, id, '1.0.0', tools, source);
}

function getDefaultTools(db: DB, id: string): Array<{ kind: string; ref: string }> {
  const row = db
    .prepare('SELECT default_tools FROM agent_definitions WHERE id = ?')
    .get(id) as { default_tools: string };
  return JSON.parse(row.default_tools) as Array<{ kind: string; ref: string }>;
}

describe('migration 037：builtin defaultTools 同步 office 八工具', () => {
  it('builtin 行追加 8 个 office 工具（对象格式，既有条目保留）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, V36);

    seedDef(db, 'builtin-coder', 'builtin', toolsJson(['read_file', 'write_file', 'edit_file']));
    seedDef(db, 'builtin-empty', 'builtin', '[]');

    db.exec(migration037.up);

    const coder = getDefaultTools(db, 'builtin-coder');
    // 既有条目原样保留（追加不重写）
    expect(coder.slice(0, 3)).toEqual([
      { kind: 'builtin', ref: 'read_file' },
      { kind: 'builtin', ref: 'write_file' },
      { kind: 'builtin', ref: 'edit_file' },
    ]);
    // 八工具全部追加到位（元素形态是对象，非裸字符串）
    for (const t of OFFICE_TOOLS) {
      const hit = coder.find((x) => x.ref === t);
      expect(hit, `缺少 office 工具 ${t}`).toEqual({ kind: 'builtin', ref: t });
    }

    const empty = getDefaultTools(db, 'builtin-empty');
    // 空数组行追加八项
    expect(empty).toHaveLength(OFFICE_TOOLS.length);
    expect(empty.map((t) => t.ref).sort()).toEqual([...OFFICE_TOOLS].sort());
    db.close();
  });

  it('custom 行不受影响（source 守卫）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, V36);

    seedDef(db, 'custom-1', 'custom', toolsJson(['read_file', 'edit_file']));

    db.exec(migration037.up);

    expect(getDefaultTools(db, 'custom-1')).toEqual([
      { kind: 'builtin', ref: 'read_file' },
      { kind: 'builtin', ref: 'edit_file' },
    ]);
    db.close();
  });

  it('幂等：已含 office 工具的行不再命中（重复 up 不重复插入）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, V36);

    seedDef(db, 'builtin-already', 'builtin', toolsJson([
      'read_file', 'office_read',
    ]));

    db.exec(migration037.up);
    db.exec(migration037.up);

    const tools = getDefaultTools(db, 'builtin-already');
    // 已含的 office_read 不重复
    expect(tools.filter((t) => t.ref === 'office_read')).toHaveLength(1);
    // 二次执行后其余七项各只 1 份
    for (const t of OFFICE_TOOLS) {
      expect(tools.filter((x) => x.ref === t), `重复 up 导致 ${t} 多份`).toHaveLength(1);
    }
    db.close();
  });
});
