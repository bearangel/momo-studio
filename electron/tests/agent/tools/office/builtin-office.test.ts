// electron/tests/agent/tools/office/builtin-office.test.ts
// 三联动契约锁：YAML 可解析 + defaultTools 引用全部真实存在 + catalog 条目齐备。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { load as loadYamlRaw } from 'js-yaml';
import { OfficeTools } from '../../../../src/main/agent/tools/office-tools';
import { ALL_BUILTIN_TOOLS, TOOL_CATEGORIES } from '../../../../src/main/agent/tools/catalog';

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
});
