// renderer/src/components/agent/WorkspaceAgentsPanel.tsx
// Tab 1：本工作空间的 agent 成员列表（v25：去编排——role 分组/编排视图/角色编辑
// 随 role 概念退役移除；正式双 Tab UI（成员/团队）由 Task 13 落地）
import { useEffect, useMemo, useState } from 'react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useSessionStore } from '../../stores/session.store';
import { ipc } from '../../ipc/client';
import { AddToWorkspaceDialog } from './AddToWorkspaceDialog';
import { AssignmentApiKeyEditor } from './AssignmentApiKeyEditor';
import { AssignmentCapabilitiesDialog } from './AssignmentCapabilitiesDialog';
import { Button } from '../ui/Button';
import type { AgentAssignment } from '../../ipc/types';

export function WorkspaceAgentsPanel() {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const setDefaultAgent = useWorkspaceStore((s) => s.setDefaultAgent);
  const { assignments, definitions, loadAssignments, stopAgent, startAgent } = useAgentStore();

  const [addOpen, setAddOpen] = useState(false);
  const [keyEditing, setKeyEditing] = useState<AgentAssignment | null>(null);
  // v1.6 Task 12：当前正在调整能力（Layer 3 override）的成员；非 null 时渲染弹窗
  const [adjustingAssignment, setAdjustingAssignment] = useState<AgentAssignment | null>(null);

  useEffect(() => {
    if (workspace) void loadAssignments(workspace.id);
  }, [workspace, loadAssignments]);

  const defMap = useMemo(() => new Map(definitions.map((d) => [d.id, d])), [definitions]);

  const handleRemove = async (a: AgentAssignment): Promise<void> => {
    const defName = defMap.get(a.agentDefinitionId)?.name ?? '未知';
    if (!confirm(`确定移除「${defName}」？`)) return;
    void stopAgent(a.instanceId);
    const result = await ipc.agent.removeMember(a.instanceId);
    if (!result.ok) {
      alert(`「${defName}」是以下团队的 leader，请先转移 leader 或解散团队：\n${result.blockedTeams.join('、')}`);
      return;
    }
    if (workspace) await loadAssignments(workspace.id);
    // v1.5.8：成员被移出后成员列表需重新读取（成员面板不会自动跟随更新）
    const { activeSessionId, loadMembers } = useSessionStore.getState();
    if (activeSessionId) await loadMembers(activeSessionId);
  };

  const handleStart = (a: AgentAssignment): void => {
    if (!workspace) return;
    void startAgent(a, workspace.id);
  };

  const handleStop = (a: AgentAssignment): void => {
    void stopAgent(a.instanceId);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 flex items-center gap-2 border-b border-border-subtle shrink-0">
        <span className="text-lg font-semibold">🤖 本工作空间 · Agent</span>
        <div className="ml-auto flex gap-2">
          <Button type="button" onClick={() => setAddOpen(true)}>+ 添加 agent</Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-2">
        {assignments.map((a) => (
          <AssignmentRow
            key={a.instanceId} a={a} defMap={defMap}
            workspace={workspace} setDefaultAgent={setDefaultAgent}
            onEditKey={setKeyEditing}
            onAdjustCapabilities={setAdjustingAssignment}
            onStart={handleStart} onStop={handleStop} onRemove={handleRemove}
          />
        ))}

        {assignments.length === 0 && (
          <div className="text-center py-12 text-neutral-500">
            <div className="text-4xl mb-2">🤖</div>
            <p>本工作空间暂无 agent</p>
            <Button className="mt-3" onClick={() => setAddOpen(true)}>+ 添加 agent</Button>
          </div>
        )}
      </div>

      {addOpen && <AddToWorkspaceDialog onClose={() => setAddOpen(false)} />}
      {keyEditing && (
        <AssignmentApiKeyEditor assignment={keyEditing} onClose={() => setKeyEditing(null)} />
      )}
      {adjustingAssignment && (
        <AssignmentCapabilitiesDialog
          assignment={adjustingAssignment}
          def={definitions.find((d) => d.id === adjustingAssignment.agentDefinitionId)!}
          onClose={() => {
            setAdjustingAssignment(null);
            // setMemberDeltas 不像 setMemberApiKeyOverride 那样内部刷新列表，需显式刷新
            if (workspace) void loadAssignments(workspace.id);
          }}
        />
      )}
    </div>
  );
}

interface RowProps {
  a: AgentAssignment;
  defMap: Map<string, { name: string; iconEmoji: string }>;
  workspace?: { id: string; defaultAgentInstanceId: string | null } | null;
  setDefaultAgent?: (wsId: string, instanceId: string) => Promise<void>;
  onStart?: (a: AgentAssignment) => void;
  onStop?: (a: AgentAssignment) => void;
  onEditKey: (a: AgentAssignment) => void;
  onAdjustCapabilities: (a: AgentAssignment) => void;
  onRemove: (a: AgentAssignment) => Promise<void>;
}

function AssignmentRow({
  a, defMap, workspace, setDefaultAgent,
  onStart, onStop,
  onEditKey, onAdjustCapabilities, onRemove,
}: RowProps) {
  const def = defMap.get(a.agentDefinitionId);
  const isDefault = workspace?.defaultAgentInstanceId === a.instanceId;
  const isRunning = a.lastRunning;

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 hover:bg-bg-tertiary/50 rounded group">
      <span className="text-lg">{def?.iconEmoji ?? '🤖'}</span>
      <span className="flex-1 truncate text-sm">{def?.name ?? '未知'}</span>
      {isDefault && <span className="text-xs" title="默认会话 agent">⭐</span>}
      <span className={isRunning ? 'text-green-500 text-xs' : 'text-neutral-600 text-xs'}>
        {isRunning ? '▶ 运行中' : '⏸ 已停止'}
      </span>
      <div className="opacity-0 group-hover:opacity-100 flex gap-1 transition-opacity">
        {isRunning
          ? onStop && <button type="button" onClick={() => onStop(a)} className="text-xs text-neutral-400 hover:text-red-400">停止</button>
          : onStart && <button type="button" onClick={() => onStart(a)} className="text-xs text-neutral-400 hover:text-green-400">启动</button>
        }
        {setDefaultAgent && workspace && !isDefault && (
          <button
            type="button"
            onClick={() => void setDefaultAgent(workspace.id, a.instanceId)}
            className="text-xs text-neutral-400 hover:text-amber-400"
          >
            设为默认
          </button>
        )}
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
