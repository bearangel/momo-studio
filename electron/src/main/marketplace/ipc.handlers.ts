// electron/src/main/marketplace/ipc.handlers.ts
//
// Marketplace IPC handler 注册入口。把 client（catalog fetch/search）与
// installer（安装/列表/卸载）包装成 marketplace:* 通道，暴露给渲染进程。
//
// 暴露通道：
//   - marketplace:getCatalog     获取 catalog（远程优先，本地回退）
//   - marketplace:search         关键词 + 类型搜索
//   - marketplace:install        安装一个包（下载/内联 + 校验 + 注册）
//   - marketplace:listInstalled  列出全部已安装包
//   - marketplace:uninstall      卸载一个包

import { ipcMain } from 'electron';
import { logger } from '../logger';
import { fetchCatalog, searchItems } from './client';
import { installPackage, listInstalled, uninstallPackage } from './installer';
import type { MarketplaceItem } from './types';

/** 注册全部 marketplace: 命名空间的 IPC handler。在 app ready 后由 registerIpcHandlers 统一调用。 */
export function registerMarketplaceHandlers(): void {
  ipcMain.handle('marketplace:getCatalog', async (_evt, catalogUrl?: string) => {
    return fetchCatalog(catalogUrl);
  });

  ipcMain.handle('marketplace:search', async (_evt, query: string, type?: string) => {
    const catalog = await fetchCatalog();
    return searchItems(catalog, query, type);
  });

  ipcMain.handle('marketplace:install', async (_evt, item: MarketplaceItem) => {
    return installPackage(item);
  });

  ipcMain.handle('marketplace:listInstalled', async () => {
    return listInstalled();
  });

  ipcMain.handle('marketplace:uninstall', async (_evt, itemId: string) => {
    uninstallPackage(itemId);
  });

  logger.info('Marketplace IPC handlers 已注册');
}
