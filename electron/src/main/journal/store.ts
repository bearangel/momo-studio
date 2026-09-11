// electron/src/main/journal/store.ts
//
// 账本仓库：journal_entries 表 CRUD + blob 内容寻址读写（v2.5 Task 1）。
// 条目入 state.db（轻量可查询），大内容 blob 落 userData 文件系统
// （<userData>/journal/<workspaceId>/objects/<hash[0:2]>/<hash>，D6 决策）。
// 全部同步 better-sqlite3（主进程单线程语义，与仓库其余 store 一致）；
// db 经 createJournalStore(db) 注入——测试与生产共用 getDb()。

import fs from 'node:fs';
import path from 'node:path';
import type { Database as DB } from 'better-sqlite3';
import { resolveUserDataDir } from '../paths';
import type { JournalEntry, JournalOp } from './types';

export interface JournalStore {
  insert(e: JournalEntry): void;
  listByTask(workspaceId: string, taskId: string): JournalEntry[];
  listByStream(workspaceId: string, streamSessionId: string): JournalEntry[];
  listByPath(workspaceId: string, path: string): JournalEntry[];
  /** 全 workspace 条目（created_at 升序）——探测器 taskId=null 对账基线（全量 path 并集） */
  listByWorkspace(workspaceId: string): JournalEntry[];
  /** 按 id 批量取条目（撤销核心按 id 定位）；不在该 workspace 或不存在的 id 自然落空 */
  listByIds(workspaceId: string, ids: string[]): JournalEntry[];
  /** 删除目标任务组（taskId 匹配；null = 快速会话组）中 created_at < olderThan 的条目，返回删除行数 */
  deleteByTaskGroup(workspaceId: string, taskId: string | null, olderThan: number): number;
  countAll(): number;
  /** 全部 workspace 的 blob 对象磁盘字节总和（配额计量） */
  sumBlobBytes(): number;
  /** 内容寻址写盘，幂等（同 hash 已存在即跳过） */
  writeBlob(workspaceId: string, hash: string, content: string): void;
  readBlob(workspaceId: string, hash: string): string | null;
  /** 引用计数（before_hash/after_hash 命中该 hash 的总行数）归零时物理删除对象文件 */
  dropBlobIfUnreferenced(workspaceId: string, hash: string): void;
}

/** blob 根目录：<userData>/journal/<workspaceId>/objects */
export function resolveJournalRoot(workspaceId: string): string {
  return path.join(resolveUserDataDir(), 'journal', workspaceId, 'objects');
}

/** 单个 blob 对象文件路径：<root>/<hash[0:2]>/<hash>（两级扇列） */
export function resolveJournalDir(workspaceId: string, hash: string): string {
  return path.join(resolveJournalRoot(workspaceId), hash.slice(0, 2), hash);
}

interface JournalEntryRow {
  id: string;
  workspace_id: string;
  task_id: string | null;
  session_id: string | null;
  stream_session_id: string;
  tool_name: string;
  path: string;
  op: string;
  before_hash: string | null;
  after_hash: string | null;
  old_path: string | null;
  created_at: number;
}

function rowToEntry(row: JournalEntryRow): JournalEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    streamSessionId: row.stream_session_id,
    toolName: row.tool_name,
    path: row.path,
    // 值域由 migration v33 的 CHECK 约束守护，出库值必属四值域
    op: row.op as JournalOp,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    oldPath: row.old_path,
    createdAt: row.created_at,
  };
}

function walkSum(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    total += st.isDirectory() ? walkSum(full) : st.size;
  }
  return total;
}

export function createJournalStore(db: DB): JournalStore {
  const stmtInsert = db.prepare(`
    INSERT INTO journal_entries
      (id, workspace_id, task_id, session_id, stream_session_id, tool_name,
       path, op, before_hash, after_hash, old_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtListByTask = db.prepare(`
    SELECT * FROM journal_entries
    WHERE workspace_id = ? AND task_id = ?
    ORDER BY created_at ASC, id ASC
  `);
  const stmtListByStream = db.prepare(`
    SELECT * FROM journal_entries
    WHERE workspace_id = ? AND stream_session_id = ?
    ORDER BY created_at ASC, id ASC
  `);
  const stmtListByPath = db.prepare(`
    SELECT * FROM journal_entries
    WHERE workspace_id = ? AND path = ?
    ORDER BY created_at ASC, id ASC
  `);
  const stmtListByWorkspace = db.prepare(`
    SELECT * FROM journal_entries
    WHERE workspace_id = ?
    ORDER BY created_at ASC, id ASC
  `);
  // null taskId 走 IS NULL 分支（task_id = NULL 永不命中），非 null 走等值分支
  const stmtDeleteGroup = db.prepare(`
    DELETE FROM journal_entries
    WHERE workspace_id = ?
      AND ((? IS NULL AND task_id IS NULL) OR task_id = ?)
      AND created_at < ?
  `);
  const stmtCountAll = db.prepare('SELECT COUNT(*) AS c FROM journal_entries');
  // 引用计数 = before/after 任一命中该 hash 的总行数（rename 的 before_hash 即旧内容
  // hash，天然计入；无独立的 old hash 列）
  const stmtRefCount = db.prepare(`
    SELECT COUNT(*) AS c FROM journal_entries
    WHERE workspace_id = ? AND (before_hash = ? OR after_hash = ?)
  `);

  return {
    insert(e: JournalEntry): void {
      stmtInsert.run(
        e.id,
        e.workspaceId,
        e.taskId,
        e.sessionId,
        e.streamSessionId,
        e.toolName,
        e.path,
        e.op,
        e.beforeHash,
        e.afterHash,
        e.oldPath,
        e.createdAt,
      );
    },
    listByTask(workspaceId: string, taskId: string): JournalEntry[] {
      return (stmtListByTask.all(workspaceId, taskId) as JournalEntryRow[]).map(rowToEntry);
    },
    listByStream(workspaceId: string, streamSessionId: string): JournalEntry[] {
      return (stmtListByStream.all(workspaceId, streamSessionId) as JournalEntryRow[]).map(
        rowToEntry,
      );
    },
    listByPath(workspaceId: string, filePath: string): JournalEntry[] {
      return (stmtListByPath.all(workspaceId, filePath) as JournalEntryRow[]).map(rowToEntry);
    },
    listByWorkspace(workspaceId: string): JournalEntry[] {
      return (stmtListByWorkspace.all(workspaceId) as JournalEntryRow[]).map(rowToEntry);
    },
    listByIds(workspaceId: string, ids: string[]): JournalEntry[] {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => '?').join(', ');
      const rows = db
        .prepare(
          `SELECT * FROM journal_entries
           WHERE workspace_id = ? AND id IN (${placeholders})
           ORDER BY created_at ASC, id ASC`,
        )
        .all(workspaceId, ...ids) as JournalEntryRow[];
      return rows.map(rowToEntry);
    },
    deleteByTaskGroup(workspaceId: string, taskId: string | null, olderThan: number): number {
      return stmtDeleteGroup.run(workspaceId, taskId, taskId, olderThan).changes;
    },
    countAll(): number {
      return (stmtCountAll.get() as { c: number }).c;
    },
    sumBlobBytes(): number {
      return walkSum(path.join(resolveUserDataDir(), 'journal'));
    },
    writeBlob(workspaceId: string, hash: string, content: string): void {
      const file = resolveJournalDir(workspaceId, hash);
      // 内容寻址：同 hash 即同内容，已存在直接跳过（幂等，不重写不覆盖）
      if (fs.existsSync(file)) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
    },
    readBlob(workspaceId: string, hash: string): string | null {
      const file = resolveJournalDir(workspaceId, hash);
      if (!fs.existsSync(file)) return null;
      return fs.readFileSync(file, 'utf8');
    },
    dropBlobIfUnreferenced(workspaceId: string, hash: string): void {
      const { c } = stmtRefCount.get(workspaceId, hash, hash) as { c: number };
      if (c > 0) return;
      const file = resolveJournalDir(workspaceId, hash);
      if (fs.existsSync(file)) fs.rmSync(file);
    },
  };
}
