// electron/src/main/agent/tools/git-tools.ts
// Git 工具模块：4 只读（status / diff / log / show）+ 5 写工具占位（add / commit /
//   branch / checkout / stash，后续 task 实现）。v1.5 Task 9 引入。
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

import { spawn } from 'node:child_process';
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
import { OUTPUT_LIMITS, truncateString } from './shared/output-truncate';

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
      case 'git_add':
      case 'git_commit':
      case 'git_branch':
      case 'git_checkout':
      case 'git_stash':
        throw new Error(`${name} 暂未实现（后续 task 实现）`);
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
