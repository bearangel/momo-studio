// electron/src/main/memory/sqlite-provider.ts
//
// v1 MemoryProvider 实现：直接读 SQLite messages + message_events + tasks + workspaces 表。
// 无 LLM 总结、无向量检索、无 agent 经验学习——v2+ 可替换为 FullMemoryProvider，
// 同接口调用方无感升级。
//
// 实现要点：
//   - getTaskContext：从 messages(task_id=?) 拿所有相关 message，再 listEventsByMessage 拉事件，
//     按 KEY_EVENT_TYPES 白名单过滤（剔除 thinking_delta/text_delta 这类 noise），
//     同时从 tool_call_start 提取文件改动作为 artifacts。
//   - getConversationContext：直接调 listMessagesBySession，role 用 sender 启发式判断（bot→assistant/owner→user）。
//   - getAgentContext / getUserContext：v1 stub——返回空对象，调用方代码已就绪，
//     v2 加实现时无需改调用方。
//   - getWorkspaceContext：单表 SELECT，无 join。
import { getDb } from '../storage/db';
import { getTask } from '../storage/tasks/repo';
import {
  listMessagesBySession,
  type MessageRow,
} from '../storage/messages/repo';
import {
  listEventsByMessage,
  type MessageEventRow,
} from '../storage/messages/events-repo';
import { getGlobalSettings } from '../settings/crud';
import {
  insertMemory,
  deleteMemory as repoDelete,
  listMemories,
  touchMemoryUsed,
} from '../storage/memories/repo';
import { searchMemories } from '../storage/memories/search';
import { buildPinnedView, CATALOG_MAX_ROWS, type PinnedParts, type PinnedMemoryView } from './injection';
import { logger } from '../logger';
import type { MemoryEntry, SaveMemoryInput } from '../storage/memories/repo';
import type {
  MemoryProvider,
  MemorySearchOpts,
  TaskContext,
  TaskEventSummary,
  FileChange,
  ConversationContext,
  ContextMessage,
  AgentContext,
  UserContext,
  WorkspaceContext,
} from './types';

/**
 * task 上下文纳入的关键事件白名单。
 *
 * 余下事件类型（thinking_delta / text_delta / todo_update）不进 task 摘要——
 * thinking/text 是流式增量，聚合后价值低且 token 多；todo_update 由 TodoSection
 * 在 UI 层单独展示。
 */
const KEY_EVENT_TYPES: ReadonlySet<string> = new Set([
  'tool_call_start',
  'tool_call_result',
  'dispatch_start',
  'dispatch_result',
  'segment_boundary',
  'status_change',
  'final',
]);

/**
 * 文件操作工具 → 文件动作映射。
 *
 * 不在表内的工具（含所有非文件类工具：bash / grep / glob / git_* / webfetch / todowrite /
 * dispatch:* / mcp:*）跳过——避免误把 bash 输出当作文件改动。
 */
const FILE_TOOL_ACTIONS: Record<string, 'read' | 'write' | 'edit'> = {
  read_file: 'read',
  list_files: 'read',
  exists: 'read',
  write_file: 'write',
  mkdir: 'write',
  rm: 'write',
  mv: 'write',
  edit_file: 'edit',
};

export class SQLiteMemoryProvider implements MemoryProvider {
  async getTaskContext(taskId: string): Promise<TaskContext | null> {
    const task = getTask(taskId);
    if (!task) return null;

    // 找 task 关联的所有 messages（按时间）
    const db = getDb();
    const msgRows = db
      .prepare(
        `SELECT id FROM messages WHERE task_id = ? ORDER BY created_at ASC`,
      )
      .all(taskId) as Array<{ id: string }>;

    const summaries: TaskEventSummary[] = [];
    // 用 Set 去重 file path（同一文件多次 read 只记一次），保持 artifacts 简洁
    const seenArtifacts = new Set<string>();
    const artifacts: FileChange[] = [];

    for (const m of msgRows) {
      const events = listEventsByMessage(m.id);
      for (const e of events) {
        if (!KEY_EVENT_TYPES.has(e.eventType)) continue;
        summaries.push({
          seq: e.seq,
          eventType: e.eventType,
          summary: summarizeEvent(e),
        });
        // 收集文件改动（仅 tool_call_start 携带 args）
        if (e.eventType === 'tool_call_start') {
          const toolName = e.payload.toolName as string | undefined;
          const args = e.payload.args as { path?: string } | undefined;
          if (
            toolName &&
            FILE_TOOL_ACTIONS[toolName] &&
            typeof args?.path === 'string'
          ) {
            const key = `${toolName}:${args.path}`;
            if (!seenArtifacts.has(key)) {
              seenArtifacts.add(key);
              artifacts.push({
                toolName,
                path: args.path,
                action: FILE_TOOL_ACTIONS[toolName],
              });
            }
          }
        }
      }
    }

    return { task, events: summaries, artifacts };
  }

  async getConversationContext(
    sessionId: string,
    opts?: { limit?: number; beforeTs?: number },
  ): Promise<ConversationContext> {
    const messages = listMessagesBySession(sessionId, {
      limit: opts?.limit,
      beforeTs: opts?.beforeTs,
    });
    const ctx: ContextMessage[] = messages.map((m) => messageToContext(m));
    return { messages: ctx };
  }

  async getAgentContext(_agentBotId: string): Promise<AgentContext> {
    return { preferences: [], learnedPatterns: [] };
  }

  /** v2.2 真实化：全局 preference 条目（团队共享语义，无 agent 私有维度） */
  async getUserContext(_userId: string): Promise<UserContext> {
    return {
      preferences: listMemories({ kind: 'global' }, { kind: 'preference' }).map((m) => m.content),
    };
  }

  async getWorkspaceContext(
    workspaceId: string,
  ): Promise<WorkspaceContext | null> {
    const db = getDb();
    const row = db
      .prepare(`SELECT id, name, directory_path FROM workspaces WHERE id = ?`)
      .get(workspaceId) as
      | { id: string; name: string; directory_path: string }
      | undefined;
    if (!row) return null;
    return {
      workspaceId: row.id,
      workspaceName: row.name,
      directoryPath: row.directory_path,
    };
  }

  /**
   * v2.2：常驻注入视图（每轮现拉；总开关关闭返回空视图，spec §9）。
   * 整体 try/catch：底层 SQLite 异常（如 FTS CORRUPT_VTAB 形态，P1 实证）降级为空视图，
   * 绝不让注入阻塞消息处理主链路。
   */
  async getPinnedContext(opts: { workspaceId: string; sessionId: string | null }): Promise<PinnedMemoryView> {
    try {
      if (!getGlobalSettings().memoryEnabled) return { hint: '', truncatedCount: 0, pinnedIds: [] };
      const globalPinned = listMemories({ kind: 'global' }, { pinned: true });
      const workspacePinned = opts.workspaceId
        ? listMemories({ kind: 'workspace', workspaceId: opts.workspaceId }, { pinned: true })
        : [];
      // 会话层常驻条目：子 agent（sessionId=null）不带会话记忆（fresh-session 对齐）
      const sessionPinned = opts.sessionId
        ? listMemories({ kind: 'session', sessionId: opts.sessionId }, { pinned: true })
        : [];
      let sessionSummary: PinnedParts['sessionSummary'] = null;
      if (opts.sessionId) {
        const row = getDb().prepare(
          'SELECT summary, covered_until, updated_at FROM session_summaries WHERE session_id = ?',
        ).get(opts.sessionId) as { summary: string; covered_until: number; updated_at: number } | undefined;
        if (row) sessionSummary = { summary: row.summary, coveredUntil: row.covered_until, updatedAt: row.updated_at };
      }
      // 检索型目录：global + 本 ws（+ 本会话）各路 SQL LIMIT 封顶拉取（免全量拉取后内存 slice），
      // 合并限量与溢出计数由 buildPinnedView 统一执行
      const catalog = [
        ...listMemories({ kind: 'global' }, { pinned: false }, CATALOG_MAX_ROWS),
        ...listMemories({ kind: 'workspace', workspaceId: opts.workspaceId }, { pinned: false }, CATALOG_MAX_ROWS),
        ...(opts.sessionId
          ? listMemories({ kind: 'session', sessionId: opts.sessionId }, { pinned: false }, CATALOG_MAX_ROWS)
          : []),
      ];
      return buildPinnedView({ globalPinned, workspacePinned, sessionPinned, sessionSummary, catalog });
    } catch (err) {
      logger.error('getPinnedContext 失败，降级为空视图（不阻塞消息处理）', {
        workspaceId: opts.workspaceId,
        sessionId: opts.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { hint: '', truncatedCount: 0, pinnedIds: [] };
    }
  }

  async searchMemories(
    query: string,
    scope: { workspaceId: string; sessionId: string | null },
    limit = 10,
    opts?: MemorySearchOpts,
  ): Promise<MemoryEntry[]> {
    // touch 分支只存在于本 provider 包装层——storage 层检索永不 touch。
    // opts.touch=false（P3 I-1）：去重探测等内部用途不递增 use_count/last_used_at；
    // opts.scopeKind（P3 M-3）透传 storage 层单层收窄
    const hits = searchMemories(
      query,
      scope,
      limit,
      opts?.scopeKind !== undefined ? { scopeKind: opts.scopeKind } : undefined,
    );
    if (hits.length > 0 && opts?.touch !== false) touchMemoryUsed(hits.map((h) => h.id));
    return hits;
  }

  async saveMemory(input: SaveMemoryInput): Promise<MemoryEntry> {
    return insertMemory(input);
  }

  async deleteMemory(id: string): Promise<void> {
    repoDelete(id);
  }
}

/**
 * message → ContextMessage 转换。
 *
 * role 启发式（v2 P1）：
 *   - sender === 'owner' → user（用户在 v2 会话里的固定身份字符串）
 *   - 其余（含旧 '@bot:home' 与新 'agent-<slug>-<suffix>'）→ assistant
 *
 * 原本用 `m.sender.includes('bot')` 子串判定——v2 新身份 'agent-coder-a1b2c3'
 * 不含 'bot'，导致 agent 历史被注入为 role 'user'，LLM 上下文错乱。改为只
 * 排除唯一的 'owner' 标识，其余一律视为 agent/assistant。
 *
 * 后续若引入更多用户身份字符串，再扩展 allowlist 即可（不引入黑名单 'bot'
 * 等不可靠字符串匹配）。
 */
function messageToContext(m: MessageRow): ContextMessage {
  const isBot = m.sender !== 'owner';
  return {
    role: isBot ? 'assistant' : 'user',
    content: m.body,
    timestamp: m.createdAt,
    sender: m.sender,
  };
}

/**
 * 把事件 payload 压成一行人类可读摘要。
 *
 * 错误/缺失字段 fallback 到事件类型字符串——确保任何 payload 结构都能产出摘要
 * （LLM 上下文不会因为缺字段而拿到 undefined）。
 */
function summarizeEvent(e: MessageEventRow): string {
  switch (e.eventType) {
    case 'tool_call_start': {
      const name = e.payload.toolName as string | undefined;
      const args = e.payload.args as { path?: string } | undefined;
      return `调用工具 ${name ?? '?'}${args?.path ? ` (${args.path})` : ''}`;
    }
    case 'tool_call_result': {
      const success = e.payload.success === true;
      return `工具结果 ${success ? '✓' : '✗'}`;
    }
    case 'dispatch_start': {
      const name = e.payload.subAgentName as string | undefined;
      return `派发子 agent ${name ?? '?'}`;
    }
    case 'dispatch_result': {
      const status = e.payload.status as string | undefined;
      return `子 agent ${status ?? '?'}`;
    }
    case 'final':
      return '任务完成';
    case 'segment_boundary':
      return `分段 ${String(e.payload.index ?? '?')}`;
    case 'status_change':
      return `状态变更: ${String(e.payload.status ?? '?')}`;
    default:
      return e.eventType;
  }
}