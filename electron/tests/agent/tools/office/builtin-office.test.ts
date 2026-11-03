// electron/tests/agent/tools/office/builtin-office.test.ts
// office 工具契约锁（spec 2026-11-03 §6）：生成类六工具下线后只锁读取三件的
// 集合与分类不变量；DEF 侧教学文案锁随写路径退役。
import { describe, it, expect } from 'vitest';
import { OfficeTools } from '../../../../src/main/agent/tools/office-tools';
import { ALL_BUILTIN_TOOLS, TOOL_CATEGORIES } from '../../../../src/main/agent/tools/catalog';

describe('工具全集与分类', () => {
  it('只读三件进入派生全集；已下线生成类不再出现（spec 2026-11-03 §6）', () => {
    for (const n of ['office_read', 'office_read_cells', 'office_copy']) {
      expect(ALL_BUILTIN_TOOLS, n).toContain(n);
    }
    for (const gone of ['office_create_excel', 'office_write_excel', 'office_create_doc', 'office_create_ppt', 'office_create_pdf', 'office_fill_ppt_template']) {
      expect(ALL_BUILTIN_TOOLS, gone).not.toContain(gone);
    }
  });
  it('分类并集 == 全集（既有不变量）', () => {
    const union = new Set(TOOL_CATEGORIES.flatMap((c) => c.tools));
    for (const t of ALL_BUILTIN_TOOLS) expect(union.has(t)).toBe(true);
  });
});
