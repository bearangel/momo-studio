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
import { stopSync, startSyncFromSession, broadcastRuntimeChanged } from '../matrix/sync-manager';
import { autoStartAgents } from '../agent/auto-start';
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
    const result = await registerFlow(opts, deps);
    await restoreSessionAfterAuth('register');
    return result;
  });
  ipcMain.handle('auth:login', async (_evt, opts: { username: string; password: string }) => {
    const result = await loginFlow(opts, deps);
    await restoreSessionAfterAuth('login');
    return result;
  });
  ipcMain.handle('auth:getCurrentUser', async () => {
    return getCurrentUserFlow(deps);
  });
  ipcMain.handle('auth:logout', async () => {
    await logoutFlow(deps);
    // 登出后停止 /sync，避免 getSyncingClient() 继续暴露已撤销 token 的 client
    await stopSync();
    return;
  });
  logger.info('Auth IPC handlers registered');
}

/**
 * v1.5.8：登录/注册成功后恢复用户 Matrix sync + 自启动上次运行的 agent。
 * 三步独立 try/catch，任何一步失败不阻塞后续——登录主流程已经成功。
 */
async function restoreSessionAfterAuth(kind: 'register' | 'login'): Promise<void> {
  try {
    await startSyncFromSession();
  } catch (err) {
    logger.warn('登录后启动 Matrix sync 失败（不阻塞 agent 自启动）', {
      kind,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await autoStartAgents();
  } catch (err) {
    logger.warn('登录后自启动 agent 失败（不阻塞登录）', {
      kind,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    broadcastRuntimeChanged();
  } catch {
    // 广播失败不致命，UI 会在下次 IPC 调用自动同步
  }
}
