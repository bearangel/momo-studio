// electron/src/main/journal/store.ts
//
// 账本仓库：journal_entries 表 CRUD + blob 内容寻址读写（v2.5 Task 1）。
// 条目入 state.db（轻量可查询），大内容 blob 落 userData 文件系统
// （<userData>/journal/<workspaceId>/objects/<hash[0:2]>/<hash>，D6 决策）。
// 全部同步 better-sqlite3（主进程单线程语义，与仓库其余 store 一致）；
// db 经 createJournalStore(db) 注入——测试与生产共用 getDb()。

import fs from 'node:fs';
import path from 'node:path';
import type { Database as DB, Statement } from 'better-sqlite3';
import { resolveUserDataDir } from '../paths';
import type { JournalEntry, JournalOp } from './types';

/** 任务起点基线 meta 行（task_scan_baseline 表行的 camelCase 形态） */
export interface BaselineMetaRow {
  workspaceId: string;
  taskId: string;
  capturedAt: number;
  /** true = 捕获时 git 异常的降级基线（无 path 行，扫描回退累计差集） */
  degraded: boolean;
}

/** 任务起点基线脏路径行（task_scan_baseline_path 表行的 camelCase 形态） */
export interface BaselinePathRow {
  /** workspace 根相对 POSIX 路径（与 detector 变更集同口径——键契约单点） */
  path: string;
  /** sha256 hex（recorder.hashContent）；null = 捕获时文件不可读（已删除等） */
  contentHash: string | null;
}

export interface JournalStore {
  insert(e: JournalEntry): void;
  /** 批量插入（单 db.transaction 原子提交）：删除树等多条目写入路径用，
   *  避免逐条 insert 中途失败留下半批（T4 review 移交） */
  insertMany(entries: JournalEntry[]): void;
  listByTask(workspaceId: string, taskId: string): JournalEntry[];
  listByStream(workspaceId: string, streamSessionId: string): JournalEntry[];
  /** 会话级聚合（变更回滚重构 spec 2026-09-28 §5.2）：该 session 全部条目——
   *  含子 agent dispatch 写入（同 sessionId 不同 streamSessionId）；
   *  session_id 为 NULL 的条目不命中（等值查询语义） */
  listBySession(workspaceId: string, sessionId: string): JournalEntry[];
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
  /** 内容寻址写盘，幂等（同 hash 已存在即跳过）。v2.1 二进制扩展：接受 Buffer。 */
  writeBlob(workspaceId: string, hash: string, content: string | Buffer): void;
  readBlob(workspaceId: string, hash: string): string | null;
  /** v2.1 二进制扩展：字节读取（撤销恢复二进制文件用）；文本 blob 读回即其 utf-8 字节 */
  readBlobBytes(workspaceId: string, hash: string): Buffer | null;
  /** 引用计数（before_hash/after_hash 命中该 hash 的总行数）归零时物理删除对象文件 */
  dropBlobIfUnreferenced(workspaceId: string, hash: string): void;
  /** ===== 任务起点扫描基线（未入账误归因根治，迁移 049）=====
   *  生产者：task/starter.ts startTask + task/lifecycle.ts resumePausedTask →
   *  journal/baseline.ts captureTaskScanBaseline（任务事务提交后、kickoff 派发前）。
   *  注：2026-09-30 scan IPC 退役后基线暂无读取方（捕获链路保留，数据与
   *  迁移兼容）；曾由 journal/detector.ts scanUnjournaled 差集归因消费。
   *  键契约（跨模块单点）：path = workspace 根相对 POSIX 形态；contentHash =
   *  sha256 hex（recorder.hashContent），null = 捕获时文件不可读。meta 行存在
   *  即「有基线」——零脏工作区的合法空基线也有 meta 行（path 行为空数组），
   *  与「无基线」（getBaselineMeta 返回 null）可区分。 */
  /** 基线原子写入：meta 行 + 全部 path 行单事务 all-or-nothing（中途失败整笔回滚，
   *  与 insertMany 同语义——半份基线会让扫描归因半真半假） */
  insertBaseline(meta: BaselineMetaRow, paths: BaselinePathRow[]): void;
  /** 取基线 meta 行；null = 无基线（未捕获或捕获链路整体失败） */
  getBaselineMeta(workspaceId: string, taskId: string): BaselineMetaRow | null;
  /** 基线 path 行列表（path 升序）；无基线时为空数组 */
  listBaselinePaths(workspaceId: string, taskId: string): BaselinePathRow[];
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

/**
 * 递归目录字节求和（导出供 quota 等模块复用，避免重复实现；目录不存在 = 0）。
 * 与 sumBlobBytes 的语义差异：限定单目录根，不下钻到全局 userData 路径。
 */
export function walkDirBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    total += st.isDirectory() ? walkDirBytes(full) : st.size;
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
  const stmtListBySession = db.prepare(`
    SELECT * FROM journal_entries
    WHERE workspace_id = ? AND session_id = ?
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
  // 任务起点基线两表（迁移 049）语句——**惰性 prepare**：老夹具可能只建
  // journal_entries 局部 schema 而不跑全量迁移（如 revert-binary / office-tools
  // 测试库），构造期 prepare 会因 task_scan_baseline 缺表直接抛错。首次调用
  // 基线三方法才编译，非基线消费方零影响
  type SqliteStmt = Statement;
  let baselineStmts: {
    insertMeta: SqliteStmt;
    insertPath: SqliteStmt;
    getMeta: SqliteStmt;
    listPaths: SqliteStmt;
  } | null = null;
  const ensureBaselineStmts = (): {
    insertMeta: SqliteStmt;
    insertPath: SqliteStmt;
    getMeta: SqliteStmt;
    listPaths: SqliteStmt;
  } => {
    if (baselineStmts === null) {
      baselineStmts = {
        insertMeta: db.prepare(`
          INSERT INTO task_scan_baseline (workspace_id, task_id, captured_at, degraded)
          VALUES (?, ?, ?, ?)
        `),
        insertPath: db.prepare(`
          INSERT INTO task_scan_baseline_path (workspace_id, task_id, path, content_hash)
          VALUES (?, ?, ?, ?)
        `),
        getMeta: db.prepare(`
          SELECT captured_at, degraded FROM task_scan_baseline
          WHERE workspace_id = ? AND task_id = ?
        `),
        listPaths: db.prepare(`
          SELECT path, content_hash FROM task_scan_baseline_path
          WHERE workspace_id = ? AND task_id = ?
          ORDER BY path ASC
        `),
      };
    }
    return baselineStmts;
  };

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
    insertMany(entries: JournalEntry[]): void {
      if (entries.length === 0) return;
      const tx = db.transaction((list: JournalEntry[]) => {
        for (const e of list) {
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
        }
      });
      tx(entries);
    },
    listByTask(workspaceId: string, taskId: string): JournalEntry[] {
      return (stmtListByTask.all(workspaceId, taskId) as JournalEntryRow[]).map(rowToEntry);
    },
    listByStream(workspaceId: string, streamSessionId: string): JournalEntry[] {
      return (stmtListByStream.all(workspaceId, streamSessionId) as JournalEntryRow[]).map(
        rowToEntry,
      );
    },
    listBySession(workspaceId: string, sessionId: string): JournalEntry[] {
      return (stmtListBySession.all(workspaceId, sessionId) as JournalEntryRow[]).map(rowToEntry);
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
      return walkDirBytes(path.join(resolveUserDataDir(), 'journal'));
    },
    writeBlob(workspaceId: string, hash: string, content: string | Buffer): void {
      const file = resolveJournalDir(workspaceId, hash);
      // 内容寻址：同 hash 即同内容，已存在直接跳过（幂等，不重写不覆盖）
      if (fs.existsSync(file)) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof content === 'string' ? Buffer.from(content, 'utf-8') : content);
    },
    readBlob(workspaceId: string, hash: string): string | null {
      const file = resolveJournalDir(workspaceId, hash);
      if (!fs.existsSync(file)) return null;
      return fs.readFileSync(file, 'utf-8');
    },
    readBlobBytes(workspaceId: string, hash: string): Buffer | null {
      const file = resolveJournalDir(workspaceId, hash);
      if (!fs.existsSync(file)) return null;
      return fs.readFileSync(file);
    },
    dropBlobIfUnreferenced(workspaceId: string, hash: string): void {
      const { c } = stmtRefCount.get(workspaceId, hash, hash) as { c: number };
      if (c > 0) return;
      const file = resolveJournalDir(workspaceId, hash);
      if (fs.existsSync(file)) fs.rmSync(file);
    },
    insertBaseline(meta: BaselineMetaRow, paths: BaselinePathRow[]): void {
      // 单事务原子写：meta 行 + 全部 path 行 all-or-nothing（path 行 PK 冲突等
      // 中途失败时 meta 行一并回滚，杜绝「有 meta 无 path」的半份基线）
      const tx = db.transaction((m: BaselineMetaRow, list: BaselinePathRow[]) => {
        const stmts = ensureBaselineStmts();
        stmts.insertMeta.run(m.workspaceId, m.taskId, m.capturedAt, m.degraded ? 1 : 0);
        for (const p of list) {
          stmts.insertPath.run(m.workspaceId, m.taskId, p.path, p.contentHash);
        }
      });
      tx(meta, paths);
    },
    getBaselineMeta(workspaceId: string, taskId: string): BaselineMetaRow | null {
      const row = ensureBaselineStmts().getMeta.get(workspaceId, taskId) as
        | { captured_at: number; degraded: number }
        | undefined;
      return row
        ? { workspaceId, taskId, capturedAt: row.captured_at, degraded: row.degraded === 1 }
        : null;
    },
    listBaselinePaths(workspaceId: string, taskId: string): BaselinePathRow[] {
      const rows = ensureBaselineStmts().listPaths.all(workspaceId, taskId) as Array<{
        path: string;
        content_hash: string | null;
      }>;
      return rows.map((r) => ({ path: r.path, contentHash: r.content_hash }));
    },
  };
}
