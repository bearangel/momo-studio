// electron/tests/storage/080-momo-capability-management-tools.test.ts
//
// 迁移 080 回归锁：Momo（builtin + general-assistant）default_tools 整列替换为
// 全部 70 个内置工具（078 的 65 项 + 资源管理五工具，spec
// 2026-11-12-agent-capability-management-tools）。覆盖：078 后真实升级路径
// （65 → 70）、替换而非并入（过期引用清掉）、非目标行零改动、重复重放幂等、
// 冻结名单与 ALL_BUILTIN_TOOLS 全集一致（含顺序——顺序即落库顺序）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { loadMigrations } from '../../src/main/storage/migrations/index';
import { ALL_BUILTIN_TOOLS } from '../../src/main/agent/tools/catalog';
import { MOMO_V211_ALL_BUILTIN_TOOL_REFS } from '../../src/main/storage/migrations/078_momo_list_models_tool';
import {
  migration080,
  MOMO_V22_ALL_BUILTIN_TOOL_REFS,
} from '../../src/main/storage/migrations/080_momo_capability_management_tools';
import { MOMO_V23_ALL_BUILTIN_TOOL_REFS } from '../../src/main/storage/migrations/083_momo_lifecycle_v2_tools';

const tmpRoot = path.join(os.tmpdir(), `ap-mig080-test-${Date.now()}-${process.pid}`);

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
  getDb().exec(migration080.sql);
}

describe('migration 080 Momo 能力管理工具回填（65 → 70）', () => {
  it('用例 A：078 后的 65 项全集升级为 70 项（顺序即冻结名单顺序）', () => {
    // 真实升级路径：存量库 Momo 行处于 078 回填后的状态（65 项全集）
    insertDef('momo', 'builtin', 'general-assistant', [...MOMO_V211_ALL_BUILTIN_TOOL_REFS]);

    replay();

    const tools = readTools('momo');
    expect(tools).toHaveLength(70);
    expect(tools.every((t) => t.kind === 'builtin')).toBe(true);
    expect(tools.map((t) => t.ref)).toEqual([...MOMO_V22_ALL_BUILTIN_TOOL_REFS]);
    expect(new Set(tools.map((t) => t.ref))).toEqual(new Set(MOMO_V22_ALL_BUILTIN_TOOL_REFS));
  });

  it('用例 B：含过期引用的旧行整列替换（替换而非并入）', () => {
    const oldTools = [...MOMO_V211_ALL_BUILTIN_TOOL_REFS, 'legacy_removed_tool'];
    insertDef('momo', 'builtin', 'general-assistant', oldTools);

    replay();

    const tools = readTools('momo');
    expect(tools).toHaveLength(70);
    expect(tools.map((t) => t.ref)).not.toContain('legacy_removed_tool');
    for (const t of ['describe_agent', 'update_agent_capabilities', 'update_agent_profile', 'update_skill', 'update_mcp']) {
      expect(tools.map((r) => r.ref), `缺工具 ${t}`).toContain(t);
    }
  });

  it('用例 C：custom 行与其它 builtin slug 的 default_tools 完全不变', () => {
    const customTools = ['read_file', 'write_file', 'custom_only'];
    const otherBuiltinTools = ['read_file', 'grep', 'update_skill'];
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
    expect(JSON.parse(second.default_tools)).toHaveLength(70);
  });

  it('用例 E：冻结名单与 ALL_BUILTIN_TOOLS 全集一致（排序后严格相等，且顺序一致）', () => {
    // 2026-11-13 任务生命周期 v2 两工具（request_human / submit_task）扩容已按
    // 074→077→078→080 先例处置：追加迁移 083，本断言与冻结名单同步改指 083 的
    // 72 项全集（080 的 70 项名单与 SQL 保持冻结不改——用例 A-D 仍锁 080 自身
    // 行为）。下次扩容同式再追加。
    expect([...MOMO_V23_ALL_BUILTIN_TOOL_REFS].sort()).toEqual([...ALL_BUILTIN_TOOLS].sort());
    // 冻结名单文档声称「顺序即落库顺序」——与 catalog 注册顺序（模块注册序）锁死
    expect([...MOMO_V23_ALL_BUILTIN_TOOL_REFS]).toEqual([...ALL_BUILTIN_TOOLS]);
    expect(MOMO_V23_ALL_BUILTIN_TOOL_REFS).toHaveLength(72);
    expect(new Set(MOMO_V23_ALL_BUILTIN_TOOL_REFS).size).toBe(MOMO_V23_ALL_BUILTIN_TOOL_REFS.length);
  });

  it('用例 F：080 注册在链中且顺延完整（末位哨兵已移交 082 测试）', () => {
    const versions = loadMigrations().map((m) => m.version);
    expect(versions).toContain(80);
    // 任务生命周期 v2（081/082）注册后 080 不再是末位迁移——锁顺延关系而非终位（070 先例）
    expect(versions[versions.length - 1]).toBeGreaterThan(80);
    // 版本唯一性（重复注册会让 runner 静默跳过第二条，属契约破坏）
    expect(new Set(versions).size).toBe(versions.length);
  });
});
