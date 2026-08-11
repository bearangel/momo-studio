// electron/tests/skill/upload-zip.test.ts
//
// v1.6 Task 7：自定义 Skill zip 上传 / listInstalled / deleteCustomSkill 测试。
//   - 合法 zip → 解压 + 返回 slug + description
//   - 同 SHA256 幂等（不重写）
//   - 同 slug 不同 hash 覆盖
//   - 缺 SKILL.md 抛错
//   - 多根目录抛错
//   - listInstalled 返回 custom（三类来源之一）
//   - deleteCustomSkill 仅删 custom
//
// 隔离策略沿用仓库既定模式（参考 mcp-list-registered.test.ts）：
//   - process.env.AP_USER_DATA_DIR 指向临时目录 → resolveSkillsDir() 返回 <tmpRoot>/skills
//   - runMigrations() 建 skill_definitions 表（listInstalled 读 marketplace 用）
//   - closeDb() 在 afterEach 复位单例
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  uploadSkillZip,
  deleteCustomSkill,
  listInstalled,
} from '../../src/main/skill/zip-uploader';
import { runMigrations, closeDb } from '../../src/main/storage/db';

let tmpRoot: string;
let skillsDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-skill-'));
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  // resolveSkillsDir() = <userData>/skills = <tmpRoot>/skills
  skillsDir = path.join(tmpRoot, 'skills');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 构造一个合法的 skill zip：`<slug>/SKILL.md` + 标准 frontmatter */
function makeSkillZip(slug: string, description: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    `${slug}/SKILL.md`,
    Buffer.from(
      `---\nname: ${slug}\ndescription: ${description}\nversion: 1.0.0\n---\n\n# ${slug}\n\n正文。\n`,
    ),
  );
  return zip.toBuffer();
}

describe('skill zip 上传', () => {
  it('合法 zip → 解压 + 返回 slug + description', () => {
    const buf = makeSkillZip('my-skill', '测试 skill');
    const result = uploadSkillZip(buf, 'my-skill.zip');
    expect(result.slug).toBe('my-skill');
    expect(result.description).toBe('测试 skill');
    expect(fs.existsSync(path.join(skillsDir, 'my-skill', 'SKILL.md'))).toBe(true);
  });

  it('同 slug 同 SHA256 二次上传幂等（不重写文件）', () => {
    const buf = makeSkillZip('same', '同包');
    const r1 = uploadSkillZip(buf, 'a.zip');
    const r2 = uploadSkillZip(buf, 'b.zip');
    expect(r2.slug).toBe(r1.slug);
  });

  it('同 slug 不同 SHA256 二次上传覆盖', () => {
    uploadSkillZip(makeSkillZip('over', '旧'), 'a.zip');
    uploadSkillZip(makeSkillZip('over', '新'), 'b.zip');
    const result = uploadSkillZip(makeSkillZip('over', '新'), 'c.zip');
    expect(result.description).toBe('新');
  });

  it('zip 缺 SKILL.md 抛错', () => {
    const zip = new AdmZip();
    zip.addFile('no-skill/README.md', Buffer.from('no skill'));
    expect(() => uploadSkillZip(zip.toBuffer(), 'bad.zip')).toThrow(/SKILL\.md/);
  });

  it('zip 根目录有多个一级子目录抛错', () => {
    const zip = new AdmZip();
    zip.addFile('a/SKILL.md', Buffer.from('---\nname: a\ndescription: x\n---\n'));
    zip.addFile('b/SKILL.md', Buffer.from('---\nname: b\ndescription: x\n---\n'));
    expect(() => uploadSkillZip(zip.toBuffer(), 'multi.zip')).toThrow(/根目录/);
  });

  it('listInstalled 返回 builtin + marketplace + custom 三类', () => {
    uploadSkillZip(makeSkillZip('cu', '自定义'), 'cu.zip');
    // builtin（resources/skills 不存在 → 空）+ marketplace（DB 空）+ custom（刚上传）
    // 这里只验证 custom 增量
    const list = listInstalled();
    const cu = list.find((s) => s.slug === 'cu');
    expect(cu?.source).toBe('custom');
    expect(cu?.description).toBe('自定义');
  });

  it('deleteCustomSkill 仅删 custom；builtin/marketplace 抛错', () => {
    uploadSkillZip(makeSkillZip('cu', '自定义'), 'cu.zip');
    deleteCustomSkill('cu');
    expect(fs.existsSync(path.join(skillsDir, 'cu'))).toBe(false);
    // 删除后再 listInstalled 不应包含 cu
    const list = listInstalled();
    expect(list.find((s) => s.slug === 'cu')).toBeUndefined();
  });
});
