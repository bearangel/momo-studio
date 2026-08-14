// electron/src/main/index.ts
//
// Electron 主进程入口——app 生命周期编排。
//
// task-driven runtime 初始化逻辑已抽取到 ./agent/init-runtime.ts（便于测试 + 关注点分离）。
// 本文件仅负责：migrations → TaskScheduler → Conduit → IPC → Window → session restore → cleanup。
import { app, BrowserWindow } from 'electron';
import { createMainWindow } from './window';
import { registerIpcHandlers } from './ipc';
import { runMigrations } from './storage/db';
import { startConduit, stopConduit } from './conduit/manager';
import { setMainWindow, stopSync, startSyncFromSession, broadcastRuntimeChanged } from './matrix/sync-manager';
import { setMainWindow as setRuntimeMainWindow } from './agent/runtime-manager';
import { initP2p } from './p2p';
import { initTaskRuntime, stopTaskRuntime } from './task/runtime-init';
import { logger } from './logger';
import { destroyAllTaskDrivenRuntimes } from './agent/runtime-registry';
import { initTaskDrivenRuntime } from './agent/init-runtime';
import { destroyRouterService } from './agent/router-bootstrap';

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.whenReady().then(async () => {
  try {
    logger.info('App starting', { version: app.getVersion() });

    runMigrations();
    logger.info('Migrations complete');

    // D 子系统：启动 TaskScheduler（调度层）——提升 pending→assigned，执行层走 v1 runtime。
    initTaskRuntime();

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
    // initTaskDrivenRuntime 内部通过 router-bootstrap.ensureRouterService lazy 启动 RouterService
    await initTaskDrivenRuntime();
    logger.info('Task-driven runtime initialized');
    broadcastRuntimeChanged();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.info('No active session or restore failed', { error: msg });
    // 延迟 1s 发送，确保 renderer 已 mount 并注册了监听
    setTimeout(() => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        win.webContents.send('auth:sessionExpired', { reason: msg });
        logger.info('Notified renderer: session expired');
      }
    }, 1000);
  }

  // 无登录会话时 P2P 仍可启动（节点发现/信任管理不依赖 Matrix）
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
  destroyAllTaskDrivenRuntimes();
  destroyRouterService();

  stopTaskRuntime();
  void stopConduit();
  void stopSync();
});
