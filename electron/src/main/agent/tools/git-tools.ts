// electron/src/main/agent/tools/git-tools.ts
// Git 工具模块：4 只读（status / diff / log / show）+ 4 写（add / branch / checkout /
//   stash）+ 1 占位（commit，Task 11 接 GitPolicy）。v1.5 Task 9 引入只读，Task 10 加写。
//
// 设计要点：
//   - 直接 spawn git CLI，不引入 simple-git 之类的 wrapper（少一个依赖、少一层抽象）。
//   - cwd 锁定 ctx.workspaceDir：spawn 传 cwd，git 只在 workspace 内操作。
//   - GIT_TERMINAL_PROMPT=0：禁止 git 因缺凭证挂起等待用户输入（会卡住整个 agent）。
//   - 拦截 -c key=val：args.filter 跳过以 `-c.` 开头的参数，防止 LLM 绕过身份追踪
//     （`-c user.name=...` 可改提交者）。`-c.` 前缀只在 LLM 显式构造该精确字符串时
//     命中，正常 `-c foo=bar` 不会被误伤。
//   - 10s 默认超时：到点 SIGKILL（不可捕获、立即生效），防止恶意构造的死循环
//     （如巨大的 git log）。
//   - maxOutput 上限：spawn 后按字节累计 stdout / stderr，超 maxOutput 直接丢弃，
//     避免一次性把整个仓库历史吃进内存。默认 OUTPUT_LIMITS.git_status = 20KB。
//   - 退出码非 0 抛错（与 ShellTools 不同——git 只读命令失败说明真出问题了，
//     让 LLM 看到 stderr 自我纠正）。
//   - 写工具的路径参数（git_add paths）逐个走 ctx.wsFs.assertInWorkspace，拒绝
//     `..` 越界与符号链接逃逸——与 WorkspaceFS 安全模型对齐。
//   - git_checkout 仅切分支，不接受 path/commit：避免误用 `git checkout -- file`
//     丢失工作区修改，或 `git checkout <sha>` 进入 detached HEAD。
//   - v2.9 多仓 git（Task 2）：resolveRepoPath 解析可选 repo 参数（缺省根仓，
//     指定时 wsFs 边界校验 + discoverRepos 发现列表双校验）；runGit 增第四参
//     repoPath 定仓执行（`git -C <repoPath>`）。9 工具的 repo 参数接线在 Task 4。
//   - v2.9 多仓 git（Task 3）：git_repos 发现工具——discoverRepos 仓清单 + 每仓
//     并发查 branch --show-current / status --porcelain 行数，行格式
//     `root: <bool>  branch: <name|?>  dirty: <n|50+|?>  <相对路径|(.)>`；
//     单仓查询失败容错（该行字段显示 ?），空清单输出提示行。
//   - v2.9 多仓 git（Task 4）：9 工具接入 repo 参数——各 execute case 经
//     resolveRepoArg（统一入口，内调 Task 2 的 resolveRepoPath）一次解析后
//     透传 runGit 第四参；缺省（不传 repo）保持 undefined → runGit 不前置
//     -C，spawn args 与既有行为逐字节一致。git_commit 的 GitPolicy 分支
//     保护改读「目标仓」当前分支（策略仍 workspace 级单源，跨仓均匀继承）。
//   - v2.10 Windows 全平台化（T2）：本地 toPosixRel 退役，改 import 共享
//     platform/paths 的 toPosixRelPath——纯搬家，调用点语义不变（win32 反斜杠
//     相对路径统一 '/' 化由共享 helper 单点承载）。

import { spawn } from 'node:child_process';
import path from 'node:path';
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
import type { WorkspaceFS } from '../../files/workspace-fs';
import { OUTPUT_LIMITS, truncateString } from './shared/output-truncate';
import { parseStringArg } from './shared/arg-parse';
import { getGitPolicy } from '../../workspace/git-policy';
import { discoverRepos } from '../../git/repos';
import { toPosixRelPath } from '../../platform/paths';
import {
  validateCommitMessage,
  isCommitBlocked,
  renderFallbackBranch,
  renderCommitMessage,
} from '../../workspace/commit-validator';

/** git 子进程的默认超时（毫秒）。到点 SIGKILL。*/
const GIT_TIMEOUT_MS = 10_000;

/** runGit 的归一化返回值。code=null 表示进程被信号杀死或 spawn 失败。*/
interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * 在 workspace 内 spawn 一个 git 子进程并收集输出。
 *
 * @param args    传给 git 的参数（不含 `git` 本身），如 `['status', '--porcelain=v1']`。
 * @param ctx     工具上下文（取 workspaceDir）。
 * @param maxOutput stdout / stderr 各自的字节上限，默认 OUTPUT_LIMITS.git_status。
 * @param repoPath 目标仓绝对路径（resolveRepoPath 产出）。存在时 args 前置
 *                `['-C', repoPath]` 定仓执行；缺省（undefined）保持既有
 *                workspaceDir cwd 行为——args 与 spawn 选项逐字节不变。
 */
export async function runGit(
  args: string[],
  ctx: ToolContext,
  maxOutput: number = OUTPUT_LIMITS.git_status,
  repoPath?: string,
): Promise<GitResult> {
  // 过滤 `-c.` 前缀参数：防止 LLM 通过 `-c user.name=xxx` 绕过身份追踪。
  // 前缀故意用 `-c.`（点号）而非 `-c `，匹配 LLM 显式构造的 `git -c.key=val`，
  // 不会误伤正常的 `-c key=val`（带空格）。
  const safeArgs = args.filter((a) => !a.startsWith('-c.'));
  // repoPath 由本模块 resolveRepoPath 产出（绝不可能是 '-c.' 开头），在过滤后前置。
  const finalArgs = repoPath === undefined ? safeArgs : ['-C', repoPath, ...safeArgs];
  return new Promise((resolve) => {
    const child = spawn('git', finalArgs, {
      cwd: ctx.workspaceDir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    // 按字节累计，超 maxOutput 后丢弃后续 chunk（不再累加），避免大输出 OOM。
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < maxOutput) stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < maxOutput) stderr += chunk.toString('utf-8');
    });
    // 10s 超时 SIGKILL——不可被捕获，立即生效。
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 子进程已退出 */ }
    }, GIT_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      // spawn 本身失败（如 git 不存在）：归一化成 code=-1 + stderr 含错误信息。
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message });
    });
  });
}

/** repo 参数解析（v2.9 多仓 git）：缺省（undefined）→ workspace 根；指定时
 * 「wsFs 边界校验 + discoverRepos 发现列表命中」双校验，命中返回该仓绝对路径。
 *
 * 安全边界（spec §5 G4）：
 *   - 非 string → `参数 "repo" 不是字符串`
 *   - 绝对路径 → 拒（repo 契约是 workspace 相对路径，与发现清单同形态）
 *   - `..` 越界 / symlink 逃逸 / .git 内部 → assertInWorkspace 既有错误
 *   - symlink 指向 workspace 内的仓 → 边界通过但不命中发现列表
 *     （discoverRepos 用 Dirent 判断、不追符号链接）
 *
 * 命中比对两侧统一 workspace 相对 POSIX '/' 形态：`./services/api` 与
 * `services/api/` 等形态经 path.normalize 归一后等价命中。
 */
export function resolveRepoPath(workspaceDir: string, wsFs: WorkspaceFS, repo: unknown): string {
  if (repo === undefined) return workspaceDir;
  if (typeof repo !== 'string') throw new Error('参数 "repo" 不是字符串');
  if (path.isAbsolute(repo)) throw new Error('参数 "repo" 不接受绝对路径（请用 workspace 相对路径）');
  // wsFs 边界校验（同源 assertInWorkspace，返回绝对路径）
  const normalized = path.normalize(wsFs.assertInWorkspace(repo));
  const rel = toPosixRelPath(workspaceDir, normalized);
  const repos = discoverRepos(workspaceDir);
  for (const r of repos) {
    if (toPosixRelPath(workspaceDir, r) === rel) return r;
  }
  // 未命中：附可用仓清单（根仓显示 `根仓(.)`、内层为相对路径、逗号分隔），
  // 尾部提示目录缓存语义——新克隆的仓需待一次目录变更后才发现。
  const list = repos.map((r) => {
    const rRel = toPosixRelPath(workspaceDir, r);
    return rRel === '' ? '根仓(.)' : rRel;
  });
  throw new Error(`仓 "${repo}" 不在发现列表。可用: [${list.join(', ')}] 。新克隆的仓需待目录缓存失效（约一次目录变更后）或直接重试。`);
}

/**
 * repo 参数 → repoPath（Task 4 统一入口）：缺省（args.repo === undefined）保持
 * undefined——runGit 不前置 `-C`，spawn args 与既有缺省行为逐字节一致（spec §2.2
 * 不变量 1「缺省零变化」）；指定时经 resolveRepoPath 双校验（缺省根仓路径不
 * 走该路径，避免无谓的 discoverRepos 扫描）。未命中 / 越界 / 非 string 的
 * 错误文案由 resolveRepoPath 统一产出（9 工具一致）。
 */
function resolveRepoArg(args: Record<string, unknown>, ctx: ToolContext): string | undefined {
  return args.repo === undefined ? undefined : resolveRepoPath(ctx.workspaceDir, ctx.wsFs, args.repo);
}

/** 9 工具 inputSchema 共用的 repo 参数定义（spec §3.2 契约文案）。*/
const REPO_PARAM: { type: 'string'; description: string } = {
  type: 'string',
  description: '目标仓（相对 workspace 路径，缺省根仓；可用仓见 git_repos）',
};

/** 9 工具描述统一追加的多仓提示尾句（spec §3.4）。*/
const REPO_HINT = '多仓 workspace 中可用 repo 参数指定内层仓（先 git_repos 查询可用仓）';

/**
 * GitTools —— git 工具模块。v1.5 Task 9 引入。
 *
 * 工具清单（v2.9 Task 3 起共 10 个）：
 *   发现：git_repos（多仓清单 + 每仓分支 / dirty 摘要）
 *   只读：git_status / git_diff / git_log / git_show
 *   写：git_add / git_commit / git_branch / git_checkout / git_stash
 */
export class GitTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return [
      {
        name: 'git_repos',
        description:
          '发现 workspace 内全部 git 仓（根仓 + 限深 3 层内层仓），每仓一行摘要：是否根仓 / 当前分支 / dirty 文件数（≥50 显示 50+）/ 相对路径（根仓显示 (.)）。单仓查询失败时该行 branch/dirty 显示 ?。多仓 git 操作（repo 参数）前先调用本工具获取仓清单。',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'git_status',
        description: '查看 workspace git 状态（porcelain 格式）。' + REPO_HINT,
        inputSchema: {
          type: 'object',
          properties: { repo: REPO_PARAM },
        },
      },
      {
        name: 'git_diff',
        description: '查看 git diff（默认同时显示 staged 和 unstaged）。' + REPO_HINT,
        inputSchema: {
          type: 'object',
          properties: {
            staged: { type: 'boolean' },
            path: { type: 'string', description: '相对 workspace 的文件路径；repo 指定时为该仓内相对路径' },
            repo: REPO_PARAM,
          },
        },
      },
      {
        name: 'git_log',
        description: '查看提交历史（oneline 格式）。' + REPO_HINT,
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '默认 20，上限 100' },
            branch: { type: 'string' },
            repo: REPO_PARAM,
          },
        },
      },
      {
        name: 'git_show',
        description: '查看某个 commit 的详情（message + diff）。' + REPO_HINT,
        inputSchema: {
          type: 'object',
          properties: {
            commit: { type: 'string', description: '默认 HEAD' },
            stat: { type: 'boolean' },
            repo: REPO_PARAM,
          },
        },
      },
      {
        name: 'git_add',
        description: '暂存文件（git add）。paths 为相对 workspace 的路径数组。' + REPO_HINT,
        inputSchema: {
          type: 'object',
          properties: {
            paths: {
              type: 'array',
              items: { type: 'string' },
              description: '相对 workspace 的文件路径，逐个走沙箱校验；repo 指定时为该仓内相对路径',
            },
            repo: REPO_PARAM,
          },
          required: ['paths'],
        },
      },
      {
        name: 'git_commit',
        description:
          '提交暂存区到本地仓库。message 经 workspace GitPolicy 校验（branch + commit message pattern）。' +
          REPO_HINT,
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'commit message 首行' },
            description: { type: 'string', description: 'commit body（可选）' },
            repo: REPO_PARAM,
          },
          required: ['message'],
        },
      },
      {
        name: 'git_branch',
        description: '分支管理（双语义）：list=true 或省略 name → 列出分支；给 name → 创建分支。' + REPO_HINT,
        inputSchema: {
          type: 'object',
          properties: {
            list: { type: 'boolean', description: 'true → 列出现有分支' },
            name: { type: 'string', description: '给定则创建该分支' },
            repo: REPO_PARAM,
          },
        },
      },
      {
        name: 'git_checkout',
        description: '切换分支（git checkout <branch>）。仅切分支，不接受 path/commit。' + REPO_HINT,
        inputSchema: {
          type: 'object',
          properties: {
            branch: { type: 'string', description: '目标分支名（必须已存在）' },
            repo: REPO_PARAM,
          },
          required: ['branch'],
        },
      },
      {
        name: 'git_stash',
        description: 'stash 管理：push（含 -m message）/ list / pop / drop。' + REPO_HINT,
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['push', 'list', 'pop', 'drop'] },
            message: { type: 'string', description: '仅 push 使用，对应 -m' },
            index: { type: 'number', description: 'pop/drop 的 stash 索引，默认 0' },
            repo: REPO_PARAM,
          },
          required: ['action'],
        },
      },
    ];
  }

  handles(name: string): boolean {
    return [
      'git_repos',
      'git_status', 'git_diff', 'git_log', 'git_show',
      'git_add', 'git_commit', 'git_branch', 'git_checkout', 'git_stash',
    ].includes(name);
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    switch (name) {
      case 'git_repos': return executeRepos(ctx);
      case 'git_status': return executeStatus(args, ctx);
      case 'git_diff': return executeDiff(args, ctx);
      case 'git_log': return executeLog(args, ctx);
      case 'git_show': return executeShow(args, ctx);
      case 'git_add': return executeAdd(args, ctx);
      case 'git_branch': return executeBranch(args, ctx);
      case 'git_checkout': return executeCheckout(args, ctx);
      case 'git_stash': return executeStash(args, ctx);
      case 'git_commit': return executeCommit(args, ctx);
      default:
        throw new Error(`未知 git 工具: ${name}`);
    }
  }
}

/**
 * git_repos：多仓发现摘要（v2.9 Task 3）。
 *
 * discoverRepos 产出根在前、内层字典序的仓清单（保序直接沿用）；每仓
 * Promise.all 并发查 `branch --show-current` + `status --porcelain=v1` 非空行
 * 数（复用 runGit 的 10s 超时与输出截断）。单仓失败（code!==0）不阻断其余
 * 仓——该行 branch / dirty 显示 `?`（坏仓对 agent 可见本身即有价值的信号）。
 * 行格式（字段组间两空格，输出契约被 git-tools-repo.test.ts 逐字段锁死）：
 *   `root: <true|false>  branch: <name|?>  dirty: <n|50+|?>  <相对路径|(.)>`
 */
async function executeRepos(ctx: ToolContext): Promise<string> {
  const repos = discoverRepos(ctx.workspaceDir);
  if (repos.length === 0) return '未发现任何 git 仓';
  const lines = await Promise.all(
    repos.map(async (repo) => {
      const rel = toPosixRelPath(ctx.workspaceDir, repo);
      const isRoot = rel === '';
      const [branchRes, statusRes] = await Promise.all([
        runGit(['branch', '--show-current'], ctx, undefined, repo),
        runGit(['status', '--porcelain=v1'], ctx, undefined, repo),
      ]);
      // 成功且非空取分支名；失败或空输出（detached HEAD）→ ?
      const branch =
        branchRes.code === 0 && branchRes.stdout.trim() ? branchRes.stdout.trim() : '?';
      // porcelain 非空行计数（空输出 = 0）；≥50 封顶显示 50+；失败 → ?
      let dirty: string;
      if (statusRes.code !== 0) {
        dirty = '?';
      } else {
        const n = statusRes.stdout.split('\n').filter((l) => l.length > 0).length;
        dirty = n >= 50 ? '50+' : String(n);
      }
      return `root: ${isRoot}  branch: ${branch}  dirty: ${dirty}  ${isRoot ? '(.)' : rel}`;
    }),
  );
  return lines.join('\n');
}

/** git_status：porcelain v1 格式。空输出时返回友好提示。*/
async function executeStatus(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const repoPath = resolveRepoArg(args, ctx);
  const result = await runGit(['status', '--porcelain=v1'], ctx, undefined, repoPath);
  if (result.code !== 0) throw new Error(`git status 失败: ${result.stderr}`);
  if (!result.stdout.trim()) return '干净的工作区（nothing to commit）';
  return truncateString(result.stdout, OUTPUT_LIMITS.git_status);
}

/** git_diff：默认 unstaged；staged=true 加 --staged；path 走沙箱断言。*/
async function executeDiff(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const repoPath = resolveRepoArg(args, ctx);
  const gitArgs = ['diff'];
  if (args.staged === true) gitArgs.push('--staged');
  if (typeof args.path === 'string') {
    // 路径双校验：assertInWorkspace 拒绝 `..` 越界与符号链接逃逸。多仓语义下
    // 该校验保持「相对 workspace」不动（路径边界不因 repo 参数改变）；指定
    // repo 后 path 由 git 在 `-C <repoPath>` 下按仓内相对路径解析——仓已在
    // workspace 内 + git 自限于仓内，无逃逸面。
    ctx.wsFs.assertInWorkspace(args.path);
    gitArgs.push('--', args.path);
  }
  const result = await runGit(gitArgs, ctx, undefined, repoPath);
  if (result.code !== 0) throw new Error(`git diff 失败: ${result.stderr}`);
  if (!result.stdout.trim()) return '(无差异)';
  return truncateString(result.stdout, OUTPUT_LIMITS.git_show_diff);
}

/** git_log：oneline 格式，limit 钳制到 [1, 100]，默认 20。*/
async function executeLog(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const repoPath = resolveRepoArg(args, ctx);
  const limit = typeof args.limit === 'number' ? Math.min(100, Math.max(1, args.limit)) : 20;
  const gitArgs = ['log', '--oneline', '-n', String(limit)];
  if (typeof args.branch === 'string') gitArgs.push(args.branch);
  const result = await runGit(gitArgs, ctx, undefined, repoPath);
  if (result.code !== 0) throw new Error(`git log 失败: ${result.stderr}`);
  return truncateString(result.stdout, OUTPUT_LIMITS.git_status);
}

/** git_show：默认 HEAD；stat=true 加 --stat；maxOutput 用更大的 git_show_diff。*/
async function executeShow(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const repoPath = resolveRepoArg(args, ctx);
  const commit = typeof args.commit === 'string' ? args.commit : 'HEAD';
  const gitArgs = ['show', commit];
  if (args.stat === true) gitArgs.push('--stat');
  const result = await runGit(gitArgs, ctx, OUTPUT_LIMITS.git_show_diff, repoPath);
  if (result.code !== 0) throw new Error(`git show 失败: ${result.stderr}`);
  return truncateString(result.stdout, OUTPUT_LIMITS.git_show_diff);
}

/** git_add：paths 数组逐个走 wsFs.assertInWorkspace 后再交给 git add。*/
async function executeAdd(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const repoPath = resolveRepoArg(args, ctx);
  if (!Array.isArray(args.paths)) throw new Error('参数 "paths" 缺失或不是数组');
  const paths = args.paths.map((p, i) => {
    if (typeof p !== 'string') throw new Error(`paths[${i}] 不是字符串`);
    // 沙箱校验保持「相对 workspace」语义不动（与 git_diff.path 同口径）：指定
    // repo 后 paths 由 git 在 `-C <repoPath>` 下按仓内相对路径解析——仓已在
    // workspace 内 + git 自限于仓内，无逃逸面。
    ctx.wsFs.assertInWorkspace(p);
    return p;
  });
  const result = await runGit(['add', ...paths], ctx, undefined, repoPath);
  if (result.code !== 0) throw new Error(`git add 失败: ${result.stderr}`);
  return `已暂存 ${paths.length} 个文件`;
}

/** git_branch：list=true 或 name 缺失 → 列出分支；否则创建 name 分支。*/
async function executeBranch(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const repoPath = resolveRepoArg(args, ctx);
  const wantList = args.list === true || typeof args.name !== 'string';
  if (wantList) {
    const result = await runGit(['branch'], ctx, undefined, repoPath);
    if (result.code !== 0) throw new Error(`git branch 失败: ${result.stderr}`);
    return result.stdout;
  }
  const name = parseStringArg(args.name, 'name');
  const result = await runGit(['branch', name], ctx, undefined, repoPath);
  if (result.code !== 0) throw new Error(`git branch 创建失败: ${result.stderr}`);
  return `分支已创建: ${name}`;
}

/** git_checkout：仅切分支（不接受 path/commit，防丢工作区修改与 detached HEAD）。*/
async function executeCheckout(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const repoPath = resolveRepoArg(args, ctx);
  const branch = parseStringArg(args.branch, 'branch');
  const result = await runGit(['checkout', branch], ctx, undefined, repoPath);
  if (result.code !== 0) throw new Error(`git checkout 失败: ${result.stderr}`);
  return `已切换到分支: ${branch}`;
}

/** git_stash：push/list/pop/drop 四 action。push 支持 -m；pop/drop 接 optional index。*/
async function executeStash(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const repoPath = resolveRepoArg(args, ctx);
  const action = parseStringArg(args.action, 'action');
  let gitArgs: string[];
  switch (action) {
    case 'push': {
      // --include-untracked：agent 场景常需要暂存新建文件（不仅是已跟踪文件的修改）；
      // brief 原版未带此 flag，但 brief 的测试用例（push+list / pop 恢复）显式验证
      // 「新文件被 stash 后从工作区消失」——不带 -u 测试无法通过，故按 TDD 契约补此 flag。
      gitArgs = ['stash', 'push', '--include-untracked'];
      if (typeof args.message === 'string') gitArgs.push('-m', args.message);
      break;
    }
    case 'list': gitArgs = ['stash', 'list']; break;
    case 'pop':
    case 'drop': {
      const idx = typeof args.index === 'number' ? args.index : 0;
      gitArgs = ['stash', action, `stash@{${idx}}`];
      break;
    }
    default: throw new Error(`未知 git_stash action: ${action}`);
  }
  const result = await runGit(gitArgs, ctx, undefined, repoPath);
  if (result.code !== 0) throw new Error(`git stash ${action} 失败: ${result.stderr}`);
  return result.stdout || `(无输出，action=${action} 完成)`;
}

/**
 * git_commit：走 GitPolicy 三层校验后提交。
 *
 * 三层校验：
 *   1. allowAgentCommits 总开关——false 直接拒绝
 *   2. 分支保护——目标仓当前在 defaultBranch 时自动 checkout -b 到 fallback 分支
 *   3. commit message pattern——isCommitBlocked 判定（strict 违规阻断 / warning 告警）
 *
 * 校验失败（strict 违规）时回切 defaultBranch + 删 fallback 分支，不留空分支。
 * warning 违规不阻断提交，在返回值末尾追加告警。
 *
 * 多仓语义（Task 4）：repo 解析先于 GitPolicy 读取（repo 未命中的统一报错
 * 不依赖 DB）；策略本身仍 workspace 级单源（跨仓均匀继承）——但分支保护
 * 读的是**目标仓**（repoPath）的当前分支，分支切换 / 回滚 / 提交也全部
 * 落在目标仓。缺省根仓时 repoPath 为 undefined，行为与既有逐字节一致。
 */
async function executeCommit(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const repoPath = resolveRepoArg(args, ctx);
  const message = parseStringArg(args.message, 'message');
  const description = typeof args.description === 'string' ? args.description : undefined;

  const policy = getGitPolicy(ctx.workspaceId);

  // 第一层：总开关（仓无关——workspace 级单源，根仓与内层仓同拒）
  if (!policy.allowAgentCommits) {
    throw new Error(
      'GitPolicy 禁止 agent 自动提交（allowAgentCommits=false）。' +
        '如需允许，请在设置的 Git 策略中开启；否则请用 git_diff 呈现变更交由人工审查提交。',
    );
  }

  // 第二层：分支保护——目标仓在 defaultBranch 上不允许直接提交，自动切到 fallback
  const branchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], ctx, undefined, repoPath);
  if (branchResult.code !== 0) throw new Error(`获取当前分支失败: ${branchResult.stderr}`);
  const currentBranch = branchResult.stdout.trim();

  let branchSwitchedTo: string | null = null;
  if (currentBranch === policy.defaultBranch) {
    const fallback = renderFallbackBranch(policy.fallbackBranchPattern, {
      agentSlug: 'agent',
      taskId: ctx.streamSessionId,
    });
    const switchResult = await runGit(['checkout', '-b', fallback], ctx, undefined, repoPath);
    if (switchResult.code !== 0) throw new Error(`自动切到 fallback 分支失败: ${switchResult.stderr}`);
    branchSwitchedTo = fallback;
  }

  // 第三层：commit message pattern 校验
  // isCommitBlocked 仅在 strict + 不合规时返回 true；warning/none 不阻断
  const blocked = isCommitBlocked(message, policy);
  if (blocked) {
    // 回切 defaultBranch + 删 fallback 分支，避免残留空分支
    if (branchSwitchedTo) {
      await runGit(['checkout', policy.defaultBranch], ctx, undefined, repoPath);
      await runGit(['branch', '-D', branchSwitchedTo], ctx, undefined, repoPath);
    }
    const validation = validateCommitMessage(message, policy);
    throw new Error(
      `commit message 不合规: ${validation.error ?? '未匹配任何 pattern'}\n期望格式示例: ${policy.commitMessage.patterns.map((p) => p.example).join(' / ')}`,
    );
  }

  const finalMessage = renderCommitMessage(message, description, policy.commitMessage);
  const result = await runGit(['commit', '-m', finalMessage], ctx, undefined, repoPath);
  if (result.code !== 0) throw new Error(`git commit 失败: ${result.stderr}`);

  const parts: string[] = [];
  if (branchSwitchedTo) {
    parts.push(`(从 ${policy.defaultBranch} 自动切到分支: ${branchSwitchedTo})`);
  }
  parts.push(result.stdout);
  // warning 级别违规：提交已成功，但追加告警供 agent 感知
  const postCheck = validateCommitMessage(message, policy);
  if (!postCheck.valid && !blocked) {
    parts.push(`⚠️ GitPolicy warning: ${postCheck.error ?? 'message 不符合规则'}`);
  }
  return parts.join('\n');
}
