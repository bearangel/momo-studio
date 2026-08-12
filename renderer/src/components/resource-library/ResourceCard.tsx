// renderer/src/components/resource-library/ResourceCard.tsx
// 资源库统一卡片——展示 name/description/source 徽章，并按资源状态条件渲染
// 「安装」/「🗑 删除」/「✓ 已安装」三态操作区。点击卡片触发 onSelect；按钮内部点击
// 调用 e.stopPropagation() 防止冒泡到卡片 onSelect。
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

/** 资源类型默认 emoji 兜底（item.iconEmoji 优先） */
const TYPE_EMOJI: Record<ResourceItem['type'], string> = {
  agent: '🤖',
  mcp: '🔌',
  skill: '📦',
};

export function ResourceCard({ item, selected, onSelect, onInstall, onDelete }: Props) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 p-3 rounded-lg bg-bg-tertiary border cursor-pointer transition-colors',
        selected ? 'border-accent-blue' : 'border-border-subtle hover:border-border-strong',
      )}
      onClick={() => onSelect(item.id)}
    >
      <div className="flex items-start gap-2">
        <span className="text-2xl leading-none">{item.iconEmoji || TYPE_EMOJI[item.type]}</span>
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate">{item.name}</div>
          <div className="text-xs text-neutral-400 truncate">{item.description}</div>
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
            className="text-xs px-2 py-0.5 rounded bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30"
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
            className="text-xs px-2 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30"
            onClick={(e) => { e.stopPropagation(); onDelete(item.id); }}
          >
            🗑 删除
          </button>
        )}
        {/* 已安装静态标记：仅 installed 且不可删除（如 builtin）时显示 */}
        {item.installed && !item.removable && (
          <span className="text-xs text-neutral-500">✓ 已安装</span>
        )}
      </div>
    </div>
  );
}
