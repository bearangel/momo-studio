// electron/src/main/journal/revert.ts
//
// 撤销核心（v2.5 变更账本与撤销，Task 3）：hash 守卫 + 逆序链 + 对称记账。
// 2026-09-28 变更回滚重构（spec 2026-09-28-journal-rollback-redesign.md §5.1）：
// 「读当前 + hash 判定 → 分支」抽成纯决策函数 classify，执行路径退化为解释器；
// 新增 previewRevert 干跑通道（classify-only + 链式虚拟状态模拟，不写盘不记账）。
//
// 语义（v2.5 spec §5.4）：
//   - 按 path 分组、组内 created_at 逆序（LIFO）逐条执行——实现为全局 created_at
//     DESC 遍历：每条 path 的组内相对序天然逆序，组间按最新条目优先（rename 跨组
//     场景先移回名字再撤旧内容，天然正确）
//   - hash(当前) == 条目 after 语义 → 正常撤回；不等 → 漂移，仅 force 写回
//     （rename 内容不变，after 语义即 beforeHash）
//   - 文件不存在 → create 条目 no-op；其余按 before 内容重建（restored-missing）
//   - 孤儿条目（记账后写盘前中断，hash(当前)==before）→ no-op（崩溃一致性，
//     spec 明示的安全方向）
//   - 每次实际写回前对称记账（逆 op，toolName='undo'，write-ahead：条目先于文件
//     变更落库；写回失败留下的孤儿对称条目由 no-op 守卫兜底）
//   - 组内遇 failed 停该文件（同 path 后续条目不执行、不产出 outcome），其他
//     path 组继续；skipped-diverged 不停组（每条独立守卫，由组合层决定是否续撤）
//
// 预检语义（rollback spec §5.1 + D3）：previewRevert 与执行序完全一致（全局
// created_at DESC），同 path 条目以虚拟文件状态判定——撤回成功虚拟态 = 该条
// before blob；拦截/no-op 不改变虚拟态；rename 迁移 from/to 两侧虚拟态。预测
// 恒按 force=false（D2），执行时守卫仍生效（预检仅是呈现优化）。
//
// store 经 recorder 模块单例获取（与记账同一注入源）；opts.recorderCtx 缺省时
// 跳过对称记账（UI 直调场景由 IPC 层补 ctx）。文件操作全部走 node:fs/promises，
// 路径 join 相对 workspaceDir（条目 path 是 workspace 相对路径）。

import fs from 'node:fs/promises';
import path from 'node:path';
import { isInsideDir, PATH_SEMANTICS_WIN32 } from '../platform/paths';
import { getJournalStore, hashContent, recordChange } from './recorder';
import type { RecordCtx } from './recorder';
import type { JournalStore } from './store';
import type { JournalEntry } from './types';

/** 单条撤销的执行结果（UI 逐文件呈现，不静默） */
export type RevertOutcome = {
  id: string;
  path: string;
  result: 'reverted' | 'skipped-diverged' | 'restored-missing' | 'no-op' | 'failed';
  detail?: string;
};

export interface RevertOpts {
  /** hash 漂移时强制写回（UI 需明确警告「将丢失其后全部变更」） */
  force?: boolean;
  /** 对称记账上下文；缺省则跳过对称记账 */
  recorderCtx?: RecordCtx;
}

/** 对称记账规格：内容来源由执行侧解析（current=当前字节，beforeBlob=before
 *  内容 blob——writeAhead 语义：先记账后动文件） */
interface InverseSpec {
  op: 'create' | 'modify' | 'delete' | 'rename';
  relPath: string;
  beforeFrom: 'current' | 'none';
  afterFrom: 'beforeBlob' | 'none';
  /** 仅 rename 逆：现路径（移回前的位置） */
  oldPath?: string;
}

/** 纯决策产物：单条撤销的计划（无 IO；执行与预检共用，防两路分支漂移）。
 *  动作与对称记账规格同体携带（kind 判别即得非空 inverse——结构上排除
 *  「有文件动作却无记账规格」的脏计划） */
interface RevertPlan {
  outcome: RevertOutcome;
  action:
    | { kind: 'none' }
    /** 删除该相对路径文件（create 的逆） */
    | { kind: 'deleteFile'; relPath: string; inverse: InverseSpec }
    /** 写回 before blob 到该相对路径（rename 双侧缺失重建时为 oldPath） */
    | { kind: 'writeBefore'; relPath: string; inverse: InverseSpec }
    /** rename 的逆：from（现路径）移回 to（旧路径） */
    | { kind: 'moveBack'; fromRel: string; toRel: string; inverse: InverseSpec };
}

/**
 * 撤销一批账本条目。执行序 = 全局 created_at 逆序（等价 per-path 分组 LIFO +
 * 组间最新优先）；返回按执行序排列的逐条结果。
 */
export async function revertEntries(
  workspaceId: string,
  workspaceDir: string,
  ids: string[],
  opts: RevertOpts = {},
): Promise<RevertOutcome[]> {
  if (ids.length === 0) return [];
  const store = getJournalStore();
  if (!store) {
    throw new Error(
      'journal store 未注入（生产：boot 链调用 setJournalStore；测试：__setJournalStoreForTest）',
    );
  }

  const entries = store.listByIds(workspaceId, ids);
  const foundIds = new Set(entries.map((e) => e.id));

  const ordered = [...entries].sort((x, y) => {
    if (y.createdAt !== x.createdAt) return y.createdAt - x.createdAt;
    // createdAt 撞车兜底（recorder 单调时钟下不会发生）：镜像 store 的 id 升序
    if (x.id !== y.id) return x.id > y.id ? -1 : 1;
    return 0;
  });

  const outcomes: RevertOutcome[] = [];
  const stoppedPaths = new Set<string>();
  for (const entry of ordered) {
    if (stoppedPaths.has(entry.path)) continue;
    const outcome = await revertOne(store, workspaceId, workspaceDir, entry, opts);
    outcomes.push(outcome);
    if (outcome.result === 'failed') stoppedPaths.add(entry.path);
  }

  // ids 中查不到的条目（可能已被配额清理）如实汇报，不静默吞掉
  for (const id of ids) {
    if (!foundIds.has(id)) {
      outcomes.push({ id, path: '', result: 'no-op', detail: '条目不存在（可能已被配额清理）' });
    }
  }
  return outcomes;
}

/**
 * 干跑预检（spec 2026-09-28 §5.1）：与 revertEntries 同序逐条 classify，但只
 * 维护链式虚拟文件状态、不写盘不记账。预测恒按 force=false（D2）。
 */
export async function previewRevert(
  workspaceId: string,
  workspaceDir: string,
  ids: string[],
): Promise<RevertOutcome[]> {
  if (ids.length === 0) return [];
  const store = getJournalStore();
  if (!store) {
    throw new Error(
      'journal store 未注入（生产：boot 链调用 setJournalStore；测试：__setJournalStoreForTest）',
    );
  }

  const entries = store.listByIds(workspaceId, ids);
  const foundIds = new Set(entries.map((e) => e.id));
  const ordered = [...entries].sort((x, y) => {
    if (y.createdAt !== x.createdAt) return y.createdAt - x.createdAt;
    if (x.id !== y.id) return x.id > y.id ? -1 : 1;
    return 0;
  });

  // 链式虚拟状态：rel path → 虚拟字节（null = 虚拟不存在）。首次触碰读真实磁盘
  // 播种（与执行路径的首条判定同源），其后由计划推进——保证同 path 多版本链的
  // 旧条目看到「撤回后」的状态而非当前盘面（D3）
  const virtualFiles = new Map<string, Buffer | null>();

  const outcomes: RevertOutcome[] = [];
  const stoppedPaths = new Set<string>();
  for (const entry of ordered) {
    if (stoppedPaths.has(entry.path)) continue;
    try {
      if (!virtualFiles.has(entry.path)) {
        virtualFiles.set(
          entry.path,
          await readFileBytesOrNull(safeResolve(workspaceDir, entry.path)),
        );
      }
      const current = virtualFiles.get(entry.path) ?? null;
      const oldRel = entry.op === 'rename' ? entry.oldPath : null;
      let oldExists = false;
      if (oldRel != null) {
        if (virtualFiles.has(oldRel)) oldExists = (virtualFiles.get(oldRel) ?? null) !== null;
        else oldExists = await existsFile(safeResolve(workspaceDir, oldRel));
      }

      const plan = classify(entry, current, oldExists, false);
      switch (plan.action.kind) {
        case 'none':
          break;
        case 'deleteFile':
          virtualFiles.set(plan.action.relPath, null);
          break;
        case 'writeBefore': {
          // before blob 缺失/脏数据 → 执行路径同样在 fetch 时 failed（口径一致）
          const before = fetchBeforeContent(store, workspaceId, entry);
          virtualFiles.set(plan.action.relPath, before);
          break;
        }
        case 'moveBack':
          virtualFiles.set(plan.action.fromRel, null);
          virtualFiles.set(plan.action.toRel, current);
          break;
      }
      outcomes.push(plan.outcome);
    } catch (err) {
      outcomes.push({
        id: entry.id,
        path: entry.path,
        result: 'failed',
        detail: err instanceof Error ? err.message : String(err),
      });
      stoppedPaths.add(entry.path);
    }
  }

  for (const id of ids) {
    if (!foundIds.has(id)) {
      outcomes.push({ id, path: '', result: 'no-op', detail: '条目不存在（可能已被配额清理）' });
    }
  }
  return outcomes;
}

/**
 * 路径遏制：条目 path 必须落在 workspaceDir 内（防脏条目/手改库越界写盘）。
 * 导出供 win32 语义单测直测边界函数（revertEntries 的逆序链 / hash 守卫由
 * revert.test.ts 既有用例覆盖——两测试面正交）。
 */
export function safeResolve(workspaceDir: string, rel: string): string {
  const root = path.resolve(workspaceDir);
  const abs = path.resolve(workspaceDir, rel);
  if (!isInsideDir(root, abs, { win32: PATH_SEMANTICS_WIN32 })) {
    throw new Error(`journal 条目路径越界: ${rel}`);
  }
  return abs;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** 读取文件当前字节；不存在返回 null；其余读错误向上抛（→ failed）
 * v2.1 字节化：二进制与文本统一按字节处理（文本是字节子集，utf-8 无损） */
async function readFileBytesOrNull(absPath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(absPath);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

async function existsFile(absPath: string): Promise<boolean> {
  try {
    await fs.stat(absPath);
    return true;
  } catch {
    return false;
  }
}

/** 取 before 内容 blob 字节；条目脏数据（缺 beforeHash）或 blob 缺失 → 抛错（→ failed） */
function fetchBeforeContent(
  store: JournalStore,
  workspaceId: string,
  entry: JournalEntry,
): Buffer {
  if (entry.beforeHash == null) {
    throw new Error('条目缺少 beforeHash，无法撤回（数据异常）');
  }
  const content = store.readBlobBytes(workspaceId, entry.beforeHash);
  if (content === null) {
    throw new Error(`before 内容 blob 缺失（hash=${entry.beforeHash}）`);
  }
  return content;
}

/**
 * 纯决策（无 IO）：按条目 op 与当前字节判定撤销结果，产出 outcome + 执行动作 +
 * 对称记账规格。执行路径与预检路径共用本函数——分支语义只此一处（防漂移）。
 */
function classify(
  entry: JournalEntry,
  current: Buffer | null,
  oldExists: boolean,
  force: boolean,
): RevertPlan {
  const curHash = current !== null ? hashContent(current) : null;

  if (entry.op === 'rename' && entry.oldPath == null) {
    return {
      outcome: {
        id: entry.id,
        path: entry.path,
        result: 'failed',
        detail: 'rename 条目缺少 oldPath（数据异常）',
      },
      action: { kind: 'none' },
    };
  }

  switch (entry.op) {
    case 'create': {
      if (current === null) {
        return {
          outcome: {
            id: entry.id,
            path: entry.path,
            result: 'no-op',
            detail: 'create 撤回：文件不存在（未生效或已被还原）',
          },
          action: { kind: 'none' },
        };
      }
      if (curHash !== entry.afterHash && !force) {
        return { outcome: skippedDiverged(entry), action: { kind: 'none' } };
      }
      // 逆操作 delete：before=当前内容（漂移时即漂移现场，撤销的撤销可还原）
      return {
        outcome: {
          id: entry.id,
          path: entry.path,
          result: 'reverted',
          ...(curHash === entry.afterHash ? {} : { detail: '强制撤回：已删除漂移后的文件' }),
        },
        action: {
          kind: 'deleteFile',
          relPath: entry.path,
          inverse: { op: 'delete', relPath: entry.path, beforeFrom: 'current', afterFrom: 'none' },
        },
      };
    }

    case 'modify': {
      if (current === null) {
        // 文件缺失 → 重建 before；实际动作是建文件 → 对称条目记 create
        return {
          outcome: { id: entry.id, path: entry.path, result: 'restored-missing' },
          action: {
            kind: 'writeBefore',
            relPath: entry.path,
            inverse: { op: 'create', relPath: entry.path, beforeFrom: 'none', afterFrom: 'beforeBlob' },
          },
        };
      }
      if (curHash === entry.afterHash) {
        return {
          outcome: { id: entry.id, path: entry.path, result: 'reverted' },
          action: {
            kind: 'writeBefore',
            relPath: entry.path,
            inverse: {
              op: 'modify',
              relPath: entry.path,
              beforeFrom: 'current',
              afterFrom: 'beforeBlob',
            },
          },
        };
      }
      if (curHash === entry.beforeHash) {
        return {
          outcome: {
            id: entry.id,
            path: entry.path,
            result: 'no-op',
            detail: '孤儿条目：文件已处于 before 状态（记账后未写盘或已被撤销）',
          },
          action: { kind: 'none' },
        };
      }
      if (!force) return { outcome: skippedDiverged(entry), action: { kind: 'none' } };
      return {
        outcome: {
          id: entry.id,
          path: entry.path,
          result: 'reverted',
          detail: '强制写回：覆盖漂移后的内容',
        },
        action: {
          kind: 'writeBefore',
          relPath: entry.path,
          inverse: { op: 'modify', relPath: entry.path, beforeFrom: 'current', afterFrom: 'beforeBlob' },
        },
      };
    }

    case 'delete': {
      if (current === null) {
        // delete 已生效 → 重建 before；实际动作是建文件 → 对称条目记 create
        return {
          outcome: { id: entry.id, path: entry.path, result: 'restored-missing' },
          action: {
            kind: 'writeBefore',
            relPath: entry.path,
            inverse: { op: 'create', relPath: entry.path, beforeFrom: 'none', afterFrom: 'beforeBlob' },
          },
        };
      }
      if (curHash === entry.beforeHash) {
        return {
          outcome: {
            id: entry.id,
            path: entry.path,
            result: 'no-op',
            detail: '孤儿条目：删除未生效（记账后未执行）',
          },
          action: { kind: 'none' },
        };
      }
      if (!force) return { outcome: skippedDiverged(entry), action: { kind: 'none' } };
      // 删除后文件被重建且漂移 → 强制写回；实际动作是覆盖重写 → 对称条目记 modify
      return {
        outcome: {
          id: entry.id,
          path: entry.path,
          result: 'reverted',
          detail: '强制写回：覆盖删除后重建的漂移内容',
        },
        action: {
          kind: 'writeBefore',
          relPath: entry.path,
          inverse: { op: 'modify', relPath: entry.path, beforeFrom: 'current', afterFrom: 'beforeBlob' },
        },
      };
    }

    case 'rename': {
      const oldRel = entry.oldPath as string;
      if (current === null) {
        if (oldExists) {
          // 新路径不存在且文件仍在旧路径 → rename 未生效或已被回退，不动现场
          return {
            outcome: {
              id: entry.id,
              path: entry.path,
              result: 'no-op',
              detail: 'rename 未生效：文件仍在旧路径',
            },
            action: { kind: 'none' },
          };
        }
        // 双侧缺失 → 在旧路径重建 before 内容；实际动作是建文件 → 对称条目记 create
        return {
          outcome: { id: entry.id, path: entry.path, result: 'restored-missing' },
          action: {
            kind: 'writeBefore',
            relPath: oldRel,
            inverse: { op: 'create', relPath: oldRel, beforeFrom: 'none', afterFrom: 'beforeBlob' },
          },
        };
      }
      // rename 守卫语义：内容不变，after 态即 beforeHash
      const guardOk = curHash === entry.beforeHash;
      if (!guardOk && !force) {
        return { outcome: skippedDiverged(entry), action: { kind: 'none' } };
      }
      const details: string[] = [];
      if (!guardOk) details.push('强制移回：内容已漂移');
      if (oldExists) details.push('目标路径已存在，移回时已覆盖');
      // 逆操作 rename 反向：path=旧路径（移回后位置），oldPath=当前路径
      return {
        outcome: {
          id: entry.id,
          path: entry.path,
          result: 'reverted',
          ...(details.length > 0 ? { detail: details.join('；') } : {}),
        },
        action: {
          kind: 'moveBack',
          fromRel: entry.path,
          toRel: oldRel,
          inverse: {
            op: 'rename',
            relPath: oldRel,
            beforeFrom: 'current',
            afterFrom: 'none',
            oldPath: entry.path,
          },
        },
      };
    }
  }
}

function skippedDiverged(entry: JournalEntry): RevertOutcome {
  return {
    id: entry.id,
    path: entry.path,
    result: 'skipped-diverged',
    detail: 'hash 漂移：文件在记账后被其他变更修改（force=true 可强制写回）',
  };
}

/** 按记账规格落对称条目（write-ahead：先于文件变更） */
function recordInverseSpec(
  rc: RecordCtx | undefined,
  spec: InverseSpec,
  current: Buffer | null,
  beforeContent: Buffer | null,
): void {
  if (!rc) return;
  recordChange(
    { ...rc, toolName: 'undo' },
    spec.relPath,
    spec.op,
    spec.beforeFrom === 'current' ? current : null,
    spec.afterFrom === 'beforeBlob' ? beforeContent : null,
    spec.oldPath,
  );
}

/** 写回内容字节（先确保父目录存在——restore 场景父目录可能已删；父路径被普通文件
 *  占位时 mkdir 抛 EEXIST → 由调用方 catch 成 failed） */
async function writeBack(absPath: string, content: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content);
}

/** 执行侧解释器：classify 产计划 → 对称记账（write-ahead）→ 文件操作 */
async function revertOne(
  store: JournalStore,
  workspaceId: string,
  workspaceDir: string,
  entry: JournalEntry,
  opts: RevertOpts,
): Promise<RevertOutcome> {
  try {
    safeResolve(workspaceDir, entry.path);
    const absOldPath = entry.oldPath != null ? safeResolve(workspaceDir, entry.oldPath) : null;
    const current = await readFileBytesOrNull(safeResolve(workspaceDir, entry.path));
    const oldExists = absOldPath != null ? await existsFile(absOldPath) : false;
    const plan = classify(entry, current, oldExists, opts.force === true);

    switch (plan.action.kind) {
      case 'none':
        return plan.outcome;
      case 'deleteFile': {
        const absPath = safeResolve(workspaceDir, plan.action.relPath);
        recordInverseSpec(opts.recorderCtx, plan.action.inverse, current, null);
        await fs.rm(absPath);
        return plan.outcome;
      }
      case 'writeBefore': {
        const before = fetchBeforeContent(store, workspaceId, entry);
        const absPath = safeResolve(workspaceDir, plan.action.relPath);
        recordInverseSpec(opts.recorderCtx, plan.action.inverse, current, before);
        await writeBack(absPath, before);
        return plan.outcome;
      }
      case 'moveBack': {
        const absFrom = safeResolve(workspaceDir, plan.action.fromRel);
        const absTo = safeResolve(workspaceDir, plan.action.toRel);
        recordInverseSpec(opts.recorderCtx, plan.action.inverse, current, null);
        await fs.mkdir(path.dirname(absTo), { recursive: true });
        await fs.rename(absFrom, absTo);
        return plan.outcome;
      }
    }
  } catch (err) {
    return {
      id: entry.id,
      path: entry.path,
      result: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
