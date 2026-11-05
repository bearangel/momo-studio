// electron/src/main/agent/tools/shared/sandboxed-exec.ts
//
// 受管沙箱执行器（spec 2026-11-03 §5.2）：resolveSandboxedSpawn 决策 + spawn
// 收集 + 超时/中止进程组强杀 + 输出截断。office-pro 插件 run_js 的唯一执行
// 通道；env 白名单基座之外的环境变量一律不传入子进程（对齐 shell-tools 纪律）。
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { resolveSandboxedSpawn } from '../../../sandbox';
import { mergePathEntries, resolveLoginShellPath } from '../../../sandbox/path-resolve';

export interface SandboxedExecRequest {
  /** 完整 argv（argv[0]=可执行文件绝对路径） */
  argv: string[];
  /** 工作目录（须为 workspace 目录——沙箱 policy 的写授权基准） */
  cwd: string;
  /** 追加 env（如 ELECTRON_RUN_AS_NODE）；白名单基座之上合并 */
  env?: Record<string, string>;
  /** 毫秒；到点杀进程组并标记 timedOut */
  timeoutMs: number;
  /** stdout / stderr 各自的字节上限；超出丢弃后续并标注 truncated */
  maxOutputBytes: number;
  abortSignal?: AbortSignal;
}

export interface SandboxedExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  /** 沙箱形态 tag（seatbelt/net-off 等），调用方透传给 LLM 自诊 */
  spawnTag: string;
}

/** env 白名单基座：子进程仅可见这些继承变量 + 请求方显式追加项 */
const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'USERPROFILE', 'APPDATA', 'TEMP',
] as const;

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (typeof v === 'string' && v.length > 0) env[key] = v;
  }
  return env;
}

/** 杀进程组：POSIX kill(-pgid)（detached spawn 使 pid 即 pgid）；win 走 taskkill /T /F 杀树 */
function killTree(child: ChildProcess, isWin: boolean): void {
  if (typeof child.pid !== 'number') return;
  if (isWin) {
    void spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 进程已退出：no-op */ }
  }
}

export async function execSandboxed(req: SandboxedExecRequest): Promise<SandboxedExecResult> {
  const plan = resolveSandboxedSpawn(req.cwd, req.argv);
  if (plan.kind === 'blocked') throw new Error(plan.reason);
  const env: Record<string, string> = {
    ...baseEnv(),
    ...(plan.kind === 'wrapped' ? plan.envAdditions : {}),
    ...(req.env ?? {}),
  };
  // 工具链可见性（2026-11-04）：与 bash 通道（shell-tools.ts）同源——登录
  // shell PATH 并入白名单 PATH 的值（只增值、不加键），插件 run_js 子进程同样
  // 能看到 sdkman/homebrew 等工具链目录。解析每进程缓存一次（path-resolve）。
  if (env.PATH !== undefined) {
    env.PATH = mergePathEntries(env.PATH, await resolveLoginShellPath());
  }
  const isWin = process.platform === 'win32';
  const child = spawn(plan.shell, plan.args, {
    cwd: req.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isWin, // POSIX 进程组长语义：kill(-pid) 杀全组
    windowsHide: true,
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let truncated = false;
  let timedOut = false;
  let aborted = false;
  let settled = false;

  const cap = (chunk: Buffer, sink: 'out' | 'err'): void => {
    const cur = sink === 'out' ? stdout : stderr;
    if (cur.length >= req.maxOutputBytes) { truncated = true; return; }
    const room = req.maxOutputBytes - cur.length;
    const taken = chunk.length <= room ? chunk : chunk.subarray(0, room);
    if (taken.length < chunk.length) truncated = true;
    const next = Buffer.concat([cur, taken]);
    if (sink === 'out') stdout = next; else stderr = next;
  };
  child.stdout?.on('data', (c: Buffer) => cap(c, 'out'));
  child.stderr?.on('data', (c: Buffer) => cap(c, 'err'));

  return await new Promise<SandboxedExecResult>((resolve) => {
    const timer = setTimeout(() => { timedOut = true; killTree(child, isWin); }, req.timeoutMs);
    const onAbort = (): void => { aborted = true; killTree(child, isWin); };
    req.abortSignal?.addEventListener('abort', onAbort, { once: true });
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.abortSignal?.removeEventListener('abort', onAbort);
      for (const f of plan.kind === 'wrapped' ? plan.cleanupFiles : []) {
        try { fs.unlinkSync(f); } catch { /* 清理失败无碍 */ }
      }
      resolve({
        exitCode: code,
        stdout: stdout.toString('utf-8'),
        stderr: stderr.toString('utf-8'),
        timedOut, aborted, truncated,
        spawnTag: plan.tag,
      });
    };
    child.on('close', (code) => finish(code));
    child.on('error', () => finish(null));
  });
}
