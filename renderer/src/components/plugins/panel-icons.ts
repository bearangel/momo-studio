// renderer/src/components/plugins/panel-icons.ts
//
// panel.json icon（'lucide:<name>'）→ 组件映射。v1 白名单（panel-sync 已限
// lucide: 前缀）；未收录名回落 Puzzle（与 manifest 缺省同款，视觉可辨）。
import type { LucideIcon } from 'lucide-react';
import {
  Puzzle,
  GitFork,
  GitBranch,
  Network,
  Boxes,
  Layers,
  Workflow,
  FileSearch,
  TerminalSquare,
} from 'lucide-react';

export const PANEL_ICONS: Record<string, LucideIcon> = {
  puzzle: Puzzle,
  'git-fork': GitFork,
  'git-branch': GitBranch,
  network: Network,
  boxes: Boxes,
  layers: Layers,
  workflow: Workflow,
  'file-search': FileSearch,
  terminal: TerminalSquare,
};

export function panelIconOf(icon: string): LucideIcon {
  return PANEL_ICONS[icon.replace(/^lucide:/, '')] ?? Puzzle;
}
