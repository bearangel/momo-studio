// electron/src/main/resource/changed-emit.ts
//
// resource:changed 全窗口广播（spec §6）。计划期探明：现行系统无通用资源刷新通道
// （registerPluginAgents 落库零推送、registerMcp 注释「广播」是死注释）——本模块补上。
// 懒加载 require electron：vitest 里 require('electron') 返回路径字符串，静默跳过
// （broadcastProgressToWindows 同款纪律）。
import { logger } from '../logger';

export const RESOURCE_CHANGED_CHANNEL = 'resource:changed';

export function broadcastResourceChanged(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as typeof import('electron') | string;
  if (typeof electron === 'string') return;
  for (const win of electron.BrowserWindow.getAllWindows()) {
    win.webContents.send(RESOURCE_CHANGED_CHANNEL, { at: Date.now() });
  }
  logger.info('resource:changed 已广播');
}
