// electron/src/main/ipc/authFlows.ts already validated; this is the thin
// production wiring that constructs real AuthDeps from existing primitives and
// binds each auth IPC channel to the matching flow.
import { ipcMain } from 'electron';
import {
  registerFlow,
  loginFlow,
  logoutFlow,
  getCurrentUserFlow,
  type AuthDeps,
} from './authFlows';
import { startConduit } from '../conduit/manager';
import { createMatrixClient } from '../matrix/client';
import { setSecret, getSecret, deleteSecret } from '../storage/keychain';
import { getDb } from '../storage/db';
import { logger } from '../logger';

// Constructed once at module load. Each field delegates to the existing module
// primitive; dbRun/dbGet adapt better-sqlite3's prepared-statement API to the
// dependency-injected signatures declared in AuthDeps.
const deps: AuthDeps = {
  startConduit,
  createMatrixClient,
  setSecret,
  getSecret,
  deleteSecret,
  dbRun: (sql: string, ...params: unknown[]): void => {
    getDb().prepare(sql).run(...params);
  },
  dbGet: <T>(sql: string, ...params: unknown[]): T | undefined => {
    return getDb().prepare(sql).get(...params) as T | undefined;
  },
};

/** Register all `auth:*` IPC handlers. Idempotent-ish: Electron errors on duplicate handles. */
export function registerAuthHandlers(): void {
  ipcMain.handle('auth:register', async (_evt, opts: { username: string; password: string }) => {
    return registerFlow(opts, deps);
  });
  ipcMain.handle('auth:login', async (_evt, opts: { username: string; password: string }) => {
    return loginFlow(opts, deps);
  });
  ipcMain.handle('auth:getCurrentUser', async () => {
    return getCurrentUserFlow(deps);
  });
  ipcMain.handle('auth:logout', async () => {
    await logoutFlow(deps);
    return;
  });
  logger.info('Auth IPC handlers registered');
}
