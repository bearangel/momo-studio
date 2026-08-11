// electron/src/main/skill/zip-uploader.ts
//
// 自定义 Skill zip 上传：解压 + SHA256 校验 + 注册到 <userData>/skills/<slug>/。
//
// v1.6.2 起支持三种 zip 结构：
//   - 模式 A（扁平）：SKILL.md 在根目录，slug 取 frontmatter.name 或 zip filename
//   - 模式 B（单子目录包裹）：<slug>/SKILL.md，slug = 子目录名（向后兼容）
//   - 模式 C（多子目录批量）：一个 zip 含多个 <slug>/SKILL.md，每个独立安装
//
// 校验规则：
//   - 缺 SKILL.md → 抛错
//   - SKILL.md 路径深度 > 2 段（如 a/b/SKILL.md）→ 抛错
//   - 自动忽略 OS 元数据：__MACOSX/、.DS_Store、._*、Thumbs.db、*.bak
//   - 同 slug 同 SHA256 → 幂等跳过（不重写）
//   - 同 slug 不同 SHA256 → 备份旧目录后覆盖
//   - 每个 skill 独立判断幂等（批量场景部分跳过部分覆盖）
//   - 所有 entry 做三层路径防御（entryName 含 `..` / rel 含 `..` / resolved 沙箱）
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

/**
 * v1.6.2：单次 zip 上传的返回结构（uploadSkillZip 返回数组，即使只装一个 skill）。
 * 与 InstalledSkill 的区别：不含 source / installedAt（这两个由 listInstalled 二次解析）。
 */
export interface UploadedSkill {
  slug: string;
  /** 展示名（来自 frontmatter.name，无则用 slug 兜底） */
  name: string;
  description: string;
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
 * v1.6.2：判断某 entry 是否为 OS 元数据（解压时跳过）。
 * macOS Finder 压缩会注入 __MACOSX/ + ._* AppleDouble；Windows 资源管理器注入 Thumbs.db。
 * 用户上传场景必须忽略这些，否则会把垃圾文件写进 skill 目录。
 */
function isIgnoredEntry(entryName: string): boolean {
  const norm = entryName.replace(/\\/g, '/');
  if (norm.startsWith('__MACOSX/')) return true;
  // 逐段检查：.DS_Store / Thumbs.db / ._ 开头（AppleDouble 资源叉）/ .bak 后缀
  for (const seg of norm.split('/')) {
    if (seg === '.DS_Store' || seg === 'Thumbs.db') return true;
    if (seg.startsWith('._')) return true;
    if (seg.endsWith('.bak')) return true;
  }
  return false;
}

/**
 * v1.6.2：frontmatter.name → slug（kebab-case）。扁平结构（SKILL.md 在根目录）时使用。
 * 例："My Cool Skill" → "my-cool-skill"。空串则由调用方 fallback 到 zip filename。
 */
function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
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
 *
 * v1.6.2 支持三种结构（详见文件头注释）。返回 UploadedSkill[]——即使只装一个 skill
 * 也返回长度为 1 的数组（IPC 返回类型 breaking change，调用方需协调）。
 *
 * 每个 skill 独立做 SHA256 幂等判断：同 hash 跳过，不同 hash 覆盖。
 * 因此批量场景（模式 C）下部分 skill 可能跳过、部分覆盖，结果数组记录全部处理结果。
 */
export function uploadSkillZip(buffer: Buffer, filename: string): UploadedSkill[] {
  const zip = new AdmZip(buffer);
  const allEntries = zip.getEntries();

  // 找全部 SKILL.md entry（过滤掉 OS 元数据后）
  const skillEntries = allEntries.filter(
    (e) =>
      !e.isDirectory &&
      !isIgnoredEntry(e.entryName) &&
      (e.entryName === 'SKILL.md' || e.entryName.endsWith('/SKILL.md')),
  );
  if (skillEntries.length === 0) {
    throw new Error('zip 内未找到 SKILL.md（要求 SKILL.md 在根目录或 <slug>/SKILL.md 结构）');
  }

  // 整个 zip 的 SHA256——批量场景下所有 skill 共享同一 hash（因为是同一个 zip）
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const skillsDir = getSkillsDir();
  const results: UploadedSkill[] = [];

  for (const skillEntry of skillEntries) {
    // 校验 SKILL.md 路径深度：≤ 2 段（SKILL.md 或 <slug>/SKILL.md）
    const parts = skillEntry.entryName.split('/');
    if (parts.length > 2) {
      throw new Error(
        `SKILL.md 路径过深：${skillEntry.entryName}（要求 SKILL.md 或 <slug>/SKILL.md）`,
      );
    }

    // 解析 frontmatter 取 name + description
    const md = skillEntry.getData().toString('utf-8');
    const front = parseFrontmatter(md);
    const name = front.name ?? '';
    const description = front.description ?? '';

    // 推断 slug：
    //   - <subdir>/SKILL.md → slug = 子目录名（frontmatter.name 不覆盖，模式 B/C）
    //   - SKILL.md（根目录）→ slug = frontmatter.name 转 kebab → 否则 filename 去 .zip（模式 A）
    let slug: string;
    if (parts.length === 2 && parts[0]) {
      slug = parts[0];
    } else {
      const fromName = nameToSlug(name);
      slug = fromName || filename.replace(/\.zip$/i, '');
    }

    // slug 合法性：空串 / 含 `..` / 含路径分隔符 → 抛错（路径防御前置）
    if (!slug || slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
      throw new Error(`非法 slug：${slug || '(空)'}`);
    }

    const targetDir = path.join(skillsDir, slug);
    const hashFile = path.join(targetDir, '.sha256');

    // SHA256 幂等检查：同 hash 跳过（每个 skill 独立判断）
    let skipped = false;
    if (fs.existsSync(hashFile)) {
      const existingHash = fs.readFileSync(hashFile, 'utf-8').trim();
      if (existingHash === hash) {
        logger.info('Skill zip 同 hash 幂等跳过', { slug, hash });
        skipped = true;
      }
    }

    if (!skipped) {
      // 覆盖：备份旧目录并立即清理（同 slug 不同 hash）
      if (fs.existsSync(targetDir)) {
        const bak = `${targetDir}.bak.${Date.now()}`;
        fs.renameSync(targetDir, bak);
        fs.rmSync(bak, { recursive: true, force: true });
      }

      // 解压到目标目录——对每个 entry 做三层路径防御
      fs.mkdirSync(targetDir, { recursive: true });
      const resolvedTarget = path.resolve(targetDir);
      // 扁平结构（SKILL.md 在根目录）→ 收集全部非元数据 entry；
      // 包裹结构 → 仅收集 <slug>/ 前缀下的 entry
      const isFlat = parts.length === 1;

      for (const entry of allEntries) {
        if (entry.isDirectory) continue;
        // OS 元数据忽略（__MACOSX / .DS_Store / Thumbs.db / ._ / *.bak）
        if (isIgnoredEntry(entry.entryName)) continue;
        // 路径防御 1：原始 entryName 含 `..` 一律跳过
        if (entry.entryName.includes('..')) continue;

        let rel: string;
        if (isFlat) {
          rel = entry.entryName;
        } else {
          if (!entry.entryName.startsWith(`${slug}/`)) continue;
          rel = entry.entryName.slice(slug.length + 1);
        }
        // 路径防御 2：相对路径为空或含 `..` 一律跳过
        if (!rel || rel.includes('..')) continue;

        const dest = path.join(targetDir, rel);
        // 路径防御 3：解析后必须在 targetDir 内（防符号链接 / 绝对路径穿越）
        const resolvedDest = path.resolve(dest);
        if (
          resolvedDest !== resolvedTarget &&
          !resolvedDest.startsWith(resolvedTarget + path.sep)
        ) {
          continue;
        }

        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, entry.getData());
      }

      // 写 hash 标记文件——区分 custom（有此文件）vs marketplace（无此文件）的关键
      fs.writeFileSync(hashFile, hash);
      logger.info('Skill zip 上传成功', { slug, hash });
    }

    results.push({ slug, name: name || slug, description });
  }

  return results;
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
