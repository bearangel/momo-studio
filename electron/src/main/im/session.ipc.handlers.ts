// electron/src/main/im/session.ipc.handlers.ts
//
// session: 命名空间 IPC handler（2.0.0 P1 Task 8；v25 Task 6 双会话通道面）。
// 会话内核的 renderer 入口：生命周期（list/get/createQuick/createCollab/rename/delete）、
// 消息写入（send）、历史读取（getMessages/loadOlder）与导出（exportMessages）。
// 全部转调 session-ops / session-service / team 服务——本层不含业务逻辑。
//
// v25 Task 7：createQuick / createCollab 接入 session-ops 真双流程
// （默认 agent 直达 / 团队快照 + is_leader + title_auto，spec §4.4）；
// 通道契约（名称/入参/错误码）与 Task 6 锁定版保持不变。
//
// 推送通道（Task 12 起 im:message 反向桥已移除，全部发送方统一新通道）：
//   - session:message             ← 用户/agent 消息行推送（session-service / p2p handleRemoteMessage）
//   - session:message_event_batch ← 流式 events 批量推送（stream-relay onFlush）

import { ipcMain } from 'electron';
import { logger } from '../logger';
import {
  getSessionsForWorkspace,
  createQuickSession,
  createCollabSession,
  renameSession,
  deleteSessionOp,
  getSessionMembersInfo,
  type SessionSummary,
  type CollabTarget,
} from './session-ops';
import { sendUserMessage } from './session-service';
import { getSession, type SessionRow } from '../storage/sessions/repo';
import {
  listMessagesBySession,
  listRecentMessagesBySession,
  listOlderMessages,
  countOwnerMessages,
  type MessageRow,
} from '../storage/messages/repo';
import {
  listEventsByMessage,
  type MessageEventRow,
} from '../storage/messages/events-repo';
import { formatRoomToMarkdown, type ExportMessage } from './markdown-exporter';
import { listMembers, getAgentDefinition } from '../agent/crud';
import { listWorkspaces } from '../workspace/crud';
import { scheduleExtraction, TRIGGER_TURN_INTERVAL } from '../memory/extraction';

/** SessionRow → SessionSummary（createQuick/createCollab 返回形状；members 现查） */
function toSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    titleAuto: row.titleAuto,
    kind: row.kind,
    lastMessageAt: row.lastMessageAt,
    members: getSessionMembersInfo(row.id),
  };
}

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

  // 快速会话（spec §4.4）：session-ops 读 workspace 默认 agent 直达；
  // 无默认 reject NoDefaultAgentError（message 含 NO_DEFAULT_AGENT，
  // renderer 识别后弹一次性选择/引导）。
  ipcMain.handle('session:createQuick', async (_evt, workspaceId: string) => {
    const row = createQuickSession(workspaceId);
    logger.info('快速会话已创建', { sessionId: row.id, workspaceId });
    return toSummary(row);
  });

  // 协作会话（spec §4.4）：单 agent 直建；团队目标在 session-ops 展开当前成员
  // 快照（leader 成员 is_leader=1）。title 留空 → 占位标题 + title_auto=1
  // （Task 8 命名服务接管，spec D4）；用户命名 → title_auto=0。
  ipcMain.handle(
    'session:createCollab',
    async (_evt, workspaceId: string, title: string | undefined, target: CollabTarget) => {
      const row = createCollabSession(workspaceId, title ?? null, target);
      logger.info('协作会话已创建', { sessionId: row.id, workspaceId, targetType: target.type });
      return toSummary(row);
    },
  );

  // 重命名。空串/空白校验由调用方（renderer UI）负责。
  ipcMain.handle('session:rename', async (_evt, sessionId: string, title: string) => {
    renameSession(sessionId, title);
    return { ok: true } as const;
  });

  // 解散会话。非保护会话级联清理成员；错误原样传播给 renderer
  //（v25 过渡态：团队会话保护待 Task 7 按新会话模型重接，见 session-ops）。
  ipcMain.handle('session:delete', async (_evt, sessionId: string) => {
    deleteSessionOp(sessionId);
    return { ok: true } as const;
  });

  // 用户消息写入：INSERT → touch → 推 session:message → P2P 广播 → 冲突检测 → 路由。
  ipcMain.handle(
    'session:send',
    async (_evt, sessionId: string, body: string, mentionedInstanceIds?: string[]) => {
      const result = await sendUserMessage({ sessionId, body, mentionedInstanceIds });
      // v2.2 记忆 P2（spec §6.4 触发点）：用户消息落库成功后按轮次间隔触发自动提取。
      // owner 消息数（含本条）% TRIGGER_TURN_INTERVAL === 0 时触发；fire-and-forget。
      // 计数失败仅告警——消息已落库并路由，绝不能因提取触发拖垮 send 返回（spec §8）。
      try {
        const ownerCount = countOwnerMessages(sessionId);
        if (ownerCount > 0 && ownerCount % TRIGGER_TURN_INTERVAL === 0) {
          scheduleExtraction(sessionId);
        }
      } catch (err) {
        logger.warn('记忆提取轮次计数失败（不影响消息发送）', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return result;
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
  // 2026-09-06 导出/显示对齐：取数改「最近 N 条」（原 ASC+LIMIT 实为最早 N 条）；
  // 过滤与分段归组对齐 renderer MessageList.tsx / group-segments.ts 显示语义。
  ipcMain.handle(
    'session:exportMessages',
    async (_evt, sessionId: string, limit: number): Promise<{ filename: string; content: string }> => {
      // 1. 从 SQLite 拉最近 limit 条（升序输出）
      const rows = listRecentMessagesBySession(sessionId, limit);

      // 2. 显示侧对齐（MessageList.tsx 同款过滤 + group-segments.ts 同款分段归组）：
      //    dispatch/task_reply/子 agent 顶层条目在显示侧不独立渲染，导出同样剔除；
      //    分段消息（segmentOf）替换父消息位置——父消息全文与分段快照二选一，防重复。
      const visible = rows.filter((m) => {
        if (m.eventType === 'io.momo.studio.dispatch') return false;
        if (m.eventType === 'io.momo.studio.task_reply') return false;
        if (m.parentStreamSessionId) return false;
        return true;
      });
      const segmentsByParent = new Map<string, typeof rows>();
      for (const m of rows) {
        if (m.segmentOf === null) continue;
        const list = segmentsByParent.get(m.segmentOf);
        if (list) {
          list.push(m);
        } else {
          segmentsByParent.set(m.segmentOf, [m]);
        }
      }
      for (const list of segmentsByParent.values()) {
        list.sort((a, b) => (a.segmentIndex ?? 0) - (b.segmentIndex ?? 0));
      }
      const replacedParents = new Set<string>();
      const entries: typeof rows = [];
      for (const m of visible) {
        if (m.segmentOf !== null) continue; // 分段由父消息位置承载（或走孤儿兜底）
        const segments = m.streamSessionId ? segmentsByParent.get(m.streamSessionId) : undefined;
        if (segments && segments.length > 0 && m.streamSessionId) {
          replacedParents.add(m.streamSessionId);
          entries.push(...segments);
        } else {
          entries.push(m);
        }
      }
      for (const [parentStreamId, segments] of segmentsByParent) {
        if (replacedParents.has(parentStreamId)) continue;
        entries.push(...segments); // 孤儿分段：父消息不在取数窗口，兜底导出防丢失
      }
      entries.sort((a, b) => a.createdAt - b.createdAt);

      // 3. 反查 agent 名字：botNameMap 同时按 assignmentId（session 语义）与
      //    agentUserId（当前 agent 消息 sender 仍为 bot 的 Matrix userId）建立索引，
      //    两套 sender 标识都能命中。
      const botNameMap = new Map<string, string>();
      for (const ws of listWorkspaces()) {
        for (const a of listMembers(ws.id)) {
          const def = getAgentDefinition(a.agentDefinitionId);
          if (def) {
            botNameMap.set(a.instanceId, def.name);
            botNameMap.set(a.agentUserId, def.name);
          }
        }
      }

      // 4. MessageRow → ExportMessage 适配（content 富字段留 message_events 重建，此处空对象）
      const exportMessages: ExportMessage[] = entries.map((m) => ({
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
