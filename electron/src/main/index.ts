// electron/src/main/index.ts
import { app, BrowserWindow } from 'electron';
import { createMainWindow } from './window';
import { registerIpcHandlers } from './ipc';
import { runMigrations } from './storage/db';
import { startConduit, stopConduit } from './conduit/manager';
import { setMainWindow, stopSync } from './matrix/sync-manager';
import { registerBuiltinAgents } from './agent/builtin';
import { logger } from './logger';

// Single-instance lock: if a second instance tries to launch, the first wins
// and the second quits immediately.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.whenReady().then(async () => {
  try {
    logger.info('App starting', { version: app.getVersion() });

    // 1. DB migrations (synchronous: blocks startup until schema is ready)
    runMigrations();
    logger.info('Migrations complete');

    // 1b. 注册内置 agent（须在 migrations 之后、IPC 之前，否则 renderer 拉不到）
    registerBuiltinAgents();

    // 2. Conduit pre-warm. Conduit is lazy-started on first auth request,
    //    but we kick it off now so the first onboarding step is faster.
    //    Failures are non-fatal: auth will retry on demand.
    void startConduit().catch((err) => {
      logger.error('Conduit pre-start failed (will retry on auth)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // 3. IPC handlers (auth, system, etc.)
    registerIpcHandlers();

    // 4. Window
    const win = createMainWindow();
    setMainWindow(win);
  } catch (err) {
    logger.error('Fatal startup error', {
      error: err instanceof Error ? err.message : String(err),
    });
    app.quit();
  }
});

// macOS: apps stay alive after all windows close (re-activate from dock).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

// Best-effort Conduit teardown before the process exits. stopConduit sends
// SIGTERM (with a SIGKILL fallback after its grace period); we fire it
// synchronously here since Electron does not await async before-quit handlers.
app.on('before-quit', () => {
  void stopConduit();
  void stopSync();
});
