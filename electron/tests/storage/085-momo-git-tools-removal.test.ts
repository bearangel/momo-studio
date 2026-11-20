// electron/src/main/storage/migrations/tests 对应锁：迁移 085 回归锁——
// Momo（builtin + general-assistant）default_tools 整列替换为 62 项全集
// （083 的 72 项 − git 工具域 10 项，2026-11-20 git 工具域下线拍板）。
// 覆盖：083 后真实缩减路径（72 → 62）、替换而非并入（git_* 旧引用清掉）、
// 非目标行零改动、重复重放幂等、冻结名单与 ALL_BUILTIN_TOOLS 全集一致
// （含顺序——顺序即落库顺序）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { loadMigrations } from '../../src/main/storage/migrations';
import { ALL_BUILTIN_TOOLS } from '../../src/main/agent/tools/catalog';
import { MOMO_V23_ALL_BUILTIN_TOOL_REFS } from '../../src/main/storage/migrations/083_momo_lifecycle_v2_tools';
import {
  migration085,
  MOMO_V25_ALL_BUILTIN_TOOL_REFS,
} from '../../src/main/storage/migrations/085_momo_git_tools_removal';

const tmpRoot = path.join(os.tmpdir(), `ap-mig085-test-${Date.now()}-${process.pid}`);

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
  getDb().exec(migration085.sql);
}

describe('migration 085 Momo git 工具域下线回填（72 → 62）', () => {
  it('用例 A：083 后的 72 项全集缩减为 62 项（顺序即冻结名单顺序，git_* 清掉）', () => {
    // 真实升级路径：存量库 Momo 行处于 083 回填后的状态（72 项全集）
    insertDef('momo', 'builtin', 'general-assistant', [...MOMO_V23_ALL_BUILTIN_TOOL_REFS]);

    replay();

    const tools = readTools('momo');
    expect(tools).toHaveLength(62);
    expect(tools.every((t) => t.kind === 'builtin')).toBe(true);
    expect(tools.map((t) => t.ref)).toEqual([...MOMO_V25_ALL_BUILTIN_TOOL_REFS]);
    // 替换而非并入：git 旧引用不保留
    expect(tools.some((t) => t.ref.startsWith('git_'))).toBe(false);
    expect(tools.some((t) => t.ref === 'bash')).toBe(true);
  });

  it('用例 B：非目标行零改动（custom agent 残留 git_* ref 原样保留——运行时 merger 静默丢弃）', () => {
    const staleRefs = ['read_file', 'git_status', 'git_commit', 'bash'];
    insertDef('custom1', 'custom', 'my-agent', staleRefs);
    insertDef('builtin2', 'builtin', 'other-builtin', staleRefs);

    replay();

    // 只命中 source='builtin' AND slug='general-assistant'：其余行（含其他 builtin slug）不动
    expect(readTools('custom1').map((t) => t.ref)).toEqual(staleRefs);
    expect(readTools('builtin2').map((t) => t.ref)).toEqual(staleRefs);
  });

  it('用例 C：重复重放幂等（结果不变）', () => {
    insertDef('momo', 'builtin', 'general-assistant', [...MOMO_V23_ALL_BUILTIN_TOOL_REFS]);
    replay();
    const first = readTools('momo');
    replay();
    expect(readTools('momo')).toEqual(first);
  });

  it('用例 E：085 注册为最新迁移（末位哨兵自 084 测试移入，070→080→082→083 先例）', () => {
    const versions = loadMigrations().map((m) => m.version);
    expect(versions).toContain(85);
    expect(versions[versions.length - 1]).toBe(85);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('用例 D：冻结名单与 ALL_BUILTIN_TOOLS 全集一致（排序后严格相等，且顺序一致）', () => {
    expect([...MOMO_V25_ALL_BUILTIN_TOOL_REFS].sort()).toEqual([...ALL_BUILTIN_TOOLS].sort());
    // 冻结名单文档声称「顺序即落库顺序」——与 catalog 注册顺序（模块注册序）锁死
    expect([...MOMO_V25_ALL_BUILTIN_TOOL_REFS]).toEqual([...ALL_BUILTIN_TOOLS]);
    expect(MOMO_V25_ALL_BUILTIN_TOOL_REFS).toHaveLength(62);
    expect(new Set(MOMO_V25_ALL_BUILTIN_TOOL_REFS).size).toBe(MOMO_V25_ALL_BUILTIN_TOOL_REFS.length);
  });
});
