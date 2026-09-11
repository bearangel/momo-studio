// electron/src/main/journal/types.ts
//
// 变更账本类型面（v2.5 变更账本与撤销，spec §5.2 + 实施计划精化）。
// 归组键为 stream_session_id（消息行流结束才落库，无 message_id 列）；
// task_id / session_id 可空对齐快速会话边界。

/** 文件变更操作四值域（migration v33 CHECK 约束同款锁定） */
export type JournalOp = 'create' | 'modify' | 'delete' | 'rename';

/** 账本条目：一次工具级文件变更的记账记录 */
export interface JournalEntry {
  id: string;
  workspaceId: string;
  /** 可空：快速会话无任务 */
  taskId: string | null;
  /** 可空：取自记账时 ctx.roomId（v2 会话 id 经此透传） */
  sessionId: string | null;
  /** 归组键：消息行流（UI 经 streamSessionId→message 反查定位消息） */
  streamSessionId: string;
  /** write_file / edit_file / apply_patch / rm / mv / undo */
  toolName: string;
  /** workspace 相对路径（展示与对账键） */
  path: string;
  op: JournalOp;
  /** sha256 hex；create 前 / delete 后为 null；rename 即旧内容 hash */
  beforeHash: string | null;
  afterHash: string | null;
  /** 仅 rename */
  oldPath: string | null;
  createdAt: number;
}

/**
 * list 通道视图（v2.5 Task 7 IPC）：条目 + blob 文本内容。
 * beforeText / afterText 由 readBlob 取内容并截断 100KB（防巨文件撑爆 IPC 通道）；
 * hash 为 null（create 前 / delete 后）或 blob 缺失时对应文本为 null。
 */
export interface JournalEntryView extends JournalEntry {
  beforeText: string | null;
  afterText: string | null;
}
