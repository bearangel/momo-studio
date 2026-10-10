// renderer/src/components/resource-library/ResourceRow.tsx
// 资源库紧凑行（spec §6.1）——取代卡片网格。结构：
//   图标 + 名称 + 来源徽章 + 一行描述(截断) + 尾部操作槽（按 installed/installable/removable 条件渲染按钮）
//   （徽章紧随名称、与操作槽以弹性描述区隔开——贴着按钮渲染会被误读为可点按钮）
// 操作按钮点击 stopPropagation 防冒泡到行 onSelect。
// 键盘可达（组④ C11）：行 role=button 可聚焦，Enter/Space 选中，↑/↓/Home/End 在行间移动焦点。
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
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
  /** builtin agent 停用入口（2026-10-10：列表行与详情面板对称；影响面确认挂 View 层） */
  onDisable?: (id: string) => void;
}

/** 资源类型兜底图标（item.iconEmoji 优先——用户数据照渲染）。TypeSidebar/TypePageShell 复用。 */
export const TYPE_ICON: Record<ResourceType, LucideIcon> = {
  agent: Bot,
  mcp: Puzzle,
  skill: Package,
};

/** 行间焦点移动（组④ C11）：pick 基于全量行数组与当前索引给出目标行 */
function moveFocus(current: HTMLElement, pick: (rows: HTMLElement[], idx: number) => HTMLElement | undefined): void {
  const rows = Array.from(
    current.parentElement?.querySelectorAll<HTMLElement>('[data-testid^="resource-row-"]') ?? [],
  );
  const next = pick(rows, rows.indexOf(current));
  next?.focus();
}

export function ResourceRow({
  item, selected, onSelect, onInstall, onDelete, onEnable, onEdit, onConfigure, onDisable,
}: ResourceRowProps) {
  const TypeIcon = TYPE_ICON[item.type];

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const el = e.currentTarget;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(item.id);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(el, (rows, i) => rows[i + 1]);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(el, (rows, i) => rows[i - 1]);
    } else if (e.key === 'Home') {
      e.preventDefault();
      moveFocus(el, (rows) => rows[0]);
    } else if (e.key === 'End') {
      e.preventDefault();
      moveFocus(el, (rows) => rows[rows.length - 1]);
    }
  };

  return (
    <div
      data-testid={`resource-row-${item.id}`}
      role="button"
      tabIndex={0}
      aria-label={`${item.name}，${item.description}`}
      className={cn(
        'group flex items-center gap-2 px-3 h-11 rounded-lg border bg-surface-2 cursor-pointer transition-colors',
        selected ? 'border-accent-500' : 'border-subtle hover:border-strong',
      )}
      onClick={() => onSelect(item.id)}
      onKeyDown={onKeyDown}
    >
      {item.iconEmoji ? (
        <span className="text-xl leading-none shrink-0">{item.iconEmoji}</span>
      ) : (
        <TypeIcon size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-secondary" />
      )}
      <span className="font-medium truncate text-primary text-[13px]">{item.name}</span>
      <SourceBadge source={item.source} />
      <span className="text-xs text-tertiary truncate flex-1 min-w-0">{item.description}</span>

      <span className="flex gap-1 items-center shrink-0">
        {/* 安装/导入：仅 installable 且未安装；p2p 文案为「导入」（与详情面板口径一致，走查 A3） */}
        {item.installable && !item.installed && onInstall && (
          <button
            type="button"
            className="text-xs px-2 py-0.5 rounded bg-surface-active text-accent-600 dark:text-accent-300 hover:opacity-80"
            onClick={(e) => { e.stopPropagation(); onInstall(item.id); }}
          >
            {item.source === 'p2p' ? '导入' : '安装'}
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
        {/* 停用：builtin agent 已启用——回到未启用态（与详情面板对称；级联影响面由确认框披露） */}
        {item.type === 'agent' && item.source === 'builtin' && item.builtin?.agentEnabled && onDisable && (
          <button
            type="button"
            className="text-xs px-2 py-0.5 rounded bg-status-error-tint text-status-error hover:opacity-80"
            onClick={(e) => { e.stopPropagation(); onDisable(item.id); }}
          >
            停用
          </button>
        )}
        {/* 已安装静态标记：installed 且不可删的 builtin 非 agent 项（随应用分发语义）。
            mcp DB 行派生项在禁用态改显「已禁用」（warning，组⑤） */}
        {item.mcp && !item.mcp.enabled ? (
          <span className="inline-flex items-center gap-1 text-xs text-status-warning">已禁用</span>
        ) : (
          item.installed &&
          !item.removable &&
          !(item.type === 'agent' && item.source === 'builtin') && (
            <span className="inline-flex items-center gap-1 text-xs text-status-success">
              <Check size={12} strokeWidth={1.75} aria-hidden />
              已安装
            </span>
          )
        )}
        {/* 删除：仅 installed 且 removable（custom 上传项）。常显——hover 浮现方案
            实测会让「点编辑时删除恰好出现在指针处」造成误删，回退常显（danger
            红色样式 + 二次确认弹窗防误触） */}
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
