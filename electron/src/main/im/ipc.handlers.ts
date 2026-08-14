// electron/src/main/im/ipc.handlers.ts
//
// IM 相关 IPC handler 注册入口。
// 暴露给渲染进程的能力：启动 /sync、发送消息、查询房间列表和历史消息。
// 实际的 Matrix 操作委托给 matrix/sync-manager。
//
// v2.0 A 子系统：历史消息读路径已切换到 SQLite（messages + message_events 表）。
//   - im:getMessages / im:loadOlderMessages / im:getMessageEvents 直接走 SQLite repo
//   - im:exportRoomMessages 也改读 SQLite（content 富字段丢失，A9 改造 markdown-exporter 时补齐）
//   - Matrix sync-manager 仍负责实时消息推送（im:message）和房间列表
import { ipcMain, BrowserWindow } from 'electron';
import { logger } from '../logger';
import { startConduit } from '../conduit/manager';
import {
  startSyncFromSession,
  sendMessage,
  sendMessageWithMentions,
  getRoomsForWorkspace,
} from '../matrix/sync-manager';
import { getCurrentUserId } from '../matrix/session';
import { formatRoomToMarkdown, type ExportMessage } from './markdown-exporter';
import { listAssignments, getAgentDefinition } from '../agent/crud';
import { listWorkspaces } from '../workspace/crud';
import {
  insertMessage,
  updateMessageMatrixEventId,
  listMessagesByRoom,
  listOlderMessages,
  type MessageRow,
} from '../storage/messages/repo';
import {
  listEventsByMessage,
  type MessageEventRow,
} from '../storage/messages/events-repo';
import { broadcastLocalMessage } from '../p2p';
import { detectConflict } from '../task/conflict-detector';
import { listTasks, getTask } from '../storage/tasks/repo';

/** 注册全部 im: 命名空间的 IPC handler。在 app ready 后由 registerIpcHandlers 统一调用。 */
export function registerImHandlers(): void {
  // 先等 Conduit 就绪：renderer 在 app 启动早期就调 im:startSync，
  // 此时 Conduit 可能还没 bind 端口（RocksDB 打开 + schema migration 需要数百 ms）。
  // startConduit 内部有 pendingStart 去重，多次调用安全。
  ipcMain.handle('im:startSync', async () => {
    await startConduit();
    await startSyncFromSession();
  });

  // A final fix（C1）：用户消息写路径补齐 SQLite INSERT。
  // spec 写路径：im:send → INSERT messages row（source='local'）→ push im:message →
  //   发 Matrix → 回填 matrix_event_id。重启后 im:getMessages 直接从 SQLite 还原用户消息，
  //   不再依赖 Matrix /sync 回放（旧路径载荷 id=undefined 导致错序/重复/字段缺失）。
  ipcMain.handle('im:send', async (_evt, roomId: string, body: string) => {
    await sendUserMessage(roomId, body);
  });

  ipcMain.handle('im:sendWithMentions', async (_evt, roomId: string, body: string, userIds: string[]) => {
    await sendUserMessage(roomId, body, userIds);
  });

  // 获取已加入的房间列表（含房间名）。workspaceId 提供时只返回该 workspace 范围内的房间。
  ipcMain.handle('im:getRooms', async (_evt, workspaceId?: string) => {
    return getRoomsForWorkspace(workspaceId);
  });

  // A 子系统：从 SQLite 读 messages + 每条 message 的 events（替代旧 getRoomMessages）
  ipcMain.handle('im:getMessages', async (_evt, roomId: string) => {
    const messages = listMessagesByRoom(roomId);
    const eventsByMessage: Record<string, MessageEventRow[]> = {};
    for (const m of messages) {
      eventsByMessage[m.id] = listEventsByMessage(m.id);
    }
    return { messages, eventsByMessage };
  });

  // A 子系统：向前翻页——返回 SQLite 里 created_at < beforeTs 的消息
  ipcMain.handle('im:loadOlderMessages', async (_evt, roomId: string, beforeTs: number, count = 30) => {
    const messages = listOlderMessages(roomId, beforeTs, count);
    const eventsByMessage: Record<string, MessageEventRow[]> = {};
    for (const m of messages) {
      eventsByMessage[m.id] = listEventsByMessage(m.id);
    }
    // hasMore: 如果本批满了，可能还有更早的
    const hasMore = messages.length >= count;
    return { messages, eventsByMessage, hasMore };
  });

  // A 子系统：拉取单条 message 的全部 events（按 seq 升序）
  ipcMain.handle('im:getMessageEvents', async (_evt, messageId: string) => {
    return listEventsByMessage(messageId);
  });

  // 新建房间（私聊/群组）
  ipcMain.handle(
    'im:createRoom',
    async (_evt, input: { name: string; isDirect: boolean; inviteUserIds: string[] }) => {
      const { createRoom } = await import('./room-ops');
      return createRoom(input);
    },
  );

  // 重命名房间
  ipcMain.handle('im:renameRoom', async (_evt, roomId: string, name: string) => {
    const { renameRoom } = await import('./room-ops');
    await renameRoom(roomId, name);
    return { ok: true };
  });

  // 解散/退出房间（自适应）
  ipcMain.handle('im:dissolveRoom', async (_evt, roomId: string) => {
    const { dissolveRoom } = await import('./room-ops');
    return dissolveRoom(roomId);
  });

  // 查询房间成员
  ipcMain.handle('im:getMembers', async (_evt, roomId: string) => {
    const { getRoomMembers } = await import('./room-ops');
    return getRoomMembers(roomId);
  });

  // 导出指定房间最近 limit 条会话为 Markdown 文件。
  // 返回 { filename, content }，renderer 用 Blob + 触发下载，无需主进程访问磁盘。
  //
  // v2.0 A 子系统过渡：已切换到从 SQLite 读 messages。当前限制：MessageRow 无 content
  // 富字段，thinking/tool_calls/dispatch 元数据丢失（content 仅填空对象）。
  // A9 改造 markdown-exporter 时会改从 message_events 表 + aggregateEvents 重建这些字段。
  ipcMain.handle(
    'im:exportRoomMessages',
    async (_evt, roomId: string, limit: number): Promise<{ filename: string; content: string }> => {
      // 1. 从 SQLite 拉 limit 条消息
      const rows = listMessagesByRoom(roomId, { limit });

      // 2. 反查 agent name：listAssignments 需要 workspaceId，所以遍历所有 workspace，
      //    收集全部 assignment，构造 botUserId → agentName 映射。
      const botNameMap = new Map<string, string>();
      for (const ws of listWorkspaces()) {
        for (const a of listAssignments(ws.id)) {
          const def = getAgentDefinition(a.agentDefinitionId);
          if (def) botNameMap.set(a.botMatrixUserId, def.name);
        }
      }

      // 3. MessageRow → ExportMessage 适配（content 暂为空对象，A9 补齐富字段）
      const exportMessages: ExportMessage[] = rows.map((m) => ({
        eventId: m.matrixEventId ?? m.id,
        roomId: m.roomId,
        sender: m.sender,
        body: m.body,
        eventType: m.eventType,
        content: {},
        timestamp: m.createdAt,
        botName: botNameMap.get(m.sender) ?? null,
      }));

      // 4. 取房间名（找不到用 roomId 兜底，因 formatRoomToMarkdown 头部需要非空 roomName）
      const roomName = getRoomsForWorkspace().find((r) => r.roomId === roomId)?.name ?? '';

      // 5. 格式化 Markdown
      const content = formatRoomToMarkdown(exportMessages, {
        roomName: roomName || roomId,
        roomId,
        exportedAt: new Date(),
        requestedLimit: limit,
        actualCount: rows.length,
      });

      // 6. 生成 filename：momo-session-<safeRoomName>-<YYYYMMDD-HHmm>.md
      const pad = (n: number): string => n.toString().padStart(2, '0');
      const d = new Date();
      const dateStr = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
      const sanitized =
        (roomName || roomId)
          .replace(/[^\w-]/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_|_$/g, '')
          .slice(0, 30) || roomId;
      const filename = `momo-session-${sanitized}-${dateStr}.md`;

      return { filename, content };
    },
  );

  logger.info('IM IPC handlers 已注册');
}

/**
 * 用户消息写路径（A final fix C1）。
 * 顺序：INSERT SQLite（source='local'）→ push MessageRow → 发 Matrix → 回填 matrix_event_id。
 * - INSERT 在发送前：本地优先，Matrix 发送失败时消息仍在 SQLite，重启可还原。
 * - push 在发送前：renderer 立即显示（无需等 Matrix 往返）。
 * - matrix_event_id 回填：sync-manager 用它在 /sync 回声中按 sender=本地用户跳过，避免重复。
 *   即使回填前 /sync 已到，本地用户消息也会被 sync-manager 第二层去重拦截。
 */
async function sendUserMessage(
  roomId: string,
  body: string,
  mentionedUserIds?: string[],
): Promise<void> {
  const ownerUserId = getCurrentUserId();
  if (!ownerUserId) throw new Error('未登录，无法发送消息');

  const msg = insertMessage({
    roomId,
    sender: ownerUserId,
    eventType: 'm.room.message',
    body,
  });
  pushMessageRow(msg);

  try {
    const { eventId } = mentionedUserIds
      ? await sendMessageWithMentions(roomId, body, mentionedUserIds)
      : await sendMessage(roomId, body);
    if (eventId) updateMessageMatrixEventId(msg.id, eventId);
  } catch (err) {
    logger.warn('Matrix 发送失败，消息仅保留在本地 SQLite', { error: (err as Error).message });
  }

  // C 子系统：本地新消息 fire-and-forget 广播给信任的 P2P 对端。
  // sync 未初始化时 broadcastLocalMessage 静默返回，无副作用。
  void broadcastLocalMessage({
    roomId,
    sender: ownerUserId,
    body,
    eventType: 'm.room.message',
  });

  // B 子系统：冲突触发检测。当前房间是某 in_progress 任务的 execution_room 且消息
  // mention 了另一个任务时，推 im:conflict 事件给 renderer 弹 ConflictDialog。
  const conflict = detectConflict(roomId, body, {
    findInProgressTaskByRoom: (r) =>
      listTasks({ executionRoomId: r, status: 'in_progress', limit: 1 })[0] ?? null,
    getTask,
  });
  if (conflict) {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('im:conflict', conflict);
    }
  }
}

/** 推送 SQLite MessageRow 到 renderer（与 ImMessage 字段完全对齐，跨 IPC 形状一致） */
function pushMessageRow(msg: MessageRow): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  win.webContents.send('im:message', msg);
}
