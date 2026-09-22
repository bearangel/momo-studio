// renderer/src/components/resource-library/SourceBadge.tsx
// 资源来源徽章——6 种 source 各自的中文标签 + Badge tone。
// v2.1 P3 裁定：builtin=accent / custom=neutral / marketplace=violet / p2p=success，
// 四色硬编码退役，收敛 Badge 原子件（明暗双模式经 tone 自动适配）。
// P2 双轨 hub（smithery/modelscope）与 marketplace 同为网络安装源，tone 归组 violet。
import type { ResourceSource } from '../../ipc/types';
import type { BadgeTone } from '../ui/Badge';
import { Badge } from '../ui/Badge';

/** source × { 中文标签, Badge tone } */
const SOURCE_BADGE: Record<ResourceSource, { label: string; tone: BadgeTone }> = {
  builtin:     { label: '系统预置', tone: 'accent' },
  custom:      { label: '我的上传', tone: 'neutral' },
  marketplace: { label: '网络资源', tone: 'violet' },
  p2p:         { label: 'P2P 共享', tone: 'success' },
  smithery:    { label: 'Smithery', tone: 'violet' },
  modelscope:  { label: '魔搭社区', tone: 'violet' },
};

export function SourceBadge({ source }: { source: ResourceSource }) {
  const conf = SOURCE_BADGE[source];
  return <Badge tone={conf.tone}>{conf.label}</Badge>;
}
