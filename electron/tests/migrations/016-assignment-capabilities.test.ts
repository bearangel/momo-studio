// electron/tests/migrations/016-assignment-capabilities.test.ts
//
// v1.6 迁移 v16 测试：
//   1. agent_assignment_capabilities 表（Layer 3 per-assignment 能力 delta，含 ON DELETE CASCADE）
//   2. mcp_definitions 加 source 列（默认 'marketplace'，区分市场安装 vs 用户自定义）
//   3. mcp_definitions 加 installed_at 列（安装时间戳）
//   4. builtin agent_definitions 的 default_tools 强制写为 24 工具 JSON
//   5. cascade delete：assignment 删除时 delta 自动清理
//
// 注意：v23 会 RENAME workspaces.matrix_space_id 和 agent_assignments.bot_matrix_user_id。
// 故本测试只 apply 到 v16（applyUpToVersion(16)），不复用 012 之前用
// runMigrations() + getDb() 单例的写法——后者会把 v23 也跑掉，破坏本测试 INSERT 断言。
// 模式参照 012-agent-role-separation.test.ts。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { loadMigrations, BUILTIN_DEFAULT_TOOLS_JSON } from '../../src/main/storage/migrations';

let db: DB;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );
  const markApplied = db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)',
  );
  for (const m of loadMigrations().filter((m) => m.version <= 16)) {
    db.exec(m.sql);
    markApplied.run(m.version);
  }
});

afterAll(() => {
  db.close();
});

describe('migration v16: agent_assignment_capabilities + mcp_definitions 扩展 + builtin 修复', () => {
  it('创建 agent_assignment_capabilities 表，含 CASCADE 外键', () => {
    const info = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_assignment_capabilities'",
      )
      .get() as { sql: string };
    expect(info).toBeDefined();
    expect(info.sql).toContain('assignment_id');
    expect(info.sql).toContain('capability_type');
    expect(info.sql).toContain('mode');
    expect(info.sql).toContain('ON DELETE CASCADE');
  });

  it('mcp_definitions 加 source 列，默认 marketplace', () => {
    const cols = db.prepare('PRAGMA table_info(mcp_definitions)').all() as Array<{
      name: string;
    }>;
    expect(cols.some((c) => c.name === 'source')).toBe(true);
    // 默认值通过 INSERT 验证：仅提供必填列，source 应自动填 'marketplace'
    db.prepare(
      'INSERT INTO mcp_definitions (id, name, version, command, args) VALUES (?, ?, ?, ?, ?)',
    ).run('t1', 'test-mcp', '1.0.0', 'npx', '[]');
    const row = db.prepare('SELECT source FROM mcp_definitions WHERE id = ?').get('t1') as {
      source: string;
    };
    expect(row.source).toBe('marketplace');
  });

  it('mcp_definitions 加 installed_at 列', () => {
    const cols = db.prepare('PRAGMA table_info(mcp_definitions)').all() as Array<{
      name: string;
    }>;
    expect(cols.some((c) => c.name === 'installed_at')).toBe(true);
  });

  it('v16 builtin 修复：default_tools 写为 24 工具 JSON', () => {
    // 模拟 v1.5 旧数据：builtin def 的 default_tools 只有空数组
    db.prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, runtime, system_prompt, default_tools, source, model_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('builtin-test', '测试', 'test', '1.0.0', 'declarative', 'prompt', '[]', 'builtin', 'm');

    // migration 在 beforeAll 已执行，但当时表中无 builtin 数据，UPDATE 未命中任何行。
    // 此处手动执行与 v16 migration 完全相同的 UPDATE（使用同一个导出常量），
    // 验证 SQL 语句 + BUILTIN_DEFAULT_TOOLS_JSON 常量在真实数据上的正确性。
    db.prepare("UPDATE agent_definitions SET default_tools = ? WHERE source = 'builtin'").run(
      BUILTIN_DEFAULT_TOOLS_JSON,
    );

    const row = db.prepare('SELECT default_tools FROM agent_definitions WHERE id = ?').get(
      'builtin-test',
    ) as { default_tools: string };
    const tools = JSON.parse(row.default_tools) as Array<{ ref: string }>;
    expect(tools).toHaveLength(24);
    expect(tools.some((t) => t.ref === 'bash')).toBe(true);
    expect(tools.some((t) => t.ref === 'lsp_find_references')).toBe(true);
  });

  it('cascade delete：assignment 删除时 delta 自动清理', () => {
    // 外键约束要求 agent_definitions + workspaces + agent_assignments 都存在
    db.prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, runtime, system_prompt, default_tools, source, model_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('def1', 'A', 'a', '1', 'declarative', 'p', '[]', 'custom', 'm');
    db.prepare(
      `INSERT INTO workspaces
         (id, name, description, directory_path, matrix_space_id, git_initialized, owner_id, icon_emoji)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('ws1', 'WS', '', '/tmp', '!s:r', 0, '@owner:s', '📁');
    db.prepare(
      `INSERT INTO agent_assignments
         (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id, enabled, role)
       VALUES (?, ?, ?, ?, 1, 'standalone')`,
    ).run('inst1', 'ws1', 'def1', '@bot:s');
    db.prepare(
      'INSERT INTO agent_assignment_capabilities (assignment_id, capability_type, mode, ref) VALUES (?, ?, ?, ?)',
    ).run('inst1', 'tool', 'add', 'bash');

    // 删除 assignment，delta 行应通过 ON DELETE CASCADE 自动清理
    db.prepare('DELETE FROM agent_assignments WHERE instance_id = ?').run('inst1');
    const cnt = db
      .prepare('SELECT COUNT(*) as c FROM agent_assignment_capabilities WHERE assignment_id = ?')
      .get('inst1') as { c: number };
    expect(cnt.c).toBe(0);
  });
});
