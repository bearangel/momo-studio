// electron/tests/storage/074-momo-all-builtin-tools.test.ts
//
// 迁移 074 回归锁：Momo（builtin + general-assistant）default_tools 整列替换为
// 全部 58 个内置工具。覆盖：替换而非并入（旧 25 工具含已移除引用被清掉）、
// 非目标行零改动、重复重放幂等、冻结名单与 ALL_BUILTIN_TOOLS 全集一致。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { ALL_BUILTIN_TOOLS } from '../../src/main/agent/tools/catalog';
import {
  migration074,
  MOMO_ALL_BUILTIN_TOOL_REFS,
} from '../../src/main/storage/migrations/074_momo_all_builtin_tools';
import { MOMO_V23_ALL_BUILTIN_TOOL_REFS } from '../../src/main/storage/migrations/083_momo_lifecycle_v2_tools';

const tmpRoot = path.join(os.tmpdir(), `ap-mig074-test-${Date.now()}-${process.pid}`);

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

function insertDef(id: string, source: string, slug: string, refs: string[]): void {
  const defaultTools = JSON.stringify(refs.map((ref) => ({ kind: 'builtin', ref })));
  getDb()
    .prepare(
      `INSERT INTO agent_definitions
         (id, slug, name, version, runtime, system_prompt, default_tools, default_mcps,
          default_skills, source, model_provider_id, model_name)
       VALUES (?, ?, ?, '1.0.0', 'declarative', '你是测试', ?, '[]', '[]', ?, NULL, 'glm-5.3')`,
    )
    .run(id, slug, id, defaultTools, source);
}

function readTools(id: string): Array<{ kind: string; ref: string }> {
  const row = getDb().prepare('SELECT default_tools FROM agent_definitions WHERE id = ?').get(id) as {
    default_tools: string;
  };
  return JSON.parse(row.default_tools) as Array<{ kind: string; ref: string }>;
}

function replay(): void {
  getDb().exec(migration074.sql);
}

describe('migration 074 Momo 全量内置工具回填', () => {
  it('用例 A：builtin general-assistant 行由旧 25 工具替换为 58 工具全集（顺序保持）', () => {
    // 旧 25 工具：v1.6 24 工具 + 1 条已移除的 LSP 引用，验证「替换」而非 union
    const oldTools = [
      'read_file', 'write_file', 'list_files', 'edit_file', 'mkdir', 'rm', 'mv', 'exists',
      'grep', 'glob', 'bash',
      'git_status', 'git_diff', 'git_log', 'git_show', 'git_add', 'git_commit',
      'git_branch', 'git_checkout', 'git_stash',
      'webfetch', 'todowrite',
      'lsp_diagnostics', 'lsp_find_references', 'legacy_removed_tool',
    ];
    expect(oldTools).toHaveLength(25);
    insertDef('momo', 'builtin', 'general-assistant', oldTools);

    replay();

    const tools = readTools('momo');
    expect(tools).toHaveLength(58);
    expect(tools.every((t) => t.kind === 'builtin')).toBe(true);
    // 顺序即冻结名单顺序（json_each 按数组序扫描）
    expect(tools.map((t) => t.ref)).toEqual([...MOMO_ALL_BUILTIN_TOOL_REFS]);
    // 严格集合相等 + 无重复
    expect(new Set(tools.map((t) => t.ref))).toEqual(new Set(MOMO_ALL_BUILTIN_TOOL_REFS));
    expect(tools.map((t) => t.ref)).toHaveLength(new Set(tools.map((t) => t.ref)).size);
    // 替换语义：旧引用不再残留
    expect(tools.map((t) => t.ref)).not.toContain('lsp_diagnostics');
    expect(tools.map((t) => t.ref)).not.toContain('legacy_removed_tool');
  });

  it('用例 B：custom 行与其它 builtin slug 的 default_tools 完全不变', () => {
    const customTools = ['read_file', 'write_file', 'custom_only'];
    const otherBuiltinTools = ['read_file', 'grep', 'list_workgroups'];
    insertDef('custom-1', 'custom', 'my-helper', customTools);
    insertDef('builtin-other', 'builtin', 'coder', otherBuiltinTools);
    insertDef('momo-for-contrast', 'builtin', 'general-assistant', ['read_file']);

    replay();

    expect(readTools('custom-1')).toEqual(customTools.map((ref) => ({ kind: 'builtin', ref })));
    expect(readTools('builtin-other')).toEqual(otherBuiltinTools.map((ref) => ({ kind: 'builtin', ref })));
    expect(readTools('momo-for-contrast')).toHaveLength(58);
  });

  it('用例 C：重复重放幂等（结果逐字节不变）', () => {
    insertDef('momo', 'builtin', 'general-assistant', ['read_file', 'lsp_diagnostics']);

    replay();
    const first = getDb().prepare('SELECT default_tools FROM agent_definitions WHERE id = ?').get('momo') as {
      default_tools: string;
    };
    replay();
    const second = getDb().prepare('SELECT default_tools FROM agent_definitions WHERE id = ?').get('momo') as {
      default_tools: string;
    };

    expect(second.default_tools).toBe(first.default_tools);
    expect(JSON.parse(second.default_tools)).toHaveLength(58);
  });

  it('用例 D：冻结名单与 ALL_BUILTIN_TOOLS 全集一致（排序后严格相等）', () => {
    // 2026-11-09 资源创建六工具扩容按本用例原处方处置：追加迁移 077；2026-11-10
    // list_models 扩容同式再追加迁移 078；2026-11-12 能力管理五工具同式再追加
    // 迁移 080；2026-11-13 任务生命周期 v2 两工具（request_human / submit_task）
    // 同式再追加迁移 083，本断言与冻结名单同步改指 083 的 72 项全集（074 的 58
    // 项名单与 SQL 保持冻结不改——用例 A-C 仍锁 074 自身行为）。下次扩容同式再追加。
    expect([...MOMO_V23_ALL_BUILTIN_TOOL_REFS].sort()).toEqual([...ALL_BUILTIN_TOOLS].sort());
    expect(MOMO_V23_ALL_BUILTIN_TOOL_REFS).toHaveLength(72);
    expect(new Set(MOMO_V23_ALL_BUILTIN_TOOL_REFS).size).toBe(MOMO_V23_ALL_BUILTIN_TOOL_REFS.length);
  });
});
