// renderer/src/components/resource-library/ResourceCard.tsx
// 资源库卡片（2026-10-23 卡片化 + 流式布局，P1 预览批准定值）——取代紧凑行
// （spec 2026-09-22 §6.1 行形态退役；当时否决卡片的「状态难承载」由底栏
// 左状态/右操作双簇解决）。结构：
//   头：emoji/类型图标 + 名称(truncate) + 来源徽章（右贴，与行内「徽章紧随名称」
//       不同——卡片头部横向空间按弹性分配，右贴避免名称截断宽度被挤压）
//   身：描述两行截断（min-h-9 保证同行卡片底栏对齐）
//   底栏：状态标记簇居左（插件停用/目录缺失/已启用/已安装/已禁用）、
//         操作簇居右（开关/安装/启用/编辑/配置/停用/删除图标钮）。
// 全部条件渲染 1:1 迁移自 ResourceRow，零行为变更。
// 操作按钮点击 stopPropagation 防冒泡到卡片 onSelect。
// 键盘可达（2D 升级）：卡片 role=button 可聚焦，Enter/Space 选中，
// ←→↑↓/Home/End 网格导航（列数按 offsetTop 分组动态推导——详情面板拖宽/
// 窗口缩放引起重排后列数变化，不写死）。
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, RefreshCw, Trash2 } from 'lucide-react';
import type { ResourceItem } from '../../ipc/types';
import { cn } from '../../lib/cn';
import { Badge } from '../ui/Badge';
import { SourceBadge } from './SourceBadge';
import { Switch } from '../ui/Switch';
import { TYPE_ICON } from './type-icons';

interface ResourceCardProps {
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
  /** builtin agent 停用入口（2026-10-10：卡片与详情面板对称；影响面确认挂 View 层） */
  onDisable?: (id: string) => void;
  /** 插件工作空间级启停（spec 2026-10-21 §9①：卡内开关；View 层接 store.setPluginEnabled） */
  onTogglePlugin?: (item: ResourceItem, next: boolean) => void;
  /** 发布到 momo-hub 入口（M1 Task 14）：custom 资源四类型限定显示 */
  onPublishToHub?: (item: ResourceItem) => void;
  /** hub 是否已接入（enrolled）——false 时发布入口禁用 + title 引导 */
  hubEnrolled?: boolean;
  /** hub 发布事件带来的最新版本表（key `${type}:${slug}` → 版本；角标判定源） */
  hubUpdates?: Record<string, string>;
}

/** 网格焦点移动：pick 基于全量卡片数组、当前索引与「当前行的列数」给出目标卡。
 *  列数 = 与当前卡片 offsetTop 相同的卡片数（同一视觉行）——响应式重排后自动
 *  跟随，无硬编码列数；拿不到布局信息（全 0）时退化为全体一行，↑↓ 跳界由
 *  调用方钳制兜底。 */
function moveFocus(
  current: HTMLElement,
  pick: (cards: HTMLElement[], idx: number, columns: number) => HTMLElement | undefined,
): void {
  const grid = current.parentElement;
  if (!grid) return;
  const cards = Array.from(
    grid.querySelectorAll<HTMLElement>('[data-testid^="resource-card-"]'),
  );
  const columns = cards.filter((c) => c.offsetTop === current.offsetTop).length || 1;
  pick(cards, cards.indexOf(current), columns)?.focus();
}

export function ResourceCard({
  item, selected, onSelect, onInstall, onDelete, onEnable, onEdit, onConfigure, onDisable, onTogglePlugin,
  onPublishToHub, hubEnrolled, hubUpdates,
}: ResourceCardProps) {
  const TypeIcon = TYPE_ICON[item.type];
  // hub 可更新角标判定（M1 Task 14）：已装 hub 资源 + 事件版本 ≠ 已装版本——
  // 恒等比较不做 semver（T10 裁定：hub versions[0] 是时序最新而非 semver 最大）
  const hubLatest =
    item.source === 'hub' ? hubUpdates?.[`${item.type}:${item.slug}`] : undefined;
  const hubUpdatable =
    item.source === 'hub' && item.installed && !!item.version && !!hubLatest && hubLatest !== item.version;

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const el = e.currentTarget;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(item.id);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      // 跳整行；末行不满列时钳制到最后一张（网格惯例）
      moveFocus(el, (cards, i, cols) => cards[Math.min(i + cols, cards.length - 1)]);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(el, (cards, i, cols) => cards[Math.max(i - cols, 0)]);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      moveFocus(el, (cards, i) => cards[i + 1]);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      moveFocus(el, (cards, i) => cards[i - 1]);
    } else if (e.key === 'Home') {
      e.preventDefault();
      moveFocus(el, (cards) => cards[0]);
    } else if (e.key === 'End') {
      e.preventDefault();
      moveFocus(el, (cards) => cards[cards.length - 1]);
    }
  };

  return (
    <div
      data-testid={`resource-card-${item.id}`}
      role="button"
      tabIndex={0}
      aria-label={`${item.name}，${item.description}`}
      className={cn(
        'group flex flex-col gap-2 p-3 rounded-lg border bg-surface-2 cursor-pointer transition-colors min-w-0',
        selected ? 'border-accent-500' : 'border-subtle hover:border-strong',
      )}
      onClick={() => onSelect(item.id)}
      onKeyDown={onKeyDown}
    >
      {/* 头：图标 + 名称 + 来源徽章右贴 */}
      <div className="flex items-center gap-2 min-w-0">
        {item.iconEmoji ? (
          <span className="text-xl leading-none shrink-0">{item.iconEmoji}</span>
        ) : (
          <TypeIcon size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-secondary" />
        )}
        <span className="font-medium truncate text-primary text-[13px] min-w-0">{item.name}</span>
        <span className="ml-auto shrink-0">
          <SourceBadge source={item.source} />
        </span>
      </div>

      {/* 身：描述两行截断（min-h-9 对齐同行卡片底栏） */}
      <span className="text-xs text-tertiary leading-normal line-clamp-2 min-h-9">
        {item.description}
      </span>

      {/* 底栏：左状态标记簇 + 右操作簇（mt-auto 锚底） */}
      <span className="mt-auto flex flex-wrap items-center gap-1">
        {/* ── 左：状态标记 ─────────────────────────────────────────── */}
        {/* plugin 源卡（mcp/skill/agent）：来源插件在当前 ws 停用——管理面保留卡+徽标（矩阵 C7） */}
        {item.pluginDisabled && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-surface-3 text-tertiary">插件已停用</span>
        )}
        {/* 插件启停面（spec 2026-10-21 §9①）：恒显徽标（当前 ws 视角） */}
        {item.type === 'plugin' && item.plugin && (
          <>
            {item.plugin.state === 'missing' ? (
              <span className="text-xs px-2 py-0.5 rounded-full bg-status-error-tint text-status-error">目录缺失</span>
            ) : item.plugin.enabled ? (
              <span className="text-xs px-2 py-0.5 rounded-full bg-status-success-tint text-status-success">已启用</span>
            ) : (
              <span className="text-xs px-2 py-0.5 rounded-full bg-surface-3 text-tertiary">已停用</span>
            )}
          </>
        )}
        {/* 已启用标记：builtin agent def 已在库 */}
        {item.type === 'agent' && item.source === 'builtin' && item.builtin?.agentEnabled && (
          <span className="inline-flex items-center gap-1 text-xs text-status-success">
            <Check size={12} strokeWidth={1.75} aria-hidden />
            已启用
          </span>
        )}
        {/* 已安装静态标记：installed 且不可删的 builtin 非 agent 项（随应用分发语义）。
            mcp DB 行派生项在停用态改显「已停用」（warning，组⑤；D5 措辞统一） */}
        {item.mcp && !item.mcp.enabled ? (
          <span className="inline-flex items-center gap-1 text-xs text-status-warning">已停用</span>
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

        {/* hub 已装资源版本态（M1 Task 14）：可更新 → warning 徽标 + 版本变迁；
            已是最新 → 纯文案不占徽标（预览 ④ 定值） */}
        {item.source === 'hub' && item.installed && (
          hubUpdatable ? (
            <>
              <Badge tone="warning" className="shrink-0">
                <RefreshCw size={12} strokeWidth={1.75} aria-hidden />
                可更新
              </Badge>
              <span className="whitespace-nowrap text-xs text-tertiary">
                v{item.version} → v{hubLatest}
              </span>
            </>
          ) : (
            item.version && (
              <span className="whitespace-nowrap text-xs text-tertiary">
                v{item.version} · 已是最新
              </span>
            )
          )
        )}

        {/* ── 右：操作簇 ───────────────────────────────────────────── */}
        <span className="flex gap-1 items-center ml-auto shrink-0">
          {/* 插件启停开关（spec 2026-10-21 §9①） */}
          {item.type === 'plugin' && item.plugin && onTogglePlugin && (
            <Switch
              checked={item.plugin.enabled}
              disabled={item.plugin.state === 'missing'}
              aria-label={`${item.plugin.enabled ? '停用' : '启用'}插件 ${item.name}`}
              onChange={(next) => onTogglePlugin(item, next)}
            />
          )}
          {/* 安装/导入：仅 installable 且未安装；p2p 文案为「导入」（与详情面板口径一致，走查 A3） */}
          {item.installable && !item.installed && onInstall && (
            <button
              type="button"
              className="text-xs px-2 py-0.5 rounded bg-surface-active text-accent-600 dark:text-accent-300 hover:opacity-80"
              onClick={(e) => { e.stopPropagation(); onInstall(item.id); }}
            >
              安装
            </button>
          )}
          {/* 更新：hub 已装且事件版本较新——走既有安装链拉新版本（M1 Task 14） */}
          {hubUpdatable && onInstall && (
            <button
              type="button"
              className="text-xs px-2 py-0.5 rounded bg-surface-active text-accent-600 dark:text-accent-300 hover:opacity-80"
              onClick={(e) => { e.stopPropagation(); onInstall(item.id); }}
            >
              更新
            </button>
          )}
          {/* 发布到 hub：custom 资源四类型限定；未接入禁用 + title 引导（M1 Task 14） */}
          {item.source === 'custom' && onPublishToHub && (
            <button
              type="button"
              disabled={!hubEnrolled}
              title={hubEnrolled ? undefined : '未接入 momo-hub——去「设置 → 节点互联」接入后可发布'}
              className="text-xs px-2 py-0.5 rounded bg-surface-active text-accent-600 dark:text-accent-300 hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={(e) => { e.stopPropagation(); if (hubEnrolled) onPublishToHub(item); }}
            >
              发布到 hub
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
          {/* 删除：仅 installed 且 removable（custom 上传项）。常显图标钮——hover
              浮现方案实测会让「点编辑时删除恰好出现在指针处」造成误删，回退常显
              （danger 红色样式 + 二次确认弹窗防误触；卡片上收为图标钮省宽） */}
          {item.installed && item.removable && onDelete && (
            <button
              type="button"
              aria-label={`删除 ${item.name}`}
              className="inline-flex items-center justify-center w-[22px] h-[22px] rounded bg-status-error-tint text-status-error hover:opacity-80"
              onClick={(e) => { e.stopPropagation(); onDelete(item.id); }}
            >
              <Trash2 size={12} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        </span>
      </span>
    </div>
  );
}
