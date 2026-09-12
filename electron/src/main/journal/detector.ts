// electron/src/main/journal/detector.ts
//
// git 探测器（v2.5 变更账本 Task 5，spec §5.5）：bash 账外变更的事后核对。
//
// 职责：scanUnjournaled——对每个仓跑 `git status --porcelain=v1
//      --untracked-files=all`，与账本路径集做差，产出未入账变更清单。
//      多仓发现（discoverRepos + mtime 缓存）已上提共享模块 ../git/repos.ts
//      （v2.9 多仓 git Task 1 纯搬家，detector 与 git 工具层双方引用），
//      此处 import 消费。
//
// 铁律：只读不写、绝不产生 commit；git 不可用 / 执行失败 / 输出截断一律
// degraded 空结果（无法核对绝不半真半假）。runGit 形态参照 v2.4
// sandbox/probe.ts defaultRunner（spawn + 超时 + 输出截断 + 可注入），
// 但本模块自持、不 import sandbox。
//
// 存储注入：与 revert 层同源，消费 recorder 模块单例 getJournalStore()。
// 单例是模块级状态、每进程各一份——生产每进程恰一个注入点：子进程侧
// agent/runtime-entry.ts（boot 链 setJournalStore，服务工具记账路径）与
// 主进程侧 journal/ipc.handlers.ts（registerJournalIpc 注册即注入，服务
// detector / revert / quota / IPC）。detector 只在主进程运行，store 就绪
// 由主进程注入保证——下方 fail-fast 报错的指引亦指向主进程注入点。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { discoverRepos } from '../git/repos';
import { toPosixRelPath } from '../platform/paths';
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
    throw new Error('journal store 未注入（探测器无法对账；生产：主进程 registerJournalIpc 注册即注入；测试：__setJournalStoreForTest）');
  }

  const repos = discoverRepos(workspaceDir);
  const degradedEmpty: ScanResult = { journaled: [], unjournaled: [], repos: [], degraded: true };

  const changed = new Set<string>();
  for (const repo of repos) {
    const r = await runner(['-C', repo, 'status', '--porcelain=v1', '--untracked-files=all']);
    if (r.code !== 0 || r.errCode !== null || r.truncated) return degradedEmpty;
    for (const rel of parsePorcelain(r.stdout)) {
      const abs = path.resolve(repo, rel);
      // toPosixRelPath：relative 到 workspace 根后统一 POSIX '/'（win32 反斜杠
      // 相对段与账本侧归一同口径对齐）
      const wsRel = toPosixRelPath(workspaceDir, abs);
      if (wsRel === '') continue;
      changed.add(wsRel);
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
