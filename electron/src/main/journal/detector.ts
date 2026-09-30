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
import fs from 'node:fs';
import path from 'node:path';
import { discoverRepos } from '../git/repos';
import { toPosixRelPath } from '../platform/paths';
import { getJournalStore, hashContent } from './recorder';

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

/** 默认 runner：spawn git + 10s 超时 SIGKILL + 1MB 输出截断（标记 truncated）。
 *  win32 shell 豁免（v2.10 spawn 审计）：git 是真 PE（git.exe），无 shell 的
 *  spawn 走 CreateProcess 直寻 .exe 可执行——不经过 .cmd shim 解析、不会
 *  ENOENT，故不加 shell 分支（对照 mcp/client.ts 的裸命令 npx 问题）。 */
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
  /** 任务起点基线归因是否可用（2026-09-29 误归因根治）：taskId 非 null 且有
   *  非降级基线（迁移 049，baseline.ts 捕获）时 true；无基线 / 降级基线
   *  （回退累计差集）或整体 degraded 时 false；taskId=null（快速会话，基线
   *  概念不适用）恒 true。UI 据此提示「累计账外状态，非本任务专属」。 */
  baselineAvailable: boolean;
}

/** 应用内部目录（workspace 根相对 POSIX）豁免清单——根治「应用产物混入未入账
 *  清单」：贴图缓存 `.momo/`（files/asset-ipc.ts 的 saveImage 落盘）与 agent
 *  草稿区 `.momo-scratch/`（dispatch 全文 / 演示产物，prompt-hints 约定）。
 *  这些是应用自身产物而非用户/agent 的工程变更，git status 报出后一律剔除。
 *  单点常量：目录本身（'.momo'）与任意子路径（'.momo/…'）两种形态都命中。 */
const APP_INTERNAL_DIR_PREFIXES = ['.momo', '.momo-scratch'] as const;

function isAppInternalPath(wsRelPath: string): boolean {
  for (const dir of APP_INTERNAL_DIR_PREFIXES) {
    if (wsRelPath === dir || wsRelPath.startsWith(`${dir}/`)) return true;
  }
  return false;
}

/** 读工作区文件当前内容并算 sha256 hex——基线捕获（baseline.ts）与扫描归因
 *  （本模块 scanUnjournaled）两侧共用的单点。不可读（已删除 / 权限等）返回
 *  null，与基线行 contentHash=null 同语义（null = 不可读 ≠ 空内容，空文件有
 *  确定 sha256）。Buffer 直读，二进制文件保真（hashContent v2.1 契约）。 */
export function hashFileOrNull(absPath: string): string | null {
  try {
    return hashContent(fs.readFileSync(absPath));
  } catch {
    return null;
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
 * 应用内部目录豁免（2026-09-29 误归因根治 B）：`.momo/` 与 `.momo-scratch/`
 * 前缀路径直接从变更集剔除——无论有无任务基线、无论 taskId 是否为 null。
 *
 * 任务起点基线差集归因（2026-09-29 误归因根治 A，迁移 049）：taskId 非 null
 * 且有非降级基线时，对每个「changed 且非 journaled」候选三分：
 *   - 不在基线 → 列入（任务期间新脏）
 *   - 在基线且当前内容 hash 与捕获时相同 → 剔除（历史脏未动——自上次 commit
 *     累计的旧脏，与本任务无关）
 *   - 在基线但 hash 不同（含当前已不可读而基线有 hash）→ 列入（任务期间
 *     再改动/删除）
 * 无基线 / 降级基线 → 回退现行累计差集，baselineAvailable=false（UI 提示
 * 「累计账外状态，非本任务专属」）。taskId=null 基线概念不适用，
 * baselineAvailable 恒 true。
 *
 * 并发边界（已知可接受）：多任务共享 worktree 时，A 任务在 B 任务捕获基线
 * 之后的写入会落进 B 的「任务期间新脏」——基线是瞬时快照，不区分写入者。
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
  const degradedEmpty: ScanResult = { journaled: [], unjournaled: [], repos: [], degraded: true, baselineAvailable: false };

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

  // 应用内部目录豁免：从副本迭代再删（Set 迭代中删除当前项虽是定义行为，
  // 副本形态更直白且不依赖读者知道该边缘规则）
  for (const p of [...changed]) {
    if (isAppInternalPath(p)) changed.delete(p);
  }

  const entries =
    taskId === null ? store.listByWorkspace(workspaceId) : store.listByTask(workspaceId, taskId);
  const journaledPaths = new Set(entries.map((e) => e.path.replace(/\\/g, '/')));

  // 基线差集归因的基线装载：taskId 非 null 且有非降级基线（meta 行存在且
  // degraded=0）才装载；否则保持 null = 全体候选走累计差集回退。
  // 键契约与捕获侧（baseline.ts）单点对齐：path = workspace 根相对 POSIX，
  // contentHash = sha256 hex（null = 捕获时不可读）
  let baseline: Map<string, string | null> | null = null;
  if (taskId !== null) {
    const meta = store.getBaselineMeta(workspaceId, taskId);
    if (meta && !meta.degraded) {
      baseline = new Map(
        store.listBaselinePaths(workspaceId, taskId).map((r) => [r.path, r.contentHash]),
      );
    }
  }

  const journaled: string[] = [];
  const unjournaled: string[] = [];
  for (const p of changed) {
    if (journaledPaths.has(p)) {
      journaled.push(p);
      continue;
    }
    if (baseline !== null && baseline.has(p)) {
      const baseHash = baseline.get(p) ?? null;
      const curHash = hashFileOrNull(path.join(workspaceDir, p));
      // 历史脏未动（含捕获时与现在都不可读）→ 剔除；hash 漂移（含基线有
      // hash 而当前已删除）→ 任务期间再改动，列入
      if (baseHash === curHash) continue;
    }
    unjournaled.push(p);
  }
  journaled.sort();
  unjournaled.sort();
  const baselineAvailable = taskId === null ? true : baseline !== null;
  return { journaled, unjournaled, repos, degraded: false, baselineAvailable };
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
