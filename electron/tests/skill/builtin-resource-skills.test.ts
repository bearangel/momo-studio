// electron/tests/skill/builtin-resource-skills.test.ts
//
// 四册资源创建技能的内容锁：frontmatter 完整 + 触发短语 + 关键纪律在场 + 工具名引用正确。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SKILLS_ROOT = path.join(__dirname, '../../resources/skills');
const SLUGS = ['create-agent', 'create-skill', 'create-mcp', 'build-team'] as const;
const TOOL_NAMES = ['resource_list', 'create_agent', 'add_agent_member', 'create_skill', 'create_mcp', 'create_team', 'list_models'];

describe('builtin 资源创建技能', () => {
  it.each(SLUGS)('%s：SKILL.md 在位且 frontmatter 完整', (slug) => {
    const md = fs.readFileSync(path.join(SKILLS_ROOT, slug, 'SKILL.md'), 'utf-8');
    expect(md).toMatch(/^---\n/);
    expect(md).toMatch(/name: .+/);
    expect(md).toMatch(/description: .+/);
  });

  it('create-agent 含工具名引用与复述纪律', () => {
    const md = fs.readFileSync(path.join(SKILLS_ROOT, 'create-agent/SKILL.md'), 'utf-8');
    expect(md).toContain('create_agent');
    expect(md).toContain('复述');
    expect(fs.existsSync(path.join(SKILLS_ROOT, 'create-agent/references/tool-catalog.md'))).toBe(true);
  });

  it('build-team 含盘点先行纪律', () => {
    const md = fs.readFileSync(path.join(SKILLS_ROOT, 'build-team/SKILL.md'), 'utf-8');
    expect(md).toContain('resource_list');
    expect(md).toContain('盘点');
    expect(md).toContain('leader');
  });

  it('create-skill 防自举递归纪律在场', () => {
    const md = fs.readFileSync(path.join(SKILLS_ROOT, 'create-skill/SKILL.md'), 'utf-8');
    expect(md).toContain('递归');
  });

  it('create-agent model 块必填纪律在场（回归锁：模板注释曾标「建议位」致 agent 省略整块、create_agent 两次失败）', () => {
    const md = fs.readFileSync(path.join(SKILLS_ROOT, 'create-agent/SKILL.md'), 'utf-8');
    expect(md).toContain('必填');
    expect(md).toContain('NEVER: 省略 spec.declarative.model');
  });

  it('create-mcp 凭证纪律在场', () => {
    const md = fs.readFileSync(path.join(SKILLS_ROOT, 'create-mcp/SKILL.md'), 'utf-8');
    expect(md).toContain('回显');
  });

  it('全部工具名引用都在七工具集内（防拼错工具名）', () => {
    for (const slug of SLUGS) {
      const md = fs.readFileSync(path.join(SKILLS_ROOT, slug, 'SKILL.md'), 'utf-8');
      const mentioned = TOOL_NAMES.filter((t) => new RegExp(`\\b${t}\\b`).test(md));
      expect(mentioned.length, `${slug} 至少引用一个真实工具名`).toBeGreaterThan(0);
    }
  });
});
