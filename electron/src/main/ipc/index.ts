// electron/src/main/ipc/index.ts
import { ipcMain } from 'electron';
import { logger } from '../logger';

export function registerIpcHandlers(): void {
  logger.info('Registering IPC handlers');

  ipcMain.handle('auth:register', async (_evt, opts: { username: string; password: string }) => {
    // Real implementation in Task 11
    void opts;
    throw new Error('auth:register not implemented yet');
  });

  ipcMain.handle('auth:login', async (_evt, opts: { username: string; password: string }) => {
    void opts;
    throw new Error('auth:login not implemented yet');
  });

  ipcMain.handle('auth:getCurrentUser', async () => {
    throw new Error('auth:getCurrentUser not implemented yet');
  });

  ipcMain.handle('auth:logout', async () => {
    throw new Error('auth:logout not implemented yet');
  });

  ipcMain.handle('system:getInfo', async () => {
    throw new Error('system:getInfo not implemented yet');
  });

  ipcMain.handle('system:getConduitStatus', async () => {
    throw new Error('system:getConduitStatus not implemented yet');
  });
}