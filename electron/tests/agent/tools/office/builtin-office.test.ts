// electron/tests/agent/tools/office/builtin-office.test.ts
// office 工具契约锁。2026-11-02 内置资源极简化前本文件是
// office-assistant.yaml / catalog readme / 工具 DEF「三联动」锁——
// 预置资源（YAML + catalog 条目）随极简化下架后两腿退役；office 工具
// 本身是内置工具仍在发货，本文件保留并收拢 DEF 侧教学文案与 schema 契约。
import { describe, it, expect } from 'vitest';
import { OfficeTools } from '../../../../src/main/agent/tools/office-tools';
import { ALL_BUILTIN_TOOLS, TOOL_CATEGORIES } from '../../../../src/main/agent/tools/catalog';

describe('工具全集与分类', () => {
  it('office 九工具全部进入派生全集（不锁总数——ALL_BUILTIN_TOOLS 随模块注册扩展）', () => {
    for (const n of [
      'office_read', 'office_read_cells', 'office_create_excel', 'office_write_excel',
      'office_create_doc', 'office_create_ppt', 'office_create_pdf', 'office_copy',
      'office_fill_ppt_template',
    ]) {
      expect(ALL_BUILTIN_TOOLS, n).toContain(n);
    }
  });
  it('分类并集 == 全集（既有不变量）', () => {
    const union = new Set(TOOL_CATEGORIES.flatMap((c) => c.tools));
    for (const t of ALL_BUILTIN_TOOLS) expect(union.has(t)).toBe(true);
  });
});

describe('WRITE_EXCEL_DEF 教学文案与 schema 契约（LLM 看到的工具描述）', () => {
  const writeDef = new OfficeTools().getDefs().find((d) => d.name === 'office_write_excel')!;
  const opsSchema = (writeDef.inputSchema.properties as Record<string, unknown>)['ops'] as {
    items: { properties: { op: { enum: string[] }; columns: { description: string } } };
  };

  it('公式优先工作流：description 含 SUMIF；op enum 含 add_chart / fill / set_format', () => {
    expect(writeDef.description).toContain('SUMIF');
    expect(writeDef.description).toContain('add_chart');
    expect(writeDef.description).toContain('fill');
    expect(writeDef.description).toContain('set_format');
    expect(opsSchema.items.properties.op.enum).toContain('add_chart');
    expect(opsSchema.items.properties.op.enum).toContain('fill');
    expect(opsSchema.items.properties.op.enum).toContain('set_format');
  });

  it('fill 七型 + 原子性 + 表头覆盖警示 + 跨文件搬运教学（原 A 场景 / §14.8-6 锁收拢）', () => {
    expect(writeDef.description).toContain('sequence_date');
    expect(writeDef.description).toContain('template');
    expect(writeDef.description).toContain('原子');
    expect(writeDef.description).toContain('覆盖表头');
    expect(writeDef.description).toContain('office_read_cells');
    expect(writeDef.description).toContain('repeat');
    // columns 子 schema 双重锁定（description + schema 两路锁）
    expect(opsSchema.items.properties.columns.description).toContain('sequence_date');
    expect(opsSchema.items.properties.columns.description).toContain('template');
  });
});

describe('PPT 视觉四能力契约（原 §14.9 三联动锁的 DEF 腿）', () => {
  it('office_create_ppt：模板工具点名 + background/chart/images 三能力（description + schema 双路锁）', () => {
    const pptCreate = new OfficeTools().getDefs().find((d) => d.name === 'office_create_ppt')!;
    expect(pptCreate.description).toContain('office_fill_ppt_template');
    expect(pptCreate.description).toContain('background');
    expect(pptCreate.description).toContain('chart');
    expect(pptCreate.description).toContain('images');
    const pptProps = pptCreate.inputSchema.properties as Record<string, unknown>;
    const pptSlides = (pptProps['slides'] as { items: { properties: Record<string, unknown> } }).items.properties;
    expect(pptSlides).toHaveProperty('background');
    expect(pptSlides).toHaveProperty('images');
    expect(pptSlides).toHaveProperty('chart');
  });

  it('office_fill_ppt_template：模板不动 / 另存产出 / 版式主题品牌（T2 兜底防回归）', () => {
    const fillDef = new OfficeTools().getDefs().find((d) => d.name === 'office_fill_ppt_template');
    expect(fillDef).toBeDefined();
    expect(fillDef!.description).toContain('模板');
    expect(fillDef!.description).toContain('另存');
    expect(fillDef!.description).toMatch(/版式|主题|品牌/);
  });
});
