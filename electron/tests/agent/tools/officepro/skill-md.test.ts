// electron/tests/agent/tools/officepro/skill-md.test.ts
// SKILL.md 格式锁（spec 2026-11-03 §5.3）：frontmatter 必填字段 + 核心章节关键词。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSkillMd } from '../../../../src/main/skill/loader';
import { PLUGIN_ROOT } from './fixtures';

const skillDir = path.join(PLUGIN_ROOT, 'skills/office-authoring');

describe('office-authoring SKILL.md', () => {
  it('parseSkillMd 通过（frontmatter 完整）', () => {
    const def = parseSkillMd(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8'), skillDir);
    expect(def.slug).toBe('office-authoring');
    expect(def.name).toBeTruthy();
    expect(def.description).toBeTruthy();
  });

  it('正文含核心章节（决策树 / footgun / 设计规范 / QA）', () => {
    const def = parseSkillMd(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8'), skillDir);
    for (const keyword of ['路径决策', 'footgun', '设计规范', 'QA', 'momo-validate', 'outputs']) {
      expect(def.body).toContain(keyword);
    }
  });
});
