// electron/tests/agent/tools/tools-catalog-v2.3.test.ts
// v2.3 工具注册中心 + catalog 常量同步校验：apply_patch 已落地至注册中心与 catalog，
// 但高破坏力使其不进 SAFE_MINIMUM_TOOLS；TOOL_CATEGORIES 文件分类与 ALL_BUILTIN_TOOLS
// 一致且无重复。

import { describe, it, expect } from 'vitest';
import { ALL_BUILTIN_TOOLS, SAFE_MINIMUM_TOOLS, TOOL_CATEGORIES } from '../../../src/main/agent/tools/catalog';

describe('catalog v2.3', () => {
  it('ALL_BUILTIN_TOOLS 包含 apply_patch', () => {
    expect(ALL_BUILTIN_TOOLS).toContain('apply_patch');
  });

  it('SAFE_MINIMUM_TOOLS 不包含 apply_patch（高破坏力工具不进入最小集）', () => {
    expect(SAFE_MINIMUM_TOOLS).not.toContain('apply_patch');
  });

  it('TOOL_CATEGORIES 文件分类包含 apply_patch', () => {
    const fileCategory = TOOL_CATEGORIES.find(c => c.label === '文件');
    expect(fileCategory?.tools).toContain('apply_patch');
  });

  it('ALL_BUILTIN_TOOLS 与 TOOL_CATEGORIES 并集一致（无重复）', () => {
    const union = TOOL_CATEGORIES.flatMap(c => c.tools);
    expect(new Set(union).size).toBe(union.length);
    // 显式 Set<string> 以接受 union 元素（TOOL_CATEGORIES.tools 为 string[]），
    // 避免 Set<ALL_BUILTIN_TOOLS 字面量联合> 与 string 不兼容的类型错误。
    const allSet = new Set<string>(ALL_BUILTIN_TOOLS);
    for (const t of union) expect(allSet.has(t)).toBe(true);
  });
});
