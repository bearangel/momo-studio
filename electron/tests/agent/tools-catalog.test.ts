// electron/tests/agent/tools-catalog.test.ts
// 目录派生契约（v2.x 单一真相源，spec §4.2）：
//   1. ALL_BUILTIN_TOOLS 覆盖注册中心全部模块工具（含 v2.x 新增的任务/记忆/浏览器/会话/进程/git_repos）
//   2. SAFE_MINIMUM_TOOLS = Tier 1（17 个，defaultOn 派生）
//   3. TOOL_CATEGORIES 并集 = ALL_BUILTIN_TOOLS 且无重复
//   4. 派生完备性：buildToolCatalog 每个条目都能在注册中心模块 defs 里找到（防手写残留）
import { describe, it, expect } from 'vitest';
import {
  ALL_BUILTIN_TOOLS,
  SAFE_MINIMUM_TOOLS,
  TOOL_CATEGORIES,
  buildToolCatalog,
} from '../../src/main/agent/tools/catalog';
import { unconditionalModules } from '../../src/main/agent/tools/index';
import { LSP_CATALOG_ENTRIES } from '../../src/main/agent/tools/lsp-tools';

describe('tools/catalog 派生常量', () => {
  it('ALL_BUILTIN_TOOLS 覆盖全部模块工具（含任务/记忆/浏览器/会话/进程/git_repos）', () => {
    for (const name of unconditionalModules().flatMap((m) => m.getDefs().map((d) => d.name))) {
      expect(ALL_BUILTIN_TOOLS).toContain(name);
    }
    for (const name of ['bash', 'lsp_find_references', 'apply_patch', 'office_read',
      'read_task', 'memory_search', 'browser_navigate', 'list_sessions', 'process_list', 'git_repos']) {
      expect(ALL_BUILTIN_TOOLS).toContain(name);
    }
    expect(new Set(ALL_BUILTIN_TOOLS).size).toBe(ALL_BUILTIN_TOOLS.length);
  });

  it('SAFE_MINIMUM_TOOLS = Tier 1 共 17 个（只读 13 + 文件写 4，不含 rm/bash）', () => {
    expect(SAFE_MINIMUM_TOOLS).toHaveLength(17);
    for (const banned of ['rm', 'bash', 'apply_patch', 'git_commit', 'webfetch', 'office_read']) {
      expect(SAFE_MINIMUM_TOOLS).not.toContain(banned);
    }
    for (const t of SAFE_MINIMUM_TOOLS) {
      expect(ALL_BUILTIN_TOOLS).toContain(t);
    }
  });

  it('TOOL_CATEGORIES 并集 = ALL_BUILTIN_TOOLS 且无重复', () => {
    const all = TOOL_CATEGORIES.flatMap((c) => c.tools);
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual([...ALL_BUILTIN_TOOLS].sort());
  });

  it('buildToolCatalog 完备：条目数 = 模块 defs + LSP 条目数，每条目有 meta', () => {
    const entries = buildToolCatalog();
    const registryNames = [
      ...unconditionalModules().flatMap((m) => m.getDefs().map((d) => d.name)),
      ...LSP_CATALOG_ENTRIES.map((e) => e.name),
    ];
    expect(entries.map((e) => e.name).sort()).toEqual([...registryNames].sort());
    for (const e of entries) {
      expect(e.category.length).toBeGreaterThan(0);
      expect(typeof e.defaultOn).toBe('boolean');
    }
  });
});
