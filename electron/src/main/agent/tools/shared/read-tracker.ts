// electron/src/main/agent/tools/shared/read-tracker.ts
// v2.3 Read-before-Edit：维护已读取文件集合。
// 2026-09-26 升级：会话（session）维度持久化 + 内容指纹守门。
//   - 键从 streamSessionId（回合，每条用户消息一个）→ sessionId：回合重置与
//     app 重启不再清空读账本——多回合开发、断点续跑后上下文里「已读过」的
//     文件不再被高频误拒
//   - add 时记录文件内容 sha1；assertRead 校验当前指纹——bash/外部改动后的
//     漂移被精准拦截（「文件在读取后被修改」），未漂移则放行
//   - 子 agent（parentStreamSessionId 非空）：读取不解锁任何编辑（add no-op），
//     编辑永远拒绝（fresh-session，与 Memory 子 agent 规则一致）
// 落库走子进程内 WAL 连接（与变更账本/MemoryTools 同源，见 runtime-entry）。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { getDb } from '../../../storage/db';
import { logger } from '../../../logger';

/** 读取未注册错误（与历史文案一致——agent 记忆里已学到该提示） */
const NOT_READ = (path: string) => `文件未读取。请先调用 read_file 读取 ${path} 后再编辑。`;
/** 读后漂移错误（指纹不匹配：bash / 外部改动） */
const DRIFTED = (path: string) =>
  `文件在读取后被修改（可能是 bash 或外部改动），读取指纹已失效。请重新调用 read_file 读取 ${path} 最新内容后再编辑。`;

/** 计算文件当前内容指纹；文件不可读返回 null */
function hashFile(abs: string): string | null {
  try {
    return createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
  } catch {
    return null;
  }
}

export class ReadTracker {
  /** sessionId → path → 读取时内容指纹（内存缓存；DB 为持久层） */
  private sessionReads = new Map<string, Map<string, string>>();

  /** 标记某 session 已读取某 path（记录当前内容指纹）。
   *  子 agent 的读取 no-op——不得解锁任何编辑（含父 agent）。 */
  add(sessionId: string, path: string, parentStreamSessionId?: string): void {
    if (parentStreamSessionId !== undefined) return;
    const hash = hashFile(path);
    if (hash === null) return;
    let set = this.sessionReads.get(sessionId);
    if (!set) {
      set = new Map();
      this.sessionReads.set(sessionId, set);
    }
    set.set(path, hash);
    try {
      getDb()
        .prepare(
          `INSERT INTO session_file_reads (session_id, path, content_hash, read_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id, path) DO UPDATE SET content_hash = excluded.content_hash, read_at = excluded.read_at`,
        )
        .run(sessionId, path, hash, Date.now());
    } catch (err) {
      // 持久化失败降级为内存语义（本进程内守门仍有效），不阻塞工具
      logger.warn('读账本落库失败（降级内存语义）', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 查询某 session 某 path 的读取指纹；内存未命中查 DB 并回填缓存 */
  private recordedHash(sessionId: string, path: string): string | null {
    const mem = this.sessionReads.get(sessionId)?.get(path);
    if (mem !== undefined) return mem;
    try {
      const row = getDb()
        .prepare('SELECT content_hash FROM session_file_reads WHERE session_id = ? AND path = ?')
        .get(sessionId, path) as { content_hash: string } | undefined;
      if (!row) return null;
      let set = this.sessionReads.get(sessionId);
      if (!set) {
        set = new Map();
        this.sessionReads.set(sessionId, set);
      }
      set.set(path, row.content_hash);
      return row.content_hash;
    } catch {
      return null;
    }
  }

  /** 检查某 session 是否已读取某 path（指纹在库） */
  has(sessionId: string, path: string): boolean {
    return this.recordedHash(sessionId, path) !== null;
  }

  /**
   * 强阻塞守门：未读或读后漂移时抛错。
   * parentStreamSessionId 非空（子 agent）→ 永远抛错（fresh-session 对齐）。
   */
  assertRead(sessionId: string, parentStreamSessionId: string | undefined, path: string): void {
    if (parentStreamSessionId !== undefined) {
      throw new Error(NOT_READ(path));
    }
    const recorded = this.recordedHash(sessionId, path);
    if (recorded === null) {
      throw new Error(NOT_READ(path));
    }
    const current = hashFile(path);
    if (current === null || current !== recorded) {
      throw new Error(DRIFTED(path));
    }
  }

  /** 清理某 session 的内存缓存（DB 持久层保留——重开会话仍有效，指纹校验保安全） */
  clear(sessionId: string): void {
    this.sessionReads.delete(sessionId);
  }
}
