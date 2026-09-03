// electron/src/main/memory/types.ts
//
// MemoryProvider 抽象接口 + 上下文数据结构。
//
// 设计动机：runtime 当前直接调 `loadRecentHistory` / `getTask` 拼上下文，
// 是 v1.0 临时路径——v2+ 需要：
//   1. agent "经验" 复用（同一 workspace / agent 在不同任务间学习到的偏好）
//   2. 跨任务记忆（task 完成后保留关键事件摘要）
//   3. LLM 总结 + 向量检索（自动从长历史抽出关键信息）
//
// v1 实现：SQLiteMemoryProvider——直接读 messages + message_events + tasks 表。
// v2+ 实现：可注入 FullMemoryProvider（加 LLM 总结 + 向量检索 + agent 偏好学习）。
// 接口不变，调用方无感切换。
import type { TaskRow } from '../storage/tasks/repo';
import type { MemoryEntry, SaveMemoryInput } from '../storage/memories/repo';
import type { PinnedMemoryView } from './injection';

export type { MemoryEntry, SaveMemoryInput } from '../storage/memories/repo';
export type { PinnedMemoryView } from './injection';

/**
 * task 关键事件摘要（一行人类可读）。
 *
 * v1 只从 message_events 抽关键事件类型（tool_call_start / result / dispatch / final 等），
 * 不展开 thinking_delta / text_delta（噪声大，agent 上下文会爆）。
 */
export interface TaskEventSummary {
  /** 事件在同一 message 内的 seq */
  seq: number;
  /** 事件类型（来自 message_events.eventType 白名单） */
  eventType: string;
  /** 一行人类可读摘要（中文，由 summarizeEvent 生成） */
  summary: string;
}

/**
 * 任务产出物——agent 在任务过程中读/写/改的文件。
 *
 * v1 从 tool_call_start 事件提取（payload.toolName + args.path）；
 * v2+ 可扩展为 git diff 模式（识别实际改动行）。
 */
export interface FileChange {
  toolName: string;
  path: string;
  action: 'read' | 'write' | 'edit';
}

/**
 * task 上下文——组装到 system prompt / 续聊上下文中的结构。
 */
export interface TaskContext {
  task: TaskRow;
  /** 关键事件摘要（已过滤 noise 事件） */
  events: TaskEventSummary[];
  /** 文件改动列表（去重后） */
  artifacts: FileChange[];
}

/**
 * 对话消息上下文项。
 *
 * role 由 sender 启发式判断（bot → assistant / owner → user）；
 * v2+ 应改用明确的 isBot 标志（避免 '@xxx.bot.yyy' 这种边界）。
 */
export interface ContextMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** ms epoch */
  timestamp: number;
  sender: string;
}

/**
 * 房间对话上下文。
 *
 * 用途：agent 续聊时加载最近 N 条消息（limit + beforeTs 实现分页）。
 */
export interface ConversationContext {
  messages: ContextMessage[];
}

/**
 * agent 学习到的偏好 + 模式。
 *
 * v1 stub 返回空数组；v2+ 实现应从历史成功 task 中归纳（"这个 agent 总是先 read_file
 * 再 edit_file" / "该 workspace 偏好先 typecheck 再 commit"）。
 */
export interface AgentContext {
  preferences: string[];
  learnedPatterns: string[];
}

/**
 * 用户偏好（per-user）。
 *
 * v1 stub；v2+ 应从历史交互中学习（"用户偏好简洁回答" / "用户经常问 TS 问题"）。
 */
export interface UserContext {
  preferences: string[];
}

/**
 * workspace 静态信息（建索引用）。
 */
export interface WorkspaceContext {
  workspaceId: string;
  workspaceName: string;
  directoryPath: string;
}

/**
 * 统一记忆访问抽象。
 *
 * 实现：
 *   - v1：SQLiteMemoryProvider（直接读 DB）
 *   - v2+：FullMemoryProvider（LLM 总结 + 向量检索 + 经验学习，可注入）
 *
 * 调用方：agent runtime 组装 system prompt / 续聊 / dispatch 上下文的统一入口。
 */
export interface MemoryProvider {
  /** 取 task 上下文（含关键事件 + 文件改动） */
  getTaskContext(taskId: string): Promise<TaskContext | null>;
  /** 取房间最近对话（按 createdAt 升序返回，limit + beforeTs 实现分页） */
  getConversationContext(
    sessionId: string,
    opts?: { limit?: number; beforeTs?: number },
  ): Promise<ConversationContext>;
  /** 取 agent 学习偏好（v1 stub） */
  getAgentContext(agentBotId: string): Promise<AgentContext>;
  /** 取用户偏好（v1 stub） */
  getUserContext(userId: string): Promise<UserContext>;
  /** 取 workspace 静态信息（不存在返回 null） */
  getWorkspaceContext(workspaceId: string): Promise<WorkspaceContext | null>;
  // —— v2.2 新增 ——
  /** 常驻注入视图（总开关关闭时返回空视图，spec §9） */
  getPinnedContext(opts: { workspaceId: string; sessionId: string | null }): Promise<PinnedMemoryView>;
  /** BM25 检索（命中条目递增 use_count） */
  searchMemories(query: string, scope: { workspaceId: string; sessionId: string | null }, limit?: number): Promise<MemoryEntry[]>;
  /** 写入记忆（pinned 缺省按 kind 推导：rule/preference=常驻） */
  saveMemory(input: SaveMemoryInput): Promise<MemoryEntry>;
  /** 删除记忆（不存在抛错） */
  deleteMemory(id: string): Promise<void>;
}
