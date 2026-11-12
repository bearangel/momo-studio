// electron/tests/storage/077-momo-resource-creation-tools.test.ts
//
// 迁移 077 回归锁：Momo（builtin + general-assistant）default_tools 整列替换为
// 全部 64 个内置工具（074 的 58 项 + 资源创建六工具，spec
// 2026-11-09-resource-creation-skills）。覆盖：074 后真实升级路径（58 → 64）、
// 替换而非并入（过期引用清掉）、非目标行零改动、重复重放幂等、
// 冻结名单与 ALL_BUILTIN_TOOLS 全集一致（含顺序——顺序即落库顺序）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { ALL_BUILTIN_TOOLS } from '../../src/main/agent/tools/catalog';
import { MOMO_ALL_BUILTIN_TOOL_REFS } from '../../src/main/storage/migrations/074_momo_all_builtin_tools';
import {
  migration077,
  MOMO_V21_ALL_BUILTIN_TOOL_REFS,
} from '../../src/main/storage/migrations/077_momo_resource_creation_tools';
import { MOMO_V211_ALL_BUILTIN_TOOL_REFS } from '../../src/main/storage/migrations/078_momo_list_models_tool';
import { MOMO_V22_ALL_BUILTIN_TOOL_REFS } from '../../src/main/storage/migrations/080_momo_capability_management_tools';

const tmpRoot = path.join(os.tmpdir(), `ap-mig077-test-${Date.now()}-${process.pid}`);

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
  getDb().exec(migration077.sql);
}

describe('migration 077 Momo 资源创建工具回填（58 → 64）', () => {
  it('用例 A：074 后的 58 项全集升级为 64 项（顺序即冻结名单顺序）', () => {
    // 真实升级路径：存量库 Momo 行处于 074 回填后的状态（58 项全集）
    insertDef('momo', 'builtin', 'general-assistant', [...MOMO_ALL_BUILTIN_TOOL_REFS]);

    replay();

    const tools = readTools('momo');
    expect(tools).toHaveLength(64);
    expect(tools.every((t) => t.kind === 'builtin')).toBe(true);
    expect(tools.map((t) => t.ref)).toEqual([...MOMO_V21_ALL_BUILTIN_TOOL_REFS]);
    expect(new Set(tools.map((t) => t.ref))).toEqual(new Set(MOMO_V21_ALL_BUILTIN_TOOL_REFS));
  });

  it('用例 B：含过期引用的旧行整列替换（替换而非并入）', () => {
    const oldTools = [...MOMO_ALL_BUILTIN_TOOL_REFS, 'legacy_removed_tool'];
    insertDef('momo', 'builtin', 'general-assistant', oldTools);

    replay();

    const tools = readTools('momo');
    expect(tools).toHaveLength(64);
    expect(tools.map((t) => t.ref)).not.toContain('legacy_removed_tool');
    for (const t of ['resource_list', 'create_agent', 'add_agent_member', 'create_skill', 'create_mcp', 'create_team']) {
      expect(tools.map((r) => r.ref), `缺工具 ${t}`).toContain(t);
    }
  });

  it('用例 C：custom 行与其它 builtin slug 的 default_tools 完全不变', () => {
    const customTools = ['read_file', 'write_file', 'custom_only'];
    const otherBuiltinTools = ['read_file', 'grep', 'create_team'];
    insertDef('custom-1', 'custom', 'my-helper', customTools);
    insertDef('builtin-other', 'builtin', 'coder', otherBuiltinTools);

    replay();

    expect(readTools('custom-1')).toEqual(customTools.map((ref) => ({ kind: 'builtin', ref })));
    expect(readTools('builtin-other')).toEqual(otherBuiltinTools.map((ref) => ({ kind: 'builtin', ref })));
  });

  it('用例 D：重复重放幂等（结果逐字节不变）', () => {
    insertDef('momo', 'builtin', 'general-assistant', ['read_file']);

    replay();
    const first = getDb().prepare('SELECT default_tools FROM agent_definitions WHERE id = ?').get('momo') as {
      default_tools: string;
    };
    replay();
    const second = getDb().prepare('SELECT default_tools FROM agent_definitions WHERE id = ?').get('momo') as {
      default_tools: string;
    };

    expect(second.default_tools).toBe(first.default_tools);
    expect(JSON.parse(second.default_tools)).toHaveLength(64);
  });

  it('用例 E：冻结名单与 ALL_BUILTIN_TOOLS 全集一致（排序后严格相等，且顺序一致）', () => {
    // 2026-11-10 list_models 扩容已按 074→077 先例处置：追加迁移 078；2026-11-12
    // 能力管理五工具同式再追加迁移 080，本断言与冻结名单同步改指 080 的 70 项
    // 全集（077 的 64 项名单与 SQL 保持冻结不改——用例 A-D 仍锁 077 自身行为）。
    // 下次扩容同式再追加。
    expect([...MOMO_V22_ALL_BUILTIN_TOOL_REFS].sort()).toEqual([...ALL_BUILTIN_TOOLS].sort());
    // 冻结名单文档声称「顺序即落库顺序」——与 catalog 注册顺序（模块注册序）锁死
    expect([...MOMO_V22_ALL_BUILTIN_TOOL_REFS]).toEqual([...ALL_BUILTIN_TOOLS]);
    expect(MOMO_V22_ALL_BUILTIN_TOOL_REFS).toHaveLength(70);
    expect(new Set(MOMO_V22_ALL_BUILTIN_TOOL_REFS).size).toBe(MOMO_V22_ALL_BUILTIN_TOOL_REFS.length);
  });
});
