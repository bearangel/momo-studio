// electron/src/main/ipc/dialog.handlers.ts
//
// 原生对话框 IPC handler。把 Electron 的 dialog.showOpenDialog 包装成
// dialog:pickDirectory 通道，供 renderer 在需要让用户选择本地目录时调用
// （例如新建工作空间的目录选择）。
import { ipcMain, dialog, BrowserWindow } from 'electron';
import { logger } from '../logger';

/** 注册 dialog:* IPC handlers。在 app ready 后由 registerIpcHandlers 统一调用。 */
export function registerDialogHandlers(): void {
  ipcMain.handle(
    'dialog:pickDirectory',
    async (
      _evt,
      opts?: { title?: string; defaultPath?: string },
    ): Promise<string | null> => {
      const focused = BrowserWindow.getFocusedWindow();
      const result = focused
        ? await dialog.showOpenDialog(focused, {
            title: opts?.title,
            defaultPath: opts?.defaultPath,
            properties: ['openDirectory', 'createDirectory'],
          })
        : await dialog.showOpenDialog({
            title: opts?.title,
            defaultPath: opts?.defaultPath,
            properties: ['openDirectory', 'createDirectory'],
          });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0]!;
    },
  );

  logger.info('Dialog IPC handlers 已注册');
}
