// electron/src/main/files/file-io/ipc.handlers.ts
//
// fileIo:* IPC（spec §5.6 设置面板数据面）。buildFileIoStatus 可注入 raw 供单测。
import { ipcMain } from 'electron';
import { spawnSync } from 'node:child_process';
import { logger } from '../../logger';
import { getGlobalSettings } from '../../settings/crud';
import {
  detectClientInstalled,
  resolveEffectiveMode,
  resolveFileIoSettings,
  type FileIoConfig,
} from './file-io-settings';
import { findNodePath } from './file-io-service';
import { syncFileIoDefaults } from './index';
import type { EffectiveFileIoMode, FileIoMode } from './types';

export interface FileIoStatus {
  mode: FileIoMode;
  effectiveMode: EffectiveFileIoMode;
  clientInstalled: boolean;
  nodeAvailable: boolean;
  nodePath: string | null;
  nodeVersion: string | null;
}

/** 聚合状态（设置面板状态卡数据源）；raw 仅测试注入 */
export function buildFileIoStatus(raw?: FileIoConfig): FileIoStatus {
  const settings = resolveFileIoSettings(raw ?? getGlobalSettings().fileIo);
  const clientInstalled = detectClientInstalled();
  let nodePath: string | null = null;
  let nodeVersion: string | null = null;
  try {
    nodePath = findNodePath(settings.nodePath);
    const r = spawnSync(nodePath, ['-v'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    nodeVersion = r.status === 0 ? String(r.stdout).trim() : null;
  } catch {
    // ENONODE：nodePath 保持 null（面板显示「未找到」）
  }
  return {
    mode: settings.mode,
    effectiveMode: resolveEffectiveMode(settings, clientInstalled),
    clientInstalled,
    nodeAvailable: nodePath !== null,
    nodePath,
    nodeVersion,
  };
}

export function registerFileIoHandlers(): void {
  ipcMain.handle('fileIo:getState', () => {
    syncFileIoDefaults();
    return buildFileIoStatus();
  });
  ipcMain.handle('fileIo:probe', () => {
    syncFileIoDefaults();
    return buildFileIoStatus();
  });
  logger.info('File IO IPC handlers 已注册');
}
