// renderer/src/components/resource-library/ResourceCard.tsx
// 资源库统一卡片——展示 name/description/source 徽章，并按资源状态条件渲染
// 「安装」/「删除」/「已安装」三态操作区。点击卡片触发 onSelect；按钮内部点击
// 调用 e.stopPropagation() 防止冒泡到卡片 onSelect。
// v2.1 P3：token 化；类型兜底 emoji → lucide（Bot/Puzzle/Package，iconEmoji 用户数据照渲染）；
// 🗑 → Trash2、「✓ 已安装」→ Check lucide。
import type { LucideIcon } from 'lucide-react';
import { Bot, Check, Package, Puzzle, Trash2 } from 'lucide-react';
import type { ResourceItem } from '../../ipc/types';
import { cn } from '../../lib/cn';
import { SourceBadge } from './SourceBadge';

interface Props {
  item: ResourceItem;
  selected: boolean;
  /** 点击卡片（非按钮）时回调，参数为 item.id */
  onSelect: (id: string) => void;
  /** 可选安装按钮回调；仅当 item.installable && !item.installed 时显示 */
  onInstall?: (id: string) => void;
  /** 可选删除按钮回调；仅当 item.installed && item.removable 时显示 */
  onDelete?: (id: string) => void;
}

/** 资源类型兜底图标（item.iconEmoji 优先——用户数据照渲染） */
const TYPE_ICON: Record<ResourceItem['type'], LucideIcon> = {
  agent: Bot,
  mcp: Puzzle,
  skill: Package,
};

export function ResourceCard({ item, selected, onSelect, onInstall, onDelete }: Props) {
  const TypeIcon = TYPE_ICON[item.type];
  return (
    <div
      className={cn(
        'flex flex-col gap-2 p-3 rounded-lg bg-surface-2 border cursor-pointer transition-colors',
        selected ? 'border-accent-500' : 'border-subtle hover:border-strong',
      )}
      onClick={() => onSelect(item.id)}
    >
      <div className="flex items-start gap-2">
        {item.iconEmoji ? (
          <span className="text-2xl leading-none">{item.iconEmoji}</span>
        ) : (
          <TypeIcon size={16} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate text-primary">{item.name}</div>
          <div className="text-xs text-tertiary truncate">{item.description}</div>
        </div>
      </div>

      <div className="flex gap-1 flex-wrap">
        <SourceBadge source={item.source} />
      </div>

      <div className="mt-auto flex gap-1 items-center">
        {/* 安装按钮：仅 installable 且未安装时显示 */}
        {item.installable && !item.installed && onInstall && (
          <button
            type="button"
            className="text-xs px-2 py-0.5 rounded bg-surface-active text-accent-600 dark:text-accent-300 hover:opacity-80"
            onClick={(e) => { e.stopPropagation(); onInstall(item.id); }}
          >
            安装
          </button>
        )}
        {/* 删除按钮：仅 installed 且 removable 时显示 */}
        {item.installed && item.removable && onDelete && (
          <button
            type="button"
            aria-label={`删除 ${item.name}`}
            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-status-error-tint text-status-error hover:opacity-80"
            onClick={(e) => { e.stopPropagation(); onDelete(item.id); }}
          >
            <Trash2 size={12} strokeWidth={1.75} aria-hidden />
            删除
          </button>
        )}
        {/* 已安装静态标记：仅 installed 且不可删除（如 builtin）时显示 */}
        {item.installed && !item.removable && (
          <span className="inline-flex items-center gap-1 text-xs text-status-success">
            <Check size={12} strokeWidth={1.75} aria-hidden />
            已安装
          </span>
        )}
      </div>
    </div>
  );
}
