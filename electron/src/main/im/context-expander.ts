// electron/src/main/im/context-expander.ts
// 输入框上下文展开器（v2.11，spec 2026-09-16 §6.2）。
// renderer 传来的 MessageContext（slug/路径）→ 子进程消费的 ExpandedContext
// （skill 正文 + 文件内容）。所有失败路径一律降级（占位 / content=null），
// 绝不阻塞消息派发——上下文是增强不是前提。
//
// skill 三源定位（对齐 skill/zip-uploader.ts listInstalled 的三源合并语义）：
//   - custom：<userData>/skills/<slug>/SKILL.md（resolveSkillsDir）
//   - builtin：<resources>/skills/<slug>/SKILL.md（resolveBuiltinSkillsDir，dev 回退 repo 内）
//   - marketplace：skill_definitions 表 cache_path（DB 不可用/表不存在 → 静默跳过）
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';
import { resolveSkillsDir } from '../paths';
import { getWorkspace } from '../workspace/crud';
import { getDb } from '../storage/db';
import { resolveBuiltinSkillsDir } from '../skill/zip-uploader';
import { WorkspaceFS } from '../files/workspace-fs';
import type { ExpandedContext, ExpandedFileItem, ExpandedSkillItem } from '../agent/runtime-config';
import type { MessageContext } from '../../../../renderer/src/ipc/types';

/** 单文件内联上限；超出降级为路径引用（LLM 转用文件工具自读） */
export const MAX_INLINE_FILE_BYTES = 64 * 1024;
/** 单条消息文件内容累计内联上限；超出后其余文件全部降级 */
export const MAX_TOTAL_INLINE_BYTES = 256 * 1024;

/** skill 不可用占位（renderTurnBody 原样注入，用户意图在流内可见） */
const SKILL_UNAVAILABLE = '[skill 已不可用]';

/** 匹配 --- 包围的 YAML frontmatter（兼容 \n 与 \r\n 行尾，与 zip-uploader 同款） */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/** 测试注入点：skill 根目录解析与 workspace 目录解析（生产路径依赖 app 环境 / SQLite，不进测试） */
export interface ExpanderDeps {
  /** 注入即完全接管 skill 定位（仅扫这些目录，跳过 builtin 根与 marketplace 表） */
  skillRoots?: string[];
  /** 注入即绕过 getWorkspace 的 DB 查询 */
  workspaceDir?: (workspaceId: string) => string | null;
}
let deps: ExpanderDeps = {};
export function setExpanderDeps(d: ExpanderDeps): void {
  deps = d;
}

/** skill slug 防御：空串 / 含 `..` / 含路径分隔符一律视为不可用（与 deleteCustomSkill 同规则，此处降级不抛错） */
function isValidSkillSlug(slug: string): boolean {
  return slug !== '' && !slug.includes('..') && !slug.includes('/') && !slug.includes('\\');
}

/** marketplace：查 skill_definitions 表拿 cache_path（无此行 / DB 不可用 → null） */
function marketplaceSkillMdPath(slug: string): string | null {
  try {
    const row = getDb()
      .prepare('SELECT cache_path FROM skill_definitions WHERE slug = ?')
      .get(slug) as { cache_path?: string } | undefined;
    const cachePath = row?.cache_path;
    return cachePath ? path.join(cachePath, 'SKILL.md') : null;
  } catch {
    // DB 未初始化或表不存在——marketplace 源跳过（不阻塞，其余源继续）
    return null;
  }
}

/**
 * 按 slug 定位 SKILL.md 绝对路径。
 * 顺序：注入 roots（测试）→ custom 根 → builtin 根 → marketplace 表。
 */
function locateSkillMd(slug: string): string | null {
  if (!isValidSkillSlug(slug)) return null;
  const roots =
    deps.skillRoots ?? [resolveSkillsDir(), resolveBuiltinSkillsDir()];
  for (const root of roots) {
    const file = path.join(root, slug, 'SKILL.md');
    if (fs.existsSync(file)) return file;
  }
  // 注入 roots 即完全接管（测试不触 DB）；生产路径补查 marketplace 安装
  if (!deps.skillRoots) {
    const fromDb = marketplaceSkillMdPath(slug);
    if (fromDb && fs.existsSync(fromDb)) return fromDb;
  }
  return null;
}

/** SKILL.md 定位 + frontmatter 剥离（name 从 frontmatter 提取，body 为其后的正文） */
function resolveSkillMarkdown(slug: string): { name: string; body: string } | null {
  const file = locateSkillMd(slug);
  if (!file) return null;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const fm = raw.match(FRONTMATTER_RE);
    if (!fm) return { name: slug, body: raw.trim() };
    const yamlText = fm[1];
    const nameMatch = yamlText?.match(/^name:\s*(.+)$/m);
    return {
      name: nameMatch?.[1]?.trim() || slug,
      body: raw.slice(fm[0].length).trim(),
    };
  } catch (err) {
    logger.warn('context-expander：SKILL.md 读取失败，降级占位', {
      slug,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** workspace 目录：注入优先，生产走 getWorkspace（真值：Workspace.directoryPath） */
function workspaceDirOf(workspaceId: string | null): string | null {
  if (!workspaceId) return null;
  if (deps.workspaceDir) return deps.workspaceDir(workspaceId);
  return getWorkspace(workspaceId)?.directoryPath ?? null;
}

/**
 * 契约层路径检查：renderer 契约是 workspace 相对路径（FileContextItem 注释），
 * 绝对路径 / `..` 串一律拒绝（输入面在 renderer，此处是信任边界的第一层）。
 * 符号链接逃逸由 WorkspaceFS.assertInWorkspace 的 realpath 防御兜底（第二层）。
 */
function isSafeRelativePath(p: string): boolean {
  if (p === '' || path.isAbsolute(p)) return false;
  const norm = path.normalize(p);
  return norm !== '..' && !norm.startsWith(`..${path.sep}`) && !norm.startsWith('.');
}

export async function expandMessageContext(
  workspaceId: string | null,
  context: MessageContext,
): Promise<ExpandedContext> {
  // 1. skills：逐 slug 展开；失败降级占位（不阻塞）
  const skills: ExpandedSkillItem[] = [];
  for (const s of context.skills) {
    const found = resolveSkillMarkdown(s.slug);
    if (found) {
      skills.push({ slug: s.slug, name: found.name, body: found.body });
    } else {
      logger.warn('context-expander：skill 不可用，降级占位', { slug: s.slug });
      skills.push({ slug: s.slug, name: s.name, body: SKILL_UNAVAILABLE });
    }
  }

  // 2. files：内联读取（单文件 + 总量双上限，超限/失败/逃逸降级 content=null）。
  //    路径防御复用 WorkspaceFS.assertInWorkspace（字符串边界 + 符号链接 realpath，
  //    与 file:* IPC 同一信任边界）
  const root = workspaceDirOf(workspaceId);
  const wsFs = root !== null ? new WorkspaceFS(root) : null;
  const files: ExpandedFileItem[] = [];
  let total = 0;
  for (const f of context.files) {
    if (wsFs === null || !isSafeRelativePath(f.path)) {
      files.push({ path: f.path, content: null });
      continue;
    }
    try {
      const abs = wsFs.assertInWorkspace(f.path);
      const stat = await fs.promises.stat(abs);
      if (stat.size > MAX_INLINE_FILE_BYTES || total + stat.size > MAX_TOTAL_INLINE_BYTES) {
        files.push({ path: f.path, content: null });
        continue;
      }
      const content = await fs.promises.readFile(abs, 'utf-8');
      total += stat.size;
      files.push({ path: f.path, content });
    } catch (err) {
      logger.warn('context-expander：文件读取失败，降级引用', {
        path: f.path,
        error: err instanceof Error ? err.message : String(err),
      });
      files.push({ path: f.path, content: null });
    }
  }

  return { skills, files };
}
