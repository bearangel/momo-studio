// electron/tests/skill/loader.test.ts
//
// parseSkillMd 单元测试：frontmatter 解析、必填字段校验、缺省值填充。

import { describe, it, expect } from 'vitest';
import { parseSkillMd } from '../../src/main/skill/loader';

const VALID_SKILL_MD = `---
name: code-review-workflow
description: 执行标准的代码审查流程
version: 1.0.0
allowedTools:
  - read_file
  - write_file
tags:
  - code-review
  - security
---

# 代码审查工作流

## 步骤
1. 读取代码文件
2. 检查安全漏洞
3. 输出审查报告
`;

describe('skill/loader', () => {
  it('parseSkillMd 解析 frontmatter + body', () => {
    const def = parseSkillMd(VALID_SKILL_MD, '/cache/code-review');
    expect(def.slug).toBe('code-review-workflow');
    expect(def.name).toBe('code-review-workflow');
    expect(def.description).toBe('执行标准的代码审查流程');
    expect(def.version).toBe('1.0.0');
    expect(def.allowedTools).toEqual(['read_file', 'write_file']);
    expect(def.tags).toEqual(['code-review', 'security']);
    expect(def.cachePath).toBe('/cache/code-review');
    expect(def.id).toBeTruthy();
    expect(def.body).toContain('# 代码审查工作流');
    expect(def.body).toContain('读取代码文件');
  });

  it('缺少 version 时默认 1.0.0', () => {
    const md = `---
name: no-version
description: 无版本声明
---
正文`;
    const def = parseSkillMd(md, '/cache');
    expect(def.version).toBe('1.0.0');
    expect(def.allowedTools).toEqual([]);
    expect(def.tags).toEqual([]);
  });

  it('缺少 frontmatter 抛错', () => {
    expect(() => parseSkillMd('just markdown', '/cache')).toThrow('frontmatter');
  });

  it('缺少 name 抛错', () => {
    const bad = `---
description: test
---
body`;
    expect(() => parseSkillMd(bad, '/cache')).toThrow('name');
  });

  it('缺少 description 抛错', () => {
    const bad = `---
name: has-name
---
body`;
    expect(() => parseSkillMd(bad, '/cache')).toThrow('description');
  });
});
