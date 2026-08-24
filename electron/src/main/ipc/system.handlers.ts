// electron/src/main/ipc/system.handlers.ts
import { ipcMain, app } from 'electron';
import { resolveUserDataDir } from '../paths';
import { logger } from '../logger';
import { readUpgradeNotice, dismissUpgradeNotice } from '../upgrade/legacy-upgrade';

export function registerSystemHandlers(): void {
  ipcMain.handle('system:getInfo', async () => {
    return {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
      appVersion: app.getVersion(),
      userDataDir: resolveUserDataDir(),
    };
  });

  // P5 Task 2：旧库升级首启提示（一次性标记）。
  // 读标记无 → null；UI 据此决定是否渲染 UpgradeNotice。
  ipcMain.handle('system:getUpgradeNotice', () => readUpgradeNotice());

  // 用户点「知道了」后调：清 kv 标记（一次性）。
  // 失败仅 warn——UI 已乐观关闭本地 state，无须阻塞用户。
  ipcMain.handle('system:dismissUpgradeNotice', () => {
    try {
      dismissUpgradeNotice();
    } catch (err) {
      logger.warn('清除升级首启标记失败（不影响 UI）', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  logger.info('System IPC handlers registered');
}
