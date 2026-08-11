// electron/tests/agent/tools-catalog.test.ts
// Task 0：验证 tools/catalog 常量。覆盖：
//   - ALL_BUILTIN_TOOLS 共 24 个，覆盖 v1.5 全部工具
//   - SAFE_MINIMUM_TOOLS 是 ALL_BUILTIN_TOOLS 的真子集
//   - TOOL_CATEGORIES 覆盖 ALL_BUILTIN_TOOLS 全部 24 个，无重复
import { describe, it, expect } from 'vitest';
import { ALL_BUILTIN_TOOLS, SAFE_MINIMUM_TOOLS, TOOL_CATEGORIES } from '../../src/main/agent/tools/catalog';

describe('tools/catalog 常量', () => {
  it('ALL_BUILTIN_TOOLS 共 24 个工具，覆盖 v1.5 全部', () => {
    expect(ALL_BUILTIN_TOOLS).toHaveLength(24);
    expect(ALL_BUILTIN_TOOLS).toContain('bash');
    expect(ALL_BUILTIN_TOOLS).toContain('lsp_find_references');
  });

  it('SAFE_MINIMUM_TOOLS 是 ALL_BUILTIN_TOOLS 的真子集', () => {
    for (const t of SAFE_MINIMUM_TOOLS) {
      expect(ALL_BUILTIN_TOOLS).toContain(t);
    }
    expect(SAFE_MINIMUM_TOOLS.length).toBeLessThan(ALL_BUILTIN_TOOLS.length);
  });

  it('TOOL_CATEGORIES 覆盖 ALL_BUILTIN_TOOLS 全部 24 个，无重复', () => {
    const all = TOOL_CATEGORIES.flatMap((c) => c.tools);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(24);
    expect(all.sort()).toEqual([...ALL_BUILTIN_TOOLS].sort());
  });
});
