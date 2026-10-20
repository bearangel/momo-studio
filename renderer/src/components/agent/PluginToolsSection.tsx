// renderer/src/components/agent/PluginToolsSection.tsx
//
// 插件工具门控分组（功能全面性规则 2026-10-17 抽公共）：DefinitionEditor
// （定义级 deniedTools）与 MemberEditDialog（成员级 deltas）共用。
// 「denied 模式串」换算纯函数 computeDeniedTools 供定义级；成员级的
// add/remove 模型换算见 computePluginToolDeltas（capability-helpers）。
import type { PluginToolInfo } from '../../ipc/types';

/** 定义级换算（deniedTools 整体清单维护）：
 *  changed 形态两种——整组模式 `plugin:<id>/*` 或精确名 `plugin:<id>/<name>`。
 *  组模式存在时开单个工具 = 摘组模式 + 展开其余精确名（保持其余仍禁）。 */
export function computeDeniedTools(
  current: string[],
  pluginId: string,
  toolFullNames: string[],
  changed: string,
  on: boolean,
): string[] {
  const group = `plugin:${pluginId}/*`;
  if (!on) {
    if (changed === group) return [...new Set([...current, group])];
    const hadGroup = current.includes(group);
    const base = current.filter((p) => p !== group);
    const rest = hadGroup ? toolFullNames.filter((n) => n !== changed) : [];
    return [...new Set([...base, changed, ...rest])];
  }
  if (changed === group) {
    return current.filter((p) => p !== group && !p.startsWith(`plugin:${pluginId}/`));
  }
  // 组模式下开单个：摘组模式，其余仍禁的展开为精确名（语义连续不跳变）
  const hadGroup = current.includes(group);
  const base = current.filter((p) => p !== group && p !== changed);
  const rest = hadGroup ? toolFullNames.filter((n) => n !== changed) : [];
  return [...base, ...rest];
}

export interface PluginToolsSectionProps {
  tools: Array<{ pluginId: string; pluginName: string; fullName: string; description: string }>;
  deniedTools: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}

/** 插件工具分组：组头整插件开关 + 组内单工具开关，默认全开 */
export function PluginToolsSection({ tools, deniedTools, onChange, disabled }: PluginToolsSectionProps) {
  const byPlugin = new Map<string, typeof tools>();
  for (const t of tools) {
    const list = byPlugin.get(t.pluginId) ?? [];
    list.push(t);
    byPlugin.set(t.pluginId, list);
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs text-secondary">插件工具</div>
      {[...byPlugin.entries()].map(([pluginId, list]) => {
        const group = `plugin:${pluginId}/*`;
        const groupDenied = deniedTools.includes(group);
        const allDenied = list.every((t) => groupDenied || deniedTools.includes(t.fullName));
        const someDenied = groupDenied || list.some((t) => deniedTools.includes(t.fullName));
        return (
          <div key={pluginId} className="rounded-md border border-subtle bg-surface-2 px-2.5 py-2">
            <label className="flex items-center gap-2 text-xs text-primary">
              <input
                type="checkbox"
                aria-label={`禁用插件 ${list[0]!.pluginName} 全部工具`}
                checked={allDenied}
                disabled={disabled}
                onChange={(e) =>
                  onChange(computeDeniedTools(deniedTools, pluginId, list.map((t) => t.fullName), group, !e.target.checked))
                }
              />
              <span className="font-medium">{list[0]!.pluginName}</span>
              <span className="font-mono text-[10px] text-tertiary">{pluginId}</span>
              {someDenied && !allDenied && <span className="text-[10px] text-tertiary">部分禁用</span>}
            </label>
            <div className="mt-1 flex flex-col gap-0.5 pl-5">
              {list.map((t) => {
                const denied = groupDenied || deniedTools.includes(t.fullName);
                return (
                  <label key={t.fullName} className="flex items-center gap-2 text-xs text-secondary">
                    <input
                      type="checkbox"
                      aria-label={`禁用 ${t.fullName}`}
                      checked={denied}
                      disabled={disabled}
                      onChange={(e) =>
                        onChange(computeDeniedTools(deniedTools, pluginId, list.map((x) => x.fullName), t.fullName, !e.target.checked))
                      }
                    />
                    <span className="font-mono">{t.fullName}</span>
                    <span className="text-tertiary">{t.description}</span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export type { PluginToolInfo };
