// electron/src/main/settings/ipc.handlers.ts
//
// settings 命名空间 IPC：全局/会话配置的读写。
// 注册在 ipcMain.handle('settings:*') 上，preload 桥接到 renderer。
// v23：v1 的房间级设置表已删除，会话级配置转存 sessions.settings_json（经 crud 转调 repo）。

import { ipcMain } from 'electron';
import {
  getGlobalSettings,
  updateGlobalSettings,
  getSessionSettings,
  updateSessionSettings,
} from './crud';
import { notifyExecutor } from '../task/executor';

/** 注册 settings 命名空间 IPC handlers */
export function registerSettingsIpc(): void {
  ipcMain.handle('settings:getGlobal', () => {
    return getGlobalSettings();
  });

  ipcMain.handle('settings:updateGlobal', (_event, patch) => {
    updateGlobalSettings(patch);
    // 并发上限变更 → 立即评估补充放行（spec §9 边界表）
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'maxConcurrentTasks')) {
      notifyExecutor();
    }
    return getGlobalSettings();
  });

  ipcMain.handle('settings:getSession', (_event, sessionId: string) => {
    return getSessionSettings(sessionId);
  });

  ipcMain.handle('settings:updateSession', (_event, sessionId: string, patch) => {
    updateSessionSettings(sessionId, patch);
    return getSessionSettings(sessionId);
  });
}
