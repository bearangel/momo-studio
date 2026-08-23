// electron/src/main/ipc/system.handlers.ts
import { ipcMain, app } from 'electron';
import { resolveUserDataDir } from '../paths';
import { logger } from '../logger';

export function registerSystemHandlers(): void {
  ipcMain.handle('system:getInfo', async () => {
    return {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
      appVersion: app.getVersion(),
      userDataDir: resolveUserDataDir(),
    };
  });

  logger.info('System IPC handlers registered');
}
