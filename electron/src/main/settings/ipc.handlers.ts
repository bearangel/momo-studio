// electron/src/main/settings/ipc.handlers.ts
//
// settings 命名空间 IPC：全局/房间配置的读写。
// 注册在 ipcMain.handle('settings:*') 上，preload 桥接到 renderer。

import { ipcMain } from 'electron';
import {
  getGlobalSettings,
  updateGlobalSettings,
  getRoomSettings,
  updateRoomSettings,
} from './crud';

/** 注册 settings 命名空间 IPC handlers */
export function registerSettingsIpc(): void {
  ipcMain.handle('settings:getGlobal', () => {
    return getGlobalSettings();
  });

  ipcMain.handle('settings:updateGlobal', (_event, patch) => {
    updateGlobalSettings(patch);
    return getGlobalSettings();
  });

  ipcMain.handle('settings:getRoom', (_event, roomId: string) => {
    return getRoomSettings(roomId);
  });

  ipcMain.handle('settings:updateRoom', (_event, roomId: string, patch) => {
    updateRoomSettings(roomId, patch);
    return getRoomSettings(roomId);
  });
}
