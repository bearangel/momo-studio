// electron/src/main/storage/memories/repo.ts
// memories 表 CRUD + FTS5 应用层双写（spec §5.3 决策 1）：
// insert/update/delete 在同一事务内同步维护 memories_fts（external content 表），
// 主表与索引永不漂移；分词经 tokenize.ts（jieba 同源）。
// 注意：memories 表只经本 repo 写（项目惯例），绕过 repo 的裸 SQL 不保证索引同步。
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { tokenizeForIndex } from './tokenize';

export interface MemoryEntry {
  id: string;
  rowid: number;              // FTS external content 表关联键
  scope: 'global' | 'workspace' | 'session';
  workspaceId: string | null;
  sessionId: string | null;
  kind: 'rule' | 'preference' | 'knowledge' | 'summary';
  pinned: boolean;
  content: string;
  tags: string[];
  source: 'user' | 'agent' | 'auto';
  sourceDetail: string | null;
  confidence: number;
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type MemoryListScope =
  | { kind: 'global' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'session'; sessionId: string };

export interface MemoryListFilter {
  kind?: MemoryEntry['kind'];
  source?: MemoryEntry['source'];
  pinned?: boolean;
}

export interface SaveMemoryInput {
  scope: 'global' | 'workspace' | 'session';
  workspaceId?: string | null;
  sessionId?: string | null;
  kind: 'rule' | 'preference' | 'knowledge' | 'summary';
  content: string;
  tags?: string[];
  pinned?: boolean;           // 缺省按 kind 推导：rule/preference=常驻
  source: 'user' | 'agent' | 'auto';
  sourceDetail?: string | null;
  confidence?: number;
}

export interface MemoryPatch {
  content?: string;
  tags?: string[];
  pinned?: boolean;
}

export type SqlRow = {
  id: string; rowid: number; scope: string; workspace_id: string | null; session_id: string | null;
  kind: string; pinned: number; content: string; tags: string; source: string;
  source_detail: string | null; confidence: number; use_count: number;
  last_used_at: number | null; created_at: number; updated_at: number;
};

export function rowToEntry(r: SqlRow): MemoryEntry {
  return {
    id: r.id, rowid: r.rowid,
    scope: r.scope as MemoryEntry['scope'],
    workspaceId: r.workspace_id, sessionId: r.session_id,
    kind: r.kind as MemoryEntry['kind'],
    pinned: r.pinned === 1,
    content: r.content,
    tags: JSON.parse(r.tags) as string[],
    source: r.source as MemoryEntry['source'],
    sourceDetail: r.source_detail, confidence: r.confidence,
    useCount: r.use_count, lastUsedAt: r.last_used_at,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** FTS tags 列：标签本身就是 token，空格连接即可（无需分词） */
function ftsTags(tags: string[]): string {
  return tags.join(' ');
}

// content 长度上限（spec §6.6）：普通 kind 2000 字、rule 4000 字（规则是常驻注入源，放宽一档）。
// 校验在 repo 层（而非仅 UI）——LLM 提取 / 导入等所有写入方统一受限。
export const CONTENT_LIMIT = 2000;
export const RULE_CONTENT_LIMIT = 4000;

/** 校验 content 长度：超限抛错（错误信息含上限，UI 直接呈现） */
function validateContentLength(kind: SaveMemoryInput['kind'], content: string): void {
  const limit = kind === 'rule' ? RULE_CONTENT_LIMIT : CONTENT_LIMIT;
  if (content.length > limit) {
    throw new Error(`记忆内容长度不能超过 ${limit} 字${kind === 'rule' ? '（规则类）' : ''}，当前 ${content.length} 字`);
  }
}

export function insertMemory(input: SaveMemoryInput): MemoryEntry {
  validateContentLength(input.kind, input.content);
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  const pinned = input.pinned ?? (input.kind === 'rule' || input.kind === 'preference');
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO memories (id, scope, workspace_id, session_id, kind, pinned, content, tags,
         source, source_detail, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, input.scope, input.workspaceId ?? null, input.sessionId ?? null,
      input.kind, pinned ? 1 : 0, input.content, JSON.stringify(input.tags ?? []),
      input.source, input.sourceDetail ?? null, input.confidence ?? 1.0, now, now,
    );
    const rowid = (db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number }).rowid;
    db.prepare('INSERT INTO memories_fts (rowid, content, tags) VALUES (?, ?, ?)')
      .run(rowid, tokenizeForIndex(input.content), ftsTags(input.tags ?? []));
  });
  tx();
  return getMemory(id)!;
}

export function updateMemory(id: string, patch: MemoryPatch): MemoryEntry {
  const db = getDb();
  const existing = getMemory(id);
  if (!existing) throw new Error(`记忆不存在: ${id}`);
  // kind 不可 patch——上限沿用既有条目的 kind（rule 4000 / 其他 2000）
  validateContentLength(existing.kind, patch.content ?? existing.content);
  const tx = db.transaction(() => {
    // external content 表：DELETE 必须先于 content 表 UPDATE——
    // FTS5 在 DELETE 时按 rowid 重新读 content 表计算要移除的 token；
    // 若 UPDATE 已改 tags/content 列，新算出的 token 与索引中旧 token 不匹配，
    // 返回 SQLITE_CORRUPT_VTAB（实测：tags 列更新触发此错误，content 列单独更新也同理）。
    // 顺序固定 DELETE → UPDATE → INSERT 同事务；FTS 永不在中间态被读。
    db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(existing.rowid);
    db.prepare(
      `UPDATE memories SET content = ?, tags = ?, pinned = ?, updated_at = ? WHERE id = ?`,
    ).run(
      patch.content ?? existing.content,
      JSON.stringify(patch.tags ?? existing.tags),
      (patch.pinned ?? existing.pinned) ? 1 : 0,
      Date.now(), id,
    );
    db.prepare('INSERT INTO memories_fts (rowid, content, tags) VALUES (?, ?, ?)').run(
      existing.rowid,
      tokenizeForIndex(patch.content ?? existing.content),
      ftsTags(patch.tags ?? existing.tags),
    );
  });
  tx();
  return getMemory(id)!;
}

export function deleteMemory(id: string): void {
  const db = getDb();
  const existing = getMemory(id);
  if (!existing) throw new Error(`记忆不存在: ${id}`);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(existing.rowid);
    db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  });
  tx();
}

export function getMemory(id: string): MemoryEntry | null {
  const row = getDb()
    .prepare('SELECT memories.rowid AS rowid, memories.* FROM memories WHERE id = ?')
    .get(id) as SqlRow | undefined;
  return row ? rowToEntry(row) : null;
}

/** 列出记忆（updated_at DESC）；limit=SQL LIMIT，供 catalog 等调用方封顶拉取量、免全量拉取后内存截断 */
export function listMemories(scope: MemoryListScope, filter?: MemoryListFilter, limit?: number): MemoryEntry[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (scope.kind === 'global') where.push(`scope = 'global'`);
  if (scope.kind === 'workspace') { where.push(`scope = 'workspace' AND workspace_id = ?`); params.push(scope.workspaceId); }
  if (scope.kind === 'session') { where.push(`scope = 'session' AND session_id = ?`); params.push(scope.sessionId); }
  if (filter?.kind) { where.push('kind = ?'); params.push(filter.kind); }
  if (filter?.source) { where.push('source = ?'); params.push(filter.source); }
  if (filter?.pinned !== undefined) { where.push('pinned = ?'); params.push(filter.pinned ? 1 : 0); }
  if (limit !== undefined) params.push(limit);
  const rows = db.prepare(
    `SELECT memories.rowid AS rowid, memories.* FROM memories
     WHERE ${where.join(' AND ')} ORDER BY updated_at DESC${limit !== undefined ? ' LIMIT ?' : ''}`,
  ).all(...params) as SqlRow[];
  return rows.map(rowToEntry);
}

/** 检索命中计数（spec §5.1 use_count/last_used_at 维护） */
export function touchMemoryUsed(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const now = Date.now();
  const tx = db.transaction(() => {
    const stmt = db.prepare('UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?');
    for (const id of ids) stmt.run(now, id);
  });
  tx();
}
