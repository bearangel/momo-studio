// electron/src/main/agent/tools/search-tools.ts
// 内容/文件名搜索工具：grep + glob。Node 实现（无 ripgrep 依赖），
// 自动尊重 workspace 的 .gitignore，并叠加硬编码的默认忽略集。

import fs from 'node:fs';
import path from 'node:path';
import fastGlob from 'fast-glob';
import ignore from 'ignore';
import type { Ignore } from 'ignore';
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
import { buildCatalog, type ToolCatalogEntry, type ToolMeta } from './catalog-entry';
import { OUTPUT_LIMITS, truncateArray } from './shared/output-truncate';
import { parseStringArg } from './shared/arg-parse';

/** workspaceDir → { mtime, matcher } 的缓存。mtime 用作失效信号。
 *  Map key 是 workspaceDir（绝对路径），不同 workspace 之间不串数据。*/
const gitignoreCache = new Map<string, { mtime: number; matcher: Ignore }>();

/** 读取 workspace 根的 .gitignore；不存在或读取失败返回 null 而不抛错。
 *  用 mtime 判断缓存有效性——文件未变直接复用 matcher。*/
function loadGitignore(workspaceDir: string): Ignore | null {
  const gitignorePath = path.join(workspaceDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return null;
  const stat = fs.statSync(gitignorePath);
  const cached = gitignoreCache.get(workspaceDir);
  if (cached && cached.mtime === stat.mtimeMs) return cached.matcher;
  try {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    const matcher = ignore().add(content);
    gitignoreCache.set(workspaceDir, { mtime: stat.mtimeMs, matcher });
    return matcher;
  } catch {
    // 读取失败（权限 / IO 错误）静默降级——不该让 .gitignore 解析失败阻塞搜索。
    return null;
  }
}

/** 硬编码的默认忽略集：与 .gitignore 是叠加关系（任一命中即过滤）。
 *  这层不依赖用户配置，保证搜索结果永远不包含构建产物和版本库元数据。*/
const DEFAULT_IGNORE: string[] = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'];

/**
 * 搜索工具模块（grep + glob）。v1.5 Task 7 引入。
 *
 * 设计要点：
 *   - 路径双校验：传入 startDir 先过一次 WorkspaceFS.assertInWorkspace，
 *     fast-glob 列出的每个候选文件再过一遍，防止符号链接逃逸。
 *   - grep 的 path 可以是目录（递归搜索）或单个文件（只搜它；显式点名即
 *     绕过 DEFAULT_IGNORE / .gitignore，见 spec 2026-11-02 §5.4）。
 *   - 大文件跳过：grep 单文件 >1MB 不读——目录模式静默跳过，单文件模式明确
 *     返回「超过 1MB 未搜索」，不让模型误以为是「没有匹配」。
 *   - 行截断：单行 >200 字符截断显示，避免单个超长行挤占 LLM 上下文。
 *   - 输出上限：从 OUTPUT_LIMITS 读 grep_matches=50 / glob_matches=200。
 */
// 类外常量（Tier 划分见 spec §3）：
const SEARCH_CATALOG_META: Record<string, ToolMeta> = {
  grep: { displayName: '内容搜索', category: '搜索', categoryEmoji: '🔍', defaultOn: true },
  glob: { displayName: '文件名搜索', category: '搜索', categoryEmoji: '🔍', defaultOn: true },
};

export class SearchTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return [
      {
        name: 'grep',
        description: '在 workspace 内递归搜索文件内容（JS 正则）。返回 file:line:content 格式，最多 50 条匹配。',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'JS 正则表达式字符串' },
            include: { type: 'string', description: '文件名 glob 过滤，如 "*.ts"（path 指向文件时忽略）' },
            path: {
              type: 'string',
              description: '搜索起始目录，或单个文件（相对 workspace），默认 "."',
            },
            caseInsensitive: { type: 'boolean', description: '大小写不敏感，默认 false' },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'glob',
        description: '按文件名 glob 模式递归查找文件。返回相对路径列表，最多 200 条。',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'glob 模式，如 "**/*.test.ts"' },
            path: { type: 'string', description: '查找起始目录（相对 workspace），默认 "."' },
          },
          required: ['pattern'],
        },
      },
    ];
  }

  getCatalog(): ToolCatalogEntry[] {
    return buildCatalog(this.getDefs(), SEARCH_CATALOG_META);
  }

  handles(name: string): boolean {
    return name === 'grep' || name === 'glob';
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (name === 'grep') return executeGrep(args, ctx);
    if (name === 'glob') return executeGlob(args, ctx);
    throw new Error(`未知 search 工具: ${name}`);
  }
}

/** grep 单文件大小上限（1MB）：超限不读，避免大文件挤爆内存。 */
const MAX_GREP_FILE_SIZE = 1024 * 1024;

/** 一条 grep 命中。file 为相对「搜索起点」的路径（单文件模式即文件名本身）。 */
interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

/** 逐行扫描单个文件内容并追加命中。命中数达输出上限时置 state.limitReached
 *  （外层据此停止继续读后续文件）；目录模式与单文件模式共用同一扫描口径。 */
function collectFileMatches(
  content: string,
  relPath: string,
  regex: RegExp,
  matches: GrepMatch[],
  state: { limitReached: boolean },
): void {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // noUncheckedIndexedAccess 下 lines[i] 类型为 string | undefined，此处断言非空
    const line = lines[i] ?? '';
    if (matches.length >= OUTPUT_LIMITS.grep_matches) {
      state.limitReached = true;
      break;
    }
    regex.lastIndex = 0;
    if (regex.test(line)) {
      // 单行 >200 字符截断显示，避免单个超长行挤占 LLM 上下文
      const preview = line.length > 200 ? line.slice(0, 200) + '…' : line;
      matches.push({ file: relPath, line: i + 1, content: preview });
    }
  }
}

/** 统一输出格式：0 条 → 「(无匹配)」；达输出上限且确实被截断 → 追加提示。
 *  truncateArray 仅在 > maxCount 时追加标记；limitReached 区分「恰好 = 上限」场景。 */
function formatGrepResult(matches: GrepMatch[], limitReached: boolean): string {
  if (matches.length === 0) return '(无匹配)';
  const body = truncateArray(
    matches,
    OUTPUT_LIMITS.grep_matches,
    (m) => `${m.file}:${m.line}:${m.content}`,
  );
  if (matches.length >= OUTPUT_LIMITS.grep_matches && limitReached) {
    return `${body}\n\n…(已达上限 ${OUTPUT_LIMITS.grep_matches} 条，请缩小范围)`;
  }
  return body;
}

/** stat 搜索起点：ENOENT/ENOTDIR 转「路径不存在: <原样 path>」；其他失败
 *  （EACCES 等）带上原始错误一起抛出——不静默吞成「(无匹配)」。 */
async function statSearchRoot(absPath: string, rawPath: string): Promise<fs.Stats> {
  try {
    return await fs.promises.stat(absPath);
  } catch (e) {
    const code = e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(`路径不存在: ${rawPath}`);
    throw new Error(
      `无法访问路径: ${rawPath} - ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function executeGrep(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const pattern = parseStringArg(args.pattern, 'pattern');
  const includeGlob = typeof args.include === 'string' ? args.include : '**/*';
  const startDir = typeof args.path === 'string' ? args.path : '.';
  const caseInsensitive = args.caseInsensitive === true;

  const absStart = ctx.wsFs.assertInWorkspace(startDir);
  // spec 2026-11-02 §5.4：path 可能显式点名「单个文件」（真实会话传过
  // 中文文件名 HTML）。旧实现一律当目录交给 fast-glob，Windows 上直接
  // ENOTDIR: not a directory, scandir。先 stat 分流，再决定候选集。
  const targetStat = await statSearchRoot(absStart, startDir);

  // g 标志让 .test() 在多行查找时可重置 lastIndex；caseInsensitive 时再加 i。
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseInsensitive ? 'gi' : 'g');
  } catch (e) {
    throw new Error(`非法正则: ${pattern} - ${e instanceof Error ? e.message : String(e)}`);
  }

  // 单文件模式：候选集就是该文件，cwd 语义退化为其父目录（include 被忽略，
  // 只可能命中这一个文件）。跳过 DEFAULT_IGNORE 与 .gitignore——用户显式点名
  // dist/x.html 就该搜它，静默给「(无匹配)」是骗人。沙箱校验已在上面完成。
  if (targetStat.isFile()) {
    // 1MB 上限保留（防 OOM），但不静默：明确告知未搜索，模型可分段读后逐段核。
    if (targetStat.size > MAX_GREP_FILE_SIZE) {
      return `文件超过 1MB 未搜索：${startDir}（可按范围分段读后用 grep 逐段核）`;
    }
    // file 字段口径与目录模式一致：相对 absStart（此处即文件名本身）的路径。
    const content = await fs.promises.readFile(absStart, 'utf-8');
    const matches: GrepMatch[] = [];
    const state = { limitReached: false };
    collectFileMatches(content, path.basename(absStart), regex, matches, state);
    return formatGrepResult(matches, state.limitReached);
  }

  // fast-glob 先按文件名 candidate，再读内容过滤。比 ripgrep 慢但 zero-dep。
  // onlyFiles:true 是 v3 默认值，显式注明便于阅读；fast-glob v3 不再支持 nodir 选项。
  const candidates = await fastGlob(includeGlob, {
    cwd: absStart, absolute: false, ignore: DEFAULT_IGNORE, onlyFiles: true,
  });

  // .gitignore 在 DEFAULT_IGNORE 之上再叠加一层。loadGitignore 失败返回 null。
  const ig = loadGitignore(ctx.workspaceDir);
  const filtered = ig ? candidates.filter((p) => !ig.ignores(p)) : candidates;

  const matches: GrepMatch[] = [];
  // 命中上限时记录，让结果末尾追加「已达上限」提示（LLM 可据此缩小范围）。
  const state = { limitReached: false };

  for (const relPath of filtered) {
    if (matches.length >= OUTPUT_LIMITS.grep_matches) {
      state.limitReached = true;
      break;
    }
    const absFile = path.join(absStart, relPath);
    // 每个候选文件再过一遍沙箱：fastGlob 不做 symlink follow 检查，WorkspaceFS 把关。
    ctx.wsFs.assertInWorkspace(absFile);

    const stat = await fs.promises.stat(absFile);
    if (stat.size > MAX_GREP_FILE_SIZE) continue;

    const content = await fs.promises.readFile(absFile, 'utf-8');
    collectFileMatches(content, relPath, regex, matches, state);
  }

  return formatGrepResult(matches, state.limitReached);
}

async function executeGlob(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const pattern = parseStringArg(args.pattern, 'pattern');
  const startDir = typeof args.path === 'string' ? args.path : '.';

  const absStart = ctx.wsFs.assertInWorkspace(startDir);
  // glob 的 path 语义仍是「目录」（单文件无意义）；只补不存在时的明确文案，
  // 避免 fast-glob 抛裸 ENOENT 让模型无从判断是拼错还是越界。
  await statSearchRoot(absStart, startDir);

  const files = await fastGlob(pattern, {
    cwd: absStart, absolute: false, ignore: DEFAULT_IGNORE, onlyFiles: true,
  });

  const ig = loadGitignore(ctx.workspaceDir);
  const filtered = ig ? files.filter((p) => !ig.ignores(p)) : files;

  if (filtered.length === 0) return '(无匹配文件)';
  return truncateArray(filtered, OUTPUT_LIMITS.glob_matches, (p) => p);
}
