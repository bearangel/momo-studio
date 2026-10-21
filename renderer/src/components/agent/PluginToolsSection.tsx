// renderer/src/components/agent/PluginToolsSection.tsx
//
// 插件工具分组（受控组件，spec 2026-10-21 §9③）：checkedFullNames + onToggle——
// 勾态完全由调用方给定（Member=授权集公式 / Definition=全量−denied），
// changed 可为精确名或 `plugin:<id>/*` 组模式串，换算归调用方。
// 定义级 deniedTools 维护的组展开算法（computeDeniedTools）仍从本文件导出。
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

/** denied 模式串命中（精确名或组前缀）——DefinitionEditor 由 deniedTools 换算 checked 用 */
export function deniedMatch(fullName: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (p === fullName) return true;
    if (p.endsWith('/*') && fullName.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}

export interface PluginToolsSectionProps {
  tools: PluginToolInfo[];
  /** 当前生效（勾选）的工具全名集——受控 */
  checkedFullNames: string[];
  /** 勾选变化：changed 为精确名或 `plugin:<id>/*` 组模式串 */
  onToggle: (changed: string, next: boolean) => void;
  disabled: boolean;
}

export function PluginToolsSection({ tools, checkedFullNames, onToggle, disabled }: PluginToolsSectionProps) {
  const byPlugin = new Map<string, PluginToolInfo[]>();
  for (const t of tools) {
    const list = byPlugin.get(t.pluginId) ?? [];
    list.push(t);
    byPlugin.set(t.pluginId, list);
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs text-secondary">插件工具</div>
      {[...byPlugin.entries()].map(([pluginId, list]) => {
        const fullNames = list.map((t) => t.fullName);
        const checkedCount = fullNames.filter((n) => checkedFullNames.includes(n)).length;
        const all = checkedCount === fullNames.length;
        const some = checkedCount > 0 && !all;
        return (
          <div key={pluginId} className="rounded-md border border-subtle bg-surface-2 px-2.5 py-2">
            <label className="flex items-center gap-2 text-xs text-primary">
              <input
                type="checkbox"
                aria-label={`启用插件 ${list[0]!.pluginName} 全部工具`}
                checked={all}
                ref={(el) => { if (el) el.indeterminate = some; }}
                disabled={disabled}
                onChange={(e) => onToggle(`plugin:${pluginId}/*`, e.target.checked)}
              />
              <span className="font-medium">{list[0]!.pluginName}</span>
              <span className="font-mono text-[10px] text-tertiary">{pluginId}</span>
              {some && <span className="text-[10px] text-tertiary">部分启用</span>}
              {!some && !all && <span className="text-[10px] text-tertiary">全不启用</span>}
            </label>
            <div className="mt-1 flex flex-col gap-0.5 pl-5">
              {list.map((t) => (
                <label key={t.fullName} className="flex items-center gap-2 text-xs text-secondary">
                  <input
                    type="checkbox"
                    aria-label={`启用 ${t.fullName}`}
                    checked={checkedFullNames.includes(t.fullName)}
                    disabled={disabled}
                    onChange={(e) => onToggle(t.fullName, e.target.checked)}
                  />
                  <span className="font-mono">{t.fullName}</span>
                  <span className="text-tertiary">{t.description}</span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export type { PluginToolInfo };
