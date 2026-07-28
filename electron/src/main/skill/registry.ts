// electron/src/main/skill/registry.ts
//
// Skill 注册表。管理已安装的 skill 包，提供三层渐进式披露（progressive disclosure），
// 目的是把 token 成本从「一次性灌满」降到「按需展开」：
//
//   Layer 1  getIndex()        frontmatter 摘要（~100 tokens/skill），始终注入 system prompt
//   Layer 2  loadFull(slug)    完整 SKILL.md 正文（~2-3k tokens），LLM 主动调 loadSkill 加载
//   Layer 3  loadResource(...) 附加资源文件，LLM 主动调 readResource 读取
//
// 同一 skill 重复注册会覆盖（以 slug 为 key），便于热更新。

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseSkillMd, readSkillResource } from './loader';
import type { SkillDefinition } from './types';
import { logger } from '../logger';

export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();

  /** 注册一个 skill 目录（须含 SKILL.md）。返回解析得到的 SkillDefinition。 */
  register(cachePath: string): SkillDefinition {
    const skillMdPath = path.join(cachePath, 'SKILL.md');
    if (!existsSync(skillMdPath)) {
      throw new Error(`SKILL.md 不存在: ${skillMdPath}`);
    }
    const content = readFileSync(skillMdPath, 'utf-8');
    const def = parseSkillMd(content, cachePath);
    this.skills.set(def.slug, def);
    logger.info('Skill 已注册', { slug: def.slug, name: def.name });
    return def;
  }

  /** 获取所有已注册 skill 的索引（Layer 1 — 注入 system prompt 用）。 */
  getIndex(): string {
    const lines: string[] = [];
    for (const def of this.skills.values()) {
      lines.push(`- ${def.name} v${def.version}: ${def.description}`);
    }
    return lines.join('\n');
  }

  /** 加载完整 SKILL.md 正文（Layer 2 — LLM 通过 loadSkill 虚拟工具触发）。 */
  loadFull(slug: string): string {
    const def = this.skills.get(slug);
    if (!def) throw new Error(`Skill 不存在: ${slug}`);
    return def.body;
  }

  /** 读取附加资源文件（Layer 3 — LLM 通过 readResource 虚拟工具触发）。 */
  loadResource(slug: string, resourcePath: string): string {
    const def = this.skills.get(slug);
    if (!def) throw new Error(`Skill 不存在: ${slug}`);
    return readSkillResource(def.cachePath, resourcePath);
  }

  /** 检查 skill 是否已注册。 */
  has(slug: string): boolean {
    return this.skills.has(slug);
  }

  /** 列出所有已注册 skill。 */
  list(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }
}
