// renderer/src/components/agent/AgentOrchestrator.tsx
//
// 编排视图（v1.3）：树形展示 workspace 内 agent 的主子关系（按 assignment.role/parentInstanceId）。
// 操作：将 standalone 改为 sub / 解除 sub 关系 / 将 standalone 改为 main。
import { useState } from 'react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { AgentAssignment } from '../../ipc/types';

interface Props {
  onBack: () => void;
}

export function AgentOrchestrator({ onBack }: Props) {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const { assignments, definitions, running, updateAssignmentRole } = useAgentStore();
  const [pickingParentFor, setPickingParentFor] = useState<string | null>(null);
  const [collapsedMains, setCollapsedMains] = useState<Set<string>>(new Set());

  const defMap = new Map(definitions.map((d) => [d.id, d]));

  // v1.3：按 assignment.role 分组
  const mainAssignments = assignments.filter((a) => a.role === 'main');
  const standaloneAssignments = assignments.filter((a) => a.role === 'standalone');

  const subsOf = (mainAssignment: AgentAssignment): AgentAssignment[] =>
    assignments.filter((a) => a.role === 'sub' && a.parentInstanceId === mainAssignment.instanceId);

  // 可改为此 main 的子的 standalone assignment（排除自身）
  const candidatesForSub = (mainInstanceId: string): AgentAssignment[] =>
    standaloneAssignments.filter((a) => a.instanceId !== mainInstanceId);

  const handleAddSub = async (mainInstanceId: string, subInstanceId: string): Promise<void> => {
    try {
      await updateAssignmentRole(subInstanceId, 'sub', mainInstanceId);
      if (workspace) alert('角色已更新，请重启相关实例以应用新配置。');
    } catch (err) {
      alert(`操作失败：${err instanceof Error ? err.message : String(err)}`);
    }
    setPickingParentFor(null);
  };

  const handleUnlink = async (subInstanceId: string): Promise<void> => {
    if (!confirm('确定解除该子 agent 的父子关系（改为独立）？')) return;
    try {
      await updateAssignmentRole(subInstanceId, 'standalone');
      alert('角色已更新，请重启相关实例以应用新配置。');
    } catch (err) {
      alert(`操作失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleSetAsMain = async (instanceId: string): Promise<void> => {
    try {
      await updateAssignmentRole(instanceId, 'main');
      alert('角色已更新，请重启相关实例以应用新配置。');
    } catch (err) {
      alert(`操作失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border-subtle flex items-center gap-2 shrink-0">
        <button type="button" onClick={onBack} className="text-sm text-neutral-400 hover:text-neutral-200">
          ← 返回列表
        </button>
        <span className="text-lg font-semibold ml-2">🌳 编排视图</span>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <ul className="flex flex-col gap-3">
          {mainAssignments.map((mainA) => {
            const mainDef = defMap.get(mainA.agentDefinitionId);
            if (!mainDef) return null;
            const subs = subsOf(mainA);
            const isPicking = pickingParentFor === mainA.instanceId;
            return (
              <li key={mainA.instanceId} className="flex flex-col gap-1">
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-tertiary border border-border-subtle">
                  <span className="text-xl">{mainDef.iconEmoji}</span>
                  <span className="text-sm text-neutral-100 flex-1">{mainDef.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">[main]</span>
                  <button
                    type="button"
                    onClick={() => {
                      const next = new Set(collapsedMains);
                      if (next.has(mainA.instanceId)) next.delete(mainA.instanceId);
                      else next.add(mainA.instanceId);
                      setCollapsedMains(next);
                    }}
                    className="text-xs text-neutral-400 hover:text-neutral-200"
                  >
                    {collapsedMains.has(mainA.instanceId) ? '▸' : '▾'}
                  </button>
                  <span className={'text-xs px-2 py-0.5 rounded-full ' +
                    (running[mainA.instanceId] ? 'bg-green-500/20 text-green-400' : 'bg-neutral-500/20 text-neutral-400')}>
                    {running[mainA.instanceId] ? '运行中' : '已停止'}
                  </span>
                </div>
                {!collapsedMains.has(mainA.instanceId) && (
                  <ul className="flex flex-col gap-1 ml-6">
                    {subs.map((subA) => {
                      const subDef = defMap.get(subA.agentDefinitionId);
                      if (!subDef) return null;
                      return (
                        <li key={subA.instanceId} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-bg-secondary border border-border-subtle">
                          <span className="text-base">{subDef.iconEmoji}</span>
                          <span className="text-sm text-neutral-200 flex-1">{subDef.name}</span>
                          <span className={'text-xs px-2 py-0.5 rounded-full ' +
                            (running[subA.instanceId] ? 'bg-green-500/20 text-green-400' : 'bg-neutral-500/20 text-neutral-400')}>
                            {running[subA.instanceId] ? '运行中' : '已停止'}
                          </span>
                          <button
                            type="button"
                            onClick={() => void handleUnlink(subA.instanceId)}
                            className="text-xs text-neutral-400 hover:text-red-400"
                          >
                            解除
                          </button>
                        </li>
                      );
                    })}
                    {isPicking ? (
                      <li className="px-3 py-1.5">
                        <select
                          value=""
                          onChange={(e) => {
                            if (e.target.value) void handleAddSub(mainA.instanceId, e.target.value);
                          }}
                          className="px-2 py-1 rounded-md bg-bg-tertiary border border-border-subtle text-neutral-100 text-sm w-full"
                        >
                          <option value="">选择 agent...</option>
                          {candidatesForSub(mainA.instanceId).map((a) => {
                            const d = defMap.get(a.agentDefinitionId);
                            return (
                              <option key={a.instanceId} value={a.instanceId}>
                                {d?.iconEmoji ?? '🤖'} {d?.name ?? '未知'}
                              </option>
                            );
                          })}
                        </select>
                      </li>
                    ) : (
                      <li>
                        <button
                          type="button"
                          onClick={() => setPickingParentFor(mainA.instanceId)}
                          className="text-xs text-accent-blue hover:underline px-3 py-1"
                          disabled={candidatesForSub(mainA.instanceId).length === 0}
                        >
                          + 添加子 agent
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}

          {standaloneAssignments.map((sa) => {
            const def = defMap.get(sa.agentDefinitionId);
            if (!def) return null;
            return (
              <li key={sa.instanceId} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-tertiary border border-border-subtle">
                <span className="text-xl">{def.iconEmoji}</span>
                <span className="text-sm text-neutral-100 flex-1">{def.name}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-500/20 text-neutral-400">[standalone]</span>
                <span className={'text-xs px-2 py-0.5 rounded-full ' +
                  (running[sa.instanceId] ? 'bg-green-500/20 text-green-400' : 'bg-neutral-500/20 text-neutral-400')}>
                  {running[sa.instanceId] ? '运行中' : '已停止'}
                </span>
                <button
                  type="button"
                  onClick={() => void handleSetAsMain(sa.instanceId)}
                  className="text-xs text-neutral-400 hover:text-blue-400"
                >
                  设为主 agent
                </button>
              </li>
            );
          })}

          {assignments.length === 0 && (
            <div className="text-center py-12 text-neutral-500">
              <p>本工作空间暂无 agent</p>
            </div>
          )}
        </ul>
      </div>
    </div>
  );
}
