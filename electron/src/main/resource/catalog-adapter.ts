// electron/src/main/resource/catalog-adapter.ts
//
// v1.7 共享转换工具：把 marketplace 域的 MarketplaceItem（catalog.json 单条）
// 转成 resource 域的 ResourceItem（v1.7 UI/IPC 统一数据结构）。
//
// builtin 与 marketplace 两源共用本函数——通过 source 参数区分：
//   - builtin：installed 恒 true（系统预置随应用分发，不可移除）
//   - marketplace：installed 由 marketplace/installer.listInstalled() 判断
//
// 设计上保持纯函数风格（除 listInstalled 一处查 DB），便于测试与组合。
// listInstalled 复用现有底层而非重新实现安装状态查询，避免双写数据源。

import type { MarketplaceItem } from '../marketplace/types';
import type { ResourceItem, ResourceSource } from './types';
import { buildResourceId } from './types';
import { listInstalled as listMarketplaceInstalled } from '../marketplace/installer';

/**
 * 把单条 catalog item 转成 ResourceItem。
 *
 * @param item   catalog.json 中的单条项（builtin 内联或 marketplace 远程均可）
 * @param source 资源来源标记：'builtin' 或 'marketplace'
 *
 * 安装状态语义：
 *   - builtin      → installed=true, installable=false, removable=false
 *                    （系统预置随应用分发，已就位不可移除）
 *   - marketplace  → installed 由 listInstalled() 判断
 *                    未装：installable=true,  removable=false
 *                    已装：installable=false, removable=true
 *
 * builtin 项保留 marketplace 元数据（author/readme/tags 等），详情面板按需读取。
 */
export function fromCatalogItem(item: MarketplaceItem, source: ResourceSource): ResourceItem {
  const id = buildResourceId(source, item.type, item.slug);

  // 安装状态：builtin 恒已装；marketplace 查 installed_packages 表
  const installedPackageIds = listMarketplaceInstalled().map((p) => p.itemId);
  const installed = source === 'builtin' ? true : installedPackageIds.includes(item.id);

  return {
    id,
    type: item.type,
    source,
    slug: item.slug,
    name: item.name,
    description: item.description,
    version: item.version,
    iconEmoji: item.iconEmoji,
    installed,
    // installable / removable 按 source + installed 状态推导
    installable: source === 'marketplace' && !installed,
    removable: source === 'marketplace' && installed,
    // builtin 项的轻量分类信息（与 marketplace namespace 字段重叠但语义独立，
    // 便于前端按 source 路由到不同详情面板时快速读取）
    builtin: source === 'builtin' ? { category: item.category, tags: item.tags } : undefined,
    // 完整 catalog 元数据保留——builtin 项也保留（详情面板共用同一渲染逻辑）
    marketplace: {
      author: item.author,
      readme: item.readme,
      downloadUrl: item.downloadUrl,
      checksum: item.checksum,
      verificationStatus: item.verificationStatus,
      sizeBytes: item.sizeBytes,
      installCount: item.installCount,
      tags: item.tags,
      category: item.category,
    },
  };
}
