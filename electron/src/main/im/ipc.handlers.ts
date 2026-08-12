// electron/src/main/im/ipc.handlers.ts
//
// IM 相关 IPC handler 注册入口。
// 暴露给渲染进程的能力：启动 /sync、发送消息、查询房间列表和历史消息。
// 实际的 Matrix 操作委托给 matrix/sync-manager。
import { ipcMain } from 'electron';
import { logger } from '../logger';
import { startConduit } from '../conduit/manager';
import {
  startSyncFromSession,
  sendMessage,
  sendMessageWithMentions,
  getRoomsForWorkspace,
  getRoomMessages,
  loadOlderMessages,
} from '../matrix/sync-manager';
import { formatRoomToMarkdown, type ExportMessage } from './markdown-exporter';
import { listAssignments, getAgentDefinition } from '../agent/crud';
import { listWorkspaces } from '../workspace/crud';

/** 注册全部 im: 命名空间的 IPC handler。在 app ready 后由 registerIpcHandlers 统一调用。 */
export function registerImHandlers(): void {
  // 先等 Conduit 就绪：renderer 在 app 启动早期就调 im:startSync，
  // 此时 Conduit 可能还没 bind 端口（RocksDB 打开 + schema migration 需要数百 ms）。
  // startConduit 内部有 pendingStart 去重，多次调用安全。
  ipcMain.handle('im:startSync', async () => {
    await startConduit();
    await startSyncFromSession();
  });

  // 发送文本消息到指定 room
  ipcMain.handle('im:send', async (_evt, roomId: string, body: string) => {
    await sendMessage(roomId, body);
  });

  ipcMain.handle('im:sendWithMentions', async (_evt, roomId: string, body: string, userIds: string[]) => {
    await sendMessageWithMentions(roomId, body, userIds);
  });

  // 获取已加入的房间列表（含房间名）。workspaceId 提供时只返回该 workspace 范围内的房间。
  ipcMain.handle('im:getRooms', async (_evt, workspaceId?: string) => {
    return getRoomsForWorkspace(workspaceId);
  });

  // 获取指定 room 的历史消息
  ipcMain.handle('im:getMessages', async (_evt, roomId: string) => {
    return getRoomMessages(roomId);
  });

  // 向前翻页加载更早的历史消息（用户滚到顶部时触发）
  ipcMain.handle('im:loadOlderMessages', async (_evt, roomId: string, count?: number) => {
    return loadOlderMessages(roomId, count);
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
  // 注意：getRoomMessages 不支持 offset 分页（只能返回最近 N 条），所以一次性拉取。
  ipcMain.handle(
    'im:exportRoomMessages',
    async (_evt, roomId: string, limit: number): Promise<{ filename: string; content: string }> => {
      // 1. 一次性拉取 limit 条消息（getRoomMessages 不支持 offset 分页）
      const messages = getRoomMessages(roomId, limit);

      // 2. 反查 agent name：listAssignments 需要 workspaceId，所以遍历所有 workspace，
      //    收集全部 assignment，构造 botUserId → agentName 映射。
      //    一个 bot 在多 workspace 可能有多个 assignment，但 definition.name 一致，所以后者覆盖无副作用。
      const botNameMap = new Map<string, string>();
      for (const ws of listWorkspaces()) {
        for (const a of listAssignments(ws.id)) {
          const def = getAgentDefinition(a.agentDefinitionId);
          if (def) botNameMap.set(a.botMatrixUserId, def.name);
        }
      }

      // 3. 注入 botName
      const exportMessages: ExportMessage[] = messages.map((m) => ({
        ...m,
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
        actualCount: messages.length,
      });

      // 6. 生成 filename：momo-session-<safeRoomName>-<YYYYMMDD-HHmm>.md
      //    CJK 房间名经过 [^\w-] 替换后可能为空，回退到 roomId（已 sanitize）
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
