// renderer/src/components/agent/CapabilityConfig.tsx
//
// 三层能力展示 + workspace 级（Layer 2）增删。
//   Layer 1：agent 定义的默认能力（只读 chip，灰色）
//   Layer 2：workspace 级共享能力（可删除 chip + 添加输入框，蓝色）
//   Layer 3：per-assignment 能力 delta——由 AssignmentCapabilitiesDialog 承担
//           （本组件通过 onAdjustAssignment callback 跳转，不在此内联编辑）
//
// Layer 2 增删走 capability.store → allocation:* IPC。无选中 agent 时仅显示 Layer 2。
//
// v1.6 Task 16：顶部新增两个增强按钮入口（均通过可选 callback 注入，未提供则不渲染，
// 保证向后兼容现有调用站点）：
//   - onEditDefinition：仅 custom agent（source !== 'builtin'）显示，跳到 DefinitionEditor edit 模式
//   - onAdjustAssignment：builtin/custom 均可，需 activeAssignment 存在，跳到 AssignmentCapabilitiesDialog
import { useEffect, useState, type FormEvent } from 'react';
import { useCapabilityStore } from '../../stores/capability.store';
import { Button } from '../ui/Button';
import type { AgentAssignment, AgentDefinition, CapabilityType } from '../../ipc/types';

interface Props {
  workspaceId: string;
  agentDef?: AgentDefinition;
  /** 当前 assignment（提供且 onAdjustAssignment 也提供时显示「调整本实例能力」按钮） */
  activeAssignment?: AgentAssignment;
  /** custom agent 时显示「编辑 def 默认能力」按钮，点击跳到 DefinitionEditor edit 模式 */
  onEditDefinition?: (defId: string) => void;
  /** 点击「调整本实例能力」打开 AssignmentCapabilitiesDialog（Layer 3 override） */
  onAdjustAssignment?: (assignment: AgentAssignment) => void;
}

type Group = { type: CapabilityType; label: string; layer1: string[]; layer2: string[] };

export function CapabilityConfig({
  workspaceId,
  agentDef,
  activeAssignment,
  onEditDefinition,
  onAdjustAssignment,
}: Props) {
  const { allocation, load, add, remove } = useCapabilityStore();

  useEffect(() => {
    void load(workspaceId);
  }, [workspaceId, load]);

  // 「编辑 def 默认能力」：仅 custom agent（builtin 默认能力不可改）+ callback 提供
  const showEditDefButton = !!onEditDefinition && !!agentDef && agentDef.source !== 'builtin';
  // 「调整本实例能力」：builtin/custom 均可，需 activeAssignment + callback 同时提供
  const showAdjustAssignmentButton = !!onAdjustAssignment && !!activeAssignment;

  const groups: Group[] = [
    {
      type: 'tool',
      label: '工具',
      layer1: agentDef?.defaultTools.map((t) => t.ref) ?? [],
      layer2: allocation?.tools ?? [],
    },
    {
      type: 'mcp',
      label: 'MCP',
      layer1: agentDef?.defaultMcps?.map((m) => m.ref) ?? [],
      layer2: allocation?.mcps ?? [],
    },
    {
      type: 'skill',
      label: '技能',
      layer1: agentDef?.defaultSkills?.map((s) => s.ref) ?? [],
      layer2: allocation?.skills ?? [],
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-200">能力配置</h3>
          <span className="text-xs text-neutral-500">工作空间共享能力对所有 agent 生效</span>
      </div>

      {(showEditDefButton || showAdjustAssignmentButton) && (
        <div className="flex flex-wrap gap-2">
          {showEditDefButton && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onEditDefinition!(agentDef!.id)}
            >
              编辑 def 默认能力
            </Button>
          )}
          {showAdjustAssignmentButton && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onAdjustAssignment!(activeAssignment!)}
            >
              调整本实例能力
            </Button>
          )}
        </div>
      )}

      {groups.map((g) => (
        <CapabilityGroup
          key={g.type}
          group={g}
          workspaceId={workspaceId}
          onAdd={add}
          onRemove={remove}
        />
      ))}

      <div className="text-xs text-neutral-600">
        Layer 1（灰）= agent 定义默认；Layer 2（蓝）= workspace 共享，可增删
      </div>
    </div>
  );
}

interface GroupProps {
  group: Group;
  workspaceId: string;
  onAdd: (workspaceId: string, type: CapabilityType, ref: string) => Promise<void>;
  onRemove: (workspaceId: string, type: CapabilityType, ref: string) => Promise<void>;
}

function CapabilityGroup({ group, workspaceId, onAdd, onRemove }: GroupProps) {
  const [input, setInput] = useState('');
  const { type, label, layer1, layer2 } = group;

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    const ref = input.trim();
    if (!ref) return;
    await onAdd(workspaceId, type, ref);
    setInput('');
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs text-neutral-400">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {layer1.map((ref) => (
          <span
            key={`l1-${ref}`}
            className="text-xs px-2 py-0.5 rounded bg-neutral-700/40 text-neutral-400 border border-neutral-700"
          >
            {ref}
          </span>
        ))}
        {layer2.map((ref) => (
          <button
            key={`l2-${ref}`}
            type="button"
            onClick={() => void onRemove(workspaceId, type, ref)}
            className="text-xs px-2 py-0.5 rounded bg-accent-blue/20 text-accent-blue border border-accent-blue/40 hover:bg-accent-blue/30"
          >
            {ref} ✕
          </button>
        ))}
        {layer1.length === 0 && layer2.length === 0 && (
          <span className="text-xs text-neutral-600">（无）</span>
        )}
      </div>
      <form onSubmit={handleAdd} className="flex gap-1.5">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`添加 workspace 级 ${label}，如 ${type === 'mcp' ? 'filesystem' : type === 'skill' ? 'code-review' : 'shell'}`}
          className="flex-1 px-2 py-1 text-xs rounded bg-bg-tertiary border border-border-subtle text-neutral-100 focus:border-accent-blue focus:outline-none"
        />
        <Button size="sm" variant="ghost" type="submit" disabled={!input.trim()}>
          添加
        </Button>
      </form>
    </div>
  );
}
