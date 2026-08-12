// electron/src/main/resource/ipc.handlers.ts
//
// 资源库 IPC handler 注册。4 个通道：
//   - resource:list      统一列表（filter 可选）
//   - resource:getDetail 按 id 查详情
//   - resource:install   marketplace 资源安装（封装现有 installPackage）
//   - resource:delete    统一删除/卸载（按 source+type 路由到底层删除函数）
//
// 设计原则：
//   - list / getDetail 直接转发给 library（纯查询，无副作用）
//   - install 仅 marketplace 源支持（builtin 不可装、custom 已在本地）
//   - delete 按 source + type 路由：marketplace→uninstallPackage / custom 三分支 /
//     builtin 抛错。各底层删除函数的参数语义不同，详见各分支注释。

import { ipcMain } from 'electron';
import { logger } from '../logger';
import { listResources, resolveResourceById } from './library';
import { sourceLabel, type ResourceFilter } from './types';
import { installPackage, uninstallPackage } from '../marketplace/installer';
import { fetchCatalog } from '../marketplace/client';
import { deleteRegistered } from '../mcp/host-manager';
import { deleteCustomSkill } from '../skill/zip-uploader';
import { deleteDefinition } from '../agent/crud';

/**
 * 注册 resource:* 命名空间的 4 个 IPC handler。
 * 在 app ready 后由 registerIpcHandlers（ipc/index.ts）统一调用。
 */
export function registerResourceHandlers(): void {
  // resource:list — 统一资源列表，filter 可选（按 type/source 过滤）
  ipcMain.handle('resource:list', async (_evt, filter?: ResourceFilter) => {
    return listResources(filter);
  });

  // resource:getDetail — 按 id 查单个资源详情，找不到返回 null
  ipcMain.handle('resource:getDetail', async (_evt, id: string) => {
    return resolveResourceById(id);
  });

  // resource:install — 仅 marketplace 源支持安装
  // installPackage 底层需要完整的 MarketplaceItem（含 downloadUrl/checksum 等），
  // ResourceItem 不携带这些字段，故先 fetchCatalog 按 slug 找到原 catalog item 再传入。
  ipcMain.handle('resource:install', async (_evt, id: string) => {
    const item = await resolveResourceById(id);
    if (!item) throw new Error(`资源 ${id} 不存在`);
    if (!item.installable) throw new Error(`「${item.name}」不可安装`);
    if (item.source !== 'marketplace') {
      throw new Error(`source=${item.source} 不支持 install 操作`);
    }
    // fetchCatalog 拿到完整 catalog，按 slug 找到原 MarketplaceItem
    const catalog = await fetchCatalog();
    const catalogItem = catalog.items.find((ci) => ci.slug === item.slug);
    if (!catalogItem) {
      throw new Error(`marketplace catalog 中未找到 slug=${item.slug}`);
    }
    return installPackage(catalogItem);
  });

  // resource:delete — 按 source + type 路由到底层删除函数
  //   - builtin        → 抛错（系统预置不可移除）
  //   - marketplace    → uninstallPackage(item.id)（按 installed_packages.item_id 查删）
  //   - custom + mcp   → deleteRegistered(item.slug)（按 mcp_definitions.name 查删）
  //   - custom + skill → deleteCustomSkill(item.slug)（按 skills 目录名查删）
  //   - custom + agent → deleteDefinition(item.slug)（按 agent_definitions.slug 查删）
  ipcMain.handle('resource:delete', async (_evt, id: string) => {
    const item = await resolveResourceById(id);
    if (!item) throw new Error(`资源 ${id} 不存在`);
    if (!item.removable) {
      // 错误文案须含 "系统预置不可移除" 连续子串（builtin 场景），用 sourceLabel 拼接保证一致
      throw new Error(`${sourceLabel(item.source)}不可移除：「${item.name}」`);
    }
    switch (item.source) {
      case 'marketplace':
        // uninstallPackage 按 installed_packages.item_id 查找；ResourceItem.id 即资源全局 id
        return uninstallPackage(item.id);
      case 'custom':
        if (item.type === 'mcp') return deleteRegistered(item.slug);
        if (item.type === 'skill') return deleteCustomSkill(item.slug);
        if (item.type === 'agent') return deleteDefinition(item.slug);
        throw new Error(`未知 custom type: ${item.type}`);
      default:
        throw new Error(`source=${item.source} 不支持 delete 操作`);
    }
  });

  logger.info('Resource IPC handlers 已注册');
}
