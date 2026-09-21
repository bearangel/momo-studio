// electron/tests/agent/tools-catalog.test.ts
// Task 0：验证 tools/catalog 常量。覆盖：
//   - ALL_BUILTIN_TOOLS 共 34 个，覆盖 v1.5 + v2.3 apply_patch + v2.1 OfficeTools 全部（§14.9-3 增 office_fill_ppt_template）
//   - SAFE_MINIMUM_TOOLS 是 ALL_BUILTIN_TOOLS 的真子集
//   - TOOL_CATEGORIES 覆盖 ALL_BUILTIN_TOOLS 全部 34 个，无重复
import { describe, it, expect } from 'vitest';
import { ALL_BUILTIN_TOOLS, SAFE_MINIMUM_TOOLS, TOOL_CATEGORIES } from '../../src/main/agent/tools/catalog';

describe('tools/catalog 常量', () => {
  it('ALL_BUILTIN_TOOLS 共 33 个工具，覆盖 v1.5 + v2.3 apply_patch + v2.1 OfficeTools 全部', () => {
    expect(ALL_BUILTIN_TOOLS).toHaveLength(34);
    expect(ALL_BUILTIN_TOOLS).toContain('bash');
    expect(ALL_BUILTIN_TOOLS).toContain('lsp_find_references');
    expect(ALL_BUILTIN_TOOLS).toContain('apply_patch');
    expect(ALL_BUILTIN_TOOLS).toContain('office_read');
    expect(ALL_BUILTIN_TOOLS).toContain('office_copy');
  });

  it('SAFE_MINIMUM_TOOLS 是 ALL_BUILTIN_TOOLS 的真子集', () => {
    for (const t of SAFE_MINIMUM_TOOLS) {
      expect(ALL_BUILTIN_TOOLS).toContain(t);
    }
    expect(SAFE_MINIMUM_TOOLS.length).toBeLessThan(ALL_BUILTIN_TOOLS.length);
  });

  it('TOOL_CATEGORIES 覆盖 ALL_BUILTIN_TOOLS 全部 34 个，无重复', () => {
    const all = TOOL_CATEGORIES.flatMap((c) => c.tools);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(34);
    expect(all.sort()).toEqual([...ALL_BUILTIN_TOOLS].sort());
  });
});
