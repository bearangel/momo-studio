// electron/src/main/storage/memories/search.ts
// BM25 检索（spec §6.5）：MATCH 表达式与写入侧同源分词；
// scope 过滤实现「全局 + 本 workspace + 本会话」三层并集。
import { getDb } from '../db';
import { buildMatchExpr } from './tokenize';
import type { MemoryEntry } from './repo';

// 复用 repo 的行转换（保持单一实现，防类型漂移）
export { type MemoryEntry } from './repo';
import { rowToEntry, type SqlRow } from './repo';
// 注意：rowToEntry 需在 repo.ts 导出（见 Step 4 的 repo 微调）

export interface MemorySearchScope {
  workspaceId: string;
  sessionId: string | null;
}

/** searchMemories 追加选项（P3 M-3，缺省行为不变） */
export interface MemorySearchOptions {
  /** 三层并集收窄到单层（memory_search scope 先滤后截下推 SQL，保证目标层完整 top-N） */
  scopeKind?: MemoryEntry['scope'];
}

export function searchMemories(
  query: string,
  scope: MemorySearchScope,
  limit = 10,
  opts?: MemorySearchOptions,
): MemoryEntry[] {
  const matchExpr = buildMatchExpr(query);
  if (matchExpr === '') return [];
  const db = getDb();
  // scopeKind 下推：SQL 层先收窄再 LIMIT（客户端过滤会把名额浪费在非目标层上）
  const scopeKindClause = opts?.scopeKind !== undefined ? ' AND memories.scope = ?' : '';
  const params: unknown[] = [matchExpr, scope.workspaceId, scope.sessionId ?? ''];
  if (opts?.scopeKind !== undefined) params.push(opts.scopeKind);
  params.push(limit);
  const rows = db.prepare(
    `SELECT memories.rowid AS rowid, memories.*
     FROM memories_fts
     JOIN memories ON memories.rowid = memories_fts.rowid
     WHERE memories_fts MATCH ?
       AND (memories.scope = 'global'
         OR (memories.scope = 'workspace' AND memories.workspace_id = ?)
         OR (memories.scope = 'session' AND memories.session_id = ?))${scopeKindClause}
     ORDER BY bm25(memories_fts)
     LIMIT ?`,
  ).all(...params) as SqlRow[];
  return rows.map(rowToEntry);
}
