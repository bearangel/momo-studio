// electron/src/main/sandbox/toolchain-grant.ts
// 会话级 grants 布尔模型已于 2026-10-03 随通用写授权（write-grant.ts）下线——
// 本模块仅保留预置默认清单与目录展开归一（expandToolchainDirs）。
// 目录展开：字面 ~/ 前缀 + npm/pip 占位项 → 归一绝对路径（realpath 优先，失败
// resolve 兜底——目录未创建时 allow 不存在路径无害）。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';

/** 预置默认五项（spec D3）。npm/pip 为占位项，展开时探测解析 */
export const DEFAULT_TOOLCHAIN_DIRS: string[] = [
  '~/.rustup', '~/.cargo', '~/go', 'npm:global-prefix', 'pip:user',
];

/** npm 全局 prefix 探测（同步、模块级缓存一次） */
let npmPrefixCache: string | null | undefined;
function resolveNpmPrefix(): string | null {
  if (npmPrefixCache !== undefined) return npmPrefixCache;
  try {
    // 打包 GUI 启动是 launchd 最小 PATH（无 /opt/homebrew/bin 等）——npm 不可见
    // 会静默 null，授权后 npm -g 仍被拦且无信号（终审 F3）。显式补常见包管理器
    // 位置候选；PATH 重复条目无害，去重不必
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].join(path.delimiter),
    };
    npmPrefixCache = execSync('npm prefix -g', { encoding: 'utf-8', timeout: 10_000, env }).trim() || null;
  } catch (err) {
    npmPrefixCache = null; // npm 不可用：占位项跳过
    logger.warn('npm 全局 prefix 探测失败（npm 不可见？）——npm:global-prefix 目录将被跳过', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return npmPrefixCache;
}

/** pip --user base 目录推导（~/Library/Python/X.Y 或 ~/.local——平台分支） */
function resolvePipUser(home: string): string {
  return process.platform === 'darwin'
    ? path.join(home, 'Library', 'Python') // 版本号目录的父目录（宽匹配）
    : path.join(home, '.local');
}

function realpathOrResolve(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

export function expandToolchainDirs(
  raw: string[],
  home: string,
  /** npmPrefix 注入（测试用）：显式 null = 探测失败语义（占位项跳过）；缺省走真实探测 */
  opts?: { npmPrefix?: string | null },
): string[] {
  const out: string[] = [];
  for (const item of raw) {
    const s = item.trim();
    if (s === '') continue;
    let abs: string | null = null;
    if (s === 'npm:global-prefix') {
      // opts.npmPrefix 以「显式提供」判定注入（含 null=探测失败语义）——用 ??
      // 会把显式 null 回退到真实探测，破坏测试注入契约（终审 F3）
      abs = opts !== undefined && opts.npmPrefix !== undefined ? opts.npmPrefix : resolveNpmPrefix();
    } else if (s === 'pip:user') {
      abs = resolvePipUser(home);
    } else if (s === '~') {
      abs = home;
    } else if (s.startsWith('~/')) {
      abs = path.join(home, s.slice(2));
    } else {
      abs = s; // 用户清单里的绝对路径原样
    }
    if (abs === null || abs === '') continue;
    const norm = realpathOrResolve(abs);
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}
