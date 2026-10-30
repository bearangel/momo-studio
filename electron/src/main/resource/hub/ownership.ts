// electron/src/main/resource/hub/ownership.ts
//
// M5.0 资源归属 studio 侧判定单源（spec 2026-10-30 §7.5 源头拦截 + 存量清理）：
//
//   - hasLocalSlugEntity / isHubInstallAccounted：本地同 type+slug「自有实体」与
//     「hub 装记账」的判定原子（安装链拦截与并存扫描共用，防两处口径漂移）
//   - assertNoLocalSlugConflict：安装链（installHubPackage 单点）拦截入口——
//     本地自有实体在场且非 hub 装记账 → HubSlugConflictError 拒装，消「自定义 +
//     hub 版」并存从源头断根（同时堵 mirror 自动补装路径）
//   - scanHubCoexistIssues：存量并存扫描（设置页 hub 面板一次扫描清单非阻断）——
//     hub 装记账 + 本地 custom 实体同 slug 并存：owner=本机引导删 hub 副本，
//     异物提示可保留
//
// 判定口径（消费面矩阵 §5）：
//   - 「自有实体」= custom/marketplace 源本地实体（agent 定义 / mcp 注册行 /
//     skill 已装清单 / plugins 注册行）；builtin 不算——hub 装另起 marketplace
//     行，异源并存是 P2-4 既有语义
//   - 「hub 装记账」= installed_packages `hub:{slug}` 同 type 行且 cache_path !== ''
//     （发布记账回填行恒 cache_path=''——recordPublishAccounting 语义；空串/非空
//     是「发布过」与「从 hub 装过」的唯一判别锚，一义一名）
//   - plugin 特例：zip 装/注册与 hub 装共用 plugins 表同一行，物理上不并存——
//     记账非空即 hub 装本体，冲突判定自然放行、扫描不产出 plugin 行

import { listAgentDefinitions } from '../../agent/agent-queries';
import { listRegistered } from '../../mcp/host-manager';
import { listInstalled as listInstalledSkills } from '../../skill/zip-uploader';
import { getPlugin } from '../../plugin/registry';
import { listInstalled } from '../../marketplace/installer';
import { getHubCatalogOwnership, hubPackageItemId } from './momo-hub';
import { HubSlugConflictError } from '../hub-install';
import type { ResourceType } from '../types';

/** 本地同 type+slug 自有实体（custom/marketplace 源）在场判定 */
export function hasLocalSlugEntity(type: ResourceType, slug: string): boolean {
  switch (type) {
    case 'agent':
      return listAgentDefinitions().some(
        (d) => d.slug === slug && (d.source === 'custom' || d.source === 'marketplace'),
      );
    case 'mcp':
      return listRegistered().some(
        (m) => m.name === slug && (m.source === 'custom' || m.source === 'marketplace'),
      );
    case 'skill':
      return listInstalledSkills().some(
        (s) => s.slug === slug && (s.source === 'custom' || s.source === 'marketplace'),
      );
    case 'plugin':
      return getPlugin(slug) !== null;
  }
}

/** hub 装记账命中（`hub:{slug}` 同 type 行且 cache_path 非空 = 真从 hub 装过） */
export function isHubInstallAccounted(type: ResourceType, slug: string): boolean {
  return listInstalled().some(
    (p) => p.itemId === hubPackageItemId(slug) && p.itemType === type && p.cachePath !== '',
  );
}

/**
 * 安装链 slug 冲突拦截（spec §7.5）：本地自有实体在场且非 hub 装记账 → 抛
 * HubSlugConflictError。存量并存（custom + 旧 hub 装记账）不拦——更新合法，
 * 清理由扫描小票引导。
 */
export function assertNoLocalSlugConflict(type: ResourceType, slug: string): void {
  if (hasLocalSlugEntity(type, slug) && !isHubInstallAccounted(type, slug)) {
    throw new HubSlugConflictError(
      `本地已有同名自定义资源（${type}「${slug}」）；如需安装请先删除或改名本地版本`,
    );
  }
}

/** 并存小票行（resource:hubCoexistScan 返回——renderer HubSettingsPanel 消费） */
export interface HubCoexistIssue {
  type: ResourceType;
  slug: string;
  /** hub 装记账版本（hub 副本版本） */
  hubVersion: string;
  /** 目录归属是否本机（owner=本机 → 引导删 hub 副本；否则提示异物可保留） */
  ownedBySelf: boolean;
}

/**
 * 存量并存扫描：hub 装记账（cache 非空）× 本地 custom 实体同 slug 并存清单。
 * plugin 物理不并存（见模块头）——恒不产出。目录归属经 getHubCatalogOwnership
 * （lastGood 语义——hub 不可达时按最近已知归属判，扫描非阻断可接受）。
 */
export async function scanHubCoexistIssues(): Promise<HubCoexistIssue[]> {
  const ownership = await getHubCatalogOwnership();
  const ownerOf = (type: ResourceType, slug: string): string | undefined =>
    ownership.entries.find((e) => e.type === type && e.slug === slug)?.ownerNodeId;
  const selfNodeId = ownership.notEnrolled ? null : ownership.selfNodeId;

  const issues: HubCoexistIssue[] = [];
  const seen = new Set<string>();
  for (const row of listInstalled()) {
    if (!row.itemId.startsWith('hub:') || row.cachePath === '') continue;
    const type = row.itemType;
    if (type !== 'agent' && type !== 'mcp' && type !== 'skill') continue;
    const slug = row.itemId.slice('hub:'.length);
    const key = `${type}:${slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 「本地自有实体」排除 hub 副本本体：skill/agent/mcp 的 marketplace 源行在
    // 记账在场时即 hub 副本——只认 custom 源（与拦截口径的差异点：拦截面更宽
    // （marketplace catalog 装也被护），扫描面只报告真实并存）
    const hasCustomEntity =
      type === 'agent'
        ? listAgentDefinitions().some((d) => d.slug === slug && d.source === 'custom')
        : type === 'mcp'
          ? listRegistered().some((m) => m.name === slug && m.source === 'custom')
          : listInstalledSkills().some((s) => s.slug === slug && s.source === 'custom');
    if (!hasCustomEntity) continue;
    const owner = ownerOf(type, slug);
    issues.push({
      type,
      slug,
      hubVersion: row.version,
      ownedBySelf: selfNodeId !== null && owner !== undefined && owner === selfNodeId,
    });
  }
  return issues;
}
