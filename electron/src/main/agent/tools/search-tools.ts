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
import { assertNotCipher } from './shared/cipher-gate';
import { FileIoError } from '../../files/file-io/types';
import { looksEncrypted } from '../../files/file-io/cipher-detect';
import type { WorkspaceFS } from '../../files/workspace-fs';

/** workspaceDir → { mtime, matcher } 的缓存。mtime 用作失效信号。
 *  Map key 是 workspaceDir（绝对路径），不同 workspace 之间不串数据。*/
const gitignoreCache = new Map<string, { mtime: number; matcher: Ignore }>();

/** 读取 workspace 根的 .gitignore；不存在或读取失败返回 null 而不抛错。
 *  用 mtime 判断缓存有效性——文件未变直接复用 matcher。
 *  内容经 wsFs 内容通道读取（B 方案收口）；密文（strict 抛错或魔数自检）
 *  同样按读取失败降级 null——密文规则表比没有规则表更糟。*/
async function loadGitignore(workspaceDir: string, wsFs: WorkspaceFS): Promise<Ignore | null> {
  const gitignorePath = path.join(workspaceDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return null;
  const stat = fs.statSync(gitignorePath);
  const cached = gitignoreCache.get(workspaceDir);
  if (cached && cached.mtime === stat.mtimeMs) return cached.matcher;
  try {
    const buf = await wsFs.readFile(gitignorePath);
    if (looksEncrypted(buf)) return null;
    const matcher = ignore().add(buf.toString('utf-8'));
    gitignoreCache.set(workspaceDir, { mtime: stat.mtimeMs, matcher });
    return matcher;
  } catch {
    // 读取失败（权限 / IO 错误 / EENCRYPTED）静默降级——不该让 .gitignore 解析失败阻塞搜索。
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

/** 目录模式批量读批大小（B 方案收口）：有界内存 + 摊薄通道往返 */
const GREP_READ_BATCH = 16;

/** 跳过加密文件提示的文件名上限（防密文仓库把提示行本身撑爆上下文） */
const ENCRYPTED_SKIP_NAME_CAP = 10;

/** 目录模式密文跳过提示行：「⚠ 已跳过 N 个加密文件: a, b, …」（超 10 个截断） */
function encryptedSkipNote(names: string[]): string {
  const shown = names.slice(0, ENCRYPTED_SKIP_NAME_CAP).join(', ');
  const more = names.length > ENCRYPTED_SKIP_NAME_CAP ? ' …' : '';
  return `⚠ 已跳过 ${names.length} 个加密文件: ${shown}${more}`;
}

/**
 * 目录模式批量读 + 逐文件密文容错（B 方案收口）：
 * - 常态：整批 readFiles，批内每个 buffer 自检 looksEncrypted（独立于通道
 *   strict 设置——grep 的失败模式是静默假阴性）→ 密文项置 null 归入跳过；
 * - strict 通道下整批被 EENCRYPTED 硬失败时退化为逐文件读，定位到具体
 *   加密文件归入跳过；其余读错误原样抛（不吞——与旧版单文件读失败即抛一致）。
 * 返回与 absFiles 同序的数组，null = 加密跳过。
 */
async function readBatchWithCipherSkip(
  wsFs: WorkspaceFS,
  absFiles: string[],
): Promise<Array<Buffer | null>> {
  try {
    const bufs = await wsFs.readFiles(absFiles);
    return bufs.map((b) => (looksEncrypted(b) ? null : b));
  } catch (err) {
    if (!(err instanceof FileIoError && err.code === 'EENCRYPTED')) throw err;
    const out: Array<Buffer | null> = [];
    for (const f of absFiles) {
      try {
        const b = await wsFs.readFile(f);
        out.push(looksEncrypted(b) ? null : b);
      } catch (e) {
        if (e instanceof FileIoError && e.code === 'EENCRYPTED') out.push(null);
        else throw e;
      }
    }
    return out;
  }
}

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
    // 1MB 上限保留（防 OOM），但不静默：明确告知未搜索 + 给**可执行**的下一步。
    // 旧提示「用 grep 逐段核」不可执行——grep 只有 pattern/path/include，没有行
    // 范围参数，模型照着做只会再撞同一个 1MB 上限（终审 Minor 5）。
    if (targetStat.size > MAX_GREP_FILE_SIZE) {
      return `文件超过 1MB 未搜索：${startDir}（可用 read_file 分页读后再定位，如先读前 200KB 找到关键词所在行）`;
    }
    // B 方案收口：内容经通道读取 + 密文自检（独立于 strict——静默「(无匹配)」
    // 是骗人；strict 通道自身也会以 EENCRYPTED 硬失败，两条路都是明确报错）
    const contentBuf = await ctx.wsFs.readFile(absStart);
    assertNotCipher(contentBuf, startDir);
    const matches: GrepMatch[] = [];
    const state = { limitReached: false };
    collectFileMatches(contentBuf.toString('utf-8'), path.basename(absStart), regex, matches, state);
    return formatGrepResult(matches, state.limitReached);
  }

  // fast-glob 先按文件名 candidate，再读内容过滤。比 ripgrep 慢但 zero-dep。
  // onlyFiles:true 是 v3 默认值，显式注明便于阅读；fast-glob v3 不再支持 nodir 选项。
  const candidates = await fastGlob(includeGlob, {
    cwd: absStart, absolute: false, ignore: DEFAULT_IGNORE, onlyFiles: true,
  });

  // .gitignore 在 DEFAULT_IGNORE 之上再叠加一层。loadGitignore 失败返回 null。
  const ig = await loadGitignore(ctx.workspaceDir, ctx.wsFs);
  const filtered = ig ? candidates.filter((p) => !ig.ignores(p)) : candidates;

  // 预过滤：逐文件沙箱校验 + 大小上限，得到可读候选集（B 方案收口：内容读
  // 改为批量经通道，stat/沙箱仍逐文件前置——大文件不进批，省通道流量）
  const readableRels: string[] = [];
  for (const relPath of filtered) {
    const absFile = path.join(absStart, relPath);
    // 每个候选文件再过一遍沙箱：fastGlob 不做 symlink follow 检查，WorkspaceFS 把关。
    ctx.wsFs.assertInWorkspace(absFile);
    const stat = await fs.promises.stat(absFile);
    if (stat.size > MAX_GREP_FILE_SIZE) continue;
    readableRels.push(relPath);
  }

  const matches: GrepMatch[] = [];
  // 命中上限时记录，让结果末尾追加「已达上限」提示（LLM 可据此缩小范围）。
  const state = { limitReached: false };
  // 密文文件按相对路径收集（与 file 字段同口径），结果末尾聚合提示。
  const skippedEncrypted: string[] = [];

  for (let i = 0; i < readableRels.length; i += GREP_READ_BATCH) {
    if (matches.length >= OUTPUT_LIMITS.grep_matches) {
      state.limitReached = true;
      break;
    }
    const batchRels = readableRels.slice(i, i + GREP_READ_BATCH);
    const buffers = await readBatchWithCipherSkip(
      ctx.wsFs,
      batchRels.map((r) => path.join(absStart, r)),
    );
    for (let j = 0; j < batchRels.length; j++) {
      const relPath = batchRels[j]!;
      const buf = buffers[j];
      if (buf === null || buf === undefined) {
        skippedEncrypted.push(relPath);
        continue;
      }
      collectFileMatches(buf.toString('utf-8'), relPath, regex, matches, state);
      if (state.limitReached) break;
    }
  }

  const body = formatGrepResult(matches, state.limitReached);
  if (skippedEncrypted.length === 0) return body;
  return `${body}\n\n${encryptedSkipNote(skippedEncrypted)}`;
}

async function executeGlob(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const pattern = parseStringArg(args.pattern, 'pattern');
  const startDir = typeof args.path === 'string' ? args.path : '.';

  const absStart = ctx.wsFs.assertInWorkspace(startDir);
  // glob 的 path 语义仍是「目录」（单文件对 glob 无意义）：不存在给明确文案，
  // 指向文件时也不能放给 fast-glob 抛裸 ENOTDIR——改成可执行的中文错误（终审 Minor 3）。
  const startStat = await statSearchRoot(absStart, startDir);
  if (!startStat.isDirectory()) {
    throw new Error(`path 必须是目录: ${startDir}（glob 的 path 只接受目录；要搜单个文件请用 grep）`);
  }

  const files = await fastGlob(pattern, {
    cwd: absStart, absolute: false, ignore: DEFAULT_IGNORE, onlyFiles: true,
  });

  const ig = await loadGitignore(ctx.workspaceDir, ctx.wsFs);
  const filtered = ig ? files.filter((p) => !ig.ignores(p)) : files;

  if (filtered.length === 0) return '(无匹配文件)';
  return truncateArray(filtered, OUTPUT_LIMITS.glob_matches, (p) => p);
}
