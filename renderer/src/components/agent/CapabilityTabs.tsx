// renderer/src/components/agent/CapabilityTabs.tsx
//
// 能力配置共享组件：三个 Tab（工具 / MCP / Skill）+ 类别分组 checkbox。
// 三种模式：
//   - mode='edit'：value 是绝对勾选集合（DefinitionEditor 自定义 agent 编辑用）。
//                  底部显示 [全选] [清空] [安全最小集] 三个快捷按钮。
//   - mode='override'：value 是最终值。调用方（Layer 3 弹窗 AssignmentCapabilitiesDialog）
//                      在保存时对照 defaultValue 计算 added/removed delta。
//                      本组件只管最终值，不计算 delta，仅在 UI 上提示默认集合。
//   - mode='readonly'：checkbox disabled（builtin agent configure 模式用）。
//
// 设计依据：docs/plans/2026-08-11-v1.6-capability-config.md「CapabilityTabs」块。
// 被 DefinitionEditor（edit / readonly 模式）和 AssignmentCapabilitiesDialog（override 模式）复用。
import { useEffect, useState } from 'react';
import { ipc } from '../../ipc/client';
import { cn } from '../../lib/cn';
import {
  ALL_BUILTIN_TOOLS,
  SAFE_MINIMUM_TOOLS,
  TOOL_CATEGORIES,
} from '../../lib/tool-catalog';
// Capabilities 类型自 v1.6 Task 11 起抽到 capability-helpers 共享 lib；本地 import 供组件
// 自身 props 使用，同时 re-export 保持现有 `import { type Capabilities } from './CapabilityTabs'` 不破。
import { type Capabilities } from '../../lib/capability-helpers';
export type { Capabilities };
import type { ResourceItem } from '../../ipc/types';

type Tab = 'tools' | 'mcp' | 'skill';

export interface CapabilityTabsProps {
  mode: 'edit' | 'override' | 'readonly';
  /**
   * def + workspace 默认集合（override 模式下用于 UI 提示用户默认是什么；
   * delta 计算由调用方在保存时做，本组件不计算）。
   * edit / readonly 模式可省略。
   */
  defaultValue?: Capabilities;
  /** 当前选中集合（edit / override / readonly 三模式均为绝对最终值） */
  value: Capabilities;
  /** 勾选变化回调，返回新的完整能力集合 */
  onChange: (next: Capabilities) => void;
}

const TAB_LABELS: Record<Tab, string> = {
  tools: '工具',
  mcp: 'MCP',
  skill: 'Skill',
};

export function CapabilityTabs({ mode, defaultValue, value, onChange }: CapabilityTabsProps) {
  const [tab, setTab] = useState<Tab>('tools');
  // v1.7：mcps / skills 拉取自统一 ipc.resource.list；filter installed 只展示已安装项。
  const [mcps, setMcps] = useState<ResourceItem[]>([]);
  const [skills, setSkills] = useState<ResourceItem[]>([]);

  // 拉取动态列表：已注册 MCP + 已安装 Skill（仅展示用，不影响 value）
  useEffect(() => {
    void ipc.resource
      .list({ type: 'mcp' })
      .then((items) => setMcps(items.filter((i) => i.installed)));
    void ipc.resource
      .list({ type: 'skill' })
      .then((items) => setSkills(items.filter((i) => i.installed)));
  }, []);

  const readonly = mode === 'readonly';

  /** 切换某一项（tools / mcps / skills）的勾选状态 */
  function toggleItem(bucket: 'tools' | 'mcps' | 'skills', item: string, checked: boolean): void {
    if (readonly) return;
    const current = value[bucket];
    const next = checked
      ? [...current, item]
      : current.filter((x) => x !== item);
    onChange({ ...value, [bucket]: next });
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Tab 头 */}
      <div className="flex gap-1 border-b border-border-subtle">
        {(['tools', 'mcp', 'skill'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={cn(
              'text-xs px-2.5 py-1 -mb-px border-b-2 transition-colors',
              tab === t
                ? 'border-accent-blue text-accent-blue'
                : 'border-transparent text-neutral-400 hover:text-neutral-200',
            )}
            onClick={() => setTab(t)}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {/* 工具 Tab */}
      {tab === 'tools' && (
        <div className="flex flex-col gap-2">
          {TOOL_CATEGORIES.map((cat) => (
            <div key={cat.label}>
              <div className="text-xs text-neutral-500 mb-1">
                {cat.emoji} {cat.label}
              </div>
              <div className="flex flex-wrap gap-2">
                {cat.tools.map((tool) => {
                  const checked = value.tools.includes(tool);
                  return (
                    <label
                      key={tool}
                      className="flex items-center gap-1 text-xs text-neutral-300"
                    >
                      <input
                        type="checkbox"
                        aria-label={tool}
                        checked={checked}
                        disabled={readonly}
                        onChange={(e) => toggleItem('tools', tool, e.target.checked)}
                      />
                      {tool}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}

          {/* edit 模式：三个快捷按钮 */}
          {mode === 'edit' && (
            <div className="flex gap-1 mt-1">
              <button
                type="button"
                className="text-xs px-2 py-0.5 rounded bg-bg-tertiary hover:bg-border-subtle"
                onClick={() => onChange({ ...value, tools: [...ALL_BUILTIN_TOOLS] })}
              >
                全选
              </button>
              <button
                type="button"
                className="text-xs px-2 py-0.5 rounded bg-bg-tertiary hover:bg-border-subtle"
                onClick={() => onChange({ ...value, tools: [] })}
              >
                清空
              </button>
              <button
                type="button"
                className="text-xs px-2 py-0.5 rounded bg-bg-tertiary hover:bg-border-subtle"
                onClick={() => onChange({ ...value, tools: [...SAFE_MINIMUM_TOOLS] })}
              >
                安全最小集
              </button>
            </div>
          )}

          {/* override 模式：提示默认值（delta 由调用方在保存时计算） */}
          {mode === 'override' && defaultValue && (
            <div className="text-xs text-neutral-500 mt-1">
              默认（def + workspace）：{defaultValue.tools.join(', ') || '无'}
              <br />
              勾选 = 保留/添加；取消 = 移除
            </div>
          )}
        </div>
      )}

      {/* MCP Tab */}
      {tab === 'mcp' && (
        <div className="flex flex-col gap-1">
          {mcps.length === 0 ? (
            <div className="text-xs text-neutral-500">
              尚未注册任何 MCP（去 Marketplace → + 添加 MCP）
            </div>
          ) : (
            mcps.map((m) => {
              const checked = value.mcps.includes(m.slug);
              return (
                <label
                  key={m.slug}
                  className="flex items-center gap-1 text-xs text-neutral-300"
                >
                  <input
                    type="checkbox"
                    aria-label={m.slug}
                    checked={checked}
                    disabled={readonly}
                    onChange={(e) => toggleItem('mcps', m.slug, e.target.checked)}
                  />
                  {m.name}
                  <span className="text-neutral-500">[{m.source}]</span>
                </label>
              );
            })
          )}
        </div>
      )}

      {/* Skill Tab */}
      {tab === 'skill' && (
        <div className="flex flex-col gap-1">
          {skills.length === 0 ? (
            <div className="text-xs text-neutral-500">尚未安装任何 Skill</div>
          ) : (
            skills.map((s) => {
              const checked = value.skills.includes(s.slug);
              return (
                <label
                  key={s.slug}
                  className="flex items-center gap-1 text-xs text-neutral-300"
                >
                  <input
                    type="checkbox"
                    aria-label={s.slug}
                    checked={checked}
                    disabled={readonly}
                    onChange={(e) => toggleItem('skills', s.slug, e.target.checked)}
                  />
                  {s.name} ({s.slug})
                  <span className="text-neutral-500">[{s.source}]</span>
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
