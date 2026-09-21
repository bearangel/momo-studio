// electron/tests/agent/tools/office/builtin-office.test.ts
// 三联动契约锁：YAML 可解析 + defaultTools 引用全部真实存在 + catalog 条目齐备。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { load as loadYamlRaw } from 'js-yaml';
import { OfficeTools } from '../../../../src/main/agent/tools/office-tools';
import { ALL_BUILTIN_TOOLS, TOOL_CATEGORIES } from '../../../../src/main/agent/tools/catalog';
import { parseAgentManifestWithSuggestion } from '../../../../src/main/agent/manifest-parser';

// __dirname = electron/tests/agent/tools/office（5 级）→ 4 级上溯到 electron/（agents 在
// electron/resources/agents），5 级上溯到仓库根（marketplace 在根 resources/marketplace）。
const AGENTS_DIR = path.resolve(__dirname, '../../../..', 'resources/agents');
const CATALOG_PATH = path.resolve(__dirname, '../../../../..', 'resources/marketplace/catalog.json');

function loadYaml(rel: string): Record<string, unknown> {
  return loadYamlRaw(fs.readFileSync(path.join(AGENTS_DIR, rel), 'utf-8')) as Record<string, unknown>;
}

describe('office-assistant.yaml', () => {
  it('解析成功且元数据齐备', () => {
    const m = loadYaml('office-assistant.yaml');
    const meta = m.metadata as Record<string, unknown>;
    expect(meta.slug).toBe('office-assistant');
    expect(typeof meta.name).toBe('string');
    const spec = m.spec as Record<string, unknown>;
    expect(spec.type).toBe('standalone');
  });

  it('defaultTools 引用的工具全部真实存在（防契约漂移）', () => {
    const m = loadYaml('office-assistant.yaml');
    const spec = m.spec as Record<string, unknown>;
    // spec.defaultTools 与 spec.declarative 平级（manifest-parser.ts:86 读取该路径）。
    const tools = spec.defaultTools as Array<{ kind: string; ref: string }>;
    expect(tools.length).toBeGreaterThan(0);
    const realDefs = new Set(new OfficeTools().getDefs().map((d) => d.name));
    for (const t of tools) {
      expect(
        realDefs.has(t.ref) || ALL_BUILTIN_TOOLS.includes(t.ref as (typeof ALL_BUILTIN_TOOLS)[number]),
        `defaultTools 引用了不存在的工具: ${t.ref}`,
      ).toBe(true);
    }
    // 办公八工具必须全部在内
    for (const n of [
      'office_read', 'office_read_cells', 'office_create_excel', 'office_write_excel',
      'office_create_doc', 'office_create_ppt', 'office_create_pdf', 'office_copy',
    ]) {
      expect(tools.some((t) => t.ref === n), `缺少 ${n}`).toBe(true);
    }
  });

  it('能被生产解析器 parseAgentManifestWithSuggestion 解析（defaultTools 13 项契约锁）', () => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'office-assistant.yaml'), 'utf-8');
    const { def } = parseAgentManifestWithSuggestion(content);
    expect(def.slug).toBe('office-assistant');
    expect(def.defaultTools).toHaveLength(13);
    const refs = def.defaultTools.map((t) => t.ref);
    for (const n of ['office_read', 'office_copy', 'office_create_pdf', 'webfetch']) {
      expect(refs, n).toContain(n);
    }
  });
});

describe('工具全集与分类', () => {
  it('office 八工具全部进入全集（33 个）', () => {
    expect(ALL_BUILTIN_TOOLS).toHaveLength(33);
    expect(ALL_BUILTIN_TOOLS).toContain('office_read');
    expect(ALL_BUILTIN_TOOLS).toContain('office_copy');
  });
  it('分类并集 == 全集（既有不变量）', () => {
    const union = new Set(TOOL_CATEGORIES.flatMap((c) => c.tools));
    for (const t of ALL_BUILTIN_TOOLS) expect(union.has(t)).toBe(true);
  });
});

describe('marketplace catalog', () => {
  it('office-assistant 条目存在且为内联包', () => {
    const p = CATALOG_PATH;
    const catalog = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      items: Array<{ id: string; slug: string; type: string; downloadUrl: string; readme: string }>;
    };
    const item = catalog.items.find((i) => i.slug === 'office-assistant');
    expect(item).toBeDefined();
    expect(item!.type).toBe('agent');
    expect(item!.downloadUrl).toBe(''); // 内联包（createInlinePackage 就地生成 manifest）
    expect(item!.readme.length).toBeGreaterThan(50); // readme 即 systemPrompt 载体
  });

  it('add_chart 提示词同步锁：YAML systemPrompt / catalog readme / WRITE_EXCEL_DEF description 三处一致', () => {
    // YAML systemPrompt 含 add_chart 工作流指引
    const yaml = loadYaml('office-assistant.yaml');
    const yamlPrompt = ((yaml.spec as Record<string, unknown>).declarative as Record<string, unknown>)
      .systemPrompt as string;
    expect(yamlPrompt).toContain('add_chart');

    // catalog readme 含 add_chart 指引（readme 即 systemPrompt 载体）
    const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8')) as {
      items: Array<{ slug: string; readme: string }>;
    };
    const item = catalog.items.find((i) => i.slug === 'office-assistant');
    expect(item!.readme).toContain('add_chart');

    // WRITE_EXCEL_DEF description 含 add_chart（LLM 看到的工具描述）
    const writeDef = new OfficeTools().getDefs().find((d) => d.name === 'office_write_excel');
    expect(writeDef!.description).toContain('add_chart');
    // op enum 已扩展
    const props = writeDef!.inputSchema.properties as Record<string, unknown>;
    const opsSchema = props['ops'] as { items: { properties: { op: { enum: string[] } } } };
    expect(opsSchema.items.properties.op.enum).toContain('add_chart');

    // 公式优先工作流同步锁（P1c）：YAML / catalog readme / WRITE_EXCEL_DEF 三处一致
    expect(yamlPrompt).toContain('SUMIF');
    expect(item!.readme).toContain('SUMIF');
    expect(writeDef!.description).toContain('SUMIF');
  });

  it('fill 提示词同步锁（spec §14.7）：YAML / catalog readme / WRITE_EXCEL_DEF 三处一致 + op enum 含 fill', () => {
    const yaml = loadYaml('office-assistant.yaml');
    const yamlPrompt = ((yaml.spec as Record<string, unknown>).declarative as Record<string, unknown>)
      .systemPrompt as string;
    expect(yamlPrompt).toContain('fill');

    const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8')) as {
      items: Array<{ slug: string; readme: string }>;
    };
    const item = catalog.items.find((i) => i.slug === 'office-assistant');
    expect(item!.readme).toContain('fill');

    const writeDef = new OfficeTools().getDefs().find((d) => d.name === 'office_write_excel');
    expect(writeDef!.description).toContain('fill');
    const props = writeDef!.inputSchema.properties as Record<string, unknown>;
    const opsSchema = props['ops'] as { items: { properties: { op: { enum: string[] } } } };
    expect(opsSchema.items.properties.op.enum).toContain('fill');
  });

  it('A 场景验收契约锁：WRITE_EXCEL_DEF 含 fill 七型字段名 + 原子性契约；YAML/readme 含 VLOOKUP 第一列起措辞 + 验证一致性', () => {
    const writeDef = new OfficeTools().getDefs().find((d) => d.name === 'office_write_excel');
    // WRITE_EXCEL_DEF description 含 fill 七型字段关键词 + 原子性契约
    expect(writeDef!.description).toContain('sequence_date');
    expect(writeDef!.description).toContain('template');
    expect(writeDef!.description).toContain('原子');

    // columns 子 schema 双重锁定（description + schema 两路锁）
    const props = writeDef!.inputSchema.properties as Record<string, unknown>;
    const opsSchema = props['ops'] as { items: { properties: { columns: { description: string } } } };
    expect(opsSchema.items.properties.columns.description).toContain('sequence_date');
    expect(opsSchema.items.properties.columns.description).toContain('template');

    // YAML systemPrompt：VLOOKUP 从第一列起 + office_read_cells 验证一致性
    const yaml = loadYaml('office-assistant.yaml');
    const yamlPrompt = ((yaml.spec as Record<string, unknown>).declarative as Record<string, unknown>)
      .systemPrompt as string;
    expect(yamlPrompt).toContain('第一');
    expect(yamlPrompt).toContain('office_read_cells');

    // catalog readme 同步锁
    const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8')) as {
      items: Array<{ slug: string; readme: string }>;
    };
    const item = catalog.items.find((i) => i.slug === 'office-assistant');
    expect(item!.readme).toContain('第一');
    expect(item!.readme).toContain('office_read_cells');
  });

  it('§14.8-6 三联动契约锁：set_format 提示词/搬运教学 三处一致 + 表头覆盖警示 + fill 表 repeat', () => {
    const writeDef = new OfficeTools().getDefs().find((d) => d.name === 'office_write_excel');
    const props = writeDef!.inputSchema.properties as Record<string, unknown>;
    const opsSchema = props['ops'] as { items: { properties: { op: { enum: string[] } } } };

    // set_format 三处一致：YAML systemPrompt / catalog readme / WRITE_EXCEL_DEF
    const yaml = loadYaml('office-assistant.yaml');
    const yamlPrompt = ((yaml.spec as Record<string, unknown>).declarative as Record<string, unknown>)
      .systemPrompt as string;
    expect(yamlPrompt).toContain('set_format');
    // set_format 在系统提示里要求白名单提一句（防 LLM 注入未白名单格式）
    expect(yamlPrompt).toContain('白名单');
    // set_format 在系统提示里要求显式提「百分比/千分位」场景词
    expect(yamlPrompt).toContain('百分比');

    const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8')) as {
      items: Array<{ slug: string; readme: string }>;
    };
    const item = catalog.items.find((i) => i.slug === 'office-assistant');
    expect(item!.readme).toContain('set_format');
    expect(item!.readme).toContain('百分比');

    expect(writeDef!.description).toContain('set_format');
    // op enum 已扩（T2 已加，本用例兜底）
    expect(opsSchema.items.properties.op.enum).toContain('set_format');

    // 表头覆盖警示（spec §14.8-6 三句之一；YAML/catalog 不必逐句重复，DEF 是 LLM 看到的关键）
    expect(writeDef!.description).toContain('覆盖表头');

    // 跨文件搬数据教学：read_cells 精读 + set_cells 分批 ≤50 行 + 公式列筛选预警（YAML/catalog/DEF 三处一致）
    for (const source of [yamlPrompt, item!.readme, writeDef!.description]) {
      // 三个教学要点都要落到三处（语义等价允许表述差异，但关键词必须出现）
      expect(source).toContain('office_read_cells');
    }
    // 分批 ≤50 行：YAML 系统提示里必含（教学最常落地处）；catalog readme 语义同步
    expect(yamlPrompt).toContain('50 行');
    expect(item!.readme).toContain('50 行');
    // 公式列筛选/预警：IF/COUNTIF/SUMIF 三选其一即可（spec 给「IF/COUNTIF」）
    expect(yamlPrompt).toMatch(/IF|COUNTIF|SUMIF/);
    expect(item!.readme).toMatch(/IF|COUNTIF|SUMIF/);

    // fill 表含 repeat（spec §14.8-3 + §14.8-6 复用 fill 七型表，T2 已加，本用例锁语义）
    expect(writeDef!.description).toContain('repeat');
    expect(writeDef!.description).toContain('sequence_date');
  });

  it('§14.9 PPT 视觉四能力三联动契约锁：YAML/catalog/DEF 三处各含 office_fill_ppt_template + DEF 含 background/chart + YAML 含模板工作流关键词', () => {
    const yaml = loadYaml('office-assistant.yaml');
    const yamlPrompt = ((yaml.spec as Record<string, unknown>).declarative as Record<string, unknown>)
      .systemPrompt as string;
    expect(yamlPrompt).toContain('office_fill_ppt_template');

    const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8')) as {
      items: Array<{ slug: string; readme: string }>;
    };
    const item = catalog.items.find((i) => i.slug === 'office-assistant');
    expect(item!.readme).toContain('office_fill_ppt_template');

    const pptCreate = new OfficeTools().getDefs().find((d) => d.name === 'office_create_ppt');
    expect(pptCreate!.description).toContain('office_fill_ppt_template');
    // 双保险：DEF 名 + description 都点名，防 description 改了工具名还在
    expect(new OfficeTools().getDefs().some((d) => d.name === 'office_fill_ppt_template')).toBe(true);

    expect(pptCreate!.description).toContain('background');
    expect(pptCreate!.description).toContain('chart');
    expect(pptCreate!.description).toContain('images');
    // schema properties 也含 background/chart/images（双路锁：description + schema）
    const pptProps = pptCreate!.inputSchema.properties as Record<string, unknown>;
    const pptSlides = (pptProps['slides'] as { items: { properties: Record<string, unknown> } }).items.properties;
    expect(pptSlides).toHaveProperty('background');
    expect(pptSlides).toHaveProperty('images');
    expect(pptSlides).toHaveProperty('chart');

    // 模板工作流关键词（spec §14.9-3 模板填充工具 + YAML 教学指引）
    expect(yamlPrompt).toContain('模板');
    expect(yamlPrompt).toContain('填充');
    expect(item!.readme).toContain('模板');
    expect(item!.readme).toContain('填充');

    // OFFICE_FILL_PPT_DEF 模板不动 / 产出新文件 / 版式主题品牌全保留（T2 已写，本用例兜底防回归）
    const fillDef = new OfficeTools().getDefs().find((d) => d.name === 'office_fill_ppt_template');
    expect(fillDef).toBeDefined();
    expect(fillDef!.description).toContain('模板');
    expect(fillDef!.description).toContain('另存');
    expect(fillDef!.description).toMatch(/版式|主题|品牌/);
  });
});
