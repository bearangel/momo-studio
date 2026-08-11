// electron/src/main/skill/zip-uploader.ts
//
// 自定义 Skill zip 上传：解压 + SHA256 校验 + 注册到 <userData>/skills/<slug>/。
//
// zip 结构要求：`<slug>/SKILL.md` + 可选 `<slug>/resources/*`。
//   - 缺 SKILL.md → 抛错
//   - 多个 SKILL.md（多个一级子目录）→ 抛错
//   - 同 slug 同 SHA256 → 幂等返回（不重写）
//   - 同 slug 不同 SHA256 → 备份旧目录后覆盖
//   - 所有 entry 做路径防御（含 `..` 的跳过）
//
// .sha256 标记文件写在 <targetDir>/.sha256——这是区分 custom（用户上传）vs
// marketplace（市场安装写 skill_definitions 表，cache_path 在别处）的关键：
// listInstalled 据此判定 custom；deleteCustomSkill 据此拒绝删 builtin/marketplace。

import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { load as yamlLoad } from 'js-yaml';
import { resolveSkillsDir } from '../paths';
import { logger } from '../logger';
import { getDb } from '../storage/db';

/** 已安装 skill 的对外展示结构（listInstalled 返回） */
export interface InstalledSkill {
  slug: string;
  name: string;
  description: string;
  /** 来源：builtin=应用内置 / marketplace=市场安装 / custom=用户 zip 上传 */
  source: 'builtin' | 'marketplace' | 'custom';
  /** 安装时间 ISO 字符串；builtin 为 null */
  installedAt: string | null;
}

/** 自定义 skill zip 存放目录（<userData>/skills/）。内部统一走此函数。 */
export function getSkillsDir(): string {
  return resolveSkillsDir();
}

/** frontmatter 最小结构（zip-uploader 只关心 name/description） */
interface SkillFrontmatter {
  name?: string;
  description?: string;
}

/** 匹配 --- 包围的 YAML frontmatter（兼容 \n 与 \r\n 行尾） */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/** 轻量 YAML frontmatter 解析（比 loader.ts 的 parseSkillMd 更宽容：不抛错） */
function parseFrontmatter(md: string): SkillFrontmatter {
  const m = md.match(FRONTMATTER_RE);
  if (!m) return {};
  const yamlText = m[1];
  if (yamlText === undefined) return {};
  try {
    return yamlLoad(yamlText) as SkillFrontmatter;
  } catch {
    return {};
  }
}

/**
 * 解析内置 skill 目录（dev: <repo>/electron/resources/skills/，packaged: resourcesPath/skills）。
 * 与 agent/builtin.ts 的 resolveBuiltinAgentsDir 同款模式。目录不存在时 listInstalled 返回空。
 */
function resolveBuiltinSkillsDir(): string {
  if (process.resourcesPath && !process.defaultApp) {
    return path.join(process.resourcesPath, 'skills');
  }
  return path.join(__dirname, '..', '..', '..', 'resources', 'skills');
}

/**
 * 上传 zip → 解压到 <skillsDir>/<slug>/ + 写 .sha256 标记。
 * 返回 slug + description（从 frontmatter 解析）。
 */
export function uploadSkillZip(
  buffer: Buffer,
  _filename: string,
): { slug: string; description: string } {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  // 找全部 SKILL.md（路径形如 <slug>/SKILL.md 或 SKILL.md）
  const skillEntries = entries.filter(
    (e) =>
      !e.isDirectory && (e.entryName.endsWith('/SKILL.md') || e.entryName === 'SKILL.md'),
  );
  if (skillEntries.length === 0) {
    throw new Error('zip 内未找到 SKILL.md（要求 <slug>/SKILL.md 结构）');
  }
  if (skillEntries.length > 1) {
    // 多个 SKILL.md = 多个一级子目录（如 a/SKILL.md + b/SKILL.md）
    throw new Error('zip 根目录包含多个子目录（应有且仅有一个 <slug>/ 包裹 SKILL.md）');
  }

  const skillEntry = skillEntries[0];
  if (!skillEntry) {
    throw new Error('zip 内未找到 SKILL.md（解析异常）');
  }

  // 校验 SKILL.md 路径深度：<slug>/SKILL.md（2 段）或 SKILL.md（1 段）
  const parts = skillEntry.entryName.split('/');
  if (parts.length > 2) {
    throw new Error(`SKILL.md 路径过深：${skillEntry.entryName}（要求 <slug>/SKILL.md）`);
  }
  // parts[0] 在 noUncheckedIndexedAccess 下为 string | undefined，显式判空
  const slug = parts.length === 2 && parts[0] ? parts[0] : 'unnamed';
  if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
    throw new Error(`非法 slug：${slug}`);
  }

  // 解析 frontmatter 取 description
  const md = skillEntry.getData().toString('utf-8');
  const front = parseFrontmatter(md);
  const description = front.description ?? '';

  // SHA256 幂等检查（对 buffer 整体取 hash）
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const skillsDir = getSkillsDir();
  const targetDir = path.join(skillsDir, slug);
  const hashFile = path.join(targetDir, '.sha256');

  if (fs.existsSync(hashFile)) {
    const existingHash = fs.readFileSync(hashFile, 'utf-8').trim();
    if (existingHash === hash) {
      logger.info('Skill zip 同 hash 幂等返回', { slug, hash });
      return { slug, description };
    }
  }

  // 覆盖：备份旧目录并立即清理（同 slug 不同 hash）
  if (fs.existsSync(targetDir)) {
    const bak = `${targetDir}.bak.${Date.now()}`;
    fs.renameSync(targetDir, bak);
    fs.rmSync(bak, { recursive: true, force: true });
  }

  // 解压到目标目录——对每个 entry 做路径防御
  fs.mkdirSync(targetDir, { recursive: true });
  const resolvedTarget = path.resolve(targetDir);
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    // 路径防御 1：原始 entryName 含 `..` 一律跳过
    if (entry.entryName.includes('..')) continue;

    // 剥离 <slug>/ 前缀得到相对路径
    const rel = entry.entryName.startsWith(`${slug}/`)
      ? entry.entryName.slice(slug.length + 1)
      : entry.entryName;
    // 路径防御 2：相对路径为空或含 `..` 一律跳过
    if (!rel || rel.includes('..')) continue;

    const dest = path.join(targetDir, rel);
    // 路径防御 3：解析后必须在 targetDir 内（防符号链接 / 绝对路径穿越）
    const resolvedDest = path.resolve(dest);
    if (resolvedDest !== resolvedTarget && !resolvedDest.startsWith(resolvedTarget + path.sep)) {
      continue;
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
  }

  // 写 hash 标记文件——区分 custom（有此文件）vs marketplace（无此文件）的关键
  fs.writeFileSync(hashFile, hash);
  logger.info('Skill zip 上传成功', { slug, hash });
  return { slug, description };
}

/**
 * 列出所有已安装 skill，合并三个来源：
 *   - builtin：扫描 <resources>/skills/ 目录（应用内置，随版本发布）
 *   - marketplace：从 skill_definitions 表读（市场安装）
 *   - custom：扫描 <skillsDir>/ 下有 .sha256 标记的子目录（用户 zip 上传）
 *
 * DB 不可用或 skill_definitions 表不存在时 marketplace 返回空（不阻断 listInstalled）。
 */
export function listInstalled(): InstalledSkill[] {
  const result: InstalledSkill[] = [];

  // 1. builtin：扫描内置 skill 目录（当前可能不存在 → 返回空）
  const builtinDir = resolveBuiltinSkillsDir();
  if (fs.existsSync(builtinDir)) {
    for (const entry of fs.readdirSync(builtinDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMdPath = path.join(builtinDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;
      try {
        const md = fs.readFileSync(skillMdPath, 'utf-8');
        const front = parseFrontmatter(md);
        result.push({
          slug: entry.name,
          name: front.name ?? entry.name,
          description: front.description ?? '',
          source: 'builtin',
          installedAt: null,
        });
      } catch (err) {
        logger.warn('内置 skill 解析失败，跳过', {
          dir: entry.name,
          error: (err as Error).message,
        });
      }
    }
  }

  // 2. marketplace：从 skill_definitions 表读
  try {
    const db = getDb();
    const rows = db
      .prepare('SELECT name, slug, description, created_at FROM skill_definitions')
      .all() as Array<{
      name: string;
      slug: string;
      description: string;
      created_at: string;
    }>;
    for (const row of rows) {
      result.push({
        slug: row.slug,
        name: row.name,
        description: row.description,
        source: 'marketplace',
        installedAt: row.created_at,
      });
    }
  } catch (err) {
    // DB 未初始化或表不存在——marketplace 返回空，不阻断 listInstalled
    logger.debug('skill_definitions 表读取跳过', { error: (err as Error).message });
  }

  // 3. custom：扫描 <skillsDir>/ 下有 .sha256 标记的子目录
  const skillsDir = getSkillsDir();
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // 跳过 .bak.* 临时目录（理论上已被清理，防御性跳过）
      if (entry.name.endsWith('.bak')) continue;
      if (entry.name.startsWith('.')) continue;

      const hashFile = path.join(skillsDir, entry.name, '.sha256');
      if (!fs.existsSync(hashFile)) continue; // 无标记 = 非 custom 上传

      const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
      let name = entry.name;
      let description = '';
      if (fs.existsSync(skillMdPath)) {
        try {
          const md = fs.readFileSync(skillMdPath, 'utf-8');
          const front = parseFrontmatter(md);
          if (front.name) name = front.name;
          if (front.description) description = front.description;
        } catch {
          // 解析失败用 dir name 兜底
        }
      }
      result.push({
        slug: entry.name,
        name,
        description,
        source: 'custom',
        installedAt: fs.statSync(hashFile).mtime.toISOString(),
      });
    }
  }

  return result;
}

/**
 * 删除自定义上传的 skill（仅限有 .sha256 标记的目录）。
 * builtin / marketplace 安装的 skill 不可通过此接口删除——提示用户走卸载按钮。
 */
export function deleteCustomSkill(slug: string): void {
  // 路径防御：拒绝含 `..`、路径分隔符的 slug
  if (slug.includes('..') || slug.includes('/') || slug.includes('\\') || slug === '') {
    throw new Error(`非法 slug：${slug}`);
  }
  const skillsDir = getSkillsDir();
  const targetDir = path.join(skillsDir, slug);
  const hashFile = path.join(targetDir, '.sha256');

  if (!fs.existsSync(hashFile)) {
    throw new Error(
      `Skill ${slug} 不是自定义上传（无 .sha256 标记），请通过卸载按钮移除市场安装的 skill`,
    );
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  logger.info('Custom skill 已删除', { slug });
}
