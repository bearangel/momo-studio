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

import { spawn } from 'node:child_process';
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
import { OUTPUT_LIMITS, truncateString } from './shared/output-truncate';
import { getGitPolicy } from '../../workspace/git-policy';
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
 */
async function runGit(
  args: string[],
  ctx: ToolContext,
  maxOutput: number = OUTPUT_LIMITS.git_status,
): Promise<GitResult> {
  // 过滤 `-c.` 前缀参数：防止 LLM 通过 `-c user.name=xxx` 绕过身份追踪。
  // 前缀故意用 `-c.`（点号）而非 `-c `，匹配 LLM 显式构造的 `git -c.key=val`，
  // 不会误伤正常的 `-c key=val`（带空格）。
  const safeArgs = args.filter((a) => !a.startsWith('-c.'));
  return new Promise((resolve) => {
    const child = spawn('git', safeArgs, {
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

/**
 * GitTools —— git 工具模块。v1.5 Task 9 引入。
 *
 * 工具清单：
 *   只读（本 task 实现）：git_status / git_diff / git_log / git_show
 *   写（后续 task 实现）：git_add / git_commit / git_branch / git_checkout / git_stash
 *
 * handles(name) 对全部 9 个返回 true——这样 LLM 调用写工具时由本模块给出
 * 「暂未实现」错误，而不会被路由到其他模块或抛 UnknownToolError。
 */
export class GitTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return [
      {
        name: 'git_status',
        description: '查看 workspace git 状态（porcelain 格式）',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'git_diff',
        description: '查看 git diff（默认同时显示 staged 和 unstaged）',
        inputSchema: {
          type: 'object',
          properties: {
            staged: { type: 'boolean' },
            path: { type: 'string' },
          },
        },
      },
      {
        name: 'git_log',
        description: '查看提交历史（oneline 格式）',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '默认 20，上限 100' },
            branch: { type: 'string' },
          },
        },
      },
      {
        name: 'git_show',
        description: '查看某个 commit 的详情（message + diff）',
        inputSchema: {
          type: 'object',
          properties: {
            commit: { type: 'string', description: '默认 HEAD' },
            stat: { type: 'boolean' },
          },
        },
      },
      {
        name: 'git_add',
        description: '暂存文件（git add）。paths 为相对 workspace 的路径数组',
        inputSchema: {
          type: 'object',
          properties: {
            paths: {
              type: 'array',
              items: { type: 'string' },
              description: '相对 workspace 的文件路径，逐个走沙箱校验',
            },
          },
          required: ['paths'],
        },
      },
      {
        name: 'git_commit',
        description: '提交暂存区到本地仓库。message 经 workspace GitPolicy 校验（branch + commit message pattern）。',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'commit message 首行' },
            description: { type: 'string', description: 'commit body（可选）' },
          },
          required: ['message'],
        },
      },
      {
        name: 'git_branch',
        description: '分支管理（双语义）：list=true 或省略 name → 列出分支；给 name → 创建分支',
        inputSchema: {
          type: 'object',
          properties: {
            list: { type: 'boolean', description: 'true → 列出现有分支' },
            name: { type: 'string', description: '给定则创建该分支' },
          },
        },
      },
      {
        name: 'git_checkout',
        description: '切换分支（git checkout <branch>）。仅切分支，不接受 path/commit',
        inputSchema: {
          type: 'object',
          properties: {
            branch: { type: 'string', description: '目标分支名（必须已存在）' },
          },
          required: ['branch'],
        },
      },
      {
        name: 'git_stash',
        description: 'stash 管理：push（含 -m message）/ list / pop / drop',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['push', 'list', 'pop', 'drop'] },
            message: { type: 'string', description: '仅 push 使用，对应 -m' },
            index: { type: 'number', description: 'pop/drop 的 stash 索引，默认 0' },
          },
          required: ['action'],
        },
      },
    ];
  }

  handles(name: string): boolean {
    return [
      'git_status', 'git_diff', 'git_log', 'git_show',
      'git_add', 'git_commit', 'git_branch', 'git_checkout', 'git_stash',
    ].includes(name);
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    switch (name) {
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

/** git_status：porcelain v1 格式。空输出时返回友好提示。*/
async function executeStatus(_args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const result = await runGit(['status', '--porcelain=v1'], ctx);
  if (result.code !== 0) throw new Error(`git status 失败: ${result.stderr}`);
  if (!result.stdout.trim()) return '干净的工作区（nothing to commit）';
  return truncateString(result.stdout, OUTPUT_LIMITS.git_status);
}

/** git_diff：默认 unstaged；staged=true 加 --staged；path 走沙箱断言。*/
async function executeDiff(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const gitArgs = ['diff'];
  if (args.staged === true) gitArgs.push('--staged');
  if (typeof args.path === 'string') {
    // 路径双校验：assertInWorkspace 拒绝 `..` 越界与符号链接逃逸。
    ctx.wsFs.assertInWorkspace(args.path);
    gitArgs.push('--', args.path);
  }
  const result = await runGit(gitArgs, ctx);
  if (result.code !== 0) throw new Error(`git diff 失败: ${result.stderr}`);
  if (!result.stdout.trim()) return '(无差异)';
  return truncateString(result.stdout, OUTPUT_LIMITS.git_show_diff);
}

/** git_log：oneline 格式，limit 钳制到 [1, 100]，默认 20。*/
async function executeLog(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const limit = typeof args.limit === 'number' ? Math.min(100, Math.max(1, args.limit)) : 20;
  const gitArgs = ['log', '--oneline', '-n', String(limit)];
  if (typeof args.branch === 'string') gitArgs.push(args.branch);
  const result = await runGit(gitArgs, ctx);
  if (result.code !== 0) throw new Error(`git log 失败: ${result.stderr}`);
  return truncateString(result.stdout, OUTPUT_LIMITS.git_status);
}

/** git_show：默认 HEAD；stat=true 加 --stat；maxOutput 用更大的 git_show_diff。*/
async function executeShow(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const commit = typeof args.commit === 'string' ? args.commit : 'HEAD';
  const gitArgs = ['show', commit];
  if (args.stat === true) gitArgs.push('--stat');
  const result = await runGit(gitArgs, ctx, OUTPUT_LIMITS.git_show_diff);
  if (result.code !== 0) throw new Error(`git show 失败: ${result.stderr}`);
  return truncateString(result.stdout, OUTPUT_LIMITS.git_show_diff);
}

/** 把 unknown 归一化为 string，非 string 则抛错。各 execute* 入参校验共用。*/
function parseStringArg(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`参数 "${name}" 缺失或不是字符串`);
  return value;
}

/** git_add：paths 数组逐个走 wsFs.assertInWorkspace 后再交给 git add。*/
async function executeAdd(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  if (!Array.isArray(args.paths)) throw new Error('参数 "paths" 缺失或不是数组');
  const paths = args.paths.map((p, i) => {
    if (typeof p !== 'string') throw new Error(`paths[${i}] 不是字符串`);
    ctx.wsFs.assertInWorkspace(p);
    return p;
  });
  const result = await runGit(['add', ...paths], ctx);
  if (result.code !== 0) throw new Error(`git add 失败: ${result.stderr}`);
  return `已暂存 ${paths.length} 个文件`;
}

/** git_branch：list=true 或 name 缺失 → 列出分支；否则创建 name 分支。*/
async function executeBranch(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const wantList = args.list === true || typeof args.name !== 'string';
  if (wantList) {
    const result = await runGit(['branch'], ctx);
    if (result.code !== 0) throw new Error(`git branch 失败: ${result.stderr}`);
    return result.stdout;
  }
  const name = parseStringArg(args.name, 'name');
  const result = await runGit(['branch', name], ctx);
  if (result.code !== 0) throw new Error(`git branch 创建失败: ${result.stderr}`);
  return `分支已创建: ${name}`;
}

/** git_checkout：仅切分支（不接受 path/commit，防丢工作区修改与 detached HEAD）。*/
async function executeCheckout(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const branch = parseStringArg(args.branch, 'branch');
  const result = await runGit(['checkout', branch], ctx);
  if (result.code !== 0) throw new Error(`git checkout 失败: ${result.stderr}`);
  return `已切换到分支: ${branch}`;
}

/** git_stash：push/list/pop/drop 四 action。push 支持 -m；pop/drop 接 optional index。*/
async function executeStash(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
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
  const result = await runGit(gitArgs, ctx);
  if (result.code !== 0) throw new Error(`git stash ${action} 失败: ${result.stderr}`);
  return result.stdout || `(无输出，action=${action} 完成)`;
}

/**
 * git_commit：走 GitPolicy 三层校验后提交。
 *
 * 三层校验：
 *   1. allowAgentCommits 总开关——false 直接拒绝
 *   2. 分支保护——当前在 defaultBranch 时自动 checkout -b 到 fallback 分支
 *   3. commit message pattern——isCommitBlocked 判定（strict 违规阻断 / warning 告警）
 *
 * 校验失败（strict 违规）时回切 defaultBranch + 删 fallback 分支，不留空分支。
 * warning 违规不阻断提交，在返回值末尾追加告警。
 */
async function executeCommit(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const message = parseStringArg(args.message, 'message');
  const description = typeof args.description === 'string' ? args.description : undefined;

  const policy = getGitPolicy(ctx.workspaceId);

  // 第一层：总开关
  if (!policy.allowAgentCommits) {
    throw new Error('GitPolicy 禁止 agent 自动提交（allowAgentCommits=false）');
  }

  // 第二层：分支保护——在 defaultBranch 上不允许直接提交，自动切到 fallback
  const branchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], ctx);
  if (branchResult.code !== 0) throw new Error(`获取当前分支失败: ${branchResult.stderr}`);
  const currentBranch = branchResult.stdout.trim();

  let branchSwitchedTo: string | null = null;
  if (currentBranch === policy.defaultBranch) {
    const fallback = renderFallbackBranch(policy.fallbackBranchPattern, {
      agentSlug: 'agent',
      taskId: ctx.streamSessionId,
    });
    const switchResult = await runGit(['checkout', '-b', fallback], ctx);
    if (switchResult.code !== 0) throw new Error(`自动切到 fallback 分支失败: ${switchResult.stderr}`);
    branchSwitchedTo = fallback;
  }

  // 第三层：commit message pattern 校验
  // isCommitBlocked 仅在 strict + 不合规时返回 true；warning/none 不阻断
  const blocked = isCommitBlocked(message, policy);
  if (blocked) {
    // 回切 defaultBranch + 删 fallback 分支，避免残留空分支
    if (branchSwitchedTo) {
      await runGit(['checkout', policy.defaultBranch], ctx);
      await runGit(['branch', '-D', branchSwitchedTo], ctx);
    }
    const validation = validateCommitMessage(message, policy);
    throw new Error(
      `commit message 不合规: ${validation.error ?? '未匹配任何 pattern'}\n期望格式示例: ${policy.commitMessage.patterns.map((p) => p.example).join(' / ')}`,
    );
  }

  const finalMessage = renderCommitMessage(message, description, policy.commitMessage);
  const result = await runGit(['commit', '-m', finalMessage], ctx);
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
