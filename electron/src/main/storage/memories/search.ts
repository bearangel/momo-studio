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

export function searchMemories(
  query: string,
  scope: MemorySearchScope,
  limit = 10,
): MemoryEntry[] {
  const matchExpr = buildMatchExpr(query);
  if (matchExpr === '') return [];
  const db = getDb();
  const rows = db.prepare(
    `SELECT memories.rowid AS rowid, memories.*
     FROM memories_fts
     JOIN memories ON memories.rowid = memories_fts.rowid
     WHERE memories_fts MATCH ?
       AND (memories.scope = 'global'
         OR (memories.scope = 'workspace' AND memories.workspace_id = ?)
         OR (memories.scope = 'session' AND memories.session_id = ?))
     ORDER BY bm25(memories_fts)
     LIMIT ?`,
  ).all(matchExpr, scope.workspaceId, scope.sessionId ?? '', limit) as SqlRow[];
  return rows.map(rowToEntry);
}
