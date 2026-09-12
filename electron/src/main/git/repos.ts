// electron/src/main/git/repos.ts
//
// 多仓 git 发现共享模块（v2.9 多仓 git Task 1）：限定深度找 workspace 内
// 全部 git 仓（根仓 + 内层仓），结果按 workspaceDir 缓存、目录 mtime 失效。
// 自 journal/detector.ts 纯搬家上提（Task 1 语义零漂移：函数体与注释
// 逐字节保留，仅 DEFAULT_MAX_DEPTH 依共享接口加 export）——detector（账外
// 变更对账）与后续 git 工具层双方引用。
//

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// discoverRepos：多仓发现 + mtime 缓存
// ---------------------------------------------------------------------------

/** 限定深度默认 3 层（spec §5.5） */
export const DEFAULT_MAX_DEPTH = 3;

interface RepoCacheEntry {
  mtimeMs: number;
  repos: string[];
}

/** 缓存 keyed by workspaceDir + maxDepth；根目录 mtime 变化即失效（新增/删除/改名直接子条目都会 bump）。
 *  maxDepth 入键：不同深度的调用互不污染缓存结果 */
const repoCache = new Map<string, RepoCacheEntry>();

/**
 * 找 workspace 内全部 git 仓根（绝对路径，根仓在前、内层按路径字典序）。
 *
 *   - workspace 根自身是 git 仓（存在 .git 目录或文件，兼容 worktree）→ 含根
 *   - 内层仓最多找 maxDepth 层深（相对根的路径分量数）
 *   - 跳过 node_modules、隐藏目录（.git 内部天然不深入）、非目录与符号链接
 *   - workspaceDir 不存在 → 空数组（防御，不抛错）
 */
export function discoverRepos(workspaceDir: string, maxDepth: number = DEFAULT_MAX_DEPTH): string[] {
  let st: fs.Stats;
  try {
    st = fs.statSync(workspaceDir);
  } catch {
    return [];
  }
  const cacheKey = `${workspaceDir}\0${maxDepth}`;
  const cached = repoCache.get(cacheKey);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.repos;

  const repos: string[] = [];
  if (fs.existsSync(path.join(workspaceDir, '.git'))) repos.push(workspaceDir);
  walkDirs(workspaceDir, 1, maxDepth, repos);
  repoCache.set(cacheKey, { mtimeMs: st.mtimeMs, repos });
  return repos;
}

function walkDirs(dir: string, depth: number, maxDepth: number, out: string[]): void {
  if (depth > maxDepth) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    //Dirent 不追踪符号链接：isDirectory() 对 symlink 恒 false，天然不越界
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    if (fs.existsSync(path.join(full, '.git'))) out.push(full);
    walkDirs(full, depth + 1, maxDepth, out);
  }
}
