// electron/src/main/ipc/index.ts
import { ipcMain } from 'electron';
import { logger } from '../logger';
import { registerAuthHandlers } from './auth.handlers';

export function registerIpcHandlers(): void {
  logger.info('Registering IPC handlers');

  registerAuthHandlers();

  ipcMain.handle('system:getInfo', async () => {
    throw new Error('system:getInfo not implemented yet');
  });

  ipcMain.handle('system:getConduitStatus', async () => {
    throw new Error('system:getConduitStatus not implemented yet');
  });
}
