// electron/src/main/skill/loader.ts
//
// SKILL.md 解析器。分离 YAML frontmatter（--- 包围）与 Markdown 正文，
// 校验必填字段后输出 SkillDefinition。
//
// 用 js-yaml 的 load（manifest-parser 同款），CJS 友好无 ESM 冲突。
// 正则分离 frontmatter/body 后对捕获组做显式判空（noUncheckedIndexedAccess 下
// 捕获组类型为 string | undefined）。

import { load as yamlLoad } from 'js-yaml';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import type { SkillDefinition, SkillFrontmatter } from './types';

/** 匹配 --- 包围的 YAML frontmatter + 其后的 Markdown 正文 */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

/** 解析 SKILL.md 文本为 SkillDefinition。格式错误或缺少必填字段会抛错。 */
export function parseSkillMd(content: string, cachePath: string): SkillDefinition {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error('SKILL.md 格式错误：缺少 YAML frontmatter（--- 包围）');
  }
  // noUncheckedIndexedAccess: 捕获组为 string | undefined，显式判空
  const yamlText = match[1];
  const body = match[2];
  if (yamlText === undefined || body === undefined) {
    throw new Error('SKILL.md 格式错误：无法分离 frontmatter 与正文');
  }

  const fm = yamlLoad(yamlText) as SkillFrontmatter;

  // 校验必填字段
  if (!fm.name) throw new Error('SKILL.md frontmatter 缺少 name');
  if (!fm.description) throw new Error('SKILL.md frontmatter 缺少 description');

  return {
    id: randomUUID(),
    slug: fm.name,
    name: fm.name,
    description: fm.description,
    version: fm.version ?? '1.0.0',
    allowedTools: fm.allowedTools ?? [],
    tags: fm.tags ?? [],
    cachePath,
    body: body.trim(),
  };
}

/**
 * 读取 skill 目录下的附加资源文件（相对于 skill cachePath）。文件不存在会抛 fs 错误。
 *
 * 安全：对解析后的路径做沙箱检查，防止 LLM 通过 resourcePath（如 `../../etc/passwd`、
 * 绝对路径或符号链接）读取 cachePath 之外的文件。优先对已存在的目标做 realpath 校验；
 * 目标尚不存在时回退到父目录校验。
 */
export function readSkillResource(cachePath: string, resourcePath: string): string {
  const fullPath = path.resolve(cachePath, resourcePath);
  const realCachePath = realpathSync(cachePath);

  // 优先对目标文件本身做 realpath；文件不存在时回退到父目录
  let realAnchor: string;
  try {
    realAnchor = realpathSync(fullPath);
  } catch {
    try {
      realAnchor = realpathSync(path.dirname(fullPath));
    } catch {
      throw new Error(`资源路径无效: ${resourcePath}`);
    }
  }
  // 解析后的真实路径必须在 cachePath 目录内（防 ../ 与符号链接穿越）
  if (realAnchor !== realCachePath && !realAnchor.startsWith(realCachePath + path.sep)) {
    throw new Error(`资源路径越界: ${resourcePath}`);
  }
  return readFileSync(fullPath, 'utf-8');
}
