// electron/src/main/agent/tools/shell-tools.ts
// Bash 执行工具：workspace 内自由 shell + 黑名单 + 环境变量白名单 + 截断 + 超时。
//
// 设计要点：
//   - v2.4：OS 沙箱接入（spec §5.2）——spawn 参数经 resolveShellSpawn 三态决策：
//     wrapped（bwrap/sandbox-exec 包裹）/ plain（permissive 降级直跑，结果带
//     unsandboxed 标记）/ blocked（strict 且不可用，spawn 前抛错含安装指引）。
//   - cwd 锁定 ctx.workspaceDir：spawn 直接传 cwd，LLM 无法靠 `cd` 越界；
//     每条命令独立 shell（`bash -c '<cmd>'`），cd 不持久。
//   - 命令黑名单在 spawn 前拦截：rm -rf 根/家目录、mkfs、dd 写设备、fork bomb、
//     改写 /etc/passwd|shadow|sudoers、chmod -R /、关机重启、git commit（强制走
//     git_commit 工具接受 GitPolicy 校验）。命中即抛错，由调用方转成 tool result。
//   - 环境变量白名单：只传 PATH/HOME/USER/... 等基础变量，API key/token 一律
//     不传入子进程；额外注入 WORKSPACE_DIR / MOMO_STUDIO_AGENT。
//   - 输出截断：stdout/stderr 各 10KB（OUTPUT_LIMITS），超长追加截断标记。
//   - 超时：默认 30s，最大 120s，超时 SIGKILL 子进程并返回超时标记；
//     退出码非 0 不抛错，让 LLM 看到 stderr 自我纠正。

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
import { OUTPUT_LIMITS } from './shared/output-truncate';
import { parseStringArg } from './shared/arg-parse';
import { resolveShellSpawn } from '../../sandbox';
import { buildKillTreeArgs } from '../../sandbox/windows';

/**
 * 命令黑名单。每条 = 危险模式 + 命中后给 LLM 的理由。
 * 模式按「具体路径 / 设备 / 系统文件」精确匹配，避免误伤 workspace 内的
 * 同名相对路径操作（如 rm -rf ./dist 不应被拦截）。
 */
const BLACKLIST_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // rm -rf / 根目录（裸 / 后必须接空白或行尾，避免误伤 /home 等子路径写法已被其他规则覆盖）
  { pattern: /\brm\s+-[rf]+\s+\/\s*($|\s)/, reason: '禁止 rm -rf / 根目录' },
  // rm -rf /* 通配根下所有
  { pattern: /\brm\s+-[rf]+\s+\/\*/, reason: '禁止 rm -rf /*' },
  // rm -rf ~ / ~/... 家目录
  { pattern: /\brm\s+-[rf]+\s+~/, reason: '禁止 rm -rf 家目录' },
  // mkfs 任意文件系统格式化
  { pattern: /\bmkfs\b/, reason: '禁止 mkfs 格式化' },
  // dd 写块设备（if=... 任意，of=/dev/... 才拦截——读设备不危险）
  { pattern: /\bdd\s+if=.*of=\/dev\//, reason: '禁止 dd 写设备' },
  // fork bomb 经典模式 :(){ :|:& };:
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&/, reason: '禁止 fork bomb' },
  // 改写系统账号 / 鉴权文件（> /etc/passwd|shadow|sudoers）
  { pattern: />\s*\/etc\/(passwd|shadow|sudoers)/, reason: '禁止改写系统账号文件' },
  // chmod -R 递归改根权限
  { pattern: /\bchmod\s+-R\s+[0-7]+\s+\/$/, reason: '禁止递归改根权限' },
  // 关机 / 重启
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: '禁止关机重启' },
  // git commit 必须走专用 git_commit 工具（走 GitPolicy 校验 + 审计）
  { pattern: /\bgit\s+commit\b/, reason: '禁止 bash 直接 git commit，请用 git_commit 工具（走 GitPolicy 校验）' },
  // ── Windows 危险命令（v2.4，spec §5.5；regex 大小写不敏感场景用 i flag）──
  { pattern: /\bformat(\.com)?\s+[a-z]:/i, reason: '禁止格式化磁盘卷' },
  { pattern: /\b(remove-item|rm)\s+.*-recurse\s+.*[a-z]:\\/i, reason: '禁止递归删除盘根' },
  { pattern: /\bbcdedit\b/i, reason: '禁止修改启动配置' },
  { pattern: /\bvssadmin\s+delete\s+shadows/i, reason: '禁止删除卷影副本' },
  { pattern: /\breg\s+add\b.*\\run\b/i, reason: '禁止写自启动注册表项' },
];

/**
 * 检查命令是否被黑名单拦截。命中即抛错（错误信息含理由 + 命令前 200 字符预览）。
 * 命令在 spawn 前过此函数，避免危险命令真的进入子进程。
 */
export function assertCommandAllowed(command: string): void {
  for (const { pattern, reason } of BLACKLIST_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error(`命令被黑名单拦截: ${reason}（命令前 200 字符: ${command.slice(0, 200)}）`);
    }
  }
}

/**
 * 构造沙箱环境变量。白名单外的 process.env 一律不传入子进程——这是
 * 「LLM 看不到主机 API key/token」的核心防线。
 *
 * 白名单成员：进程运行必需的 PATH/HOME/USER/... 与本地化相关变量。
 * 额外注入 WORKSPACE_DIR（让脚本感知沙箱根）+ MOMO_STUDIO_AGENT（标记来源）。
 */
export function buildSandboxEnv(ctx: ToolContext): NodeJS.ProcessEnv {
  const ALLOWED = new Set([
    'PATH', 'HOME', 'USER', 'USERPROFILE',
    'LANG', 'LC_ALL', 'LC_CTYPE',
    'SHELL', 'TERM',
    'TMPDIR', 'TMP', 'TEMP',
    'SYSTEMROOT', 'WINDIR',
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) {
    if (ALLOWED.has(key)) env[key] = process.env[key];
  }
  env.WORKSPACE_DIR = ctx.workspaceDir;
  env.MOMO_STUDIO_AGENT = '1';
  return env;
}

/** 把 v 钳制到 [min, max] 区间。timeoutMs 越界时归一化到合法范围。 */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * ShellTools —— bash 工具模块。v1.5 Task 8 引入。
 *
 * 工具名：bash。参数：command（必填）、timeoutMs（可选，默认 30000，最大 120000）。
 * 返回格式：`exit_code: <code>` 开头，后接 stdout / stderr / 超时标记 / 截断标记。
 */
export class ShellTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return [{
      name: 'bash',
      description: '在 workspace 根目录执行 shell 命令（受 OS 沙箱约束：读全盘但敏感目录不可读、仅可写 workspace 与 /tmp、默认禁网）。30s 超时，stdout+stderr 各截断 10KB。退出码非 0 不抛错。每条命令独立 shell，cd 不持久。',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '完整 shell 命令' },
          timeoutMs: { type: 'number', description: '超时毫秒，默认 30000，最大 120000' },
        },
        required: ['command'],
      },
    }];
  }

  handles(name: string): boolean {
    return name === 'bash';
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (name !== 'bash') throw new Error(`未知 shell 工具: ${name}`);

    const command = parseStringArg(args.command, 'command');
    // timeoutMs：未传或非 number 走默认 30s；越界时 clamp 到 [1s, 120s]。
    const timeoutMs = clamp(typeof args.timeoutMs === 'number' ? args.timeoutMs : 30000, 1000, 120000);

    // 黑名单拦截先于 spawn，命中即抛错（调用方转成 tool result 反馈给 LLM）。
    assertCommandAllowed(command);

    // v2.4：OS 沙箱接入（spec §5.2）——三态决策替换平台硬编码。
    // blocked（strict 且沙箱不可用）必须在 spawn 之前抛错：
    // 错误信息含安装指引，由调用方转成 tool result 反馈给 LLM 自行处理。
    const plan = resolveShellSpawn(ctx.workspaceDir, command);
    if (plan.kind === 'blocked') throw new Error(plan.reason);
    // wrapped 模式叠加沙箱 env 增量（npm/pip 缓存重定向到 tmp，写剖面自洽）
    const env = { ...buildSandboxEnv(ctx), ...(plan.kind === 'wrapped' ? plan.envAdditions : {}) };
    const isWin = process.platform === 'win32';

    return await new Promise((resolve, reject) => {
      const child = spawn(plan.shell, plan.args, {
        cwd: ctx.workspaceDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX：detached 使 bash 成为进程组长，kill(-pid) 杀全组（v1.5.6 语义保留）。
        // win32 无进程组语义：detached=false + 杀树走 taskkill /T /F（spec §5.5）。
        detached: !isWin,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let killed = false;
      // v1.5.6: 防重复 resolve/reject——close 事件 + 兜底 timer 可能竞争
      let settled = false;
      const guard = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };

      // 输出按 OUTPUT_LIMITS.bash_stdout / bash_stderr 截断。逻辑：
      //   1) 已满 → 直接丢弃本 chunk，同时置 truncated=true；
      //   2) 本 chunk 超过剩余配额 → 截取剩余部分，置 truncated=true；
      //   3) 本 chunk 在配额内 → 全量追加。
      // 关键：必须在「本次发生截断」时立即置 truncated，避免子进程在单 chunk
      //       填满后立即退出时遗漏标记（truncated 永远不会被设回）。
      child.stdout.on('data', (chunk: Buffer) => {
        const remaining = OUTPUT_LIMITS.bash_stdout - stdout.length;
        if (remaining <= 0) { truncated = true; return; }
        const chunkStr = chunk.toString('utf-8');
        if (chunkStr.length > remaining) {
          stdout += chunkStr.slice(0, remaining);
          truncated = true;
        } else {
          stdout += chunkStr;
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const remaining = OUTPUT_LIMITS.bash_stderr - stderr.length;
        if (remaining <= 0) { truncated = true; return; }
        const chunkStr = chunk.toString('utf-8');
        if (chunkStr.length > remaining) {
          stderr += chunkStr.slice(0, remaining);
          truncated = true;
        } else {
          stderr += chunkStr;
        }
      });

      // v1.5.6: 杀整个进程组（bash + 所有子进程）。SIGKILL 不可被捕获/忽略。
      const killProcessGroup = (): void => {
        if (!child.pid) return;
        if (isWin) {
          // Windows：taskkill 树杀（process.kill(-pid) 在 win32 会抛 EINVAL）
          spawn('taskkill', buildKillTreeArgs(child.pid), { stdio: 'ignore' });
          return;
        }
        // detached 模式下 child.pid 就是 pgid；process.kill(-pid) 给全组发 SIGKILL。
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // 进程组杀失败（已退出/权限），降级杀 child 自身
          try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
        }
      };

      // v1.5.6: 兜底 resolve——进程组 SIGKILL 后 close 事件可能仍不触发
      //（极端 hang / 子进程脱离了进程组 / stdio 未关）。
      // timeout 和 abort 两个路径共用此兜底，防 Promise 永久卡住。
      let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
      const armFallback = (reason: string): void => {
        if (fallbackTimer) return; // 已在倒计时
        fallbackTimer = setTimeout(() => {
          guard(() => {
            const parts = [`exit_code: null`, `(${reason}，进程组已杀 + 2s 兜底结束)`];
            if (stdout) parts.push(`stdout:\n${stdout}${truncated ? '\n…(已截断)' : ''}`);
            if (stderr) parts.push(`stderr:\n${stderr}${truncated ? '\n…(已截断)' : ''}`);
            resolve(parts.join('\n\n'));
          });
        }, 2000);
      };

      // 超时定时器：到点 SIGKILL 整个进程组 + 启动 2s 兜底。
      const timer = setTimeout(() => {
        killed = true;
        killProcessGroup();
        armFallback(`超时 ${timeoutMs}ms`);
      }, timeoutMs);

      // v1.5.1：监听外部 abortSignal（chat loop 中断）。被 abort 时立即 SIGKILL + 兜底。
      let aborted = false;
      const onAbort = (): void => {
        if (aborted || killed || settled) return;
        aborted = true;
        killProcessGroup();
        // v1.5.6: abort 也要启动兜底 timer——跟 timeout 路径一样，
        // 进程组 SIGKILL 后 close 可能不触发（子进程持有 stdio），不兜底会卡住。
        armFallback('用户中断');
      };
      if (ctx.abortSignal) {
        if (ctx.abortSignal.aborted) onAbort();
        else ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      child.on('close', (code) => {
        guard(() => {
          clearTimeout(timer);
          if (fallbackTimer) clearTimeout(fallbackTimer);
          if (ctx.abortSignal) ctx.abortSignal.removeEventListener('abort', onAbort);
          // v1.5.2: 外部中断时抛 AbortError，chat loop 据此跳出整个循环（不推 tool_result 给 LLM）。
          // 不抛的话 LLM 看到 "(用户中断)" 结果仍会重试，形成死循环。
          if (aborted) {
            const e = new Error('bash 被中断');
            e.name = 'AbortError';
            reject(e);
            return;
          }
          // v2.4：sandbox 行紧跟 exit_code 行——LLM 与调用方据此感知本次执行
          // 是否落在 OS 沙箱内（unsandboxed:* = permissive 降级直跑）。
          const parts: string[] = [`exit_code: ${code ?? 'null'}`, `sandbox: ${plan.tag}`];
          // wrapped 模式清理临时 profile 文件（darwin seatbelt .sb 等）——best-effort
          for (const f of plan.kind === 'wrapped' ? plan.cleanupFiles : []) {
            try { fs.unlinkSync(f); } catch { /* best-effort */ }
          }
          if (killed) parts.push(`(超时 ${timeoutMs}ms，已强杀)`);
          if (stdout) parts.push(`stdout:\n${stdout}${truncated ? '\n…(stdout 已截断)' : ''}`);
          if (stderr) parts.push(`stderr:\n${stderr}${truncated ? '\n…(stderr 已截断)' : ''}`);
          if (!stdout && !stderr && code === 0 && !killed) parts.push('(无输出)');
          // 永远 resolve——退出码非 0 不抛错，让 LLM 看到 stderr 自我纠正。
          resolve(parts.join('\n\n'));
        });
      });

      // spawn 本身失败（如 shell 不存在）：转成文本结果而非抛错。
      child.on('error', (err) => {
        guard(() => {
          clearTimeout(timer);
          if (fallbackTimer) clearTimeout(fallbackTimer);
          if (ctx.abortSignal) ctx.abortSignal.removeEventListener('abort', onAbort);
          resolve(`shell 启动失败: ${err.message}`);
        });
      });
    });
  }
}
