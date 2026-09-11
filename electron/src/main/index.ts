// electron/src/main/index.ts
//
// Electron 主进程入口——app 生命周期编排。
//
// task-driven runtime 初始化逻辑已抽取到 ./agent/init-runtime.ts（便于测试 + 关注点分离）。
// 本文件仅负责：migrations → TaskScheduler → IPC → Window → runtime 初始化 → cleanup。
//
// v2.0 P1 Task 12：Matrix/Conduit 全家已删——启动链无外部服务进程，无 /sync，
// 无登录/会话恢复（单用户本地应用 sender='owner'），SQLite 是唯一状态源。
import { app, BrowserWindow, ipcMain, protocol } from 'electron';
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
import { reprobeSandbox } from './sandbox/probe';
import { enforceQuota } from './journal/quota';
import { listWorkspaces } from './workspace/crud';
import { sweepStaleStreaming } from './task/resume';
import { assembleBrowserSubsystem } from './browser/boot';
import { initRealViewFactory } from './browser/view-factory';
import { BROWSER_SHOT_SCHEME } from './browser/protocol';

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// v2.7 McpBrowser：browser-shot:// 截图协议注册为 privileged scheme——
// Electron 硬约束：registerSchemesAsPrivileged 必须在 app ready 之前调用
// （模块顶层即本进程最早时机；handler 注册在 whenReady 内 boot 组装时进行）。
protocol.registerSchemesAsPrivileged([
  { scheme: BROWSER_SHOT_SCHEME, privileges: { standard: true, stream: true } },
]);

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

    // v2.6.0 任务断点续跑：boot 陈旧流清扫（spec §5.4 + T3 移交约束：runMigrations
    // 之后、runtime 起动之前）。sweepStaleStreaming 内部 try/catch 兜底——DB
    // 未就绪 / 单行收尾失败均不阻断启动。正常关机由 finalizeStreamOnCrash 在
    // child exit 时覆盖；这里是 App 崩溃 / 强制 kill 的兜底。
    const swept = sweepStaleStreaming();
    if (swept > 0) {
      logger.info('boot 陈旧流清扫完成', { swept });
    }

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

    // v2.7 McpBrowser：浏览器子系统组装（runMigrations 后——settings store 依赖
    // workspace_settings 表；窗口创建前——browser 工具与初始激活先行可用）。
    // 组装内部：hooks 先行 → 真视图工厂（互认共享 hooks）→ manager（截图目录注入
    // userData/browser-screenshots）→ initBrowserTools → browser-shot 协议 handler。
    const browserBoot = assembleBrowserSubsystem({
      userDataDir: app.getPath('userData'),
      createFactory: (hooks) => initRealViewFactory(hooks),
      protocol,
    });

    // boot 初始激活：与 renderer load() 的默认激活同序（created_at DESC 首项）；
    // renderer 随后的 workspace:switch 通知到达时 onWorkspaceActivated 幂等收敛
    const firstWorkspace = listWorkspaces()[0];
    if (firstWorkspace) {
      browserBoot.switchWorkspace(firstWorkspace.id, firstWorkspace.directoryPath);
    }

    registerIpcHandlers({
      // workspace:switch 收口（TitleBar tab → store → IPC → main）：浏览器视图
      // 生命周期在此切换（manager 内部自动切走旧 ws + file:// 根同步）
      onWorkspaceSwitched: (wsId, dir) => browserBoot.switchWorkspace(wsId, dir),
    });

    // v2.5：boot 逐 workspace journal 配额清理（T6 移交）——registerIpcHandlers 内
    // registerJournalIpc 已注入 store；清理失败只 warn 不阻塞启动（安全网自身
    // 不能变成故障点，与 maybeEnforceQuota 节流触发器同处理）。
    try {
      for (const ws of listWorkspaces()) {
        try {
          enforceQuota(ws.id);
        } catch (err) {
          logger.warn('journal 配额 boot 清理失败（不影响启动）', {
            workspaceId: ws.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.warn('journal 配额 boot 清理遍历失败（不影响启动）', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // v2.4：OS 沙箱 boot 探测（fire-and-forget，不阻塞启动；失败只影响 bash 可用性）
    void reprobeSandbox().catch((err) => {
      logger.warn('沙箱探测失败（不影响应用启动）', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    const win = createMainWindow();
    setSessionMainWindow(win);

    // v2.7：视图叠加接线——create/destroy 时 addChildView/removeChildView 到主窗口
    // contentView（占位区 rect 由 renderer 上报 → manager.setBounds）；
    // 推送面/IPC invoke 面定标到主窗口 webContents（14 通道注册）；
    // before-quit → disposeAll 销毁活跃视图（partition 数据落盘）
    browserBoot.factory.setMountTarget(win.contentView);
    browserBoot.attachToWindow(ipcMain, win.webContents);
    browserBoot.bindLifecycle(app);

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
