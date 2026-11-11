// electron/src/main/files/file-io/ipc.handlers.ts
//
// fileIo:* IPC（spec §5.6 设置面板数据面）。buildFileIoStatus 可注入 raw 供单测。
//
// I3（2026-11-11 终审）：node 探测异步化 + 模块级缓存——spawnSync 冷启动实测
// 3.7~5.4s（安全软件机器），面板每次 getState 都同步探测会把主进程事件循环
// 钉死。getState 命中缓存直接返回；probe 强制重探并更新缓存。服务自身 spawn
// 路径仍用同步 findNodePath（spawn 时点可接受）。
import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';
import { logger } from '../../logger';
import { getGlobalSettings } from '../../settings/crud';
import {
  detectClientInstalled,
  resolveEffectiveMode,
  resolveFileIoSettings,
  type FileIoConfig,
} from './file-io-settings';
import { probeNodeAvailability, type NodeProbeResult } from './file-io-service';
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

/** 自动探测（nodePath 为 null）的统一缓存键——与任何真实路径串不冲突即可 */
const AUTO_NODE_KEY = '<auto>';

/** 缓存键 = 配置的 nodePath 原值；配置变更（含清空回 auto）自然换键重探 */
const nodeProbeCache = new Map<string, NodeProbeResult>();

/** 探测函数注入点（测试锁缓存行为，避免真实 spawn）；null 还原真实探测 */
let probeNode: (nodePath: string | null) => Promise<NodeProbeResult> = probeNodeAvailability;

/** 测试注入：替换探测函数并清缓存 */
export function __setNodeProbeForTest(
  fn: ((nodePath: string | null) => Promise<NodeProbeResult>) | null,
): void {
  probeNode = fn ?? probeNodeAvailability;
  nodeProbeCache.clear();
}

/** 测试 teardown：清缓存（防跨用例命中泄漏） */
export function __resetNodeProbeCacheForTest(): void {
  nodeProbeCache.clear();
}

/**
 * 聚合状态（设置面板状态卡数据源）；raw 仅测试注入。refresh=true 强制重探并
 * 更新缓存（fileIo:probe 路径），否则命中缓存返回（fileIo:getState 路径）。
 */
export async function buildFileIoStatus(
  raw?: FileIoConfig,
  opts?: { refresh?: boolean },
): Promise<FileIoStatus> {
  const settings = resolveFileIoSettings(raw ?? getGlobalSettings().fileIo);
  const clientInstalled = detectClientInstalled();
  const key = settings.nodePath ?? AUTO_NODE_KEY;
  let probed = nodeProbeCache.get(key);
  if (opts?.refresh === true || probed === undefined) {
    probed = await probeNode(settings.nodePath);
    nodeProbeCache.set(key, probed);
  }
  return {
    mode: settings.mode,
    effectiveMode: resolveEffectiveMode(settings, clientInstalled),
    clientInstalled,
    nodeAvailable: probed.nodePath !== null,
    nodePath: probed.nodePath,
    nodeVersion: probed.nodeVersion,
  };
}

export function registerFileIoHandlers(): void {
  ipcMain.handle('fileIo:getState', async () => {
    syncFileIoDefaults();
    return buildFileIoStatus();
  });
  ipcMain.handle('fileIo:probe', async () => {
    syncFileIoDefaults();
    return buildFileIoStatus(undefined, { refresh: true });
  });
  // 系统文件选择器选取 Node.js 可执行文件；取消返回 null（面板据此不落任何变更）
  ipcMain.handle('fileIo:pickNodePath', async () => {
    const configured = resolveFileIoSettings(getGlobalSettings().fileIo).nodePath;
    // Electron 44 类型：window 形参不可空，无聚焦窗走无参重载（同 dialog.handlers.ts）
    const options: OpenDialogOptions = {
      title: '选择 Node.js 可执行文件',
      properties: ['openFile'],
      defaultPath: configured ?? undefined,
      filters:
        process.platform === 'win32'
          ? [{ name: 'Node.js', extensions: ['exe'] }]
          : undefined,
    };
    const focused = BrowserWindow.getFocusedWindow();
    const res = focused
      ? await dialog.showOpenDialog(focused, options)
      : await dialog.showOpenDialog(options);
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });
  logger.info('File IO IPC handlers 已注册');
}
