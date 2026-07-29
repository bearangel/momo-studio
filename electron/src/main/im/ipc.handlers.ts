// electron/src/main/im/ipc.handlers.ts
//
// IM 相关 IPC handler 注册入口。
// 暴露给渲染进程的能力：启动 /sync、发送消息、查询房间列表和历史消息。
// 实际的 Matrix 操作委托给 matrix/sync-manager。
import { ipcMain } from 'electron';
import { logger } from '../logger';
import {
  startSyncFromSession,
  sendMessage,
  sendMessageWithMentions,
  getJoinedRooms,
  getRoomMessages,
} from '../matrix/sync-manager';

/** 注册全部 im: 命名空间的 IPC handler。在 app ready 后由 registerIpcHandlers 统一调用。 */
export function registerImHandlers(): void {
  // 启动 Matrix /sync：主进程从 keychain 恢复 token + 创建 client + 开始长轮询。
  // 幂等：已运行时直接返回。resolve 后房间列表即可查询。
  ipcMain.handle('im:startSync', async () => {
    await startSyncFromSession();
  });

  // 发送文本消息到指定 room
  ipcMain.handle('im:send', async (_evt, roomId: string, body: string) => {
    await sendMessage(roomId, body);
  });

  ipcMain.handle('im:sendWithMentions', async (_evt, roomId: string, body: string, userIds: string[]) => {
    await sendMessageWithMentions(roomId, body, userIds);
  });

  // 获取已加入的房间列表（含房间名）
  ipcMain.handle('im:getRooms', async () => {
    return getJoinedRooms();
  });

  // 获取指定 room 的历史消息
  ipcMain.handle('im:getMessages', async (_evt, roomId: string) => {
    return getRoomMessages(roomId);
  });

  logger.info('IM IPC handlers 已注册');
}
