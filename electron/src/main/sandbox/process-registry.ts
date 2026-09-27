// electron/src/main/sandbox/process-registry.ts
//
// 沙箱进程组生命周期登记（2026-09-25 立项：任务终态收割 + 存量清扫）。
//
// 背景（主机验收实测）：bash 工具里 `(npm start &)` 的后台子进程在 bash -c
// 正常退出后孤儿化（reparent 到 launchd）——脱离沙箱生命周期，后续回合在
// 沙箱内 kill 被 seatbelt 拒（跨进程组），幽灵端口跨任务累积（实测同一台
// 机器上 3000/3100 分别被当天与 12 天前的泄漏进程占用）。
//
// 契约：任务（回合）拥有其进程组——
//   - 回合内跨工具调用可存活（dev server 起完下一条命令 curl 的既有合法模式）
//   - finalizeActiveTask / destroy 一到，全组 SIGKILL（主进程侧执行，
//     结构性免疫 seatbelt 拒杀）
//   - bash 工具 spawn 后经 child IPC 上报 pgid（runtime 子进程执行工具，
//     登记必须落主进程——回合收尾钩子在主进程）
//
// 存量清扫：boot 时（migrations 后、agent runtime 起）扫全系统孤儿进程——
//   - Linux：环境带 MOMO_STUDIO_AGENT=1（buildSandboxEnv 注入、后代继承；
//     /proc/<pid>/environ 精确可读）
//   - darwin：新版 macOS 对任意进程的环境枚举已被 SIP 封死（ps -E /
//     launchctl procinfo 均不可见，2026-09-25 实测）——改用「孤儿（ppid=1）
//     + cwd 落在 workspace 目录」（目录清单由调用方传入；bash 工具子进程
//     cwd 恒为 workspaceDir。用户活跃终端/编辑器进程 ppid≠1，天然豁免）
//   - win32：no-op（无跨进程环境枚举，v1 放弃存量清扫——增量收割已覆盖）
// boot 时刻本 app 尚未跑任何 bash 工具，命中者必为历史泄漏。
//
// pgid 复用缓解：收割前先 kill(-pgid, 0) 探测组是否仍有成员——空组（ESRCH）
// 跳过，不做盲杀。

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { logger } from '../logger';

/** streamSessionId → 该回合登记的进程组/进程 id 集合 */
const groupsByStream = new Map<string, Set<number>>();

/**
 * 用户保留的进程组（process_keep，2026-09-26）：pgid → 归属信息。
 * 生命周期 = app 会话内（模块态，不持久化）——boot 清扫一律清（防跨重启累积）。
 * 授权口径：同 workspace 的后续回合可 process_kill 关闭。
 */
export interface KeptGroup {
  pgid: number;
  workspaceId: string;
  /** 保留时的端口备注（process_list 展示用；可选） */
  port?: number;
  /** 发起保留的回合（溯源） */
  streamSessionId: string;
  keptAt: number;
}
const keptGroups = new Map<number, KeptGroup>();

/** 每 workspace 保留上限（防泄漏堆积——超出拒绝，agent 收明确报错） */
export const KEEP_LIMIT_PER_WORKSPACE = 5;

/** 测试用：窥视保留表（只读快照） */
export function __keptForTest(): Map<number, KeptGroup> {
  return new Map(keptGroups);
}

/** bash 工具 spawn 成功后登记（POSIX 下 pgid = detached spawn 的 child.pid） */
export function registerProcessGroup(streamSessionId: string, pidOrPgid: number): void {
  let set = groupsByStream.get(streamSessionId);
  if (!set) {
    set = new Set();
    groupsByStream.set(streamSessionId, set);
  }
  set.add(pidOrPgid);
}

/**
 * 收割某回合登记的全部进程组（SIGKILL best-effort）。
 * 幂等：收割后清条目；重复调用 no-op。kept 组不在此表（keep 时已移出）——
 * 天然豁免回合收割。
 */
export function reapProcessGroups(streamSessionId: string): void {
  const set = groupsByStream.get(streamSessionId);
  if (!set) return;
  groupsByStream.delete(streamSessionId);
  for (const id of set) {
    if (process.platform === 'win32') {
      // win32 无进程组：按 pid 树杀（与 shell-tools 超时路径同款）
      spawn('taskkill', ['/PID', String(id), '/T', '/F'], { stdio: 'ignore' });
      continue;
    }
    try {
      // 探测组是否仍有成员（pgid 复用窗口缓解——空组跳过不盲杀）
      process.kill(-id, 0);
    } catch {
      continue; // ESRCH：组已消亡
    }
    try {
      process.kill(-id, 'SIGKILL');
    } catch (err) {
      // EPERM 等残余失败：warn 后继续（不阻断其余组收割）
      logger.warn('进程组收割失败（继续其余组）', {
        pgid: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * runtime 子进程上报消息的消费入口（runtime-spawner messageHandler 调用）。
 * 载荷形状不符时返回 false（消息原样落回其它分支）。
 */
export function registerFromChildMsg(msg: unknown): boolean {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as { type?: unknown; streamSessionId?: unknown; pgid?: unknown };
  if (m.type !== 'proc-group:register') return false;
  if (typeof m.streamSessionId !== 'string' || typeof m.pgid !== 'number') return false;
  registerProcessGroup(m.streamSessionId, m.pgid);
  return true;
}

/** 环境标记：buildSandboxEnv 注入、沙箱后代继承——Linux 存量泄漏的身份指纹 */
const TAG = 'MOMO_STUDIO_AGENT=1';

/** Linux：读候选进程环境指纹（/proc 精确可读）；darwin 环境被 SIP 封死不适用 */
function envHasTag(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, 'utf-8').includes(TAG);
  } catch {
    return false;
  }
}

/** darwin：分块批量读候选进程的 cwd（lsof 单次往返），返回 pid → cwd */
function readCwds(pids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  // 分块：候选数百级时单次 lsof 会超时/拒查系统进程——每块独立容错
  const CHUNK = 100;
  for (let i = 0; i < pids.length; i += CHUNK) {
    const chunk = pids.slice(i, i + CHUNK);
    try {
      const text = execFileSync(
        'lsof',
        ['-a', '-p', chunk.join(','), '-d', 'cwd', '-Fn'],
        { encoding: 'utf-8', timeout: 10_000 },
      );
      let curPid: number | null = null;
      for (const line of text.split('\n')) {
        if (line.startsWith('p')) curPid = Number(line.slice(1));
        else if (line.startsWith('n') && curPid !== null) {
          out.set(curPid, line.slice(1));
          curPid = null;
        }
      }
    } catch {
      // 本块失败（候选退出/权限）——保留已解析部分，继续其余块
    }
  }
  return out;
}

function isInsideDir(cwd: string, roots: string[]): boolean {
  return roots.some((r) => cwd === r || cwd.startsWith(`${r}/`) || cwd.startsWith(`${r}\\`));
}

/** ps 快照：pid → ppid/pgid/uid/启动时刻（lstart 解析失败记 0——darwin 时间窗过滤会排除 0） */
function psSnapshot(): {
  ppidOf: Map<number, number>;
  pgidOf: Map<number, number>;
  uidOf: Map<number, number>;
  startAt: Map<number, number>;
} {
  const ppidOf = new Map<number, number>();
  const pgidOf = new Map<number, number>();
  const uidOf = new Map<number, number>();
  const startAt = new Map<number, number>();
  let output: string;
  try {
    output = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,uid=,lstart='], { encoding: 'utf-8', timeout: 5000 });
  } catch {
    return { ppidOf, pgidOf, uidOf, startAt };
  }
  for (const line of output.split('\n')) {
    // 形如 "  123     1   120   501 Fri Sep 25 22:47:39 2026"
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m || !m[1] || !m[2] || !m[3] || !m[4] || !m[5]) continue;
    const pid = Number(m[1]);
    ppidOf.set(pid, Number(m[2]));
    pgidOf.set(pid, Number(m[3]));
    uidOf.set(pid, Number(m[4]));
    const ts = Date.parse(m[5]);
    startAt.set(pid, Number.isNaN(ts) ? 0 : ts);
  }
  return { ppidOf, pgidOf, uidOf, startAt };
}

/** 保留组豁免判定：pid 属于任一 kept 组则清扫跳过（用户保留的服务不是逃逸者） */
function isKeptPid(pid: number, pgidOf: Map<number, number>): boolean {
  const pgid = pgidOf.get(pid);
  return pgid !== undefined && keptGroups.has(pgid);
}

/** 当前 app 进程树白名单（自 process.pid 沿 ppid 上溯的祖先链） */
function ownAncestry(ppidOf: Map<number, number>): Set<number> {
  const ownTree = new Set<number>();
  let cur: number | undefined = process.pid;
  while (cur !== undefined && !ownTree.has(cur)) {
    ownTree.add(cur);
    cur = ppidOf.get(cur);
  }
  return ownTree;
}

/**
 * 回合逃逸清扫（2026-09-25 缺口修复）：setsid / double-fork 守护化进程脱离
 * 注册进程组，kill(-pgid) 打不着——回合收尾在组杀后补一轮孤儿窗扫描，
 * 识别口径与 boot 清扫一致（Linux 环境标记；darwin ppid=1 + cwd ∈ workspace）
 * 并加时间窗收紧：只杀「本回合开始之后启动」的孤儿，不动历史孤儿（boot 的地盘）。
 */
export function sweepRoundEscapes(
  workspaceDirs: string[],
  startedAfterMs: number,
): { scanned: number; killed: number } {
  if (process.platform === 'win32') return { scanned: 0, killed: 0 };
  const { ppidOf, pgidOf, uidOf, startAt } = psSnapshot();
  const myUid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const ownTree = ownAncestry(ppidOf);

  const darwinCandidates: number[] = [];
  let scanned = 0;
  let killed = 0;
  for (const pid of ppidOf.keys()) {
    if (ownTree.has(pid) || ppidOf.get(pid) !== 1 || uidOf.get(pid) !== myUid) continue;
    if (isKeptPid(pid, pgidOf)) continue; // 用户保留的服务不是逃逸者
    scanned += 1;
    if (process.platform === 'linux') {
      if (envHasTag(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
          killed += 1;
        } catch {
          // 已退出——跳过
        }
      }
      continue;
    }
    // darwin：时间窗 + cwd 双条件延迟到 lsof 批查后判定。lstart 仅秒级精度
    //（与毫秒锚点同秒启动的进程会被截断成「更早」）——窗底回退 1.5s 余量；
    // 语义无恶化：窗底附近的多杀目标（workspace 孤儿）本就是 boot 清扫的无窗口径
    const windowFloor = startedAfterMs - 1500;
    const started = startAt.get(pid) ?? 0;
    if (started >= windowFloor) darwinCandidates.push(pid);
  }

  if (process.platform === 'darwin' && darwinCandidates.length > 0) {
    const cwds = readCwds(darwinCandidates);
    const resolvedRoots = workspaceDirs.map((r) => {
      try {
        return fs.realpathSync(r);
      } catch {
        return r;
      }
    });
    for (const pid of darwinCandidates) {
      const cwd = cwds.get(pid);
      if (cwd === undefined || !isInsideDir(cwd, resolvedRoots)) continue;
      try {
        process.kill(pid, 'SIGKILL');
        killed += 1;
      } catch {
        // 已退出——跳过
      }
    }
  }
  return { scanned, killed };
}

/**
 * boot 清扫存量沙箱孤儿。
 * 识别口径：ppid === 1（孤儿化）且不属于当前 app 进程树，再加平台指纹——
 * Linux 查环境标记；darwin 查 cwd ∈ workspaceDirs。
 * 返回击杀数（boot 日志用）。
 */
export function sweepTaggedOrphans(workspaceDirs: string[] = []): { scanned: number; killed: number } {
  if (process.platform === 'win32') return { scanned: 0, killed: 0 };
  const { ppidOf, pgidOf, uidOf } = psSnapshot();
  const myUid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const ownTree = ownAncestry(ppidOf);

  const orphanCandidates: number[] = [];
  let scanned = 0;
  let killed = 0;
  for (const pid of ppidOf.keys()) {
    if (ownTree.has(pid) || ppidOf.get(pid) !== 1 || uidOf.get(pid) !== myUid) continue;
    if (isKeptPid(pid, pgidOf)) continue; // boot 时 kept 表恒空（模块态）；防御性豁免

    scanned += 1;
    if (process.platform === 'linux') {
      if (envHasTag(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
          killed += 1;
        } catch {
          // 已退出——跳过
        }
      }
      continue;
    }
    orphanCandidates.push(pid);
  }

  // darwin：cwd ∈ workspace 目录（/tmp 等软链场景——lsof 返回已解析路径，
  // 根目录须 realpath 归一后比对，否则 /tmp ≠ /private/tmp 恒失配）
  if (process.platform === 'darwin' && orphanCandidates.length > 0) {
    const cwds = readCwds(orphanCandidates);
    const resolvedRoots = workspaceDirs.map((r) => {
      try {
        return fs.realpathSync(r);
      } catch {
        return r;
      }
    });
    for (const pid of orphanCandidates) {
      const cwd = cwds.get(pid);
      if (cwd === undefined || !isInsideDir(cwd, resolvedRoots)) continue;
      try {
        process.kill(pid, 'SIGKILL');
        killed += 1;
      } catch {
        // 已退出——跳过
      }
    }
  }
  return { scanned, killed };
}

/** 测试用：窥视登记表（只读快照） */
export function __registeredForTest(): Map<string, Set<number>> {
  return new Map(Array.from(groupsByStream, ([k, v]) => [k, new Set(v)]));
}

/** 测试用：清空登记表 */
export function __clearRegistryForTest(): void {
  groupsByStream.clear();
}

// ── 回合进程管理（process_kill / process_list 工具的主进程侧支撑）──
// 背景：seatbelt 的 signal 过滤器无法表达「自身进程组」（pgrp 变体语法实测
// 全非法，2026-09-25），沙箱内 agent 连自己启动的 dev server 都杀不掉。
// 方案：不放宽沙箱——工具经 IPC 请求主进程代杀，授权口径 = 该回合登记的
// 进程组（registerProcessGroup 表）。沙箱外执行 + 精确授权 + 跨平台。

/** 回合进程条目（process_list 返回形状） */
export interface RoundProcessInfo {
  pgid: number;
  /** 组内存活成员（pid + 命令行）——全灭时为空数组 */
  members: Array<{ pid: number; command: string }>;
  /** 用户保留标记（process_keep 产物——跨回合存活） */
  kept?: boolean;
  /** 保留时的端口备注（kept 组才有） */
  port?: number;
}

/** ps 快照：pid → pgid 与命令行（成员清点用；失败返回空表） */
function psMembers(): Map<number, { pgid: number; command: string }> {
  const out = new Map<number, { pgid: number; command: string }>();
  try {
    const text = execFileSync('ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf-8', timeout: 5000 });
    for (const line of text.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (m && m[1] && m[2] && m[3]) out.set(Number(m[1]), { pgid: Number(m[2]), command: m[3].trim() });
    }
  } catch {
    // ps 失败——返回已解析部分
  }
  return out;
}

/**
 * 列出某回合登记的进程组及存活成员（process_list 工具支撑）。
 * 顺带清掉全灭的登记条目（防表无限增长）。
 * 附带 workspaceId 时并列返回该 workspace 的用户保留组（标记 kept）。
 */
export function listRoundProcesses(
  streamSessionId: string,
  workspaceId?: string,
): RoundProcessInfo[] {
  const pgids = groupsByStream.get(streamSessionId);
  const out: RoundProcessInfo[] = [];
  if (pgids && pgids.size > 0) {
    const snapshot = psMembers();
    for (const pgid of [...pgids]) {
      const members = [...snapshot.entries()]
        .filter(([, v]) => v.pgid === pgid)
        .map(([pid, v]) => ({ pid, command: v.command }));
      if (members.length === 0) {
        pgids.delete(pgid); // 组已全灭——登记条目出清
        continue;
      }
      out.push({ pgid, members });
    }
    if (pgids.size === 0) groupsByStream.delete(streamSessionId);
  }
  if (workspaceId !== undefined) {
    const snapshot = out.length > 0 ? null : psMembers();
    for (const kept of keptGroups.values()) {
      if (kept.workspaceId !== workspaceId) continue;
      const snap = snapshot ?? psMembers();
      const members = [...snap.entries()]
        .filter(([, v]) => v.pgid === kept.pgid)
        .map(([pid, v]) => ({ pid, command: v.command }));
      if (members.length === 0) {
        keptGroups.delete(kept.pgid); // 服务已自行退出——保留条目出清
        continue;
      }
      out.push({ pgid: kept.pgid, members, kept: true, port: kept.port });
    }
  }
  return out;
}

/** killRoundProcess 结果 */
export interface KillRoundResult {
  /** 击杀的进程组数 */
  killedGroups: number;
  /** 命中但不在授权集内被拒绝的目标（pid 或端口描述） */
  refused: string[];
  error?: string;
}

/**
 * 保留本回合进程组（process_keep 支撑）：目标解析与 kill 同源（port/pid/pgid
 * 三选一，须属本回合登记组）；标记后移出回合表——豁免收割与逃逸补扫。
 * 上限：每 workspace ≤ KEEP_LIMIT_PER_WORKSPACE；生命周期 = app 会话内
 * （boot 清扫一律清，防跨重启累积）。
 */
export function keepRoundProcess(
  streamSessionId: string,
  workspaceId: string,
  target: { pgid?: number; pid?: number; port?: number },
): { ok: true; pgid: number; port?: number } | { ok: false; error: string } {
  const authorized = groupsByStream.get(streamSessionId);
  if (!authorized || authorized.size === 0) {
    return { ok: false, error: '本回合无可保留的后台进程（先用 bash 后台启动服务）' };
  }
  const snapshot = psMembers();
  const resolvePgid = (): number | null => {
    if (target.pgid !== undefined) return authorized.has(target.pgid) ? target.pgid : null;
    const pids: number[] = [];
    if (target.pid !== undefined) pids.push(target.pid);
    if (target.port !== undefined) {
      try {
        const text = execFileSync('lsof', ['-tiTCP:' + target.port, '-sTCP:LISTEN'], { encoding: 'utf-8', timeout: 5000 });
        for (const line of text.split('\n')) {
          const p = Number(line.trim());
          if (Number.isInteger(p) && p > 0) pids.push(p);
        }
      } catch {
        // 无监听
      }
    }
    for (const pid of pids) {
      const pgid = snapshot.get(pid)?.pgid ?? null;
      if (pgid !== null && authorized.has(pgid)) return pgid;
    }
    return null;
  };
  const pgid = resolvePgid();
  if (pgid === null) {
    return { ok: false, error: '目标进程不属于本回合启动的进程（keep 仅限自己启动的服务）' };
  }
  const keptCount = [...keptGroups.values()].filter((k) => k.workspaceId === workspaceId).length;
  if (keptCount >= KEEP_LIMIT_PER_WORKSPACE) {
    return { ok: false, error: `本工作空间保留服务已达上限 ${KEEP_LIMIT_PER_WORKSPACE}——先用 process_kill 关闭不再需要的` };
  }
  // 移出回合表（豁免收割/逃逸补扫）+ 记入保留表
  authorized.delete(pgid);
  if (authorized.size === 0) groupsByStream.delete(streamSessionId);
  keptGroups.set(pgid, { pgid, workspaceId, port: target.port, streamSessionId, keptAt: Date.now() });
  return { ok: true, pgid, ...(target.port !== undefined ? { port: target.port } : {}) };
}

/**
 * 授权击杀（process_kill 工具支撑）：允许杀「该回合登记的进程组」+
 * 「同 workspace 的用户保留组」。target 三选一：pgid 直杀整组 / pid 归组后
 * 杀组 / port 经 lsof 找监听 pid 归组杀（agent 最自然的按端口关服务）。
 */
export function killRoundProcess(
  streamSessionId: string,
  target: { pgid?: number; pid?: number; port?: number },
  workspaceId?: string,
): KillRoundResult {
  const authorized = groupsByStream.get(streamSessionId) ?? new Set<number>();
  const snapshot = psMembers();
  const pgidOfPid = (pid: number): number | null => snapshot.get(pid)?.pgid ?? null;
  /** 授权判定：本回合组 ∪ 同 workspace 保留组 */
  const isAuthorized = (pgid: number): boolean => {
    if (authorized.has(pgid)) return true;
    const kept = keptGroups.get(pgid);
    return kept !== undefined && workspaceId !== undefined && kept.workspaceId === workspaceId;
  };

  // 解析目标 → 待杀 pgid 集（保持授权校验统一在 pgid 层）
  const wanted = new Set<number>();
  const refused: string[] = [];
  if (target.pgid !== undefined) {
    if (isAuthorized(target.pgid)) wanted.add(target.pgid);
    else refused.push(`pgid ${target.pgid} 不属于本回合进程或本工作空间保留服务`);
  }
  const pidTargets: number[] = [];
  if (target.pid !== undefined) pidTargets.push(target.pid);
  if (target.port !== undefined) {
    // 端口 → 监听 pid（lsof；无监听 = 无事可做，不算错）
    try {
      const text = execFileSync('lsof', ['-tiTCP:' + target.port, '-sTCP:LISTEN'], { encoding: 'utf-8', timeout: 5000 });
      for (const line of text.split('\n')) {
        const p = Number(line.trim());
        if (Number.isInteger(p) && p > 0) pidTargets.push(p);
      }
    } catch {
      // lsof 失败（无监听进程时 exit 1）——无目标
    }
  }
  for (const pid of pidTargets) {
    const pgid = pgidOfPid(pid);
    if (pgid === null) {
      refused.push(`pid ${pid} 不存在`);
      continue;
    }
    if (isAuthorized(pgid)) wanted.add(pgid);
    else refused.push(`pid ${pid}（pgid ${pgid}）不属于本回合进程或本工作空间保留服务`);
  }

  let killedGroups = 0;
  for (const pgid of wanted) {
    try {
      if (process.platform === 'win32') {
        // win32 无进程组——组内成员逐个 taskkill /T
        for (const [pid, v] of snapshot) {
          if (v.pgid !== pgid) continue;
          spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        }
      } else {
        process.kill(-pgid, 'SIGKILL');
      }
      killedGroups += 1;
      authorized.delete(pgid);
      keptGroups.delete(pgid); // 保留组被关闭——表同步出清
    } catch {
      // 组已退出——不算失败
    }
  }
  return { killedGroups, refused };
}
