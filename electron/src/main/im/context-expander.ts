// electron/src/main/im/context-expander.ts
// 输入框上下文展开器（v2.11，spec 2026-09-16 §6.2；多模态图片 spec 2026-09-26 §6）。
// renderer 传来的 MessageContext（slug/路径）→ 子进程消费的 ExpandedContext
// （skill 正文 + 文件内容 + 图片 base64）。所有失败路径一律降级
// （占位 / content=null / 剔除进 droppedImages），绝不阻塞消息派发——
// 上下文是增强不是前提。
// 会话引用（跨会话引用 spec 2026-09-30 §6）：指针级展开——存在性 + workspace
// 归属校验通过则附元信息，失败降级 missing=true（快照标题保留）。
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
import { getSession, listSessionMembers } from '../storage/sessions/repo';
import { countMessagesBySession } from '../storage/messages/repo';
import { listMembers } from '../agent/crud';
import type {
  ExpandedContext,
  ExpandedFileItem,
  ExpandedImageItem,
  ExpandedSessionItem,
  ExpandedSkillItem,
} from '../agent/runtime-config';
import type { MessageContext } from '../../../../renderer/src/ipc/types';

/** 单文件内联上限；超出降级为路径引用（LLM 转用文件工具自读） */
export const MAX_INLINE_FILE_BYTES = 64 * 1024;
/** 单条消息文件内容累计内联上限；超出后其余文件全部降级 */
export const MAX_TOTAL_INLINE_BYTES = 256 * 1024;
/** 单图 base64 文本上限（8MB，spec 2026-09-26 §6）；超出剔除进 droppedImages */
export const MAX_IMAGE_BASE64_CHARS = 8 * 1024 * 1024;
/**
 * 单请求图片张数上限（spec 2026-09-26 §6「重发窗口内累计同限」）：
 * 当前轮 + 近 2 轮重发窗口共享（Task 9），dispatch 附图同限。
 * 主进程侧唯一常量源（renderer 侧同名 IMAGE_PER_MESSAGE_CAP 负责输入拦截，
 * 两层各守一段，数值由 spec 锁定）。
 */
export const MAX_IMAGES_PER_REQUEST = 6;

/** skill 不可用占位（renderTurnBody 原样注入，用户意图在流内可见） */
const SKILL_UNAVAILABLE = '[skill 已不可用]';

/**
 * 图片扩展名 → MIME（白名单外的扩展名一律剔除）。bmp 不在 asset:saveImage
 * 落盘白名单，但 @ 菜单可把 workspace 内 bmp 文件选进 images（spec §5）；
 * provider 层是否接受 bmp 由 Task 8 按平台过滤，本层只做扩展名映射。
 */
const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/** 匹配 --- 包围的 YAML frontmatter（兼容 \n 与 \r\n 行尾，与 zip-uploader 同款） */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/** 会话元信息形状（sessionMeta 的返回契约；生产由本模块从 repos 构建） */
export interface SessionMetaInput {
  workspaceId: string;
  title: string;
  kind: 'chat' | 'task_execution';
  lastMessageAt: number | null;
  memberNames: string[];
  messageCount: number;
}

/** 测试注入点：skill 根目录解析与 workspace 目录解析（生产路径依赖 app 环境 / SQLite，不进测试） */
export interface ExpanderDeps {
  /** 注入即完全接管 skill 定位（仅扫这些目录，跳过 builtin 根与 marketplace 表） */
  skillRoots?: string[];
  /** 注入即绕过 getWorkspace 的 DB 查询 */
  workspaceDir?: (workspaceId: string) => string | null;
  /** 会话元信息生产（测试注入即绕开 DB；生产由本模块从 repos 构建） */
  sessionMeta?: (sessionId: string) => SessionMetaInput | null;
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

/** workspace 目录：注入优先，生产走 getWorkspace（真值：Workspace.directoryPath）。
 *  两路都包 try/catch：注入分支模拟 getWorkspace 在 DB 不可用 / 表不存在时的行为，
 *  生产分支直接调 getWorkspace。任一路抛错都会逃逸出 expandMessageContext 违反
 *  「expander 永不抛错」契约——按 marketplaceSkillMdPath 同款守卫降级返回 null，
 *  让下游 wsFs=null → 文件全部 content=null。 */
function workspaceDirOf(workspaceId: string | null): string | null {
  if (!workspaceId) return null;
  try {
    if (deps.workspaceDir) return deps.workspaceDir(workspaceId);
    return getWorkspace(workspaceId)?.directoryPath ?? null;
  } catch (err) {
    logger.warn('context-expander：workspace 目录解析失败，降级', {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** 生产路径：从 repos 构建会话元信息；DB 不可用 / 查无 → null（调用方降级 missing）。
 *  memberNames 取 WorkspaceAgentMember.agentName（v2.2 JOIN 展示名，缺名回退 agent_user_id），
 *  session_members.instance_id 与 workspace 成员交集过滤（跨 workspace 定义不混入）。 */
function buildSessionMeta(sessionId: string): SessionMetaInput | null {
  try {
    const s = getSession(sessionId);
    if (s === null) return null;
    const instIds = new Set(listSessionMembers(sessionId).map((m) => m.instanceId));
    const names = listMembers(s.workspaceId)
      .filter((m) => instIds.has(m.instanceId))
      .map((m) => m.agentName);
    return {
      workspaceId: s.workspaceId,
      title: s.title,
      kind: s.kind,
      lastMessageAt: s.lastMessageAt,
      memberNames: names,
      messageCount: countMessagesBySession(sessionId),
    };
  } catch (err) {
    logger.warn('context-expander：会话元信息构建失败，降级 missing', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * 契约层路径检查：renderer 契约是 workspace 相对路径（FileContextItem 注释），
 * 绝对路径 / `.` / `..` / 父逃逸前缀一律拒绝（输入面在 renderer，此处是信任
 * 边界的第一层）。合法 dotfile（.env / .github/…）是正常 workspace 内容，
 * 不因 startsWith('.') 一刀切拒绝（I4 修复：旧实现静默降级且提示误导）。
 * 符号链接逃逸由 WorkspaceFS.assertInWorkspace 的 realpath 防御兜底（第二层）。
 */
function isSafeRelativePath(p: string): boolean {
  if (p === '' || path.isAbsolute(p)) return false;
  const norm = path.normalize(p);
  return norm !== '.' && norm !== '..' && !norm.startsWith(`..${path.sep}`);
}

export async function expandMessageContext(
  workspaceId: string | null,
  context: MessageContext,
): Promise<ExpandedContext> {
  // 1. skills：逐 slug 展开；失败降级占位（不阻塞）。
  //    I5 元素级防御：非 {slug,name:string} 形状的元素直接跳过——IPC 入口
  //    sanitizeMessageContext 已剔除，此处兜底绕过入口的路径（resume 重放 /
  //    历史行 context_json），「永不抛错」契约不能依赖上游全对
  const skills: ExpandedSkillItem[] = [];
  for (const s of context.skills) {
    if (typeof s?.slug !== 'string' || typeof s?.name !== 'string') continue;
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
  //    与 file:* IPC 同一信任边界）。I5：path 非字符串的元素无法构成降级条目
  //    （ExpandedFileItem.path 契约 string），跳过不产半截项
  const root = workspaceDirOf(workspaceId);
  const wsFs = root !== null ? new WorkspaceFS(root) : null;
  const files: ExpandedFileItem[] = [];
  let total = 0;
  for (const f of context.files) {
    if (typeof f?.path !== 'string') continue;
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

  // 3. images（多模态 Task 5，spec 2026-09-26 §6）：读文件转 base64 进
  //    ExpandedContext.images；读取失败 / 超 8MB / 路径逃逸 / 未知扩展名
  //    一律剔除并记入 droppedImages（Task 8 的 runtime 据此注入
  //    [图片加载失败: path] 占位——本层不掺渲染字符串）。
  //    与 skills/files 同款双层防御：sanitize 入口已过滤，此处元素级守卫
  //    兜底历史行 / resume 重放；单图失败绝不阻塞消息派发（永不抛错契约）。
  //    畸形元素直接跳过不进 droppedImages（path 可能不是字符串，占位无从渲染）。
  const images: ExpandedImageItem[] = [];
  const droppedImages: string[] = [];
  if (Array.isArray(context.images)) {
    for (const img of context.images) {
      if (
        typeof img?.path !== 'string' ||
        typeof img.w !== 'number' ||
        typeof img.h !== 'number'
      ) {
        continue;
      }
      const mime = IMAGE_MIME_BY_EXT[path.extname(img.path).toLowerCase()];
      if (mime === undefined) {
        logger.warn('context-expander：图片扩展名不在白名单，剔除', { path: img.path });
        droppedImages.push(img.path);
        continue;
      }
      if (wsFs === null || !isSafeRelativePath(img.path)) {
        logger.warn('context-expander：图片路径非法（逃逸 / 无 workspace），剔除', { path: img.path });
        droppedImages.push(img.path);
        continue;
      }
      try {
        const abs = wsFs.assertInWorkspace(img.path);
        const stat = await fs.promises.stat(abs);
        // base64 长度 = 4·⌈n/3⌉：按 stat 预判超限，避免把大文件整个读进内存
        if (4 * Math.ceil(stat.size / 3) > MAX_IMAGE_BASE64_CHARS) {
          logger.warn('context-expander：图片 base64 超 8MB 上限，剔除', {
            path: img.path,
            size: stat.size,
          });
          droppedImages.push(img.path);
          continue;
        }
        const base64 = (await fs.promises.readFile(abs)).toString('base64');
        // stat 与 readFile 之间文件可能增长（TOCTOU），编码后复核边界
        if (base64.length > MAX_IMAGE_BASE64_CHARS) {
          logger.warn('context-expander：图片 base64 超 8MB 上限（编码后复核），剔除', {
            path: img.path,
          });
          droppedImages.push(img.path);
          continue;
        }
        images.push({ path: img.path, mime, base64, w: img.w, h: img.h });
      } catch (err) {
        logger.warn('context-expander：图片读取失败，剔除', {
          path: img.path,
          error: err instanceof Error ? err.message : String(err),
        });
        droppedImages.push(img.path);
      }
    }
  }

  // 4. sessions（跨会话引用 spec 2026-09-30 §6）：指针级展开——存在性 + workspace
  //    归属校验 → 元信息；失败降级 missing（永不抛错契约，元素级防御同 skills I5）。
  //    workspaceId 为 null 时 meta.workspaceId === workspaceId 恒 false → 全部
  //    missing（无 workspace 上下文不注入指针，范围门语义）。title 一律用选择时
  //    快照（missing 时保留原值供回溯，meta.title 不覆盖用户所见）。
  const sessions: ExpandedSessionItem[] = [];
  if (Array.isArray(context.sessions)) {
    for (const s of context.sessions) {
      if (typeof s?.sessionId !== 'string' || s.sessionId === '' || typeof s?.title !== 'string') continue;
      const meta = (() => {
        try {
          return deps.sessionMeta ? deps.sessionMeta(s.sessionId) : buildSessionMeta(s.sessionId);
        } catch (err) {
          logger.warn('context-expander：会话元信息查找失败，降级 missing', {
            sessionId: s.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      })();
      sessions.push(
        meta !== null && meta.workspaceId === workspaceId
          ? {
              sessionId: s.sessionId,
              title: s.title,
              kind: meta.kind,
              memberNames: meta.memberNames,
              messageCount: meta.messageCount,
              lastMessageAt: meta.lastMessageAt,
              missing: false,
            }
          : { sessionId: s.sessionId, title: s.title, kind: 'chat', memberNames: [], messageCount: 0, lastMessageAt: null, missing: true },
      );
    }
  }

  return { skills, files, images, droppedImages, sessions };
}
