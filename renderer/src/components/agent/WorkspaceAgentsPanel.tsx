// renderer/src/components/agent/WorkspaceAgentsPanel.tsx
// Tab 1：本工作空间的 agent assignment 列表
// 按 main→sub 树形分组 + standalone + orphan sub 警告
import { useEffect, useMemo, useState } from 'react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useImStore } from '../../stores/im.store';
import { ipc } from '../../ipc/client';
import { AddToWorkspaceDialog } from './AddToWorkspaceDialog';
import { AssignmentRoleEditor } from './AssignmentRoleEditor';
import { AssignmentApiKeyEditor } from './AssignmentApiKeyEditor';
import { AssignmentCapabilitiesDialog } from './AssignmentCapabilitiesDialog';
import { AgentOrchestrator } from './AgentOrchestrator';
import { Button } from '../ui/Button';
import { cn } from '../../lib/cn';
import type { AgentAssignment } from '../../ipc/types';

export function WorkspaceAgentsPanel() {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const setCoordinator = useWorkspaceStore((s) => s.setCoordinator);
  const { assignments, definitions, loadAssignments, stopAgent, startAgent } = useAgentStore();

  const [addOpen, setAddOpen] = useState(false);
  const [roleEditing, setRoleEditing] = useState<AgentAssignment | null>(null);
  const [keyEditing, setKeyEditing] = useState<AgentAssignment | null>(null);
  // v1.6 Task 12：当前正在调整能力（Layer 3 override）的 assignment；非 null 时渲染弹窗
  const [adjustingAssignment, setAdjustingAssignment] = useState<AgentAssignment | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'orchestrate'>('list');

  useEffect(() => {
    if (workspace) void loadAssignments(workspace.id);
  }, [workspace, loadAssignments]);

  const defMap = useMemo(() => new Map(definitions.map((d) => [d.id, d])), [definitions]);

  const mains = assignments.filter((a) => a.role === 'main');
  const standalones = assignments.filter((a) => a.role === 'standalone');
  const orphanSubs = assignments.filter((a) => a.role === 'sub' && !a.parentInstanceId);
  const subsOf = (mainInst: string) =>
    assignments.filter((a) => a.role === 'sub' && a.parentInstanceId === mainInst);

  const handleRemove = async (a: AgentAssignment): Promise<void> => {
    const defName = defMap.get(a.agentDefinitionId)?.name ?? '未知';
    if (a.role === 'main') {
      const subCount = subsOf(a.instanceId).length;
      const msg = subCount > 0
        ? `「${defName}」有 ${subCount} 个子 agent。移除主 agent 会同时移除全部子 agent。\n\n继续？`
        : `确定移除「${defName}」？`;
      if (!confirm(msg)) return;
    } else {
      if (!confirm(`确定移除「${defName}」？`)) return;
    }
    void stopAgent(a.instanceId);
    await ipc.agent.removeAssignment(a.instanceId);
    if (workspace) await loadAssignments(workspace.id);
    // v1.5.8：bot 被 owner kick 后成员列表需重新读取（成员面板不会自动跟随 sync 更新）
    const { activeRoomId, loadMembers } = useImStore.getState();
    if (activeRoomId) await loadMembers(activeRoomId);
  };

  const handleStart = (a: AgentAssignment): void => {
    if (!workspace?.teamSessionId) return;
    void startAgent(a, workspace.id, workspace.teamSessionId);
  };

  const handleStop = (a: AgentAssignment): void => {
    void stopAgent(a.instanceId);
  };

  if (viewMode === 'orchestrate') {
    return <AgentOrchestrator onBack={() => setViewMode('list')} />;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 flex items-center gap-2 border-b border-border-subtle shrink-0">
        <span className="text-lg font-semibold">🤖 本工作空间 · Agent</span>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" type="button" onClick={() => setViewMode('orchestrate')}>
            🌳 编排视图
          </Button>
          <Button type="button" onClick={() => setAddOpen(true)}>+ 添加 agent</Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-2">
        {standalones.length > 0 && (
          <Section title="独立 agent">
            {standalones.map((a) => (
              <AssignmentRow
                key={a.instanceId} a={a} defMap={defMap}
                workspace={workspace} setCoordinator={setCoordinator}
                onEditRole={setRoleEditing} onEditKey={setKeyEditing}
                onAdjustCapabilities={setAdjustingAssignment}
                onStart={handleStart} onStop={handleStop} onRemove={handleRemove}
              />
            ))}
          </Section>
        )}

        {mains.length > 0 && (
          <Section title="主 agent">
            {mains.map((main) => (
              <div key={main.instanceId} className="space-y-1">
                <AssignmentRow
                  a={main} defMap={defMap}
                  workspace={workspace} setCoordinator={setCoordinator}
                  onEditRole={setRoleEditing} onEditKey={setKeyEditing}
                  onAdjustCapabilities={setAdjustingAssignment}
                  onStart={handleStart} onStop={handleStop} onRemove={handleRemove}
                />
                {subsOf(main.instanceId).map((sub) => (
                  <div key={sub.instanceId} className="pl-6">
                    <AssignmentRow
                      a={sub} defMap={defMap}
                      onEditRole={setRoleEditing} onEditKey={setKeyEditing}
                      onAdjustCapabilities={setAdjustingAssignment}
                      onStart={handleStart} onStop={handleStop} onRemove={handleRemove}
                    />
                  </div>
                ))}
              </div>
            ))}
          </Section>
        )}

        {orphanSubs.length > 0 && (
          <Section title="⚠️ 孤儿子 agent（无父）" titleClass="text-amber-500">
            {orphanSubs.map((sub) => (
              <div key={sub.instanceId} className="border border-amber-500/30 rounded p-2 bg-amber-500/5">
                <AssignmentRow
                  a={sub} defMap={defMap}
                  onEditRole={setRoleEditing} onEditKey={setKeyEditing}
                  onAdjustCapabilities={setAdjustingAssignment}
                  onStart={handleStart} onStop={handleStop} onRemove={handleRemove}
                />
                <div className="text-xs text-amber-500 mt-1 pl-8">
                  建议为此 agent 选择父主 agent，或改为独立角色
                </div>
              </div>
            ))}
          </Section>
        )}

        {assignments.length === 0 && (
          <div className="text-center py-12 text-neutral-500">
            <div className="text-4xl mb-2">🤖</div>
            <p>本工作空间暂无 agent</p>
            <Button className="mt-3" onClick={() => setAddOpen(true)}>+ 添加 agent</Button>
          </div>
        )}
      </div>

      {addOpen && <AddToWorkspaceDialog onClose={() => setAddOpen(false)} />}
      {roleEditing && (
        <AssignmentRoleEditor assignment={roleEditing} onClose={() => setRoleEditing(null)} />
      )}
      {keyEditing && (
        <AssignmentApiKeyEditor assignment={keyEditing} onClose={() => setKeyEditing(null)} />
      )}
      {adjustingAssignment && (
        <AssignmentCapabilitiesDialog
          assignment={adjustingAssignment}
          def={definitions.find((d) => d.id === adjustingAssignment.agentDefinitionId)!}
          onClose={() => {
            setAdjustingAssignment(null);
            // setAssignmentDeltas 不像 updateAssignmentRole/Key 那样内部刷新列表，需显式刷新
            if (workspace) void loadAssignments(workspace.id);
          }}
        />
      )}
    </div>
  );
}

function Section({ title, titleClass, children }: {
  title: string;
  titleClass?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className={cn('text-xs text-neutral-500 px-2 py-1', titleClass)}>{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

interface RowProps {
  a: AgentAssignment;
  defMap: Map<string, { name: string; iconEmoji: string }>;
  workspace?: { id: string; teamSessionId: string; coordinatorInstanceId: string | null } | null;
  setCoordinator?: (wsId: string, instanceId: string) => Promise<void>;
  onStart?: (a: AgentAssignment) => void;
  onStop?: (a: AgentAssignment) => void;
  onEditRole: (a: AgentAssignment) => void;
  onEditKey: (a: AgentAssignment) => void;
  onAdjustCapabilities: (a: AgentAssignment) => void;
  onRemove: (a: AgentAssignment) => Promise<void>;
}

function AssignmentRow({
  a, defMap, workspace, setCoordinator,
  onStart, onStop,
  onEditRole, onEditKey, onAdjustCapabilities, onRemove,
}: RowProps) {
  const def = defMap.get(a.agentDefinitionId);
  const isCoord = workspace?.coordinatorInstanceId === a.instanceId;
  const isRunning = a.lastRunning;

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 hover:bg-bg-tertiary/50 rounded group">
      <span className="text-lg">{def?.iconEmoji ?? '🤖'}</span>
      <span className="flex-1 truncate text-sm">{def?.name ?? '未知'}</span>
      <span className="text-xs text-neutral-500">
        {a.role === 'main' ? '主' : a.role === 'sub' ? '子' : '独立'}
      </span>
      {isCoord && <span className="text-xs">⭐</span>}
      <span className={isRunning ? 'text-green-500 text-xs' : 'text-neutral-600 text-xs'}>
        {isRunning ? '▶ 运行中' : '⏸ 已停止'}
      </span>
      <div className="opacity-0 group-hover:opacity-100 flex gap-1 transition-opacity">
        {isRunning
          ? onStop && <button type="button" onClick={() => onStop(a)} className="text-xs text-neutral-400 hover:text-red-400">停止</button>
          : onStart && <button type="button" onClick={() => onStart(a)} className="text-xs text-neutral-400 hover:text-green-400">启动</button>
        }
        {setCoordinator && workspace && !isCoord && (
          <button
            type="button"
            onClick={() => void setCoordinator(workspace.id, a.instanceId)}
            className="text-xs text-neutral-400 hover:text-amber-400"
          >
            设为协调
          </button>
        )}
        <button type="button" onClick={() => onEditRole(a)} className="text-xs text-neutral-400 hover:text-neutral-200">
          编辑角色
        </button>
        <button type="button" onClick={() => onEditKey(a)} className="text-xs text-neutral-400 hover:text-neutral-200">
          更新密钥
        </button>
        <button type="button" onClick={() => onAdjustCapabilities(a)} className="text-xs text-neutral-400 hover:text-neutral-200">
          ⚙ 调整能力
        </button>
        <button type="button" onClick={() => void onRemove(a)} className="text-xs text-neutral-400 hover:text-red-400">
          移除
        </button>
      </div>
    </div>
  );
}
