// renderer/src/components/agent/ToolPickerPanel.tsx
//
// 工具选择共享面板（2026-11-04 P1 预览批准 .omo/previews/tool-picker.html）：
// 搜索框（中文名/英文名双通道）+ 分类折叠分组（默认全收起）+ 组级三态勾选
// + n/m 计数徽标；插件工具作为附加分组并入本面板——取代旧 tab 外挂
// PluginToolsSection（修「切到 MCP/Skill 标签插件工具仍显示」bug）。
// 消费方：CapabilityTabs 工具 tab（成员/定义编辑）、AgentCreateWizard 自定义档。
// 勾态语义不变：内置组 = value 绝对集合；插件组 = 受控 pluginChecked +
// onPluginToggle(changed, on)（changed 为精确名或 plugin:<id>/* 组模式串，
// denied/授权换算归调用方——DefinitionEditor 用 denied、MemberEditDialog 用授权）。
import { useMemo, useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useToolCatalog } from '../../lib/useToolCatalog';
import type { PluginToolInfo } from '../../ipc/types';

export interface ToolPickerPanelProps {
  /** 内置工具勾选集（绝对集合；plugin: 前缀 ref 归插件分组管理，不在此列） */
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** 快捷按钮（全选/清空/安全最小集）——只作用于内置工具，插件授权语义独立 */
  quickActions?: boolean;
  /** 插件工具候选池（工作空间装配面）；空/缺省不渲染插件分组 */
  pluginTools?: PluginToolInfo[];
  /** 插件工具勾选全名集（受控） */
  pluginChecked?: string[];
  /** 插件勾选变化：changed 为精确名或 plugin:<id>/* 组模式串 */
  onPluginToggle?: (changed: string, on: boolean) => void;
}

interface BuiltinGroup {
  kind: 'builtin';
  key: string;
  label: string;
  emoji: string;
  tools: string[];
}
interface PluginGroup {
  kind: 'plugin';
  key: string;
  label: string;
  pluginId: string;
  tools: PluginToolInfo[];
}
type Group = BuiltinGroup | PluginGroup;

/** 搜索命中（不区分大小写；空串全放行） */
function matchesQuery(query: string, fields: string[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((f) => f.toLowerCase().includes(needle));
}

/** 搜索命中片段高亮（首个命中位置拆三段；query 空/未命中原样返回） */
function Highlight({ text, query }: { text: string; query: string }): React.ReactElement {
  const needle = query.trim().toLowerCase();
  const idx = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span className="text-accent-600 dark:text-accent-300 font-medium">
        {text.slice(idx, idx + needle.length)}
      </span>
      {text.slice(idx + needle.length)}
    </>
  );
}

export function ToolPickerPanel({
  value,
  onChange,
  disabled = false,
  quickActions = false,
  pluginTools,
  pluginChecked,
  onPluginToggle,
}: ToolPickerPanelProps) {
  const { data: catalog, error: catalogError } = useToolCatalog();
  const [query, setQuery] = useState('');
  // 默认全收起（预览合同）；搜索时命中组强制展开（expanded 状态被忽略）
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const groups = useMemo<Group[]>(() => {
    const builtin: BuiltinGroup[] = (catalog?.categories ?? []).map((c) => ({
      kind: 'builtin' as const,
      key: c.label,
      label: c.label,
      emoji: c.emoji,
      tools: c.tools,
    }));
    const byPlugin = new Map<string, PluginToolInfo[]>();
    for (const t of pluginTools ?? []) {
      const list = byPlugin.get(t.pluginId) ?? [];
      list.push(t);
      byPlugin.set(t.pluginId, list);
    }
    const plugin: PluginGroup[] = [...byPlugin.entries()].map(([pid, list]) => ({
      kind: 'plugin' as const,
      key: `plugin:${pid}`,
      label: list[0]?.pluginName ?? pid,
      pluginId: pid,
      tools: list,
    }));
    return [...builtin, ...plugin];
  }, [catalog, pluginTools]);

  const searching = query.trim().length > 0;

  /** 组内可见条目：搜索时空组隐藏、组名命中全显、否则只显命中工具 */
  function visibleTools(group: Group): string[] | PluginToolInfo[] {
    if (group.kind === 'builtin') {
      if (!searching) return group.tools;
      if (matchesQuery(query, [group.label])) return group.tools;
      return group.tools.filter(
        (t) => matchesQuery(query, [catalog?.displayName(t) ?? t, t]),
      );
    }
    if (!searching) return group.tools;
    if (matchesQuery(query, [group.label, group.pluginId])) return group.tools;
    return group.tools.filter((t) =>
      matchesQuery(query, [t.toolName, t.fullName, t.description]),
    );
  }

  function toggleExpand(key: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** 折叠行键盘可达（Enter/Space 展开；checkbox 等内部控件聚焦时跳过） */
  function headKeyDown(e: KeyboardEvent<HTMLDivElement>, key: string): void {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpand(key);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {catalogError && (
        <div className="text-xs text-status-error">{`工具目录加载失败：${catalogError}`}</div>
      )}
      {!catalogError && !catalog && <div className="text-xs text-tertiary">工具目录加载中…</div>}

      {/* 搜索框（预览定值：h-30px / bg-surface-2 / 中英双通道占位文案） */}
      <div className="flex h-[30px] items-center gap-1.5 rounded-md border border-subtle bg-surface-2 px-2">
        <Search size={16} strokeWidth={1.75} className="shrink-0 text-tertiary" />
        <input
          type="search"
          aria-label="搜索工具"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索工具（中文名 / 英文名）…"
          className="w-full bg-transparent text-xs text-primary placeholder:text-tertiary focus:outline-none"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        {groups.map((group) => {
          const items = visibleTools(group);
          if (searching && items.length === 0) return null;
          const open = searching ? true : expanded.has(group.key);

          const checkedSet: Set<string> =
            group.kind === 'builtin'
              ? new Set(value)
              : new Set(pluginChecked ?? []);
          const groupKeys: string[] =
            group.kind === 'builtin' ? group.tools : group.tools.map((t) => t.fullName);
          const checkedCount = groupKeys.filter((k) => checkedSet.has(k)).length;
          const all = groupKeys.length > 0 && checkedCount === groupKeys.length;
          const some = checkedCount > 0 && !all;
          const groupAria =
            group.kind === 'plugin'
              ? `启用插件 ${group.label} 全部工具`
              : `启用 ${group.label} 全类工具`;

          return (
            <div key={group.key} className="rounded-md border border-subtle">
              <div
                role="button"
                tabIndex={0}
                aria-expanded={open}
                aria-label={`${group.label} 分组`}
                onClick={() => toggleExpand(group.key)}
                onKeyDown={(e) => headKeyDown(e, group.key)}
                className="flex min-h-[30px] cursor-default items-center gap-2 px-2 py-1 hover:bg-surface-1"
              >
                {open ? (
                  <ChevronDown size={16} strokeWidth={1.75} className="shrink-0 text-tertiary" />
                ) : (
                  <ChevronRight size={16} strokeWidth={1.75} className="shrink-0 text-tertiary" />
                )}
                <input
                  type="checkbox"
                  aria-label={groupAria}
                  checked={all}
                  ref={(el) => {
                    if (el) el.indeterminate = some;
                  }}
                  disabled={disabled}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    if (group.kind === 'builtin') {
                      onChange(
                        e.target.checked
                          ? [...new Set([...value, ...group.tools])]
                          : value.filter((t) => !group.tools.includes(t)),
                      );
                    } else {
                      onPluginToggle?.(`plugin:${group.pluginId}/*`, e.target.checked);
                    }
                  }}
                />
                <span className="text-[12.5px] font-medium text-primary">
                  {/* emoji 为 IPC 目录数据字段（豁免，非 UI 硬编码图标） */}
                  {group.kind === 'builtin' ? `${group.emoji} ${group.label}` : group.label}
                </span>
                {group.kind === 'plugin' && (
                  <span className="shrink-0 rounded border border-accent-300 px-1 text-[10px] text-accent-600 dark:text-accent-300">
                    插件 {group.pluginId}
                  </span>
                )}
                <span
                  className={cn(
                    'ml-auto shrink-0 rounded-full px-[7px] py-px text-[10.5px]',
                    some ? 'bg-surface-active text-accent-600 dark:text-accent-300' : 'bg-surface-2 text-tertiary',
                  )}
                >
                  {checkedCount}/{groupKeys.length}
                </span>
              </div>

              {open && (
                <div className="flex flex-col gap-[3px] border-t border-subtle px-2 pb-1.5 pl-6 pt-1">
                  {(items as Array<string | PluginToolInfo>).map((item) => {
                    if (typeof item === 'string') {
                      const tool = item;
                      const display = catalog?.displayName(tool) ?? tool;
                      return (
                        <label key={tool} className="flex items-center gap-1.5 text-xs text-secondary">
                          <input
                            type="checkbox"
                            aria-label={`${display}（${tool}）`}
                            checked={value.includes(tool)}
                            disabled={disabled}
                            onChange={(e) =>
                              onChange(
                                e.target.checked
                                  ? [...value, tool]
                                  : value.filter((t) => t !== tool),
                              )
                            }
                          />
                          <Highlight text={display} query={query} />
                          <span className="font-mono text-[11px] text-tertiary">
                            <Highlight text={tool} query={query} />
                          </span>
                        </label>
                      );
                    }
                    const t = item;
                    return (
                      <label key={t.fullName} className="flex items-center gap-1.5 text-xs text-secondary">
                        <input
                          type="checkbox"
                          aria-label={`启用 ${t.fullName}`}
                          checked={(pluginChecked ?? []).includes(t.fullName)}
                          disabled={disabled}
                          onChange={(e) => onPluginToggle?.(t.fullName, e.target.checked)}
                        />
                        <span className="font-mono">
                          <Highlight text={t.toolName} query={query} />
                        </span>
                        <span className="text-[11px] text-tertiary">{t.description}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {searching && groups.every((g) => visibleTools(g).length === 0) && (
          <div className="px-1 py-2 text-xs text-tertiary">无匹配工具</div>
        )}
      </div>

      {quickActions && (
        <div className="mt-1 flex gap-1">
          <button
            type="button"
            disabled={!catalog || disabled}
            className="rounded bg-surface-2 px-2 py-0.5 text-xs hover:bg-surface-3 disabled:opacity-50"
            onClick={() => onChange([...(catalog?.allTools ?? [])])}
          >
            全选
          </button>
          <button
            type="button"
            disabled={disabled}
            className="rounded bg-surface-2 px-2 py-0.5 text-xs hover:bg-surface-3 disabled:opacity-50"
            onClick={() => onChange([])}
          >
            清空
          </button>
          <button
            type="button"
            disabled={!catalog || disabled}
            className="rounded bg-surface-2 px-2 py-0.5 text-xs hover:bg-surface-3 disabled:opacity-50"
            onClick={() => onChange([...(catalog?.safeMinimum ?? [])])}
          >
            安全最小集
          </button>
        </div>
      )}
    </div>
  );
}
