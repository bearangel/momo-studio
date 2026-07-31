// renderer/src/components/agent/AgentOrchestrator.tsx
//
// 编排视图：树形展示 workspace 内 agent 的主子关系。
// 操作：添加子 agent / 解除父子关系 / 设为主 agent。
import { useState } from 'react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { ipc } from '../../ipc/client';
import type { AgentDefinition, AgentAssignment } from '../../ipc/types';

export function AgentOrchestrator() {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const { assignments, definitions, running, loadAssignments } = useAgentStore();
  const [pickingParentFor, setPickingParentFor] = useState<string | null>(null);
  const [collapsedMains, setCollapsedMains] = useState<Set<string>>(new Set());

  const defMap = new Map(definitions.map((d) => [d.id, d]));

  // 分组：mains / standalone
  const mainAssignments = assignments.filter((a) => defMap.get(a.agentDefinitionId)?.type === 'main');
  const standaloneAssignments = assignments.filter((a) => {
    const def = defMap.get(a.agentDefinitionId);
    return def?.type !== 'main' && !def?.parentAgentId;
  });

  const subsOf = (mainAssignment: AgentAssignment): AgentAssignment[] => {
    const mainDef = defMap.get(mainAssignment.agentDefinitionId);
    if (!mainDef) return [];
    return assignments.filter((a) => {
      const def = defMap.get(a.agentDefinitionId);
      return def?.parentAgentId === mainDef.id;
    });
  };

  // 可添加为子的 agent（standalone 定义 + 未关联 sub 定义，排除自身）
  const candidatesForSub = (mainDefId: string): AgentDefinition[] =>
    definitions.filter((d) => {
      if (d.id === mainDefId) return false;
      if (d.type === 'main') return false;
      if (d.parentAgentId) return false;
      // 必须已安装到当前 workspace
      return assignments.some((a) => a.agentDefinitionId === d.id);
    });

  const handleAddSub = async (mainDefId: string, subDefId: string) => {
    try {
      const { stoppedInstanceIds } = await ipc.agent.updateDefinition({
        id: subDefId,
        type: 'sub',
        parentAgentId: mainDefId,
      });
      if (workspace) await loadAssignments(workspace.id);
      if (stoppedInstanceIds.length > 0) {
        alert(`${stoppedInstanceIds.length} 个实例已停止，请重启以应用新配置。`);
      }
    } catch (err) {
      alert(`操作失败：${err instanceof Error ? err.message : String(err)}`);
    }
    setPickingParentFor(null);
  };

  const handleUnlink = async (subDefId: string) => {
    if (!confirm('确定解除该子 agent 的父子关系？')) return;
    try {
      const { stoppedInstanceIds } = await ipc.agent.updateDefinition({
        id: subDefId,
        type: 'standalone',
        parentAgentId: undefined,
      });
      if (workspace) await loadAssignments(workspace.id);
      if (stoppedInstanceIds.length > 0) {
        alert(`${stoppedInstanceIds.length} 个实例已停止，请重启以应用新配置。`);
      }
    } catch (err) {
      alert(`操作失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleSetAsMain = async (defId: string) => {
    try {
      const { stoppedInstanceIds } = await ipc.agent.updateDefinition({ id: defId, type: 'main' });
      if (workspace) await loadAssignments(workspace.id);
      if (stoppedInstanceIds.length > 0) {
        alert(`${stoppedInstanceIds.length} 个实例已停止，请重启以应用新配置。`);
      }
    } catch (err) {
      alert(`操作失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="flex-1 overflow-auto p-3">
      <ul className="flex flex-col gap-3">
        {/* main 节点 */}
        {mainAssignments.map((mainA) => {
          const mainDef = defMap.get(mainA.agentDefinitionId);
          if (!mainDef) return null;
          const subs = subsOf(mainA);
          const isPicking = pickingParentFor === mainDef.id;
          return (
            <li key={mainA.instanceId} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-tertiary border border-border-subtle">
                <span className="text-xl">📋</span>
                <span className="text-sm text-neutral-100 flex-1">{mainDef.name}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">[main]</span>
                <button
                  type="button"
                  onClick={() => {
                    const next = new Set(collapsedMains);
                    if (next.has(mainDef.id)) next.delete(mainDef.id);
                    else next.add(mainDef.id);
                    setCollapsedMains(next);
                  }}
                  className="text-xs text-neutral-400 hover:text-neutral-200"
                >
                  {collapsedMains.has(mainDef.id) ? '▸' : '▾'}
                </button>
                <span className={'text-xs px-2 py-0.5 rounded-full ' +
                  (running[mainA.instanceId] ? 'bg-green-500/20 text-green-400' : 'bg-neutral-500/20 text-neutral-400')}>
                  {running[mainA.instanceId] ? '运行中' : '已停止'}
                </span>
              </div>
              {/* 子节点（折叠时隐藏） */}
              {!collapsedMains.has(mainDef.id) && (
              <ul className="flex flex-col gap-1 ml-6">
                {subs.map((subA) => {
                  const subDef = defMap.get(subA.agentDefinitionId);
                  if (!subDef) return null;
                  return (
                    <li key={subA.instanceId} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-bg-secondary border border-border-subtle">
                      <span className="text-base">🔗</span>
                      <span className="text-sm text-neutral-200 flex-1">{subDef.name}</span>
                      <span className={'text-xs px-2 py-0.5 rounded-full ' +
                        (running[subA.instanceId] ? 'bg-green-500/20 text-green-400' : 'bg-neutral-500/20 text-neutral-400')}>
                        {running[subA.instanceId] ? '运行中' : '已停止'}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleUnlink(subDef.id)}
                        className="text-xs text-neutral-400 hover:text-red-400"
                      >
                        解除
                      </button>
                    </li>
                  );
                })}
                {/* 添加子 agent 按钮 / 选择器 */}
                {isPicking ? (
                  <li className="px-3 py-1.5">
                    <select
                      value=""
                      onChange={(e) => {
                        if (e.target.value) void handleAddSub(mainDef.id, e.target.value);
                      }}
                      className="px-2 py-1 rounded-md bg-bg-tertiary border border-border-subtle text-neutral-100 text-sm w-full"
                    >
                      <option value="">选择 agent...</option>
                      {candidatesForSub(mainDef.id).map((d) => (
                        <option key={d.id} value={d.id}>{d.iconEmoji} {d.name}</option>
                      ))}
                    </select>
                  </li>
                ) : (
                  <li>
                    <button
                      type="button"
                      onClick={() => setPickingParentFor(mainDef.id)}
                      className="text-xs text-accent-blue hover:underline px-3 py-1"
                      disabled={candidatesForSub(mainDef.id).length === 0}
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

        {/* 孤立 sub：parentAgentId 非空但 parent 未安装到 workspace */}
        {(() => {
          const orphanSubs = assignments.filter((a) => {
            const def = defMap.get(a.agentDefinitionId);
            if (!def?.parentAgentId) return false;
            // parent 未在此 workspace 内安装
            const parentInstalled = assignments.some(
              (pa) => defMap.get(pa.agentDefinitionId)?.id === def.parentAgentId,
            );
            return !parentInstalled;
          });
          if (orphanSubs.length === 0) return null;
          return (
            <>
              <div className="text-xs text-neutral-500 px-3 pt-2">未分组子 agent</div>
              {orphanSubs.map((sa) => {
                const def = defMap.get(sa.agentDefinitionId);
                if (!def) return null;
                return (
                  <li key={sa.instanceId} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-tertiary border border-border-subtle">
                    <span className="text-xl">🔗</span>
                    <span className="text-sm text-neutral-100 flex-1">{def.name}</span>
                    <span className="text-[10px] text-neutral-500">父 agent 未安装</span>
                    <button
                      type="button"
                      onClick={() => void handleUnlink(def.id)}
                      className="text-xs text-neutral-400 hover:text-red-400"
                    >
                      解除
                    </button>
                  </li>
                );
              })}
            </>
          );
        })()}

        {/* standalone 节点 */}
        {standaloneAssignments.map((sa) => {
          const def = defMap.get(sa.agentDefinitionId);
          if (!def) return null;
          return (
            <li key={sa.instanceId} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-tertiary border border-border-subtle">
              <span className="text-xl">🤖</span>
              <span className="text-sm text-neutral-100 flex-1">{def.name}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-500/20 text-neutral-400">[standalone]</span>
              <span className={'text-xs px-2 py-0.5 rounded-full ' +
                (running[sa.instanceId] ? 'bg-green-500/20 text-green-400' : 'bg-neutral-500/20 text-neutral-400')}>
                {running[sa.instanceId] ? '运行中' : '已停止'}
              </span>
              <button
                type="button"
                onClick={() => void handleSetAsMain(def.id)}
                className="text-xs text-neutral-400 hover:text-blue-400"
              >
                设为主 agent
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
