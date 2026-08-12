// renderer/src/components/resource-library/SourceBadge.tsx
// 资源来源徽章——4 种 source 各自的中文标签 + Tailwind 主题色。
// 颜色严格按 v1.7 视觉规范，p2p 为 v2 预留（当前数据流不会出现，但 UI 已就绪）。
import type { ResourceSource } from '../../ipc/types';
import { cn } from '../../lib/cn';

/** 4 source × { 中文标签, Tailwind 主题色 class } */
const SOURCE_BADGE: Record<ResourceSource, { label: string; cls: string }> = {
  builtin:     { label: '系统预置', cls: 'bg-accent-blue/20 text-accent-blue' },
  custom:      { label: '我的上传', cls: 'bg-purple-500/20 text-purple-400' },
  marketplace: { label: '网络资源', cls: 'bg-amber-500/20 text-amber-400' },
  p2p:         { label: 'P2P 共享', cls: 'bg-pink-500/20 text-pink-400' },
};

export function SourceBadge({ source }: { source: ResourceSource }) {
  const conf = SOURCE_BADGE[source];
  return (
    <span className={cn('text-[10px] px-1.5 py-0.5 rounded border', conf.cls)}>
      {conf.label}
    </span>
  );
}
