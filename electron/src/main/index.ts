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
import { runLegacyUpgradeIfNeeded, writeLegacyUpgradeNotice } from './upgrade/legacy-upgrade';
import { setSessionMainWindow, broadcastRuntimeChanged } from './im/session-service';
import { initP2p, stopP2p } from './p2p';
import { initTaskRuntime, stopTaskRuntime } from './task/runtime-init';
import { logger } from './logger';
import { destroyAllTaskDrivenRuntimes } from './agent/runtime-registry';
import { initTaskDrivenRuntime } from './agent/init-runtime';
import { destroyRouterService } from './agent/router-bootstrap';
import { tokenizeForIndex } from './storage/memories/tokenize';

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.whenReady().then(async () => {
  try {
    logger.info('App starting', { version: app.getVersion() });

    // P5：v1.x 旧库检测 + 自动导出 + 备份重置。必须在 runMigrations 之前——
    // 旧 schema（appliedMax < 23）一旦跑了 2.0 migrations 列名即被改写，无法再导出。
    // kv 通知标记延迟到 runMigrations 之后写入（kv_store 表在新库上才建好）。
    const legacyExportDir = await runLegacyUpgradeIfNeeded();
    if (legacyExportDir) {
      logger.info('v1.x 旧库已导出并备份重置，全新 2.0 库即将初始化', {
        exportDir: legacyExportDir,
      });
    }

    runMigrations();
    logger.info('Migrations complete');

    // v2.2 记忆 P2：jieba native binding 冒烟——在首次写库前暴露打包/ABI 问题
    // （better-sqlite3 之外唯一的 native 依赖）。不 exit：冒烟失败只代表记忆检索
    // 不可用，不应拖垮应用启动；运行期记忆读写会再次抛错并留痕（降级运行）。
    try {
      tokenizeForIndex('启动冒烟');
    } catch (err) {
      logger.error('jieba 分词冒烟失败（记忆检索可能不可用，应用继续运行）', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (legacyExportDir) {
      try {
        writeLegacyUpgradeNotice(legacyExportDir);
      } catch (err) {
        logger.warn('旧库升级通知标记写入失败（不影响启动）', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

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
