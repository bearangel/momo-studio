// electron/src/main/index.ts
//
// Electron 主进程入口——app 生命周期编排。
//
// task-driven runtime 初始化逻辑已抽取到 ./agent/init-runtime.ts（便于测试 + 关注点分离）。
// 本文件仅负责：migrations → TaskScheduler → IPC → Window → runtime 初始化 → cleanup。
//
// v2.0 P1 Task 12：Matrix/Conduit 全家已删——启动链无外部服务进程，无 /sync，
// 无登录/会话恢复（单用户本地应用 sender='owner'），SQLite 是唯一状态源。
import { app, BrowserWindow } from 'electron';
import { createMainWindow } from './window';
import { registerIpcHandlers } from './ipc';
import { runMigrations } from './storage/db';
import { setSessionMainWindow, broadcastRuntimeChanged } from './im/session-service';
import { initP2p, stopP2p } from './p2p';
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

    registerIpcHandlers();

    const win = createMainWindow();
    setSessionMainWindow(win);

    // 启动即初始化 task-driven runtime：无登录概念，SQLite assignments.last_running
    // 是唯一状态源（Task 5：仅恢复用户意图为「在线」的 agent）
    try {
      await initTaskDrivenRuntime();
      logger.info('Task-driven runtime initialized');
      broadcastRuntimeChanged();
    } catch (err) {
      logger.warn('Task-driven runtime 初始化失败（不影响应用启动）', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // P2P 子系统（节点发现/信任管理不依赖 Matrix）
    void initP2p().catch((err) => {
      logger.warn('P2P 子系统初始化失败（不影响主流程）', {
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
  void stopP2p();
});
