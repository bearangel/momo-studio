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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillRegistry } from '../../src/main/skill/registry';
import { listInstalled } from '../../src/main/skill/zip-uploader';
import { runMigrations, closeDb } from '../../src/main/storage/db';

const RESOURCES_SKILLS = path.resolve(__dirname, '../../resources/skills');

describe('builtin 预置技能包', () => {
  const slugs = ['code-review', 'write-tests', 'debug-reproduce'];

  let tmpRoot: string;

  beforeEach(() => {
    // listInstalled 依赖 userData（custom 扫描）与 DB（marketplace 分支）——照 upload-zip.test 模式隔离
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-builtin-'));
    process.env.AP_USER_DATA_DIR = tmpRoot;
    runMigrations();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });

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

  // Produces 契约锁：三包经 resolveBuiltinSkillsDir + listInstalled builtin 扫描分支对外可见
  //（「resource:list 可见 source=builtin」的回归锁——防止 builtin 根解析或目录扫描回归而测试仍绿）
  it('listInstalled 收录三包（source=builtin，slug=目录名，中文展示名）', () => {
    const installed = listInstalled();
    for (const slug of slugs) {
      const hit = installed.find((s) => s.slug === slug);
      expect(hit, `${slug} 未出现在 listInstalled`).toBeDefined();
      expect(hit!.source).toBe('builtin');
      expect(hit!.name).toBeTruthy();
      expect(hit!.description.length).toBeGreaterThan(0);
    }
  });
});
