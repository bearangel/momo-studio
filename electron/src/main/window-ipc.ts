// electron/src/main/window-ipc.ts
//
// 窗口控制 IPC——renderer 的自绘 titlebar 控件调用。
// getWin 懒查（注册时窗口可能尚未创建），无窗口时静默降级。
import { ipcMain, BrowserWindow } from 'electron';
import { logger } from './logger';

export function registerWindowIpc(getWin: () => BrowserWindow | null): void {
  ipcMain.on('window:minimize', () => getWin()?.minimize());
  ipcMain.on('window:toggle-maximize', () => {
    const win = getWin();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('window:close', () => getWin()?.close());
  ipcMain.handle('window:is-maximized', () => getWin()?.isMaximized() ?? false);
  logger.info('Window IPC 已注册');
}
