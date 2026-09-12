// electron/src/main/journal/revert.ts
//
// 撤销核心（v2.5 变更账本与撤销，Task 3）：hash 守卫 + 逆序链 + 对称记账。
//
// 语义（spec §5.4）：
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

/** 读取文件当前内容；不存在返回 null；其余读错误向上抛（→ failed） */
async function readFileOrNull(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, 'utf8');
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

/** 取 before 内容 blob；条目脏数据（缺 beforeHash）或 blob 缺失 → 抛错（→ failed） */
function fetchBeforeContent(
  store: JournalStore,
  workspaceId: string,
  entry: JournalEntry,
): string {
  if (entry.beforeHash == null) {
    throw new Error('条目缺少 beforeHash，无法撤回（数据异常）');
  }
  const content = store.readBlob(workspaceId, entry.beforeHash);
  if (content === null) {
    throw new Error(`before 内容 blob 缺失（hash=${entry.beforeHash}）`);
  }
  return content;
}

/** 写回前对称记账（逆 op，toolName 强制 'undo'，其余 ctx 字段透传；无 ctx 跳过） */
function recordInverse(
  rc: RecordCtx | undefined,
  filePath: string,
  op: 'create' | 'modify' | 'delete' | 'rename',
  before: string | null,
  after: string | null,
  oldPath?: string,
): void {
  if (!rc) return;
  recordChange({ ...rc, toolName: 'undo' }, filePath, op, before, after, oldPath);
}

/** 写回内容（先确保父目录存在——restore 场景父目录可能已删；父路径被普通文件
 *  占位时 mkdir 抛 EEXIST → 由调用方 catch 成 failed） */
async function writeBack(absPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, 'utf8');
}

function skippedDiverged(entry: JournalEntry): RevertOutcome {
  return {
    id: entry.id,
    path: entry.path,
    result: 'skipped-diverged',
    detail: 'hash 漂移：文件在记账后被其他变更修改（force=true 可强制写回）',
  };
}

async function revertOne(
  store: JournalStore,
  workspaceId: string,
  workspaceDir: string,
  entry: JournalEntry,
  opts: RevertOpts,
): Promise<RevertOutcome> {
  try {
    const absPath = safeResolve(workspaceDir, entry.path);

    if (entry.op === 'rename' && entry.oldPath == null) {
      return { id: entry.id, path: entry.path, result: 'failed', detail: 'rename 条目缺少 oldPath（数据异常）' };
    }
    const absOldPath = entry.oldPath != null ? safeResolve(workspaceDir, entry.oldPath) : null;

    const current = await readFileOrNull(absPath);
    const curHash = current !== null ? hashContent(current) : null;

    switch (entry.op) {
      case 'create': {
        if (current === null) {
          return {
            id: entry.id,
            path: entry.path,
            result: 'no-op',
            detail: 'create 撤回：文件不存在（未生效或已被还原）',
          };
        }
        if (curHash !== entry.afterHash && !opts.force) return skippedDiverged(entry);
        // 逆操作 delete：before=当前内容（漂移时即漂移现场，撤销的撤销可还原）
        recordInverse(opts.recorderCtx, entry.path, 'delete', current, null);
        await fs.rm(absPath);
        return curHash === entry.afterHash
          ? { id: entry.id, path: entry.path, result: 'reverted' }
          : {
              id: entry.id,
              path: entry.path,
              result: 'reverted',
              detail: '强制撤回：已删除漂移后的文件',
            };
      }

      case 'modify': {
        if (current === null) {
          // 文件缺失 → 重建 before；实际动作是建文件 → 对称条目记 create
          const before = fetchBeforeContent(store, workspaceId, entry);
          recordInverse(opts.recorderCtx, entry.path, 'create', null, before);
          await writeBack(absPath, before);
          return { id: entry.id, path: entry.path, result: 'restored-missing' };
        }
        if (curHash === entry.afterHash) {
          const before = fetchBeforeContent(store, workspaceId, entry);
          recordInverse(opts.recorderCtx, entry.path, 'modify', current, before);
          await writeBack(absPath, before);
          return { id: entry.id, path: entry.path, result: 'reverted' };
        }
        if (curHash === entry.beforeHash) {
          return {
            id: entry.id,
            path: entry.path,
            result: 'no-op',
            detail: '孤儿条目：文件已处于 before 状态（记账后未写盘或已被撤销）',
          };
        }
        if (!opts.force) return skippedDiverged(entry);
        const before = fetchBeforeContent(store, workspaceId, entry);
        recordInverse(opts.recorderCtx, entry.path, 'modify', current, before);
        await writeBack(absPath, before);
        return {
          id: entry.id,
          path: entry.path,
          result: 'reverted',
          detail: '强制写回：覆盖漂移后的内容',
        };
      }

      case 'delete': {
        if (current === null) {
          // delete 已生效 → 重建 before；实际动作是建文件 → 对称条目记 create
          const before = fetchBeforeContent(store, workspaceId, entry);
          recordInverse(opts.recorderCtx, entry.path, 'create', null, before);
          await writeBack(absPath, before);
          return { id: entry.id, path: entry.path, result: 'restored-missing' };
        }
        if (curHash === entry.beforeHash) {
          return {
            id: entry.id,
            path: entry.path,
            result: 'no-op',
            detail: '孤儿条目：删除未生效（记账后未执行）',
          };
        }
        if (!opts.force) return skippedDiverged(entry);
        // 删除后文件被重建且漂移 → 强制写回；实际动作是覆盖重写 → 对称条目记 modify
        const before = fetchBeforeContent(store, workspaceId, entry);
        recordInverse(opts.recorderCtx, entry.path, 'modify', current, before);
        await writeBack(absPath, before);
        return {
          id: entry.id,
          path: entry.path,
          result: 'reverted',
          detail: '强制写回：覆盖删除后重建的漂移内容',
        };
      }

      case 'rename': {
        const oldRel = entry.oldPath;
        if (oldRel == null || absOldPath == null) {
          // 前置已校验，理论不可达；防御脏数据
          return { id: entry.id, path: entry.path, result: 'failed', detail: 'rename 条目缺少 oldPath（数据异常）' };
        }
        const oldExists = await existsFile(absOldPath);
        if (current === null) {
          if (oldExists) {
            // 新路径不存在且文件仍在旧路径 → rename 未生效或已被回退，不动现场
            return {
              id: entry.id,
              path: entry.path,
              result: 'no-op',
              detail: 'rename 未生效：文件仍在旧路径',
            };
          }
          // 双侧缺失 → 在旧路径重建 before 内容；实际动作是建文件 → 对称条目记 create
          const before = fetchBeforeContent(store, workspaceId, entry);
          recordInverse(opts.recorderCtx, oldRel, 'create', null, before);
          await writeBack(absOldPath, before);
          return { id: entry.id, path: entry.path, result: 'restored-missing' };
        }
        // rename 守卫语义：内容不变，after 态即 beforeHash
        const guardOk = curHash === entry.beforeHash;
        if (!guardOk && !opts.force) return skippedDiverged(entry);
        const details: string[] = [];
        if (!guardOk) details.push('强制移回：内容已漂移');
        if (oldExists) details.push('目标路径已存在，移回时已覆盖');
        // 逆操作 rename 反向：path=旧路径（移回后位置），oldPath=当前路径
        recordInverse(opts.recorderCtx, oldRel, 'rename', current, null, entry.path);
        await fs.mkdir(path.dirname(absOldPath), { recursive: true });
        await fs.rename(absPath, absOldPath);
        return {
          id: entry.id,
          path: entry.path,
          result: 'reverted',
          detail: details.length > 0 ? details.join('；') : undefined,
        };
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
