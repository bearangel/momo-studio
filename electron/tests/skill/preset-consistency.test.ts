// electron/tests/skill/preset-consistency.test.ts
// 预设内容库一致性契约锁（spec 2026-10-08 §8）：
//   A. catalog builtin skill 条目 ≡ skills 目录（双轨同步，防漂移回归）
//   B. agent YAML defaultSkills 引用的 slug 全部真实存在（防运行时静默丢技能）
//   C. 全部 SKILL.md frontmatter 完整（name/description 非空且足以承载触发语）
//   D. 全部 agent YAML 可被生产解析器解析（防启动流程静默跳过坏文件）
//   E. agent defaultTools 引用的工具名全部真实存在（防工具契约漂移，同 builtin-office 先例）
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '../../src/main/skill/zip-uploader';
import { parseAgentManifestWithSuggestion } from '../../src/main/agent/manifest-parser';
import { ALL_BUILTIN_TOOLS } from '../../src/main/agent/tools/catalog';

// __dirname = electron/tests/skill（3 级上溯到仓库根）
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SKILLS_DIR = path.join(REPO_ROOT, 'electron', 'resources', 'skills');
const AGENTS_DIR = path.join(REPO_ROOT, 'electron', 'resources', 'agents');
const CATALOG_PATH = path.join(REPO_ROOT, 'resources', 'marketplace', 'catalog.json');

function listSkillSlugs(): string[] {
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function listAgentYamls(): string[] {
  return fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.yaml')).sort();
}

interface CatalogShape {
  items: Array<{ type: string; slug: string; downloadUrl: string }>;
}

function readCatalog(): CatalogShape {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8')) as CatalogShape;
}

describe('预设内容库一致性（spec 2026-10-08）', () => {
  it('A. catalog builtin skill 条目与 skills 目录一一对齐（防双轨漂移）', () => {
    const catalogSkillSlugs = readCatalog().items
      .filter((i) => i.type === 'skill' && i.downloadUrl === '')
      .map((i) => i.slug)
      .sort();
    expect(catalogSkillSlugs).toEqual(listSkillSlugs());
  });

  it('B. agent YAML 的 defaultSkills 引用全部存在于 skills 目录', () => {
    const slugs = new Set(listSkillSlugs());
    for (const f of listAgentYamls()) {
      const { def } = parseAgentManifestWithSuggestion(
        fs.readFileSync(path.join(AGENTS_DIR, f), 'utf-8'),
      );
      for (const ref of def.defaultSkills) {
        expect(slugs.has(ref.ref), `${f} 引用了不存在的 skill: ${ref.ref}`).toBe(true);
      }
    }
  });

  it('C. 全部 SKILL.md frontmatter 完整（name/description 非空，description ≥ 12 字）', () => {
    for (const slug of listSkillSlugs()) {
      const md = fs.readFileSync(path.join(SKILLS_DIR, slug, 'SKILL.md'), 'utf-8');
      const front = parseFrontmatter(md);
      expect(front.name, `${slug} 缺 name`).toBeTruthy();
      expect(front.description, `${slug} 缺 description`).toBeTruthy();
      expect(
        front.description!.length,
        `${slug} description 过短（应含触发场景短语）`,
      ).toBeGreaterThanOrEqual(12);
    }
  });

  it('D. 全部 agent YAML 可被生产解析器解析（防静默跳过）', () => {
    for (const f of listAgentYamls()) {
      const { def } = parseAgentManifestWithSuggestion(
        fs.readFileSync(path.join(AGENTS_DIR, f), 'utf-8'),
      );
      expect(def.slug, f).toBeTruthy();
    }
  });

  it('E. agent YAML 的 defaultTools 引用的工具全部真实存在（防契约漂移）', () => {
    // LSP 休眠豁免：LSP 子系统 2026-10-08 下架（commit 9cc3407a，ALL_BUILTIN_TOOLS
    // 已摘除 lsp_*），现有 agent YAML 的 lsp 引用是下架提交刻意保留的休眠态；
    // LSP 恢复时移除本豁免。
    const dormantRefs = new Set(['lsp_diagnostics', 'lsp_find_references']);
    for (const f of listAgentYamls()) {
      const { def } = parseAgentManifestWithSuggestion(
        fs.readFileSync(path.join(AGENTS_DIR, f), 'utf-8'),
      );
      for (const t of def.defaultTools) {
        expect(
          ALL_BUILTIN_TOOLS.includes(t.ref) || dormantRefs.has(t.ref),
          `${f} 引用了不存在的工具: ${t.ref}`,
        ).toBe(true);
      }
    }
  });
});
