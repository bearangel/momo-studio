// electron/tests/skill/builtin-presets.test.ts
//
// 预置技能包：frontmatter 可解析 + registry 注册成功 + 三包齐备。
// 验证 electron/resources/skills/ 下三个 slug 的 SKILL.md 文件存在、可被
// SkillRegistry 注册（Layer 1 索引命中），且 frontmatter 三字段（name/description/version）非空。
//
// 路径说明：
//   - 本测试用 `path.resolve(__dirname, '../../resources/skills')` 解析 builtin 根。
//   - 这与生产代码 `resolveBuiltinSkillsDir()` 的 dev 分支指向同一目录：
//     `<repo>/electron/resources/skills`（`__dirname/../../../resources/skills`，因
//     编译后 __dirname 指向 electron/src/main/skill，等价路径）。
//   - 打包后生产代码走 `process.resourcesPath/skills`，本测试不覆盖该路径
//     （打包产物在容器内不可重现——以源码路径为准）。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SkillRegistry } from '../../src/main/skill/registry';

const RESOURCES_SKILLS = path.resolve(__dirname, '../../resources/skills');

describe('builtin 预置技能包', () => {
  const slugs = ['code-review', 'write-tests', 'debug-reproduce'];

  it.each(slugs)('%s 存在且可注册', (slug) => {
    const reg = new SkillRegistry();
    reg.register(path.join(RESOURCES_SKILLS, slug));
    const idx = reg.getIndex();
    expect(idx).toContain(slug);
  });

  it('frontmatter name/description 非空（picker 元数据完整）', () => {
    for (const slug of slugs) {
      const raw = fs.readFileSync(path.join(RESOURCES_SKILLS, slug, 'SKILL.md'), 'utf-8');
      const fm = raw.match(/^---\n([\s\S]*?)\n---/);
      expect(fm, `${slug} 缺 frontmatter`).not.toBeNull();
      expect(fm![1]).toMatch(/^name:\s*\S+/m);
      expect(fm![1]).toMatch(/^description:\s*\S+/m);
      expect(fm![1]).toMatch(/^version:\s*\S+/m);
    }
  });
});
