// renderer/src/components/resource-library/fetch-sources.ts
// 获取弹窗源元数据 + AddMenu 远端组构建（spec 2026-10-29 §2.2/§2.3）。
// 2026-11-02 网络获取下线后远端仅 momo-hub 一源（网络市场 / Smithery 通道已
// 退役）；副文案为预览定值。独立成模块供顺序锁单测纯函数消费（不渲染 View）。
import { ArrowRightLeft } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ResourceType } from '../../ipc/types';
import type { AddMenuItem } from './AddMenu';

/** 获取弹窗远端源（网络获取下线后仅 momo-hub） */
export type FetchSource = 'hub';

/** 源展示名（弹窗标题「从 {源名} 获取」与 AddMenu 菜单项共用） */
export const FETCH_SOURCE_LABEL: Record<FetchSource, string> = {
  hub: 'momo-hub',
};

/** registryList 的 providerKey */
export const FETCH_PROVIDER_KEY: Record<FetchSource, 'hub'> = {
  hub: 'hub',
};

/**
 * 「＋」菜单远端组（在本地项 + 分隔线之后追加）。返回项已带 separatorBefore
 * 标记（首项挂分隔线），AddMenu 据此渲染分组 divider。hub 支持全部资源类型。
 */
export function buildRemoteFetchItems(
  type: ResourceType,
  open: (source: FetchSource) => void,
): AddMenuItem[] {
  const hubHint =
    type === 'agent' || type === 'skill'
      ? '您接入的 hub 节点目录，组内共享资源'
      : '您接入的 hub 节点目录';

  return [
    {
      key: 'fetch-hub',
      title: '从 momo-hub 获取…',
      hint: hubHint,
      icon: ArrowRightLeft,
      separatorBefore: true,
      onSelect: () => open('hub'),
    },
  ];
}

/** 弹窗标题图标（与 AddMenu 菜单项同源） */
export const FETCH_SOURCE_ICON: Record<FetchSource, LucideIcon> = {
  hub: ArrowRightLeft,
};
