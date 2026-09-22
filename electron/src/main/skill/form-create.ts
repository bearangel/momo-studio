// electron/src/main/skill/form-create.ts
//
// 表单创建 skill（spec §5.1 唯一新 IPC 的主进程实现）：
//   name/description/body → <skillsDir>/<slug>/SKILL.md + .sha256 标记
// 与 zip 上传同布局——listInstalled 依据 .sha256 标记自动识别为 custom 源，无需写 DB。
// slug 冲突 = 覆盖（与 zip 重复上传同语义）。skillsDir 参数供测试注入。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getSkillsDir, nameToSlug, type UploadedSkill } from './zip-uploader';
import { logger } from '../logger';

export interface SkillCreateInput {
  name: string;
  description: string;
  body: string;
}

export function createSkillFromForm(input: SkillCreateInput, skillsDir: string = getSkillsDir()): UploadedSkill {
  if (!input.name.trim()) throw new Error('name 不能为空');
  if (!input.description.trim()) throw new Error('description 不能为空');
  if (!input.body.trim()) throw new Error('正文不能为空');
  const slug = nameToSlug(input.name);
  if (!slug) throw new Error(`无法从名称生成合法 slug：${input.name}`);

  const targetDir = path.join(skillsDir, slug);
  // frontmatter 值用 JSON 风格双引号转义——防描述含 ': ' 等 YAML 破坏字符
  const content = `---\nname: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(input.description)}\n---\n${input.body}`;
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'SKILL.md'), content, 'utf-8');
  // .sha256 标记 = custom 源识别依据（内容 hash，与 zip 上传同口径）
  fs.writeFileSync(
    path.join(targetDir, '.sha256'),
    crypto.createHash('sha256').update(content, 'utf-8').digest('hex'),
  );
  logger.info('Skill 表单创建成功', { slug });
  return { slug, name: input.name, description: input.description };
}