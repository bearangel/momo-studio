// electron/tests/migrations/016-assignment-capabilities.test.ts
//
// v1.6 迁移 v16 测试：
//   1. agent_assignment_capabilities 表（Layer 3 per-assignment 能力 delta，含 ON DELETE CASCADE）
//   2. mcp_definitions 加 source 列（默认 'marketplace'，区分市场安装 vs 用户自定义）
//   3. mcp_definitions 加 installed_at 列（安装时间戳）
//   4. builtin agent_definitions 的 default_tools 强制写为 24 工具 JSON
//   5. cascade delete：assignment 删除时 delta 自动清理
//
// DB 隔离沿用仓库既定模式（参考 013/015 测试）：
//   - process.env.AP_USER_DATA_DIR 指向临时目录
//   - getDb() 单例 + foreign_keys = ON（cascade 依赖此 PRAGMA）
//   - closeDb() 在 afterEach 复位单例
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { BUILTIN_DEFAULT_TOOLS_JSON } from '../../src/main/storage/migrations';

const tmpRoot = path.join(os.tmpdir(), `ap-mig16-test-${Date.now()}`);

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

describe('migration v16: agent_assignment_capabilities + mcp_definitions 扩展 + builtin 修复', () => {
  it('创建 agent_assignment_capabilities 表，含 CASCADE 外键', () => {
    const db = getDb();
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
    const db = getDb();
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
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(mcp_definitions)').all() as Array<{
      name: string;
    }>;
    expect(cols.some((c) => c.name === 'installed_at')).toBe(true);
  });

  it('v16 builtin 修复：default_tools 写为 24 工具 JSON', () => {
    const db = getDb();
    // 模拟 v1.5 旧数据：builtin def 的 default_tools 只有空数组
    db.prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, runtime, system_prompt, default_tools, source, model_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('builtin-test', '测试', 'test', '1.0.0', 'declarative', 'prompt', '[]', 'builtin', 'm');

    // migration 在 beforeEach 已执行，但当时表中无 builtin 数据，UPDATE 未命中任何行。
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
    const db = getDb();
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
