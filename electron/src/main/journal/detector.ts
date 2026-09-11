// electron/src/main/journal/detector.ts
//
// git 探测器（v2.5 变更账本 Task 5，spec §5.5）：bash 账外变更的事后核对。
//
// 职责两件事：
//   1) discoverRepos——限定深度找 workspace 内全部 git 仓（根仓 + 内层仓），
//      结果按 workspaceDir 缓存、目录 mtime 失效（后续多仓 git spec 复用）
//   2) scanUnjournaled——对每个仓跑 `git status --porcelain=v1
//      --untracked-files=all`，与账本路径集做差，产出未入账变更清单
//
// 铁律：只读不写、绝不产生 commit；git 不可用 / 执行失败 / 输出截断一律
// degraded 空结果（无法核对绝不半真半假）。runGit 形态参照 v2.4
// sandbox/probe.ts defaultRunner（spawn + 超时 + 输出截断 + 可注入），
// 但本模块自持、不 import sandbox。
//
// 存储注入：与 revert 层同源，消费 recorder 模块单例 getJournalStore()
// （生产 boot 链 runtime-entry 已注入）。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getJournalStore } from './recorder';

/** 单次 git 命令执行结果。errCode 承载 spawn error event 的底层错误码
 *  （'ENOENT' = 本机无 git），避免从 stderr 字符串猜测 */
export interface GitRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  errCode: string | null;
  /** 输出是否触顶截断——截断的 porcelain 不完整，扫描方必须降级 */
  truncated: boolean;
}

/** 可注入的 git 执行器（测试注入 fake；生产 defaultGitRunner） */
export type GitRunner = (args: string[]) => Promise<GitRunResult>;

/** 默认 runner：spawn git + 10s 超时 SIGKILL + 1MB 输出截断（标记 truncated） */
export const defaultGitRunner: GitRunner = (args) =>
  new Promise((resolve) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const CAP = 1_048_576;
    let out = '';
    let err = '';
    let outTruncated = false;
    let errTruncated = false;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }, 10_000);
    child.stdout?.on('data', (c: Buffer) => {
      const s = c.toString('utf-8');
      if (out.length >= CAP) {
        outTruncated = true;
        return;
      }
      if (out.length + s.length > CAP) outTruncated = true;
      out += s.slice(0, CAP - out.length);
    });
    child.stderr?.on('data', (c: Buffer) => {
      const s = c.toString('utf-8');
      if (err.length >= CAP) {
        errTruncated = true;
        return;
      }
      if (err.length + s.length > CAP) errTruncated = true;
      err += s.slice(0, CAP - err.length);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err, errCode: null, truncated: outTruncated });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      const code = (e as NodeJS.ErrnoException).code;
      resolve({
        code: null,
        stdout: out,
        stderr: e.message,
        errCode: code ?? 'SPAWN_ERROR',
        truncated: outTruncated || errTruncated,
      });
    });
  });

/** 探测结果：journaled/unjournaled 均为 git 变更路径子集（workspace 根相对、
 *  POSIX 分隔符、字典序）；degraded=true 时三列表恒空 */
export interface ScanResult {
  journaled: string[];
  unjournaled: string[];
  /** 发现的仓根绝对路径（workspace 根仓在前） */
  repos: string[];
  degraded: boolean;
}

// ---------------------------------------------------------------------------
// discoverRepos：多仓发现 + mtime 缓存
// ---------------------------------------------------------------------------

/** 限定深度默认 3 层（spec §5.5） */
const DEFAULT_MAX_DEPTH = 3;

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

// ---------------------------------------------------------------------------
// scanUnjournaled：账外变更对账
// ---------------------------------------------------------------------------

/**
 * 对 workspace 内每个发现的仓跑 git status，与账本路径集做差。
 *
 * journaled 基线（设计裁定）：
 *   - taskId 非 null → 该任务组条目（listByTask）
 *   - taskId null（快速会话）→ 全 workspace 条目并集（listByWorkspace）——
 *     快速会话无任务边界，全量基线更诚实：账本里出现过的路径不算「账外」
 *
 * 路径对齐：git 侧 relativize 到 workspace 根后统一 POSIX '/'；账本侧
 * 反斜杠归一（T2 review 预警的 Windows 对齐问题在此收口）。
 *
 * 降级（degraded=true + 空结果）：git ENOENT / 任意仓执行非零退出 / 输出截断。
 * store 未注入属接线缺陷 → fail-fast 抛错，不静默降级。
 */
export async function scanUnjournaled(
  workspaceId: string,
  workspaceDir: string,
  taskId: string | null,
  opts?: { runner?: GitRunner },
): Promise<ScanResult> {
  const runner = opts?.runner ?? defaultGitRunner;
  const store = getJournalStore();
  if (!store) {
    throw new Error('journal store 未注入（探测器无法对账；生产：boot 链 setJournalStore；测试：__setJournalStoreForTest）');
  }

  const repos = discoverRepos(workspaceDir);
  const degradedEmpty: ScanResult = { journaled: [], unjournaled: [], repos: [], degraded: true };

  const changed = new Set<string>();
  for (const repo of repos) {
    const r = await runner(['-C', repo, 'status', '--porcelain=v1', '--untracked-files=all']);
    if (r.code !== 0 || r.errCode !== null || r.truncated) return degradedEmpty;
    for (const rel of parsePorcelain(r.stdout)) {
      const abs = path.resolve(repo, rel);
      const wsRel = path.relative(workspaceDir, abs);
      if (wsRel === '') continue;
      changed.add(wsRel.split(path.sep).join('/'));
    }
  }

  const entries =
    taskId === null ? store.listByWorkspace(workspaceId) : store.listByTask(workspaceId, taskId);
  const journaledPaths = new Set(entries.map((e) => e.path.replace(/\\/g, '/')));

  const journaled: string[] = [];
  const unjournaled: string[] = [];
  for (const p of changed) {
    if (journaledPaths.has(p)) journaled.push(p);
    else unjournaled.push(p);
  }
  journaled.sort();
  unjournaled.sort();
  return { journaled, unjournaled, repos, degraded: false };
}

/**
 * 解析 porcelain v1 输出 → 相对 repo 根的路径列表。
 * 行形态 `XY <path>`（X=index 列、Y=worktree 列）：
 *   - rename/copy（R/C）行带 `旧 -> 新` 尾巴，取新路径（现行存在位）
 *   - 非_ascii 路径被引号包裹 + 八进制转义（core.quotePath 默认），需还原
 */
export function parsePorcelain(out: string): string[] {
  const paths: string[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.length < 4) continue;
    let p = line.slice(3);
    const x = line.charAt(0);
    const y = line.charAt(1);
    if ((x === 'R' || x === 'C' || y === 'R' || y === 'C') && p.includes(' -> ')) {
      p = p.slice(p.lastIndexOf(' -> ') + 4);
    }
    paths.push(unquotePath(p));
  }
  return paths;
}

/** 引号路径还原：剥离首尾 `"`、还原 `\"` `\\` 与 `\NNN` 八进制字节转义。
 *  八进制转义按字节还原后经 latin1→utf-8 重组（git 对非 ASCII 的转义形态）；
 *  仅出现过八进制转义才重组，避免污染未经转义的原始 UTF-8 路径 */
function unquotePath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const inner = p.slice(1, -1);
  let acc = '';
  let sawOctal = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner.charAt(i);
    if (ch !== '\\') {
      acc += ch;
      continue;
    }
    const next = inner.charAt(i + 1);
    if (next === '"' || next === '\\') {
      acc += next;
      i++;
      continue;
    }
    const oct = inner.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(oct)) {
      acc += String.fromCharCode(parseInt(oct, 8));
      sawOctal = true;
      i += 3;
      continue;
    }
    acc += next;
    i++;
  }
  return sawOctal ? Buffer.from(acc, 'latin1').toString('utf-8') : acc;
}
