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
import type { ResourceItem } from '../../ipc/types';

/**
 * 发布入口可见性判定（卡面按钮 / 详情按钮 / 未接入引导条三处同源）。
 * 只读 type/source/installed——与展示层数据同源，不引主进程状态。
 */
export function canPublishToHub(item: Pick<ResourceItem, 'type' | 'source' | 'installed'>): boolean {
  if (item.source === 'custom') return true;
  return item.type === 'skill' && item.source === 'marketplace' && item.installed;
}
