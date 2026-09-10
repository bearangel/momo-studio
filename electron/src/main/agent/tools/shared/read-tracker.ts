// electron/src/main/agent/tools/shared/read-tracker.ts
// v2.3 Read-before-Edit：维护 streamSession 维度已读取文件集合。
// 子 agent 通过 parentStreamSessionId 判定，永远 fresh（不继承父 agent 已读状态，与 Memory 子 agent fresh-session 规则一致）。

export class ReadTracker {
  /** streamSessionId → 已读取 path 集合 */
  private sessionReads = new Map<string, Set<string>>();

  /** 标记某 session 已读取某 path */
  add(streamSessionId: string, path: string): void {
    let set = this.sessionReads.get(streamSessionId);
    if (!set) {
      set = new Set();
      this.sessionReads.set(streamSessionId, set);
    }
    set.add(path);
  }

  /** 检查某 session 是否已读取某 path */
  has(streamSessionId: string, path: string): boolean {
    return this.sessionReads.get(streamSessionId)?.has(path) ?? false;
  }

  /**
   * 强阻塞守门：未读时抛错。
   * parentStreamSessionId 非空（子 agent）→ 永远抛错（fresh-session 对齐）。
   */
  assertRead(streamSessionId: string, parentStreamSessionId: string | undefined, path: string): void {
    if (parentStreamSessionId !== undefined) {
      throw new Error(`文件未读取。请先调用 read_file 读取 ${path} 后再编辑。`);
    }
    if (!this.has(streamSessionId, path)) {
      throw new Error(`文件未读取。请先调用 read_file 读取 ${path} 后再编辑。`);
    }
  }

  /** 清理某 session 状态（会话结束时由 runtime-entry 调用） */
  clear(streamSessionId: string): void {
    this.sessionReads.delete(streamSessionId);
  }
}