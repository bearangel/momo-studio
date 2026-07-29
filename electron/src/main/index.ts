// electron/src/main/index.ts
import { app, BrowserWindow } from 'electron';
import { createMainWindow } from './window';
import { registerIpcHandlers } from './ipc';
import { runMigrations } from './storage/db';
import { startConduit, stopConduit } from './conduit/manager';
import { setMainWindow, stopSync, startSyncFromSession } from './matrix/sync-manager';
import { registerBuiltinAgents } from './agent/builtin';
import { autoStartAgents } from './agent/auto-start';
import { logger } from './logger';

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.whenReady().then(async () => {
  try {
    logger.info('App starting', { version: app.getVersion() });

    runMigrations();
    logger.info('Migrations complete');

    registerBuiltinAgents();

    void startConduit().catch((err) => {
      logger.error('Conduit pre-start failed (will retry on auth)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    registerIpcHandlers();

    const win = createMainWindow();
    setMainWindow(win);

    // 5. 如果已有登录会话，自动恢复：启动 sync + 自动启动已分配的 agent
    void autoRestoreSession().catch((err) => {
      logger.warn('Session restore failed (user may need to re-login)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  } catch (err) {
    logger.error('Fatal startup error', {
      error: err instanceof Error ? err.message : String(err),
    });
    app.quit();
  }
});

async function autoRestoreSession(): Promise<void> {
  try {
    await startSyncFromSession();
    logger.info('Session restored: Matrix sync started');
    await autoStartAgents();
    logger.info('Session restore complete: agents auto-started');
  } catch (err) {
    logger.info('No active session or restore failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('before-quit', () => {
  void stopConduit();
  void stopSync();
});
