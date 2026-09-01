// renderer/src/components/agent/TeamsPanel.tsx
// AgentsView Tab 2「团队」（spec §6.1）：当前 workspace 的团队卡片列表。
// 团队卡片 = icon + 名称 + 👑leader 标记 + 成员 chips + 编辑/删除。
// 创建/编辑团队弹窗（TeamDialog）归 Task 13，此处「+ 新建团队」与「编辑」
// 先留占位入口；「删除」接线 agent.store.deleteTeam（spec §7：仅删定义，
// 已建会话快照无感）。
import { useEffect, useMemo } from 'react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Button } from '../ui/Button';
import { cn } from '../../lib/cn';
import type { Team, WorkspaceAgentMember } from '../../ipc/types';

export function TeamsPanel() {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const { teams, definitions, loadTeams, deleteTeam } = useAgentStore();

  useEffect(() => {
    if (workspace) void loadTeams(workspace.id);
  }, [workspace, loadTeams]);

  const defMap = useMemo(() => new Map(definitions.map((d) => [d.id, d])), [definitions]);

  const memberLabel = (member: WorkspaceAgentMember): string =>
    defMap.get(member.agentDefinitionId)?.name ?? member.agentName ?? member.agentUserId;

  const handleDelete = async (team: Team): Promise<void> => {
    if (!confirm(`确定删除团队「${team.name}」？已建会话不受影响。`)) return;
    await deleteTeam(team.id);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 flex items-center gap-2 border-b border-border-subtle shrink-0">
        <span className="text-lg font-semibold">👥 团队</span>
        <div className="ml-auto flex gap-2">
          {/* Task 13 接线：TeamDialog（创建模式；成员勾选≥2，leader 从已勾选中单选） */}
          <Button type="button" disabled title="团队弹窗即将上线">
            + 新建团队
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-3">
        {teams.map((team) => (
          <div
            key={team.id}
            className="rounded-lg border border-border-subtle bg-bg-secondary p-3"
            data-team-id={team.id}
          >
            <div className="flex items-center gap-2">
              <span className="text-lg">{team.iconEmoji}</span>
              <span className="font-medium truncate">{team.name}</span>
              <div className="ml-auto flex gap-1">
                {/* Task 13 接线：TeamDialog（编辑模式，回填现有成员与 leader） */}
                <button
                  type="button"
                  disabled
                  className="text-xs text-neutral-400 hover:text-neutral-200 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  编辑
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(team)}
                  className="text-xs text-neutral-400 hover:text-red-400"
                >
                  删除
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {team.members.map((m) => (
                <span
                  key={m.instanceId}
                  title={m.instanceId === team.leaderInstanceId ? '团队 leader' : undefined}
                  className={cn(
                    'text-xs px-2 py-0.5 rounded border',
                    m.instanceId === team.leaderInstanceId
                      ? 'bg-accent-blue/20 text-accent-blue border-accent-blue/40'
                      : 'bg-neutral-700/40 text-neutral-300 border-neutral-700',
                  )}
                >
                  {m.instanceId === team.leaderInstanceId ? '👑' : ''}
                  {memberLabel(m)}
                </span>
              ))}
              {team.members.length === 0 && (
                <span className="text-xs text-neutral-600">（无成员）</span>
              )}
            </div>
          </div>
        ))}

        {teams.length === 0 && (
          <div className="text-center py-12 text-neutral-500">
            <div className="text-4xl mb-2">👥</div>
            <p>暂无团队</p>
            <p className="text-xs mt-1 text-neutral-600">点击右上角「+ 新建团队」组建协作团队</p>
          </div>
        )}
      </div>
    </div>
  );
}
