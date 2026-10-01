// electron/src/main/sandbox/toolchain-grant.ts
// 会话 grant 表（spec §4）：「本会话允许」置位，app 运行期有效（重启自然失效）。
// 非阻塞——与已下线的阻塞 sessionGrants 不同物（修订 B 教训：阻塞等待必超时）。
// 目录展开：字面 ~/ 前缀 + npm/pip 占位项 → 归一绝对路径（realpath 优先，失败
// resolve 兜底——目录未创建时 allow 不存在路径无害）。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 预置默认五项（spec D3）。npm/pip 为占位项，展开时探测解析 */
export const DEFAULT_TOOLCHAIN_DIRS: string[] = [
  '~/.rustup', '~/.cargo', '~/go', 'npm:global-prefix', 'pip:user',
];

const grants = new Set<string>();

export function grantToolchainWorkspace(workspaceId: string): void {
  grants.add(workspaceId);
}

export function hasToolchainGrant(workspaceId: string): boolean {
  return grants.has(workspaceId);
}

export function __clearToolchainGrantsForTest(): void {
  grants.clear();
}

/** npm 全局 prefix 探测（同步、模块级缓存一次） */
let npmPrefixCache: string | null | undefined;
function resolveNpmPrefix(): string | null {
  if (npmPrefixCache !== undefined) return npmPrefixCache;
  try {
    npmPrefixCache = execSync('npm prefix -g', { encoding: 'utf-8', timeout: 10_000 }).trim() || null;
  } catch {
    npmPrefixCache = null; // npm 不可用：占位项静默跳过
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
  opts?: { npmPrefix?: string },
): string[] {
  const out: string[] = [];
  for (const item of raw) {
    const s = item.trim();
    if (s === '') continue;
    let abs: string | null = null;
    if (s === 'npm:global-prefix') {
      abs = opts?.npmPrefix ?? resolveNpmPrefix();
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
