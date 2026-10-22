// renderer/src/components/agent/AgentPickerCard.tsx
//
// 选择器统一卡片行（spec 2026-10-22 §6.2/§6.3，预览 B rev2 批准定值）：
// 三弹窗（CollabSessionDialog / DefaultAgentPickerDialog / AddAgentDialog）共用的
// agent 选择行。描述两行截断对齐 MembersPanel 已批卡片合同（line-clamp-2 +
// min-h 37px + 空「暂无说明」斜体占位 + 整卡 title 全文）。
//
// 能力摘要徽标：Wrench/Server/Sparkles 11px 图标 + 计数，计数 0 分类不渲染；
// 点击徽标行原地展开三区 chip（内置工具/MCP 服务器/技能，空区不渲染），工具区
// denied 命中项删除线灰显（deniedMatch 语义：精确名或 plugin:<id>/* 组模式），
// 徽标计数用 denied 剔除后的生效集。展开可受控（expanded/onToggleExpand——弹窗
// 手风琴单开依赖）；缺省卡内自治。
//
// hover 定值合同（对齐 MembersPanel）：surface-2 底 + border-strong 边。
// 交互槽位：onToggle=多选 checkbox / onSelect=单选整卡点选（accent 边框 +
// radiogroup 语义）/ leader+onSetLeader+showLeaderControl=主 agent Crown 徽标
// （12px accent 非交互）+ 已选卡底部 radio 行（13px radio + 12px「主 agent」标签，
// name 同组互斥）/ trailing=右侧元信息插槽（渲染于名称行行尾）。
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { Crown, Server, Sparkles, Wrench } from 'lucide-react';
import { Avatar } from '../ui/Avatar';
import { cn } from '../../lib/cn';
import { deniedMatch } from './PluginToolsSection';
import type { EffectiveCapabilities } from '../../ipc/types';

export interface AgentPickerCardProps {
  /** 行锚点 id：leader 徽标/radio 的 data-testid（leader-badge-<id> / leader-radio-<id>）与 checkbox 关联 */
  id?: string;
  name: string;
  iconEmoji?: string;
  description?: string;
  /** 生效能力（IPC 产物或 def 级降级）；undefined = 无徽标行（数据未就绪） */
  capabilities?: EffectiveCapabilities;
  /** 徽标 tooltip 语义：effective=生效能力（默认）；default=def 级默认能力（降级/def 行） */
  capabilityMode?: 'effective' | 'default';
  selected?: boolean;
  /** 多选模式：提供 → 渲染 checkbox（点击切换勾选，名称 label 关联） */
  onToggle?: () => void;
  /** 单选模式：提供 → 整卡可点选（无 checkbox；selected 以 accent 边框 + aria-checked 表达） */
  onSelect?: () => void;
  /** 主 agent 控制（预览 B rev2）：leader=true → 名称旁 Crown 12px 状态徽标（非交互） */
  leader?: boolean;
  /** 主 agent radio 行的 onChange（由 showLeaderControl 出现的行内触发） */
  onSetLeader?: () => void;
  /** radio 行出现条件（已选 >1）；行内 radio name 同组互斥 */
  showLeaderControl?: boolean;
  /** 展开受控（弹窗内手风琴单开）；缺省则卡内自治展开 */
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** 右侧元信息插槽（在线态 / source 徽标 / 加入按钮） */
  trailing?: ReactNode;
}

/** radio 组名固定 collab-leader（Task 11 锚点；当前唯一消费方 CollabSessionDialog） */
const LEADER_RADIO_GROUP = 'collab-leader';

export function AgentPickerCard(props: AgentPickerCardProps) {
  const [expandedSelf, setExpandedSelf] = useState(false);
  // 受控展开（弹窗手风琴单开）：expanded 显式传入时以 props 为准
  const expanded = props.expanded !== undefined ? props.expanded : expandedSelf;

  const desc = props.description?.trim();
  const denied = props.capabilities?.deniedTools ?? [];
  // 生效集：tools 剔除 denied 命中（徽标计数）；展开区用原始清单（命中项删除线呈现）
  const tools = (props.capabilities?.tools ?? []).filter((t) => !deniedMatch(t, denied));
  const rawTools = props.capabilities?.tools ?? [];
  const mcps = props.capabilities?.mcps ?? [];
  const skills = props.capabilities?.skills ?? [];

  const titlePrefix = props.capabilityMode === 'default' ? '默认能力：' : '';
  const badges = [
    { Icon: Wrench, n: tools.length, label: '内置工具' },
    { Icon: Server, n: mcps.length, label: 'MCP 服务器' },
    { Icon: Sparkles, n: skills.length, label: '技能' },
  ].filter((b) => b.n > 0);

  const checkboxId = props.id ? `agent-picker-${props.id}` : undefined;
  const handleCardKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      props.onSelect?.();
    }
  };

  return (
    <div
      role={props.onSelect ? 'radio' : undefined}
      aria-checked={props.onSelect ? (props.selected ?? false) : undefined}
      aria-label={props.onSelect ? props.name : undefined}
      tabIndex={props.onSelect ? 0 : undefined}
      onClick={props.onSelect ? () => props.onSelect?.() : undefined}
      onKeyDown={props.onSelect ? handleCardKeyDown : undefined}
      title={desc || undefined}
      className={cn(
        'rounded-lg border bg-surface-1 px-2.5 py-2 transition-colors',
        props.onSelect && 'cursor-pointer',
        props.onSelect && props.selected
          ? 'border-accent-500'
          : 'border-subtle hover:border-strong hover:bg-surface-2',
      )}
    >
      <div className="flex items-center gap-2">
        {props.onToggle && (
          <input
            type="checkbox"
            id={checkboxId}
            aria-label={props.name}
            checked={props.selected ?? false}
            onChange={props.onToggle}
            className="shrink-0"
          />
        )}
        <span className="shrink-0">
          {props.iconEmoji || <Avatar name={props.name} bot size="sm" />}
        </span>
        <label htmlFor={checkboxId} className="min-w-0 shrink truncate text-sm text-primary">
          {props.name}
        </label>
        {props.leader && (
          <span
            data-testid={`leader-badge-${props.id ?? props.name}`}
            title="主 agent：负责接待用户输入与任务分派"
            className="inline-flex shrink-0 text-accent-500"
          >
            <Crown size={12} strokeWidth={1.75} aria-hidden />
          </span>
        )}
        {props.trailing && (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">{props.trailing}</span>
        )}
      </div>

      <p className="mt-1.5 line-clamp-2 min-h-[37px] text-xs leading-[1.55] text-secondary">
        {desc ? desc : <span className="italic text-tertiary">暂无说明</span>}
      </p>

      {props.capabilities && badges.length > 0 && (
        <button
          type="button"
          aria-label={`${props.name}：能力清单`}
          aria-expanded={expanded}
          onClick={(e) => {
            // 单选整卡模式下阻止冒泡（点徽标行是展开，不是选卡）
            e.stopPropagation();
            if (props.onToggleExpand) props.onToggleExpand();
            else setExpandedSelf((v) => !v);
          }}
          className="mt-1 flex items-center gap-1.5"
        >
          {badges.map((b) => (
            <span
              key={b.label}
              title={`${titlePrefix}${b.label}`}
              className="inline-flex items-center gap-0.5 rounded bg-surface-3 px-1.5 py-px text-[11px] text-secondary"
            >
              <b.Icon size={11} strokeWidth={1.75} aria-hidden />
              {b.n}
            </span>
          ))}
        </button>
      )}

      {props.capabilities && expanded && (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {(
            [
              ['内置工具', rawTools],
              ['MCP 服务器', mcps],
              ['技能', skills],
            ] as const
          ).map(([label, list]) =>
            list.length === 0 ? null : (
              <div key={label} className="flex flex-wrap items-center gap-1">
                <span className="w-16 shrink-0 text-[11px] text-tertiary">{label}</span>
                {list.map((n) => (
                  <span
                    key={n}
                    className={cn(
                      'rounded bg-surface-2 px-1.5 py-px text-[11px] text-secondary',
                      label === '内置工具' && deniedMatch(n, denied) && 'line-through opacity-50',
                    )}
                  >
                    {n}
                  </span>
                ))}
              </div>
            ),
          )}
        </div>
      )}

      {props.showLeaderControl && props.onSetLeader && (
        <label className="mt-1 flex cursor-pointer items-center gap-1.5 text-xs text-secondary">
          <input
            type="radio"
            name={LEADER_RADIO_GROUP}
            data-testid={`leader-radio-${props.id ?? props.name}`}
            checked={props.leader ?? false}
            onChange={props.onSetLeader}
            className="h-[13px] w-[13px]"
          />
          主 agent
        </label>
      )}
    </div>
  );
}
