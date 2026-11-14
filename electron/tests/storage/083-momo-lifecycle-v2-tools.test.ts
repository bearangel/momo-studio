// electron/tests/storage/083-momo-lifecycle-v2-tools.test.ts
//
// 迁移 083 回归锁：Momo（builtin + general-assistant）default_tools 整列替换为
// 全部 72 个内置工具（080 的 70 项 + 任务生命周期 v2 两工具 request_human /
// submit_task，Task 14）。覆盖：080 后真实升级路径（70 → 72）、替换而非并入
//（过期引用清掉）、非目标行零改动、重复重放幂等、冻结名单与 ALL_BUILTIN_TOOLS
// 全集一致（含顺序——顺序即落库顺序）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { loadMigrations } from '../../src/main/storage/migrations/index';
import { ALL_BUILTIN_TOOLS } from '../../src/main/agent/tools/catalog';
import { MOMO_V22_ALL_BUILTIN_TOOL_REFS } from '../../src/main/storage/migrations/080_momo_capability_management_tools';
import {
  migration083,
  MOMO_V23_ALL_BUILTIN_TOOL_REFS,
} from '../../src/main/storage/migrations/083_momo_lifecycle_v2_tools';

const tmpRoot = path.join(os.tmpdir(), `ap-mig083-test-${Date.now()}-${process.pid}`);

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
  getDb().exec(migration083.sql);
}

describe('migration 083 Momo 任务生命周期 v2 工具回填（70 → 72）', () => {
  it('用例 A：080 后的 70 项全集升级为 72 项（顺序即冻结名单顺序）', () => {
    // 真实升级路径：存量库 Momo 行处于 080 回填后的状态（70 项全集）
    insertDef('momo', 'builtin', 'general-assistant', [...MOMO_V22_ALL_BUILTIN_TOOL_REFS]);

    replay();

    const tools = readTools('momo');
    expect(tools).toHaveLength(72);
    expect(tools.every((t) => t.kind === 'builtin')).toBe(true);
    expect(tools.map((t) => t.ref)).toEqual([...MOMO_V23_ALL_BUILTIN_TOOL_REFS]);
    expect(new Set(tools.map((t) => t.ref))).toEqual(new Set(MOMO_V23_ALL_BUILTIN_TOOL_REFS));
  });

  it('用例 B：含过期引用的旧行整列替换（替换而非并入）', () => {
    const oldTools = [...MOMO_V22_ALL_BUILTIN_TOOL_REFS, 'legacy_removed_tool'];
    insertDef('momo', 'builtin', 'general-assistant', oldTools);

    replay();

    const tools = readTools('momo');
    expect(tools).toHaveLength(72);
    expect(tools.map((t) => t.ref)).not.toContain('legacy_removed_tool');
    for (const t of ['request_human', 'submit_task']) {
      expect(tools.map((r) => r.ref), `缺工具 ${t}`).toContain(t);
    }
  });

  it('用例 C：custom 行与其它 builtin slug 的 default_tools 完全不变', () => {
    const customTools = ['read_file', 'write_file', 'custom_only'];
    const otherBuiltinTools = ['read_file', 'grep', 'complete_task'];
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
    expect(JSON.parse(second.default_tools)).toHaveLength(72);
  });

  it('用例 E：冻结名单与 ALL_BUILTIN_TOOLS 全集一致（排序后严格相等，且顺序一致）', () => {
    expect([...MOMO_V23_ALL_BUILTIN_TOOL_REFS].sort()).toEqual([...ALL_BUILTIN_TOOLS].sort());
    // 冻结名单文档声称「顺序即落库顺序」——与 catalog 注册顺序（模块注册序）锁死
    expect([...MOMO_V23_ALL_BUILTIN_TOOL_REFS]).toEqual([...ALL_BUILTIN_TOOLS]);
    expect(MOMO_V23_ALL_BUILTIN_TOOL_REFS).toHaveLength(72);
    expect(new Set(MOMO_V23_ALL_BUILTIN_TOOL_REFS).size).toBe(MOMO_V23_ALL_BUILTIN_TOOL_REFS.length);
  });

  it('用例 F：083 注册为最新迁移（末位哨兵自 082 测试移入，070→080→082 先例）', () => {
    const versions = loadMigrations().map((m) => m.version);
    expect(versions).toContain(83);
    expect(versions[versions.length - 1]).toBe(83);
    // 版本唯一性（重复注册会让 runner 静默跳过第二条，属契约破坏）
    expect(new Set(versions).size).toBe(versions.length);
  });
});
