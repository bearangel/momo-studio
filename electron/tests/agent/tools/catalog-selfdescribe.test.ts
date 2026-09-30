// electron/tests/agent/tools/catalog-selfdescribe.test.ts
// 目录自描述契约（spec §4.2）：
//   1. 每个模块 getCatalog() 与 getDefs() 名字一一对应
//   2. 每个条目 category 非空、defaultOn 为 boolean
//   3. 缺 meta 的工具在 buildCatalog 处 fail-fast（防将来新模块漏写）
//   4. LSP 条目带 conditional 标注
//   5. Tier 1（defaultOn=true）全集 = 17 个，与 spec §3.2 逐名核对
import { describe, it, expect } from 'vitest';
import { unconditionalModules } from '../../../src/main/agent/tools/index';
import { LSP_CATALOG_ENTRIES } from '../../../src/main/agent/tools/lsp-tools';
import { buildCatalog, type ToolCatalogEntry } from '../../../src/main/agent/tools/catalog-entry';
import type { LLMToolDef } from '../../../src/main/agent/llm-provider';

const TIER1 = [
  'read_file', 'write_file', 'list_files', 'edit_file', 'mkdir', 'mv', 'exists',
  'grep', 'glob',
  'todowrite',
  'read_task', 'read_task_history', 'read_task_progress', 'list_tasks',
  'memory_search',
  'list_sessions', 'read_session',
];

describe('ToolModule.getCatalog 自描述', () => {
  it('每个模块 getCatalog 与 getDefs 一一对应，category 非空且 defaultOn 为 boolean', () => {
    for (const m of unconditionalModules()) {
      const defs = m.getDefs().map((d) => d.name).sort();
      const cat = m.getCatalog().map((e) => e.name).sort();
      expect(cat).toEqual(defs);
      for (const e of m.getCatalog()) {
        expect(e.category.length).toBeGreaterThan(0);
        expect(typeof e.defaultOn).toBe('boolean');
      }
    }
  });

  it('Tier 1 全集 = 17 个且逐名核对', () => {
    const all: ToolCatalogEntry[] = [
      ...unconditionalModules().flatMap((m) => m.getCatalog()),
      ...LSP_CATALOG_ENTRIES,
    ];
    const tier1 = all.filter((e) => e.defaultOn).map((e) => e.name).sort();
    expect(tier1).toEqual([...TIER1].sort());
  });

  it('LSP 条目带 conditional 标注且 defaultOn=false', () => {
    expect(LSP_CATALOG_ENTRIES).toHaveLength(2);
    for (const e of LSP_CATALOG_ENTRIES) {
      expect(e.conditional).toContain('TS/JS');
      expect(e.defaultOn).toBe(false);
    }
  });

  it('buildCatalog 缺 meta 条目抛错（fail-fast）', () => {
    const defs: LLMToolDef[] = [
      { name: 'read_file', description: '', inputSchema: { type: 'object', properties: {} } },
    ];
    expect(() => buildCatalog(defs, {})).toThrow(/缺少目录元数据/);
  });
});
