// electron/src/main/index.ts
import { app, BrowserWindow } from 'electron';
import { createMainWindow } from './window';
import { registerIpcHandlers } from './ipc';
import { registerProviderHandlers } from './agent/provider-ipc';
import { runMigrations } from './storage/db';
import { startConduit, stopConduit } from './conduit/manager';
import { setMainWindow, stopSync, startSyncFromSession } from './matrix/sync-manager';
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

    void startConduit().catch((err) => {
      logger.error('Conduit pre-start failed (will retry on auth)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    registerIpcHandlers();
    registerProviderHandlers();

    const win = createMainWindow();
    setMainWindow(win);

    // 5. 如果已有登录会话，等待 Conduit 就绪后自动恢复 sync + agent
    void (async () => {
      try {
        await startConduit();
        await autoRestoreSession();
      } catch (err) {
        logger.info('Session restore deferred', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
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
