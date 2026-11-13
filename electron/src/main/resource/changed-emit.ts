// electron/src/main/resource/changed-emit.ts
//
// resource:changed 全窗口广播（spec §6）。计划期探明：现行系统无通用资源刷新通道
// （registerPluginAgents 落库零推送、registerMcp 注释「广播」是死注释）——本模块补上。
// 懒加载 require electron：vitest 里 require('electron') 返回路径字符串，静默跳过
// （broadcastProgressToWindows 同款纪律）。
// 广播只有在 Electron 主进程里才有窗口可推——经 electron-access 惰性取用。
// 原实现裸 require('electron') 在打包子进程里抛 MODULE_NOT_FOUND（2026-11-13 P0），
// typeof===string 只挡得住 vitest 形态。
import { loadElectronApis } from '../electron-access';
import { logger } from '../logger';

export const RESOURCE_CHANGED_CHANNEL = 'resource:changed';

export function broadcastResourceChanged(): void {
  const { BrowserWindow } = loadElectronApis();
  if (!BrowserWindow) return;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(RESOURCE_CHANGED_CHANNEL, { at: Date.now() });
  }
  logger.info('resource:changed 已广播');
}
