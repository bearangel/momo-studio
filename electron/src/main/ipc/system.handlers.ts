// electron/src/main/ipc/system.handlers.ts
import { ipcMain, app } from 'electron';
import os from 'node:os';
import { isConduitRunning } from '../conduit/manager';
import { resolveUserDataDir } from '../paths';
import { logger } from '../logger';

const CONDUIT_PORT = 8008;

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

  ipcMain.handle('system:getConduitStatus', async () => {
    const running = isConduitRunning();
    return {
      running,
      baseUrl: running ? `http://127.0.0.1:${CONDUIT_PORT}` : null,
      port: running ? CONDUIT_PORT : null,
    };
  });

  logger.info('System IPC handlers registered');
}
