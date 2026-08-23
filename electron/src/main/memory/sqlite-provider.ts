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
import type {
  MemoryProvider,
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

  async getUserContext(_userId: string): Promise<UserContext> {
    return { preferences: [] };
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
}

/**
 * message → ContextMessage 转换。
 *
 * role 启发式：
 *   - sender 含 'bot'（@bot / .bot. 等） → assistant
 *   - 其余 → user
 *
 * 这是 v1 简化判断——B10 任务工具集成时应改成接收 message 内的显式 isBot 标志
 * （matrix user id 命名约定不可靠，跨 homeserver 时 '@bot:home' 可能不是 agent）。
 */
function messageToContext(m: MessageRow): ContextMessage {
  const isBot = m.sender.includes('bot');
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