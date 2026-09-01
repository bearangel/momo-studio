// renderer/src/components/agent/MembersPanel.tsx
// AgentsView Tab 1「Agent 成员」（spec §6.1）：当前 workspace 的 agent 成员列表，
// 拆自 WorkspaceAgentsPanel（v25 去编排退役）。成员行 = icon emoji + 名称 + 模型 +
// ⭐默认会话标记 + 在线状态 + 行内操作（启动/停止、设为默认会话、更新密钥、
// 调整能力、移出工作空间）。移出被 leader 守卫拦截时 alert blockedTeams 团队名。
// 「+ 创建 Agent」弹窗归 Task 13（CreateAgentDialog），此处先留占位入口。
import { useEffect, useMemo, useState } from 'react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useSessionStore } from '../../stores/session.store';
import { AssignmentApiKeyEditor } from './AssignmentApiKeyEditor';
import { AssignmentCapabilitiesDialog } from './AssignmentCapabilitiesDialog';
import { Button } from '../ui/Button';
import type { AgentDefinition, WorkspaceAgentMember } from '../../ipc/types';

export function MembersPanel() {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const setDefaultAgent = useWorkspaceStore((s) => s.setDefaultAgent);
  const { members, definitions, loadMembers, startMember, stopMember, removeMember } =
    useAgentStore();

  const [keyEditing, setKeyEditing] = useState<WorkspaceAgentMember | null>(null);
  // 当前正在调整能力（Layer 3 override）的成员；非 null 时渲染弹窗
  const [adjustingMember, setAdjustingMember] = useState<WorkspaceAgentMember | null>(null);

  useEffect(() => {
    if (workspace) void loadMembers(workspace.id);
  }, [workspace, loadMembers]);

  const defMap = useMemo(() => new Map(definitions.map((d) => [d.id, d])), [definitions]);

  const handleStart = (member: WorkspaceAgentMember): void => {
    if (!workspace) return;
    void startMember(member, workspace.id);
  };

  const handleStop = (member: WorkspaceAgentMember): void => {
    void stopMember(member.instanceId);
  };

  const handleRemove = async (member: WorkspaceAgentMember): Promise<void> => {
    const name = defMap.get(member.agentDefinitionId)?.name ?? '未知';
    if (!confirm(`确定将「${name}」移出本工作空间？`)) return;
    const result = await removeMember(member.instanceId);
    if (!result.ok) {
      alert(
        `「${name}」是以下团队的 leader，请先转移 leader 或解散团队：\n${result.blockedTeams.join('、')}`,
      );
      return;
    }
    // 成员移出后刷新会话成员快照（会话成员面板不自动跟随 workspace 成员变化）
    const { activeSessionId, loadMembers: loadSessionMembers } = useSessionStore.getState();
    if (activeSessionId) await loadSessionMembers(activeSessionId);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 flex items-center gap-2 border-b border-border-subtle shrink-0">
        <span className="text-lg font-semibold">🤖 Agent 成员</span>
        <div className="ml-auto flex gap-2">
          {/* Task 13 接线：CreateAgentDialog（defaultAgentSource='agentView'，创建即加入当前 ws） */}
          <Button type="button" disabled title="创建 Agent 弹窗即将上线">
            + 创建 Agent
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-2">
        {members.map((m) => (
          <MemberRow
            key={m.instanceId}
            member={m}
            def={defMap.get(m.agentDefinitionId)}
            workspace={workspace}
            setDefaultAgent={setDefaultAgent}
            onEditKey={setKeyEditing}
            onAdjustCapabilities={setAdjustingMember}
            onStart={handleStart}
            onStop={handleStop}
            onRemove={handleRemove}
          />
        ))}

        {members.length === 0 && (
          <div className="text-center py-12 text-neutral-500">
            <div className="text-4xl mb-2">🤖</div>
            <p>本工作空间暂无 agent 成员</p>
            <p className="text-xs mt-1 text-neutral-600">点击右上角「+ 创建 Agent」添加成员</p>
          </div>
        )}
      </div>

      {keyEditing && (
        <AssignmentApiKeyEditor assignment={keyEditing} onClose={() => setKeyEditing(null)} />
      )}
      {adjustingMember && (
        <AssignmentCapabilitiesDialog
          assignment={adjustingMember}
          def={definitions.find((d) => d.id === adjustingMember.agentDefinitionId)!}
          onClose={() => {
            setAdjustingMember(null);
            // setMemberDeltas 不像 updateMemberApiKey 那样内部刷新列表，需显式刷新
            if (workspace) void loadMembers(workspace.id);
          }}
        />
      )}
    </div>
  );
}

interface RowProps {
  member: WorkspaceAgentMember;
  def?: AgentDefinition;
  workspace: { id: string; defaultAgentInstanceId: string | null } | null;
  setDefaultAgent: (workspaceId: string, instanceId: string | null) => Promise<void>;
  onStart: (member: WorkspaceAgentMember) => void;
  onStop: (member: WorkspaceAgentMember) => void;
  onEditKey: (member: WorkspaceAgentMember) => void;
  onAdjustCapabilities: (member: WorkspaceAgentMember) => void;
  onRemove: (member: WorkspaceAgentMember) => Promise<void>;
}

function MemberRow({
  member,
  def,
  workspace,
  setDefaultAgent,
  onStart,
  onStop,
  onEditKey,
  onAdjustCapabilities,
  onRemove,
}: RowProps) {
  const isDefault = workspace?.defaultAgentInstanceId === member.instanceId;
  const isRunning = member.lastRunning;

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 hover:bg-bg-tertiary/50 rounded group">
      <span className="text-lg">{def?.iconEmoji ?? '🤖'}</span>
      <span className="text-sm truncate">{def?.name ?? '未知'}</span>
      {def?.modelName && (
        <span className="text-xs text-neutral-500 truncate">{def.modelName}</span>
      )}
      {isDefault && (
        <span className="text-xs" title="默认会话 agent">
          ⭐
        </span>
      )}
      <span className={isRunning ? 'text-green-500 text-xs' : 'text-neutral-600 text-xs'}>
        {isRunning ? '▶ 运行中' : '⏸ 已停止'}
      </span>
      <div className="opacity-0 group-hover:opacity-100 flex gap-1 transition-opacity">
        {isRunning ? (
          <button
            type="button"
            onClick={() => onStop(member)}
            className="text-xs text-neutral-400 hover:text-red-400"
          >
            停止
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onStart(member)}
            className="text-xs text-neutral-400 hover:text-green-400"
          >
            启动
          </button>
        )}
        {workspace && !isDefault && (
          <button
            type="button"
            onClick={() => void setDefaultAgent(workspace.id, member.instanceId)}
            className="text-xs text-neutral-400 hover:text-amber-400"
          >
            设为默认
          </button>
        )}
        <button
          type="button"
          onClick={() => onEditKey(member)}
          className="text-xs text-neutral-400 hover:text-neutral-200"
        >
          更新密钥
        </button>
        <button
          type="button"
          onClick={() => onAdjustCapabilities(member)}
          className="text-xs text-neutral-400 hover:text-neutral-200"
        >
          ⚙ 调整能力
        </button>
        <button
          type="button"
          onClick={() => void onRemove(member)}
          className="text-xs text-neutral-400 hover:text-red-400"
        >
          移出
        </button>
      </div>
    </div>
  );
}
