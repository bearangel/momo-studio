// electron/tests/storage/052-tier1-backfill.test.ts
// migration 052 契约（spec §4.5）：
//   1. 只加不减：旧 7 工具 def → 旧集 ∪ Tier 1（17）；已有非 Tier 1 工具（bash）保留
//   2. 幂等：对已回填行重复执行等价 SQL 无变化（UNION 去重）
//   3. 空/异常输入：default_tools='[]' 的行 → 恰好 Tier 1
//   4. default_mcps / default_skills 不动
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { SAFE_MINIMUM_TOOLS } from '../../src/main/agent/tools/catalog';
import { migration052 } from '../../src/main/storage/migrations/052_agent_tools_tier1_backfill';

const tmpRoot = path.join(os.tmpdir(), `ap-mig052-test-${Date.now()}-${process.pid}`);

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

function insertDef(id: string, toolsJson: string, mcpsJson = '[]'): void {
  getDb().prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
        default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
     VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', ?, ?, '[]', 'custom', '', '🤖', NULL, 'm', 1)`,
  ).run(id, id, id, toolsJson, mcpsJson);
}

function readTools(id: string): Array<{ kind: string; ref: string }> {
  const row = getDb().prepare('SELECT default_tools FROM agent_definitions WHERE id = ?').get(id) as {
    default_tools: string;
  };
  return JSON.parse(row.default_tools) as Array<{ kind: string; ref: string }>;
}

function replay(): void {
  // 测试行插在 runMigrations 之后——手动重放 052 SQL 等价验证「migration 时点已有行被回填」；
  // SQL 幂等（UNION 去重），重放同时验证幂等性。SQL 从 migration 导出对象取，测试与实现同源。
  getDb().exec(migration052.sql);
}

describe('migration 052 Tier 1 回填', () => {
  it('旧 7 工具 def：bash 保留 + Tier 1 全集并入（只加不减）', () => {
    // 旧 7 工具 + bash（非 Tier 1，验证只加不减的「不减」侧）
    const oldTools = [...['read_file', 'write_file', 'list_files', 'edit_file', 'grep', 'glob', 'todowrite'], 'bash'];
    insertDef('d1', JSON.stringify(oldTools.map((ref) => ({ kind: 'builtin', ref }))));
    replay();
    const refs = readTools('d1').map((t) => t.ref);
    expect(refs).toContain('bash');
    for (const t of oldTools) {
      expect(refs).toContain(t);
    }
    for (const t of SAFE_MINIMUM_TOOLS) {
      expect(refs).toContain(t);
    }
  });

  it('default_tools=[] 的行 → 恰好 Tier 1（17 个），重复重放幂等', () => {
    insertDef('d2', '[]');
    replay();
    replay(); // 幂等：第二次重放结果不变
    const refs = readTools('d2').map((t) => t.ref).sort();
    expect(refs).toEqual([...SAFE_MINIMUM_TOOLS].sort());
  });

  it('default_mcps 不动', () => {
    insertDef('d3', '[]', JSON.stringify([{ kind: 'mcp', ref: 'keep-me' }]));
    replay();
    const row = getDb().prepare('SELECT default_mcps FROM agent_definitions WHERE id = ?').get('d3') as {
      default_mcps: string;
    };
    expect(JSON.parse(row.default_mcps)).toEqual([{ kind: 'mcp', ref: 'keep-me' }]);
  });
});
