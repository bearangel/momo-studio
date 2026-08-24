// electron/src/main/resource/ipc.handlers.ts
//
// 资源库 IPC handler 注册。6 个通道：
//   - resource:list         统一列表（filter 可选）
//   - resource:getDetail    按 id 查详情
//   - resource:install      marketplace 资源安装（封装现有 installPackage）
//   - resource:delete       统一删除/卸载（按 source+type 路由到底层删除函数）
//   - resource:registerMcp  注册自定义 MCP（P3 收敛自 mcp:register，返回 ResourceItem）
//   - resource:uploadSkill  上传自定义 skill zip（P3 收敛自 skill:uploadZip）
//
// 设计原则：
//   - list / getDetail 直接转发给 library（纯查询，无副作用）
//   - install 仅 marketplace 源支持（builtin 不可装、custom 已在本地）
//   - delete 按 source + type 路由：marketplace→uninstallPackage / custom 三分支 /
//     builtin 抛错。各底层删除函数的参数语义不同，详见各分支注释。
//   - registerMcp / uploadSkill 是注册表写入口，语义归 resource 域：registerMcp
//     落库 source='custom' 后复用 library 的 custom 映射取回 ResourceItem 返回。
//
// P4 Task 4 追加：三个 custom 写通道成功后 fire-and-forget 广播资源目录
// （broadcastLocalResourceCatalog——P2P 未启用时静默 no-op，本地写路径不受影响）。

import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import { logger } from '../logger';
import { listResources, resolveResourceById } from './library';
import { sourceLabel, type ResourceFilter, type ResourceItem } from './types';
import { installPackage, uninstallPackage } from '../marketplace/installer';
import { fetchCatalog } from '../marketplace/client';
import { deleteRegistered, registerMcpDefinition } from '../mcp/host-manager';
import { deleteCustomSkill, uploadSkillZip } from '../skill/zip-uploader';
import { deleteDefinition } from '../agent/crud';
import { broadcastLocalResourceCatalog } from '../p2p/resource-share';
import { requestResourceImport } from '../p2p/resource-transfer';

/** resource:registerMcp 入参——注册自定义 MCP 的最小配置（id / version 由主进程补全） */
export interface RegisterMcpInput {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 可选版本号；缺省存 '1.0.0'（DB 列 version NOT NULL） */
  version?: string;
}

/**
 * 注册 resource:* 命名空间的 6 个 IPC handler。
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

  // resource:install — marketplace 安装 + p2p 导入（P4 Task 5）
  // marketplace：installPackage 底层需要完整的 MarketplaceItem（含 downloadUrl/checksum 等），
  // ResourceItem 不携带这些字段，故先 fetchCatalog 按 slug 找到原 catalog item 再传入。
  // p2p：目录条目 → request/provide 按需拉取完整定义 → 落地 custom（agent 走
  // createCustomDef 等价路径 / mcp 走 registerMcpDefinition 幂等覆盖）。
  ipcMain.handle('resource:install', async (_evt, id: string) => {
    const item = await resolveResourceById(id);
    if (!item) {
      // p2p 项由内存目录缓存解析——来源节点离线 / 目录超 5min prune 后条目消失，
      // 给针对性文案（区别于 marketplace 的 id 不存在）
      if (id.startsWith('p2p-')) {
        throw new Error('找不到该 P2P 资源：来源节点可能已离线，或共享目录已过期');
      }
      throw new Error(`资源 ${id} 不存在`);
    }
    if (!item.installable) throw new Error(`「${item.name}」不可安装`);

    if (item.source === 'p2p') {
      // library p2p 映射：item.slug 是对端原始 slug（不掺节点前缀），
      // p2p.peerId 是完整 nodeId——直接作为请求三元组，无需反解 id 前缀
      if (item.type !== 'agent' && item.type !== 'mcp') {
        throw new Error(`P2P 共享暂只支持 agent / mcp 类型（收到 ${item.type}）`);
      }
      const peerNodeId = item.p2p?.peerId;
      if (!peerNodeId) throw new Error(`P2P 资源 ${id} 缺少来源节点信息`);
      const result = await requestResourceImport(peerNodeId, item.type, item.slug);
      if (result === 'ok') {
        // 导入即 custom 写通道（与 registerMcp/uploadSkill 同语义）→ 广播目录
        void broadcastLocalResourceCatalog();
        return;
      }
      if (result === 'not-found') {
        throw new Error(`对端节点未找到资源「${item.name}」（可能已被删除或取消共享）`);
      }
      throw new Error(`导入「${item.name}」超时：对端节点无响应（可能已离线）`);
    }

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
  //   - marketplace    → uninstallPackage(catalogItem.id)（按 installed_packages.item_id 查删）
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
      case 'marketplace': {
        // 警告：uninstallPackage 按 installed_packages.item_id 查删——该列存的是 catalog 的
        // MarketplaceItem.id（opaque），不是 ResourceItem.id。直接传 item.id 会查无此行 →
        // 静默 no-op（用户以为删成功但实际没删）。须 fetchCatalog 按 slug 反查 catalog 原 id。
        const catalog = await fetchCatalog();
        const catalogItem = catalog.items.find((ci) => ci.slug === item.slug);
        if (!catalogItem) {
          throw new Error(`marketplace catalog 中未找到 slug=${item.slug}（可能 catalog 已变更）`);
        }
        return uninstallPackage(catalogItem.id);
      }
      case 'custom': {
        let deleted: unknown;
        if (item.type === 'mcp') deleted = deleteRegistered(item.slug);
        else if (item.type === 'skill') deleted = deleteCustomSkill(item.slug);
        else if (item.type === 'agent') deleted = deleteDefinition(item.slug);
        else throw new Error(`未知 custom type: ${item.type}`);
        // 统一等待删除成功再广播（失败上抛时不广播旧目录）
        await deleted;
        void broadcastLocalResourceCatalog();
        return deleted;
      }
      default:
        throw new Error(`source=${item.source} 不支持 delete 操作`);
    }
  });

  // resource:registerMcp — 注册自定义 MCP 并返回其 ResourceItem。
  // id / version 由主进程补全（renderer 不再关心持久化细节），source 固定 'custom'
  // （保证 resource:delete 的 custom 分支可删）。注册后走 library 的 custom 映射
  // （listResources filter 短路，不触发 fetchCatalog）按 name 取回条目返回。
  ipcMain.handle('resource:registerMcp', async (_evt, config: RegisterMcpInput) => {
    registerMcpDefinition({
      id: randomUUID(),
      name: config.name,
      version: config.version ?? '1.0.0',
      command: config.command,
      args: config.args ?? [],
      env: config.env,
      source: 'custom',
    });
    const items: ResourceItem[] = await listResources({ type: 'mcp', source: 'custom' });
    const item = items.find((i) => i.slug === config.name);
    if (!item) {
      throw new Error(`注册后未在自定义资源中找到 MCP ${config.name}`);
    }
    // custom 资源变更 → 广播资源目录（fire-and-forget）
    void broadcastLocalResourceCatalog();
    return item;
  });

  // resource:uploadSkill — 上传自定义 skill zip，返回 UploadedSkill[]（v1.6.2 起支持批量）。
  // renderer 经 preload 用 Uint8Array 传输（contextBridge 里 Node Buffer 跨 IPC
  // structured clone 会损坏），main 收到后转回 Buffer。
  ipcMain.handle(
    'resource:uploadSkill',
    async (_evt, data: Uint8Array | Buffer, filename: string) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const uploaded = uploadSkillZip(buffer, filename);
      // skill 虽不入 P2P 目录（2.1 排除），仍统一触发广播保持 custom 写通道行为一致
      void broadcastLocalResourceCatalog();
      return uploaded;
    },
  );

  logger.info('Resource IPC handlers 已注册');
}
