// electron/tests/skill/form-create.test.ts
//
// 表单创建 skill（resource:createSkill）测试：与 zip 上传同布局（<skillsDir>/<slug>/SKILL.md + .sha256）
// listInstalled 据此自动识别 source='custom'。slug 冲突覆盖（与 zip 同语义）。
// skillsDir 参数供测试注入——不依赖 getSkillsDir() 默认路径。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSkillFromForm } from '../../src/main/skill/form-create';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'momo-skill-create-'));
}

describe('createSkillFromForm', () => {
  it('生成 SKILL.md（frontmatter+正文）与 .sha256 标记，返回 UploadedSkill', () => {
    const dir = tmpDir();
    const out = createSkillFromForm(
      { name: 'My Cool Skill', description: '描述：含冒号', body: '# 正文\n内容' },
      dir,
    );
    expect(out).toEqual({ slug: 'my-cool-skill', name: 'My Cool Skill', description: '描述：含冒号' });
    const md = fs.readFileSync(path.join(dir, 'my-cool-skill', 'SKILL.md'), 'utf-8');
    expect(md).toContain('name: "My Cool Skill"');
    expect(md).toContain('description: "描述：含冒号"');
    expect(md).toContain('# 正文');
    expect(fs.existsSync(path.join(dir, 'my-cool-skill', '.sha256'))).toBe(true);
  });

  it('同名重复创建覆盖旧目录（幂等语义与 zip 上传一致）', () => {
    const dir = tmpDir();
    createSkillFromForm({ name: 'dup', description: 'd', body: 'v1' }, dir);
    createSkillFromForm({ name: 'dup', description: 'd', body: 'v2' }, dir);
    const md = fs.readFileSync(path.join(dir, 'dup', 'SKILL.md'), 'utf-8');
    expect(md).toContain('v2');
  });

  it('空 name / 空 description / 空正文抛中文错误', () => {
    const dir = tmpDir();
    expect(() => createSkillFromForm({ name: '', description: 'd', body: 'b' }, dir)).toThrow('name 不能为空');
    expect(() => createSkillFromForm({ name: 'n', description: '', body: 'b' }, dir)).toThrow('description 不能为空');
    expect(() => createSkillFromForm({ name: 'n', description: 'd', body: ' ' }, dir)).toThrow('正文不能为空');
  });

  it('name 无法生成合法 slug 时抛错', () => {
    const dir = tmpDir();
    expect(() => createSkillFromForm({ name: '***', description: 'd', body: 'b' }, dir)).toThrow('无法从名称生成合法 slug');
  });

  it('覆盖时清空旧目录（zip 来源同名 skill 的附加文件不遗留）', () => {
    const dir = tmpDir();
    const skillDir = path.join(dir, 'dup');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'old');
    fs.writeFileSync(path.join(skillDir, 'scripts-tool.sh'), 'stale asset');
    createSkillFromForm({ name: 'dup', description: 'd', body: 'new' }, dir);
    expect(fs.existsSync(path.join(skillDir, 'scripts-tool.sh'))).toBe(false);
    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')).toContain('new');
    expect(fs.existsSync(path.join(skillDir, '.sha256'))).toBe(true);
  });
});
