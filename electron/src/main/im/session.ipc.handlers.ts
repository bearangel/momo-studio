// electron/src/main/im/session.ipc.handlers.ts
//
// session: 命名空间 IPC handler（2.0.0 P1 Task 8）。
// 会话内核的 renderer 入口：生命周期（list/get/create/rename/delete）、
// 消息写入（send）、历史读取（getMessages/loadOlder）与导出（exportMessages）。
// 全部转调 Task 3 的 session-ops 与 Task 7 的 session-service——本层不含业务逻辑。
//
// 推送通道（Task 12 起 im:message 反向桥已移除，全部发送方统一新通道）：
//   - session:message             ← 用户/agent 消息行推送（session-service / p2p handleRemoteMessage）
//   - session:message_event_batch ← 流式 events 批量推送（stream-relay onFlush）

import { ipcMain } from 'electron';
import { logger } from '../logger';
import {
  getSessionsForWorkspace,
  createSession,
  renameSession,
  deleteSessionOp,
  getSessionMembersInfo,
} from './session-ops';
import { sendUserMessage } from './session-service';
import { getSession, type SessionRow } from '../storage/sessions/repo';
import {
  listMessagesBySession,
  listOlderMessages,
  type MessageRow,
} from '../storage/messages/repo';
import {
  listEventsByMessage,
  type MessageEventRow,
} from '../storage/messages/events-repo';
import { formatRoomToMarkdown, type ExportMessage } from './markdown-exporter';
import { listAssignments, getAgentDefinition } from '../agent/crud';
import { listWorkspaces } from '../workspace/crud';

/** 注册全部 session: 命名空间的 IPC handler。在 app ready 后由 registerIpcHandlers 统一调用。 */
export function registerSessionIpcHandlers(): void {
  // 会话列表（含成员）。workspaceId 缺省 → 全部 workspace（仅迁移/调试用）。
  ipcMain.handle('session:list', async (_evt, workspaceId?: string) => {
    return getSessionsForWorkspace(workspaceId);
  });

  // 单会话详情：session 行 + 成员信息。会话不存在抛错（renderer 转错误提示）。
  ipcMain.handle('session:get', async (_evt, sessionId: string) => {
    const session = getSession(sessionId);
    if (!session) throw new Error(`会话不存在: ${sessionId}`);
    return { session, members: getSessionMembersInfo(sessionId) };
  });

  // 创建会话（事务写入成员；FK 不合法整笔回滚——见 session-ops.createSession）。
  // handler 内显式映射，杜绝字段改名后结构化类型检查放过多余属性的漂移。
  ipcMain.handle(
    'session:create',
    async (
      _evt,
      input: {
        workspaceId: string;
        title: string;
        memberInstanceIds?: string[];
        kind?: SessionRow['kind'];
      },
    ) => {
      return createSession({
        workspaceId: input.workspaceId,
        title: input.title,
        memberInstanceIds: input.memberInstanceIds,
        kind: input.kind,
      });
    },
  );

  // 重命名。空串/空白校验由调用方（renderer UI）负责。
  ipcMain.handle('session:rename', async (_evt, sessionId: string, title: string) => {
    renameSession(sessionId, title);
    return { ok: true } as const;
  });

  // 解散会话。非保护会话级联清理成员；错误原样传播给 renderer
  //（v25 过渡态：团队会话保护待 Task 6 按新会话模型重接，见 session-ops）。
  ipcMain.handle('session:delete', async (_evt, sessionId: string) => {
    deleteSessionOp(sessionId);
    return { ok: true } as const;
  });

  // 用户消息写入：INSERT → touch → 推 session:message → P2P 广播 → 冲突检测 → 路由。
  ipcMain.handle(
    'session:send',
    async (_evt, sessionId: string, body: string, mentionedAssignmentIds?: string[]) => {
      return sendUserMessage({ sessionId, body, mentionedAssignmentIds });
    },
  );

  // 历史读取：messages + 每条 message 的 events（renderer 用 stream-aggregator 重建）。
  ipcMain.handle('session:getMessages', async (_evt, sessionId: string) => {
    return withEvents(listMessagesBySession(sessionId));
  });

  // 向前翻页：created_at < beforeTs 的消息；满批 hasMore=true（与 im:loadOlderMessages 同法）。
  ipcMain.handle(
    'session:loadOlder',
    async (_evt, sessionId: string, beforeTs: number, count = 30) => {
      const messages = listOlderMessages(sessionId, beforeTs, count);
      return { ...withEvents(messages), hasMore: messages.length >= count };
    },
  );

  // 导出会话最近 limit 条消息为 Markdown（从 im:exportRoomMessages 迁移核心逻辑）。
  // 返回 { filename, content }，renderer 用 Blob + 触发下载，无需主进程访问磁盘。
  ipcMain.handle(
    'session:exportMessages',
    async (_evt, sessionId: string, limit: number): Promise<{ filename: string; content: string }> => {
      // 1. 从 SQLite 拉 limit 条消息
      const rows = listMessagesBySession(sessionId, { limit });

      // 2. 反查 agent 名字：botNameMap 同时按 assignmentId（session 语义）与
      //    agentUserId（当前 agent 消息 sender 仍为 bot 的 Matrix userId）建立索引，
      //    两套 sender 标识都能命中。
      const botNameMap = new Map<string, string>();
      for (const ws of listWorkspaces()) {
        for (const a of listAssignments(ws.id)) {
          const def = getAgentDefinition(a.agentDefinitionId);
          if (def) {
            botNameMap.set(a.instanceId, def.name);
            botNameMap.set(a.agentUserId, def.name);
          }
        }
      }

      // 3. MessageRow → ExportMessage 适配（content 富字段留 message_events 重建，此处空对象）
      const exportMessages: ExportMessage[] = rows.map((m) => ({
        eventId: m.id,
        roomId: m.sessionId,
        sender: m.sender,
        body: m.body,
        eventType: m.eventType,
        content: {},
        timestamp: m.createdAt,
        botName: botNameMap.get(m.sender) ?? null,
      }));

      // 4. 取会话标题（找不到用 sessionId 兜底，因导出头需要非空 roomName）
      const roomName = getSession(sessionId)?.title ?? sessionId;

      // 5. 格式化 Markdown
      const content = formatRoomToMarkdown(exportMessages, {
        roomName: roomName || sessionId,
        roomId: sessionId,
        exportedAt: new Date(),
        requestedLimit: limit,
        actualCount: rows.length,
      });

      // 6. 生成 filename：momo-session-<safeTitle>-<YYYYMMDD-HHmm>.md
      const pad = (n: number): string => n.toString().padStart(2, '0');
      const d = new Date();
      const dateStr = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
      const sanitized =
        roomName
          .replace(/[^\w-]/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_|_$/g, '')
          .slice(0, 30) || sessionId;
      const filename = `momo-session-${sanitized}-${dateStr}.md`;

      return { filename, content };
    },
  );

  logger.info('Session IPC handlers 已注册');
}

/** messages 批 → { messages, eventsByMessage }（逐条拉 events，与 im:getMessages 同法） */
function withEvents(
  messages: MessageRow[],
): { messages: MessageRow[]; eventsByMessage: Record<string, MessageEventRow[]> } {
  const eventsByMessage: Record<string, MessageEventRow[]> = {};
  for (const m of messages) {
    eventsByMessage[m.id] = listEventsByMessage(m.id);
  }
  return { messages, eventsByMessage };
}
