// electron/src/main/resource/catalog-adapter.ts
//
// v1.7 共享转换工具：把 marketplace 域的 MarketplaceItem（catalog.json 单条）
// 转成 resource 域的 ResourceItem（v1.7 UI/IPC 统一数据结构）。
//
// builtin / marketplace / hub 三源共用本函数——通过 source 参数区分：
//   - builtin：installed 恒 true（系统预置随应用分发，不可移除）
//   - marketplace：installed 由 marketplace/installer.listInstalled() 判断
//   - hub：同 marketplace 口径，但 item_id 带 'hub:' 前缀（spec M1 §6.2 零 schema
//     变更区分来源），installed_packages 命中即视为已装
//
// 设计上保持纯函数风格（除 listInstalled / listAgentDefinitions 两处查 DB），
// 便于测试与组合。listInstalled 复用现有底层而非重新实现安装状态查询，
// listAgentDefinitions 用于 agentEnabled 计算——均避免双写数据源。

import type { MarketplaceItem } from '../marketplace/types';
import type { ResourceItem, ResourceSource } from './types';
import { buildResourceId } from './types';
import { listInstalled as listMarketplaceInstalled } from '../marketplace/installer';
import { listAgentDefinitions } from '../agent/crud';

/**
 * 把单条 catalog item 转成 ResourceItem。
 *
 * @param item   catalog.json 中的单条项（builtin 内联或 marketplace 远程均可）
 * @param source 资源来源标记：'builtin' / 'marketplace' / 'hub'
 *
 * 安装状态语义：
 *   - builtin      → installed=true, installable=false, removable=false
 *                    （系统预置随应用分发，已就位不可移除）
 *   - marketplace  → installed 由 listInstalled() 判断
 *                    未装：installable=true,  removable=false
 *                    已装：installable=false, removable=true
 *   - hub          → 同 marketplace（item_id 带 'hub:' 前缀）
 *
 * builtin 项保留 marketplace 元数据（author/readme/tags 等），详情面板按需读取。
 */
export function fromCatalogItem(item: MarketplaceItem, source: ResourceSource): ResourceItem {
  const id = buildResourceId(source, item.type, item.slug);

  // 安装状态：builtin 恒已装；marketplace/hub 查 installed_packages 表。
  // installedVersion（D7）：记账行版本——hub 角标「可更新」判定的锚点数据
  //（与目录 head version 区分：目录先行 + 事件迟到时两者不等）
  const installedRow =
    source === 'builtin'
      ? undefined
      // M5.2：只有真实安装（cachePath 非空）才算已装——发布记账行（cachePath='')
      // 不是安装，旧判定让它把「创建→发布」的资源在库页顶出第二张 hub 卡
      : listMarketplaceInstalled().find((p) => p.itemId === item.id && p.cachePath !== '');
  const installed = source === 'builtin' ? true : installedRow !== undefined;

  // 预设启用态（spec 2026-09-22 §6）：仅 builtin agent 计算——按 slug 匹配
  // agent_definitions（与 marketplace install 的 slug 复用同口径，不分 source）
  const agentEnabled =
    source === 'builtin' && item.type === 'agent'
      ? listAgentDefinitions().some((d) => d.slug === item.slug)
      : undefined;

  // marketplace / hub 两源同口径：未装可装、已装可卸
  const installableSource = source === 'marketplace' || source === 'hub';

  return {
    id,
    type: item.type,
    source,
    slug: item.slug,
    name: item.name,
    description: item.description,
    version: item.version,
    installedVersion: installedRow?.version,
    iconEmoji: item.iconEmoji,
    installed,
    // installable / removable 按 source + installed 状态推导
    installable: installableSource && !installed,
    removable: installableSource && installed,
    // builtin 项的轻量分类信息（与 marketplace namespace 字段重叠但语义独立，
    // 便于前端按 source 路由到不同详情面板时快速读取）
    builtin:
      source === 'builtin'
        ? {
            category: item.category,
            tags: item.tags,
            ...(agentEnabled !== undefined ? { agentEnabled } : {}),
          }
        : undefined,
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
