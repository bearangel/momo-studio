// electron/tests/agent/tools/tools-catalog-v2.3.test.ts
// v2.3 工具注册中心 + catalog 常量同步校验（v2.x 目录派生改造后语义保留）：
//   apply_patch 已落地至注册中心与派生目录，但高破坏力使其不进 SAFE_MINIMUM_TOOLS；
//   apply_patch 归入唯一类别分组；TOOL_CATEGORIES 并集与 ALL_BUILTIN_TOOLS 一致且无重复。
// 注：目录改为注册中心派生后，apply_patch 归属「原子补丁」类（不再是旧手写的「文件」类），
//     断言不再依赖具体类别名——只锁成员关系与结构不变量。

import { describe, it, expect } from 'vitest';
import { ALL_BUILTIN_TOOLS, SAFE_MINIMUM_TOOLS, TOOL_CATEGORIES } from '../../../src/main/agent/tools/catalog';

describe('catalog v2.3', () => {
  it('ALL_BUILTIN_TOOLS 包含 apply_patch', () => {
    expect(ALL_BUILTIN_TOOLS).toContain('apply_patch');
  });

  it('SAFE_MINIMUM_TOOLS 不包含 apply_patch（高破坏力工具不进入最小集）', () => {
    expect(SAFE_MINIMUM_TOOLS).not.toContain('apply_patch');
  });

  it('apply_patch 归入且仅归入一个类别分组（派生分组不漏不重）', () => {
    const groups = TOOL_CATEGORIES.filter((c) => c.tools.includes('apply_patch'));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label.length).toBeGreaterThan(0);
  });

  it('ALL_BUILTIN_TOOLS 与 TOOL_CATEGORIES 并集一致（无重复）', () => {
    const union = TOOL_CATEGORIES.flatMap((c) => c.tools);
    expect(new Set(union).size).toBe(union.length);
    // ALL_BUILTIN_TOOLS 派生后即 string[]，直接构造 Set 比对
    const allSet = new Set<string>(ALL_BUILTIN_TOOLS);
    for (const t of union) expect(allSet.has(t)).toBe(true);
    for (const t of ALL_BUILTIN_TOOLS) expect(union.includes(t)).toBe(true);
  });
});
