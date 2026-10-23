// renderer/src/components/resource-library/type-icons.ts
// 资源类型兜底图标（item.iconEmoji 优先——用户数据照渲染）。
// 2026-10-23 卡片化：自 ResourceRow.tsx 迁出（紧凑行形态随卡片网格替换退役），
// TypeSidebar / TypePageShell / ResourceCard 三方消费。
import type { LucideIcon } from 'lucide-react';
import { Bot, Blocks, Package, Puzzle } from 'lucide-react';
import type { ResourceType } from '../../ipc/types';

export const TYPE_ICON: Record<ResourceType, LucideIcon> = {
  agent: Bot,
  mcp: Puzzle,
  skill: Package,
  plugin: Blocks,
};
