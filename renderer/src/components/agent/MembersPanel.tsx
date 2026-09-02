// renderer/src/components/agent/MembersPanel.tsx
// AgentsView Tab 1「Agent 成员」（spec §6.1）：当前 workspace 的 agent 成员列表，
// 拆自 WorkspaceAgentsPanel（v25 去编排退役）。成员行 = icon emoji + 名称 + 模型 +
// Star 默认会话标记 + 在线状态 + 行内操作（启动/停止、设为默认会话、编辑、
// 移出工作空间）。移出被 leader 守卫拦截时 alert blockedTeams 团队名。
// 「编辑」→ MemberEditDialog（API key + 能力覆盖统一弹窗；关闭时刷新成员列表，
// 因 setMemberDeltas 不像 updateMemberApiKey 那样内部刷新）。
// 「+ 创建 Agent」→ CreateAgentDialog（source='agentView'，创建成功自动加入当前 ws）。
// v2.1 P3：token 全量语义化；🤖/⭐/▶/⏸ → Bot/Star/Play/Pause lucide（iconEmoji 用户数据豁免）。
import { useEffect, useMemo, useState } from 'react';
import { Bot, Pause, Play, Star } from 'lucide-react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useSessionStore } from '../../stores/session.store';
import { MemberEditDialog } from './MemberEditDialog';
import { CreateAgentDialog } from './CreateAgentDialog';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { cn } from '../../lib/cn';
import type { AgentDefinition, WorkspaceAgentMember } from '../../ipc/types';

export function MembersPanel() {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const setDefaultAgent = useWorkspaceStore((s) => s.setDefaultAgent);
  const { members, definitions, loadMembers, startMember, stopMember, removeMember } =
    useAgentStore();

  // 当前正在编辑（API key + 能力覆盖）的成员；非 null 时渲染弹窗
  const [editingMember, setEditingMember] = useState<WorkspaceAgentMember | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

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
      <div className="px-4 py-3 flex items-center gap-2 border-b border-subtle shrink-0">
        <span className="inline-flex items-center gap-1.5 text-lg font-semibold">
          <Bot size={16} strokeWidth={1.75} aria-hidden />
          Agent 成员
        </span>
        <div className="ml-auto flex gap-2">
          <Button type="button" onClick={() => setCreateOpen(true)}>
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
            onEdit={setEditingMember}
            onStart={handleStart}
            onStop={handleStop}
            onRemove={handleRemove}
          />
        ))}

        {members.length === 0 && (
          <EmptyState
            icon={Bot}
            title="本工作空间暂无 agent 成员"
            description="点击右上角「+ 创建 Agent」添加成员"
          />
        )}
      </div>

      {createOpen && <CreateAgentDialog source="agentView" onClose={() => setCreateOpen(false)} />}
      {editingMember && (
        <MemberEditDialog
          member={editingMember}
          def={definitions.find((d) => d.id === editingMember.agentDefinitionId)!}
          onClose={() => {
            setEditingMember(null);
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
  onEdit: (member: WorkspaceAgentMember) => void;
  onRemove: (member: WorkspaceAgentMember) => Promise<void>;
}

function MemberRow({
  member,
  def,
  workspace,
  setDefaultAgent,
  onStart,
  onStop,
  onEdit,
  onRemove,
}: RowProps) {
  const isDefault = workspace?.defaultAgentInstanceId === member.instanceId;
  const isRunning = member.lastRunning;

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 hover:bg-surface-3 rounded group">
      <span className="text-lg">{def?.iconEmoji ?? <Bot size={16} strokeWidth={1.75} aria-hidden />}</span>
      <span className="text-sm truncate">{def?.name ?? '未知'}</span>
      {def?.modelName && (
        <span className="text-xs text-tertiary truncate">{def.modelName}</span>
      )}
      {isDefault && (
        <span className="inline-flex items-center" title="默认会话 agent">
          <Star
            size={12}
            strokeWidth={1.75}
            aria-hidden
            fill="currentColor"
            className="shrink-0 text-accent-500"
          />
        </span>
      )}
      <span
        className={cn(
          'inline-flex items-center gap-1 text-xs',
          isRunning ? 'text-status-success' : 'text-disabled',
        )}
      >
        {isRunning ? (
          <Play size={11} strokeWidth={1.75} aria-hidden />
        ) : (
          <Pause size={11} strokeWidth={1.75} aria-hidden />
        )}
        {isRunning ? '运行中' : '已停止'}
      </span>
      <div className="opacity-0 group-hover:opacity-100 flex gap-1 transition-opacity">
        {isRunning ? (
          <button
            type="button"
            onClick={() => onStop(member)}
            className="text-xs text-secondary hover:text-status-error"
          >
            停止
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onStart(member)}
            className="text-xs text-secondary hover:text-status-success"
          >
            启动
          </button>
        )}
        {workspace && !isDefault && (
          <button
            type="button"
            onClick={() => void setDefaultAgent(workspace.id, member.instanceId)}
            className="text-xs text-secondary hover:text-primary"
          >
            设为默认
          </button>
        )}
        <button
          type="button"
          onClick={() => onEdit(member)}
          className="text-xs text-secondary hover:text-primary"
        >
          编辑
        </button>
        <button
          type="button"
          onClick={() => void onRemove(member)}
          className="text-xs text-secondary hover:text-status-error"
        >
          移出
        </button>
      </div>
    </div>
  );
}
