// renderer/src/components/resource-library/publish-entry.ts
//
// 发布到 momo-hub 入口门控（M2.2 Task 2，spec §2.2 UC-P1-2）：单点收敛
// ResourceCard / ResourceDetail 两处渲染点的显示判定——防门控漂移
// （ResourceDetail hasMarketplaceMeta 同款纪律：一处定义两处复用）。
//
// 规则（消费面矩阵 .omo/feature-matrices/2026-10-27-m22-publish-entry.md）：
//   - custom 四类型维持（M1 Task 14：本机自有内容）
//   - marketplace 源 skill 本次开放（superpowers 类主场景——cache_path 目录
//     整包，主进程 buildSkillPackage 无来源闸）；限已装：发布语义 =
//     「本机已装此资源且愿意分发」，未装项无本地包可打
//   - builtin / hub / smithery / plugin 源维持不可发布；agent / mcp 维持仅 custom
//
// M5.0 资源归属（spec 2026-10-30 §7.4，矩阵 2026-10-30-m5.0-ownership-studio.md）：
// 目录同 type+slug 归属 = 他节点（'other'）→ 发布钮不渲染（领地制——发了也
// 403）；own/unknown 维持渲染（own = 本人权威可发新版；unknown = 无字段/目录
// 无此 slug/hub 不可达——发布尝试兜底，403 人话接住）。
import type { ResourceItem } from '../../ipc/types';

/**
 * 发布入口可见性判定（卡面按钮 / 详情按钮 / 未接入引导条三处同源）。
 * 只读 type/source/installed——与展示层数据同源，不引主进程状态。
 */
export function canPublishToHub(item: Pick<ResourceItem, 'type' | 'source' | 'installed'>): boolean {
  if (item.source === 'custom') return true;
  return item.type === 'skill' && item.source === 'marketplace' && item.installed;
}

/** 目录条目归属行（hubCatalogOwnership entries 的元素 / RegistryListEntry 子集） */
export interface HubSlugOwnership {
  ownerNodeId?: string;
}

/**
 * 归属三态判定（M5.0 单源——徽标 / 发布钮 / 下架钮 / 弹窗 own 行共用）：
 *   - 'own'    目录条目 ownerNodeId = 本机 → 「已发布」徽标
 *   - 'other'  ownerNodeId 在场且 ≠ 本机 → 发布/下架钮不渲染（403 兜底省一次点击）
 *   - 'unknown' 无目录条目 / 无字段（无主、旧 hub）/ 未接入 → 维持现状（安全降级）
 */
export function resolveHubOwnership(
  ownership: HubSlugOwnership | undefined,
  selfNodeId: string | null,
): 'own' | 'other' | 'unknown' {
  if (selfNodeId === null) return 'unknown';
  const owner = ownership?.ownerNodeId;
  if (owner === undefined) return 'unknown';
  return owner === selfNodeId ? 'own' : 'other';
}
