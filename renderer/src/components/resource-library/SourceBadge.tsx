// renderer/src/components/resource-library/SourceBadge.tsx
// 资源来源徽章——4 种 source 各自的中文标签 + Badge tone。
// v2.1 P3 裁定：builtin=accent / custom=neutral / marketplace=violet / p2p=success，
// 四色硬编码退役，收敛 Badge 原子件（明暗双模式经 tone 自动适配）。
import type { ResourceSource } from '../../ipc/types';
import type { BadgeTone } from '../ui/Badge';
import { Badge } from '../ui/Badge';

/** 4 source × { 中文标签, Badge tone } */
const SOURCE_BADGE: Record<ResourceSource, { label: string; tone: BadgeTone }> = {
  builtin:     { label: '系统预置', tone: 'accent' },
  custom:      { label: '我的上传', tone: 'neutral' },
  marketplace: { label: '网络资源', tone: 'violet' },
  p2p:         { label: 'P2P 共享', tone: 'success' },
};

export function SourceBadge({ source }: { source: ResourceSource }) {
  const conf = SOURCE_BADGE[source];
  return <Badge tone={conf.tone}>{conf.label}</Badge>;
}
