// renderer/src/components/resource-library/TypeSidebar.tsx
// 资源库二级侧边菜单（spec §2.1 决策①）：Agent / MCP / Skill 三项，无总览。
// 选中态 = bg-surface-active + accent 文字（设计系统导航选中态规范）。
import type { ResourceType } from '../../ipc/types';
import { cn } from '../../lib/cn';
import { TYPE_ICON } from './ResourceRow';

/** 三页菜单配置（与 store.activeType 的 ResourceType 对齐，无 'all'） */
const TYPES: Array<{ key: ResourceType; label: string }> = [
  { key: 'agent', label: 'Agent' },
  { key: 'mcp', label: 'MCP' },
  { key: 'skill', label: 'Skill' },
];

interface TypeSidebarProps {
  activeType: ResourceType;
  onSelect: (t: ResourceType) => void;
}

export function TypeSidebar({ activeType, onSelect }: TypeSidebarProps) {
  return (
    <nav aria-label="资源类型" className="w-28 shrink-0 border-r border-subtle bg-surface-1 py-2 flex flex-col gap-0.5">
      {TYPES.map(({ key, label }) => {
        const Icon = TYPE_ICON[key];
        const active = activeType === key;
        return (
          <button
            key={key}
            type="button"
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 mx-1.5 px-2.5 h-8 rounded-md text-[13px] transition-colors',
              active
                ? 'bg-surface-active text-accent-600 dark:text-accent-300'
                : 'text-secondary hover:bg-surface-3',
            )}
            onClick={() => onSelect(key)}
          >
            <Icon size={16} strokeWidth={1.75} aria-hidden />
            {label}
          </button>
        );
      })}
    </nav>
  );
}
