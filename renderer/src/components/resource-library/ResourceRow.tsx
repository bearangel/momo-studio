// renderer/src/components/resource-library/ResourceRow.tsx
// 资源库紧凑行（spec §6.1）——取代卡片网格。结构：
//   图标 + 名称 + 一行描述(截断) + 来源徽章 + 尾部操作槽（按 installed/installable/removable 条件渲染按钮）
// 操作按钮点击 stopPropagation 防冒泡到行 onSelect。
import type { LucideIcon } from 'lucide-react';
import { Bot, Check, Package, Puzzle, Trash2 } from 'lucide-react';
import type { ResourceItem, ResourceType } from '../../ipc/types';
import { cn } from '../../lib/cn';
import { SourceBadge } from './SourceBadge';

interface ResourceRowProps {
  item: ResourceItem;
  selected: boolean;
  onSelect: (id: string) => void;
  /** 可选安装回调；仅当 item.installable && !item.installed 时渲染按钮 */
  onInstall?: (id: string) => void;
  /** 可选删除回调；仅当 item.installed && item.removable 时渲染按钮 */
  onDelete?: (id: string) => void;
  /** builtin agent 未启用时的「启用」回调（弹 EnablePresetDialog） */
  onEnable?: (id: string) => void;
  /** custom agent 的编辑入口（仅 type=agent && source=custom && installed） */
  onEdit?: (id: string) => void;
  /** builtin 已启用 / marketplace 已装 agent 的配置入口 */
  onConfigure?: (id: string) => void;
}

/** 资源类型兜底图标（item.iconEmoji 优先——用户数据照渲染）。TypeSidebar/TypePageShell 复用。 */
export const TYPE_ICON: Record<ResourceType, LucideIcon> = {
  agent: Bot,
  mcp: Puzzle,
  skill: Package,
};

export function ResourceRow({
  item, selected, onSelect, onInstall, onDelete, onEnable, onEdit, onConfigure,
}: ResourceRowProps) {
  const TypeIcon = TYPE_ICON[item.type];
  return (
    <div
      data-testid={`resource-row-${item.id}`}
      className={cn(
        'flex items-center gap-2 px-3 h-11 rounded-lg border bg-surface-2 cursor-pointer transition-colors',
        selected ? 'border-accent-500' : 'border-subtle hover:border-strong',
      )}
      onClick={() => onSelect(item.id)}
    >
      {item.iconEmoji ? (
        <span className="text-xl leading-none shrink-0">{item.iconEmoji}</span>
      ) : (
        <TypeIcon size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-secondary" />
      )}
      <span className="font-medium truncate text-primary text-[13px]">{item.name}</span>
      <span className="text-xs text-tertiary truncate flex-1 min-w-0">{item.description}</span>
      <SourceBadge source={item.source} />

      <span className="flex gap-1 items-center shrink-0">
        {/* 安装：仅 installable 且未安装（registry 浏览 / marketplace 项） */}
        {item.installable && !item.installed && onInstall && (
          <button
            type="button"
            className="text-xs px-2 py-0.5 rounded bg-surface-active text-accent-600 dark:text-accent-300 hover:opacity-80"
            onClick={(e) => { e.stopPropagation(); onInstall(item.id); }}
          >
            安装
          </button>
        )}
        {/* 编辑：custom agent 专属（定义编辑入口） */}
        {item.type === 'agent' && item.source === 'custom' && item.installed && onEdit && (
          <button
            type="button"
            className="text-xs px-2 py-0.5 rounded bg-surface-active text-accent-600 dark:text-accent-300 hover:opacity-80"
            onClick={(e) => { e.stopPropagation(); onEdit(item.id); }}
          >
            编辑
          </button>
        )}
        {/* 配置：builtin 已启用 / marketplace 已装 agent（改模型等） */}
        {item.type === 'agent' && onConfigure &&
          ((item.source === 'builtin' && item.builtin?.agentEnabled) ||
            (item.source === 'marketplace' && item.installed)) && (
          <button
            type="button"
            className="text-xs px-2 py-0.5 rounded bg-surface-active text-accent-600 dark:text-accent-300 hover:opacity-80"
            onClick={(e) => { e.stopPropagation(); onConfigure(item.id); }}
          >
            配置
          </button>
        )}
        {/* 启用：builtin agent 未启用（def 不在库，spec 2026-09-22） */}
        {item.type === 'agent' && item.source === 'builtin' && !item.builtin?.agentEnabled && onEnable && (
          <button
            type="button"
            className="text-xs px-2 py-0.5 rounded bg-surface-active text-accent-600 dark:text-accent-300 hover:opacity-80"
            onClick={(e) => { e.stopPropagation(); onEnable(item.id); }}
          >
            启用
          </button>
        )}
        {/* 已启用标记：builtin agent def 已在库 */}
        {item.type === 'agent' && item.source === 'builtin' && item.builtin?.agentEnabled && (
          <span className="inline-flex items-center gap-1 text-xs text-status-success">
            <Check size={12} strokeWidth={1.75} aria-hidden />
            已启用
          </span>
        )}
        {/* 已安装静态标记：installed 且不可删的 builtin 非 agent 项（随应用分发语义） */}
        {item.installed && !item.removable && !(item.type === 'agent' && item.source === 'builtin') && (
          <span className="inline-flex items-center gap-1 text-xs text-status-success">
            <Check size={12} strokeWidth={1.75} aria-hidden />
            已安装
          </span>
        )}
        {/* 删除：仅 installed 且 removable（custom 上传项） */}
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
      </span>
    </div>
  );
}
