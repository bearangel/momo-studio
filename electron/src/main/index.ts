// electron/src/main/index.ts
import { app, BrowserWindow } from 'electron';
import { createMainWindow } from './window';
import { registerIpcHandlers } from './ipc';
import { runMigrations } from './storage/db';
import { startConduit, stopConduit } from './conduit/manager';
import { setMainWindow, stopSync, startSyncFromSession, broadcastRuntimeChanged } from './matrix/sync-manager';
import { setMainWindow as setRuntimeMainWindow } from './agent/runtime-manager';
import { autoStartAgents } from './agent/auto-start';
import { initP2p } from './p2p';
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

    const win = createMainWindow();
    setMainWindow(win);
    setRuntimeMainWindow(win);

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
    broadcastRuntimeChanged();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.info('No active session or restore failed', { error: msg });
    // v1.5.7: token 失效时通知 renderer 跳转登录页
    // 延迟 1s 发送，确保 renderer 已 mount 并注册了监听
    setTimeout(() => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        win.webContents.send('auth:sessionExpired', { reason: msg });
        logger.info('Notified renderer: session expired');
      }
    }, 1000);
  }

  // C 子系统：P2P 联网初始化（async 不阻塞启动；失败仅记录日志）。
  // 放在 session restore 之后——无登录会话时 P2P 仍可启动（节点发现/信任管理不依赖 Matrix）。
  void initP2p().catch((err) => {
    logger.warn('P2P 子系统初始化失败（不影响主流程）', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
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
