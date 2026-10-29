// renderer/src/components/resource-library/fetch-sources.ts
// 获取弹窗三源元数据 + AddMenu 远端组构建（spec 2026-10-29 §2.2/§2.3）。
// 顺序是预览定值：hub 永远置顶 → 网络市场 → Smithery（仅 mcp）；
// 副文案逐页取预览定值（agent/skill 同形态；plugin 仅 hub）。独立成模块供
// 顺序锁单测纯函数消费（不渲染 View）。
import { ArrowRightLeft, Globe, Hammer } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ResourceType } from '../../ipc/types';
import type { AddMenuItem } from './AddMenu';

/** 获取弹窗远端源 */
export type FetchSource = 'hub' | 'marketplace' | 'smithery';

/** 源展示名（弹窗标题「从 {源名} 获取」与 AddMenu 菜单项共用） */
export const FETCH_SOURCE_LABEL: Record<FetchSource, string> = {
  hub: 'momo-hub',
  marketplace: '网络市场',
  smithery: 'Smithery',
};

/** registryList 的 providerKey（marketplace 走 builtin 分支 = catalog 快照） */
export const FETCH_PROVIDER_KEY: Record<FetchSource, 'hub' | 'builtin' | 'smithery'> = {
  hub: 'hub',
  marketplace: 'builtin',
  smithery: 'smithery',
};

/** 各源支持的资源类型（与 registryProviders 的 types 对齐：marketplace 无 plugin） */
export function sourceSupportsType(source: FetchSource, type: ResourceType): boolean {
  if (source === 'hub') return true;
  if (source === 'marketplace') return type !== 'plugin';
  return type === 'mcp';
}

/**
 * 「＋」菜单远端组（在本地项 + 分隔线之后追加）。返回项已带 separatorBefore
 * 标记（首项挂分隔线），AddMenu 据此渲染分组 divider。
 */
export function buildRemoteFetchItems(
  type: ResourceType,
  open: (source: FetchSource) => void,
): AddMenuItem[] {
  const hubHint =
    type === 'agent' || type === 'skill'
      ? '您接入的 hub 节点目录，组内共享资源'
      : '您接入的 hub 节点目录';
  const marketplaceHint =
    type === 'agent' || type === 'skill' ? '官方内置精选目录，下载 zip 校验安装' : '官方内置精选目录';

  const items: AddMenuItem[] = [
    {
      key: 'fetch-hub',
      title: '从 momo-hub 获取…',
      hint: hubHint,
      icon: ArrowRightLeft,
      separatorBefore: true,
      onSelect: () => open('hub'),
    },
  ];
  if (type !== 'plugin') {
    items.push({
      key: 'fetch-marketplace',
      title: '从网络市场获取…',
      hint: marketplaceHint,
      icon: Globe,
      onSelect: () => open('marketplace'),
    });
  }
  if (type === 'mcp') {
    items.push({
      key: 'fetch-smithery',
      title: '从 Smithery 获取…',
      hint: '社区 MCP 服务器目录（smithery.ai），远程直连',
      icon: Hammer,
      onSelect: () => open('smithery'),
    });
  }
  return items;
}

/** 弹窗标题图标（与 AddMenu 菜单项同源） */
export const FETCH_SOURCE_ICON: Record<FetchSource, LucideIcon> = {
  hub: ArrowRightLeft,
  marketplace: Globe,
  smithery: Hammer,
};
