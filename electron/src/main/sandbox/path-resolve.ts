// electron/src/main/sandbox/path-resolve.ts
//
// 登录 shell PATH 解析与合并（工具链可见性修复，2026-11-04）。
//
// 背景（生产事故）：GUI 应用经 launchd 启动只带最小 PATH（无 /opt/homebrew/bin、
// ~/.sdkman 等），沙箱内 bash 又是非登录 shell（/etc/zprofile、~/.zprofile 等
// 初始化文件从不执行）——agent 据此误判「沙箱无 JDK」，而工具链本身在盘上
// 完全可读（seatbelt 允许全盘读）。本模块在进程内解析一次用户登录 shell 的
// PATH，供 bash 工具（shell-tools.ts）与插件受管执行（sandboxed-exec.ts）两条
// 通道合并进子进程 PATH——只增补白名单已有 PATH 键的值，绝不新增环境变量键。
//
// 缓存形态对齐 toolchain-grant.ts 的 resolveNpmPrefix / npmPrefixCache 先例：
// 每进程至多探测一次。成功与降级结果都落缓存（先例在失败时缓存 null）——
// 坏 SHELL 主机上若不缓存失败，每次工具执行都要重付探测超时。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { logger } from '../logger';

/** 单次登录 shell 探测超时（毫秒）：首条 bash 命令可能付出的额外延迟上界 */
const PROBE_TIMEOUT_MS = 3_000;

/** darwin 下 SHELL 缺失或启动失败时的回退候选链（按序尝试） */
const DARWIN_FALLBACK_SHELLS = ['/bin/zsh', '/bin/bash'] as const;

/** 探测结果缓存（undefined=未探测；降级值同样缓存——每进程一次） */
let loginPathCache: string | undefined;
/** 在途探测：并发调用共享同一次探测，避免首轮并发重复 spawn */
let inflightProbe: Promise<string> | null = null;

/**
 * 合并两条 PATH：base 顺序原样保留，extra 中 base 尚未出现的条目按序追加
 * （extra 内部亦去重，空条目跳过）。与 toolchain-grant 的
 * `[process.env.PATH, '/opt/homebrew/bin', ...].join` 同一顺序哲学——
 * 基座优先、登录 shell 增量殿后。无新增条目时原样返回 base。
 */
export function mergePathEntries(base: string, extra: string): string {
  const baseEntries = base.split(path.delimiter);
  const present = new Set(baseEntries);
  const additions: string[] = [];
  for (const entry of extra.split(path.delimiter)) {
    if (entry === '' || present.has(entry)) continue;
    present.add(entry);
    additions.push(entry);
  }
  if (additions.length === 0) return base;
  return [...baseEntries, ...additions].join(path.delimiter);
}

/**
 * 解析用户登录 shell 的 PATH（`$SHELL -l -c 'echo $PATH'`）。
 *
 * - win32 无登录 shell PATH 语义：原样返回 process.env.PATH，不 spawn。
 * - SHELL 缺失或启动失败时按平台回退（darwin：/bin/zsh → /bin/bash）。
 * - 任何失败（超时 / 非零退出 / 无候选）都优雅降级为 process.env.PATH 并记
 *   warn——沙箱 PATH 至少保持启动 PATH，绝不因探测失败阻塞工具执行。
 * - 结果进程级缓存一次（含降级结果），后续调用零开销。
 */
export function resolveLoginShellPath(): Promise<string> {
  if (loginPathCache !== undefined) return Promise.resolve(loginPathCache);
  if (inflightProbe !== null) return inflightProbe;
  const probe = probeLoginShellPath().then(
    (resolved) => {
      loginPathCache = resolved;
      return resolved;
    },
    (err) => {
      const fallback = process.env.PATH ?? '';
      loginPathCache = fallback;
      logger.warn('登录 shell PATH 探测失败——沿用当前 PATH（GUI 最小 PATH 下 sdkman/homebrew 等工具链目录将不可见）', {
        error: err instanceof Error ? err.message : String(err),
      });
      return fallback;
    },
  );
  inflightProbe = probe;
  // 探测落定后清在途引用：此后由 loginPathCache 兜底（成功与降级均已缓存）
  void probe.finally(() => { inflightProbe = null; });
  return probe;
}

/** 候选 shell 链：$SHELL 优先；darwin 追加系统回退链（linux 无回退） */
function shellCandidates(): string[] {
  const candidates: string[] = [];
  const userShell = process.env.SHELL;
  if (userShell !== undefined && userShell.trim() !== '') candidates.push(userShell);
  if (process.platform === 'darwin') candidates.push(...DARWIN_FALLBACK_SHELLS);
  return candidates;
}

/** 逐候选探测登录 PATH；全部失败时以最后一次错误 reject（由公开层降级） */
async function probeLoginShellPath(): Promise<string> {
  if (process.platform === 'win32') return process.env.PATH ?? '';
  const candidates = shellCandidates();
  if (candidates.length === 0) {
    throw new Error('无登录 shell 候选（SHELL 未设置且平台无回退链）');
  }
  let lastError: unknown = null;
  for (const shell of candidates) {
    try {
      const out = await runLoginShellEcho(shell);
      const resolved = out.trim();
      if (resolved === '') throw new Error(`${shell} -l -c 'echo $PATH' 输出为空`);
      return resolved;
    } catch (err) {
      lastError = err; // 逐候选回退；全部失败时上报最后一跳的错误
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * 单次 `$shell -l -c 'echo $PATH'` 探测。退出码非 0 / spawn 失败 / 超时均
 * reject（由调用方回退下一候选）；超时先 SIGKILL 再 reject，不留悬挂进程。
 */
function runLoginShellEcho(shell: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let out = '';
    const child = spawn(shell, ['-l', '-c', 'echo $PATH'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* 已退出：no-op */ }
      reject(new Error(`${shell} 登录 PATH 探测超时（${PROBE_TIMEOUT_MS}ms）`));
    }, PROBE_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf-8'); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${shell} 登录 PATH 探测退出码 ${code ?? 'null'}`));
    });
  });
}
