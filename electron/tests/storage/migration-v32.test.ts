// electron/tests/storage/migration-v32.test.ts
//
// 迁移 v32 测试：builtin agent defaultTools 同步 apply_patch（v2.3 FileTools）。
//
//   1. builtin 行追加 {"kind":"builtin","ref":"apply_patch"}（对象格式，非裸字符串）
//   2. custom 行不受影响
//   3. 幂等：重复执行 up SQL 不重复插入
//
// 模式参照 migration-v30.test.ts：内存库跑真实迁移到 v31 → 按生产写入格式
// （crud.ts saveAgentDefinition 的 {kind, ref} 对象数组 JSON）注入 fixture → 应用 v32。
// 刻意不用手搓 default_tools_json 列的简化表——真实 schema 列名是 default_tools，
// 简化 fixture 会掩盖列名/格式漂移（momo-test-rules 铁律 1）。

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations } from '../../src/main/storage/migrations';
import { migration032 } from '../../src/main/storage/migrations/032_v2.3_builtin_apply_patch';

const V31 = 31;

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

describe('migration v32：builtin defaultTools 追加 apply_patch', () => {
  it('builtin 行追加 apply_patch（对象格式，既有条目保留）', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, V31);

    // 两个 builtin 行：v1.6 全集 24 工具 + 从未配置过的空数组（边界值）
    seedDef(db, 'builtin-coder', 'builtin', toolsJson(['read_file', 'write_file', 'edit_file']));
    seedDef(db, 'builtin-empty', 'builtin', '[]');

    db.exec(migration032.up);

    const coder = getDefaultTools(db, 'builtin-coder');
    const patch = coder.find((t) => t.ref === 'apply_patch');
    expect(patch).toEqual({ kind: 'builtin', ref: 'apply_patch' });
    // 既有条目原样保留（追加不重写）
    expect(coder.slice(0, 3)).toEqual([
      { kind: 'builtin', ref: 'read_file' },
      { kind: 'builtin', ref: 'write_file' },
      { kind: 'builtin', ref: 'edit_file' },
    ]);

    const empty = getDefaultTools(db, 'builtin-empty');
    expect(empty).toEqual([{ kind: 'builtin', ref: 'apply_patch' }]);
    db.close();
  });

  it('custom 行不受影响', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, V31);

    seedDef(db, 'custom-custom', 'custom', toolsJson(['read_file', 'edit_file']));

    db.exec(migration032.up);

    expect(getDefaultTools(db, 'custom-custom')).toEqual([
      { kind: 'builtin', ref: 'read_file' },
      { kind: 'builtin', ref: 'edit_file' },
    ]);
    db.close();
  });

  it('幂等：重复执行 up 不重复插入', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyUpTo(db, V31);

    seedDef(db, 'builtin-coder', 'builtin', toolsJson(['read_file', 'edit_file']));

    db.exec(migration032.up);
    db.exec(migration032.up);

    const tools = getDefaultTools(db, 'builtin-coder');
    const occurrences = tools.filter((t) => t.ref === 'apply_patch').length;
    expect(occurrences).toBe(1);
    expect(tools).toHaveLength(3);
    db.close();
  });
});
