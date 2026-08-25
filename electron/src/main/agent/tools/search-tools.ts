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
 *   - 大文件跳过：grep 单文件 >1MB 直接跳过，避免 OOM（LLM 拿不到也无所谓）。
 *   - 行截断：单行 >200 字符截断显示，避免单个超长行挤占 LLM 上下文。
 *   - 输出上限：从 OUTPUT_LIMITS 读 grep_matches=50 / glob_matches=200。
 */
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
            include: { type: 'string', description: '文件名 glob 过滤，如 "*.ts"' },
            path: { type: 'string', description: '搜索起始目录（相对 workspace），默认 "."' },
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

  handles(name: string): boolean {
    return name === 'grep' || name === 'glob';
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (name === 'grep') return executeGrep(args, ctx);
    if (name === 'glob') return executeGlob(args, ctx);
    throw new Error(`未知 search 工具: ${name}`);
  }
}

async function executeGrep(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const pattern = parseStringArg(args.pattern, 'pattern');
  const includeGlob = typeof args.include === 'string' ? args.include : '**/*';
  const startDir = typeof args.path === 'string' ? args.path : '.';
  const caseInsensitive = args.caseInsensitive === true;

  const absStart = ctx.wsFs.assertInWorkspace(startDir);

  // g 标志让 .test() 在多行查找时可重置 lastIndex；caseInsensitive 时再加 i。
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseInsensitive ? 'gi' : 'g');
  } catch (e) {
    throw new Error(`非法正则: ${pattern} - ${e instanceof Error ? e.message : String(e)}`);
  }

  // fast-glob 先按文件名 candidate，再读内容过滤。比 ripgrep 慢但 zero-dep。
  // onlyFiles:true 是 v3 默认值，显式注明便于阅读；fast-glob v3 不再支持 nodir 选项。
  const candidates = await fastGlob(includeGlob, {
    cwd: absStart, absolute: false, ignore: DEFAULT_IGNORE, onlyFiles: true,
  });

  // .gitignore 在 DEFAULT_IGNORE 之上再叠加一层。loadGitignore 失败返回 null。
  const ig = loadGitignore(ctx.workspaceDir);
  const filtered = ig ? candidates.filter((p) => !ig.ignores(p)) : candidates;

  const matches: Array<{ file: string; line: number; content: string }> = [];
  const MAX_FILE_SIZE = 1024 * 1024;
  // 命中上限时记录，让结果末尾追加「已达上限」提示（LLM 可据此缩小范围）。
  let limitReached = false;

  for (const relPath of filtered) {
    if (matches.length >= OUTPUT_LIMITS.grep_matches) {
      limitReached = true;
      break;
    }
    const absFile = path.join(absStart, relPath);
    // 每个候选文件再过一遍沙箱：fastGlob 不做 symlink follow 检查，WorkspaceFS 把关。
    ctx.wsFs.assertInWorkspace(absFile);

    const stat = await fs.promises.stat(absFile);
    if (stat.size > MAX_FILE_SIZE) continue;

    const content = await fs.promises.readFile(absFile, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      // noUncheckedIndexedAccess 下 lines[i] 类型为 string | undefined，此处断言非空
      const line = lines[i] ?? '';
      if (matches.length >= OUTPUT_LIMITS.grep_matches) {
        limitReached = true;
        break;
      }
      regex.lastIndex = 0;
      if (regex.test(line)) {
        const preview = line.length > 200 ? line.slice(0, 200) + '…' : line;
        matches.push({ file: relPath, line: i + 1, content: preview });
      }
    }
  }

  if (matches.length === 0) return '(无匹配)';
  // truncateArray 仅在 > maxCount 时追加标记；limitReached 区分「恰好 = 上限」场景。
  const body = truncateArray(matches, OUTPUT_LIMITS.grep_matches, (m) => `${m.file}:${m.line}:${m.content}`);
  if (matches.length >= OUTPUT_LIMITS.grep_matches && limitReached) {
    return `${body}\n\n…(已达上限 ${OUTPUT_LIMITS.grep_matches} 条，请缩小范围)`;
  }
  return body;
}

async function executeGlob(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const pattern = parseStringArg(args.pattern, 'pattern');
  const startDir = typeof args.path === 'string' ? args.path : '.';

  const absStart = ctx.wsFs.assertInWorkspace(startDir);
  const files = await fastGlob(pattern, {
    cwd: absStart, absolute: false, ignore: DEFAULT_IGNORE, onlyFiles: true,
  });

  const ig = loadGitignore(ctx.workspaceDir);
  const filtered = ig ? files.filter((p) => !ig.ignores(p)) : files;

  if (filtered.length === 0) return '(无匹配文件)';
  return truncateArray(filtered, OUTPUT_LIMITS.glob_matches, (p) => p);
}
