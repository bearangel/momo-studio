// electron/src/main/journal/quota.ts
//
// 变更账本配额滚动清理（v2.5 变更账本与撤销，Task 6；spec §7 保留策略）。
//
// 双条件独立触发：
//   1) 30 天硬上限——组内最新条目也早于 now-30d 的「终态老组」无论配额直接删
//      （终态判定不做任务表 DB 查询，纯时间窗近似；组内 max 仍在窗口 = 活跃组，
//      不删——避免拆掉进行中任务的撤销链）；
//   2) workspace 级 blob 配额（GlobalSettings.journalQuotaMb，默认 200MB）——
//      仍超限时按最旧组逐组删到满足为止（或无组可删）。
//
// 计量语义（T1 review 裁定）：per-workspace——只 walk 本 workspace 的
// objects 目录（store.walkDirBytes 限定单目录），不用全局 sumBlobBytes
// （全局和会误伤非占用方 workspace）。
//
// 删除单元：
//   - 任务组 = 同 taskId 全部条目，整组删（边界 MAX_SAFE_INTEGER）
//   - 快速会话段 = taskId null 条目按 streamSessionId 分段（spec §7「快速会话
//     按消息组」），删最旧段（边界 = 段内最新 created_at + 1，与 store 谓词
//     「created_at < 边界」的严格小于语义天然对齐）；段间交错时窗口删可能连带
//     更旧条目——实际删除集按同款谓词从快照推导，连带条目的 hash 一并 drop，
//     不泄漏引用已归零的孤儿 blob
//
// 每删一组后对删除集全部 hash 调 dropBlobIfUnreferenced——共享 blob 由引用
// 计数守护（另一组仍引用 → 条目删但 blob 物理保留）。
//
// 节流：maybeEnforceQuota 模块计数器每 50 次记账触发一次（recordChange 尾部
// 调用，防每次记账 walk 磁盘）；boot 逐 workspace 由 T7/boot 接线直接调
// enforceQuota。清理失败只 warn 不阻塞记账（安全网自身不能变成故障点）。
//
// 循环依赖说明：本模块与 recorder 互相引用（recorder 尾调 maybeEnforceQuota，
// 本模块经 getJournalStore 取同一注入实例）——双方均为函数声明 + 调用时访问，
// CJS/ESM 环境下循环加载均安全。

import { logger } from '../logger';
import { DEFAULT_JOURNAL_QUOTA_MB, getGlobalSettings } from '../settings/crud';
import { getJournalStore } from './recorder';
import { resolveJournalRoot, walkDirBytes } from './store';
import type { JournalStore } from './store';
import type { JournalEntry } from './types';

/** 30 天硬上限窗口（毫秒） */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
/** 记账节流：每 N 次记账触发一次 enforceQuota */
const ENFORCE_EVERY_N_RECORDS = 50;

export interface QuotaEnforceResult {
  /** 本次清理删除的组数（任务组 / 快速会话段各计 1） */
  purgedGroups: number;
  /** 本次清理物理释放的 blob 字节数（仅该 workspace 的 objects 目录） */
  freedBytes: number;
}

/** 待删组：任务组（taskId 非空）或快速会话段（taskId null 按 stream 分段） */
interface PurgeUnit {
  taskId: string | null;
  /** 快速会话段的 streamSessionId（taskId null 时有值） */
  streamKey: string | null;
  minCreatedAt: number;
  maxCreatedAt: number;
  entries: JournalEntry[];
}

function unitKey(u: PurgeUnit): string {
  return u.taskId !== null ? `task:${u.taskId}` : `stream:${u.streamKey ?? ''}`;
}

/** per-workspace blob 字节计量：只 walk 本 workspace 的 objects 目录 */
function measureWorkspaceBlobBytes(workspaceId: string): number {
  return walkDirBytes(resolveJournalRoot(workspaceId));
}

/** 解析生效配额（MB）。非法值（非正数/非有限数，如手改库）回退默认，
 *  避免 0/负值触发全量清库。 */
function resolveQuotaMb(): number {
  const mb = getGlobalSettings().journalQuotaMb;
  return typeof mb === 'number' && Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_JOURNAL_QUOTA_MB;
}

/** 快照 → 有序删除单元列表（按组内最旧 created_at 升序，组键字典序兜底） */
function buildUnits(snapshot: JournalEntry[]): PurgeUnit[] {
  const byKey = new Map<string, PurgeUnit>();
  for (const e of snapshot) {
    const key = e.taskId !== null ? `task:${e.taskId}` : `stream:${e.streamSessionId}`;
    let u = byKey.get(key);
    if (!u) {
      u = {
        taskId: e.taskId,
        streamKey: e.taskId === null ? e.streamSessionId : null,
        minCreatedAt: e.createdAt,
        maxCreatedAt: e.createdAt,
        entries: [],
      };
      byKey.set(key, u);
    }
    u.entries.push(e);
    u.minCreatedAt = Math.min(u.minCreatedAt, e.createdAt);
    u.maxCreatedAt = Math.max(u.maxCreatedAt, e.createdAt);
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.minCreatedAt !== b.minCreatedAt) return a.minCreatedAt - b.minCreatedAt;
    if (a.maxCreatedAt !== b.maxCreatedAt) return a.maxCreatedAt - b.maxCreatedAt;
    return unitKey(a) < unitKey(b) ? -1 : 1;
  });
}

/**
 * 删一组并 drop 该组 hash。实际删除集按 store 谓词从快照推导（与
 * deleteByTaskGroup 的 SQL 条件严格同款），返回删除行数。
 */
function purgeUnit(
  store: JournalStore,
  workspaceId: string,
  unit: PurgeUnit,
  snapshot: JournalEntry[],
): number {
  // 任务组整组删（MAX_SAFE_INTEGER 覆盖组内全部 created_at）；
  // 快速会话段删到段内最新条目为止（+1 严格小于语义天然含整段）
  const boundary = unit.taskId !== null ? Number.MAX_SAFE_INTEGER : unit.maxCreatedAt + 1;
  const deleted = snapshot.filter((e) =>
    unit.taskId !== null ? e.taskId === unit.taskId : e.taskId === null && e.createdAt < boundary,
  );
  const changes = store.deleteByTaskGroup(workspaceId, unit.taskId, boundary);
  if (changes > 0) {
    const hashes = new Set<string>();
    for (const e of deleted) {
      if (e.beforeHash !== null) hashes.add(e.beforeHash);
      if (e.afterHash !== null) hashes.add(e.afterHash);
    }
    for (const h of hashes) store.dropBlobIfUnreferenced(workspaceId, h);
  }
  return changes;
}

/**
 * 执行配额滚动清理（boot 逐 workspace 接线 / maybeEnforceQuota 节流调用）。
 *
 * 双条件独立触发：先 30 天硬上限（终态老组无论配额），再配额滚动（删到满足
 * 为止或无组可删）。opts.now 供测试注入固定时间源（30 天窗口确定性）。
 * store 未注入属接线缺陷 → fail-fast 抛错（与 detector/revert 同契约）。
 */
export function enforceQuota(
  workspaceId: string,
  opts?: { now?: () => number },
): QuotaEnforceResult {
  const store = getJournalStore();
  if (!store) {
    throw new Error(
      'journal store 未注入（生产：boot 链调用 setJournalStore；测试：__setJournalStoreForTest）',
    );
  }
  const now = opts?.now ?? Date.now;
  const quotaBytes = resolveQuotaMb() * 1024 * 1024;
  const startBytes = measureWorkspaceBlobBytes(workspaceId);
  let purgedGroups = 0;

  // 条件一：30 天硬上限——终态老组（组内最新条目早于窗口 = 整组闲置 30 天+）
  const cutoff = now() - THIRTY_DAYS_MS;
  for (;;) {
    const snapshot = store.listByWorkspace(workspaceId);
    const target = buildUnits(snapshot).find((u) => u.maxCreatedAt < cutoff);
    if (!target) break;
    if (purgeUnit(store, workspaceId, target, snapshot) === 0) break; // 防御：快照错位时终止
    purgedGroups += 1;
  }

  // 条件二：配额滚动——仍超限时按最旧组逐组删
  while (measureWorkspaceBlobBytes(workspaceId) > quotaBytes) {
    const snapshot = store.listByWorkspace(workspaceId);
    const oldest = buildUnits(snapshot)[0];
    if (!oldest) {
      logger.warn('journal 配额超限但无组可删（可能存在无条目引用的孤儿 blob）', {
        workspaceId,
        quotaBytes,
      });
      break;
    }
    if (purgeUnit(store, workspaceId, oldest, snapshot) === 0) break;
    purgedGroups += 1;
  }

  const endBytes = measureWorkspaceBlobBytes(workspaceId);
  return { purgedGroups, freedBytes: startBytes > endBytes ? startBytes - endBytes : 0 };
}

/** 节流计数器：recordChange（含 recordDeleteTree 按条数累计）驱动 */
let recordCounter = 0;

/**
 * 节流触发器：模块计数器每 50 次记账触发一次 enforceQuota（防每次记账 walk
 * 磁盘）。任何失败只 warn 不抛——清理不能阻塞记账；store 未注入直接跳过。
 */
export function maybeEnforceQuota(workspaceId: string, recordCount = 1): void {
  if (recordCount <= 0) return;
  if (getJournalStore() === null) return;
  recordCounter += recordCount;
  if (recordCounter % ENFORCE_EVERY_N_RECORDS !== 0) return;
  try {
    enforceQuota(workspaceId);
  } catch (err) {
    logger.warn('journal 配额清理失败（不阻塞记账）', {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 测试接线：复位节流计数器（模块级状态，防跨用例漂移） */
export function __resetQuotaCounterForTest(): void {
  recordCounter = 0;
}
