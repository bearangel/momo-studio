// renderer/src/components/agent/TeamsPanel.tsx
// AgentsView Tab 2「团队」（spec §6.1）：当前 workspace 的团队卡片列表。
// 团队卡片 = icon + 名称 + Crown leader 标记 + 成员 chips + 编辑/删除。
// 「+ 新建团队」/「编辑」→ TeamDialog（Task 13 接线）；「删除」接线
// agent.store.deleteTeam（spec §7：仅删定义，已建会话快照无感）。
// v2.1 P3：token 全量语义化；👥 → Users lucide、👑 → Crown lucide（P2 先例）；
// leader chip 选中态 accent 形态（surface-active + accent-600/300）。
import { useEffect, useMemo, useState } from 'react';
import { Crown, Users } from 'lucide-react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { cn } from '../../lib/cn';
import { TeamDialog } from './TeamDialog';
import type { Team, WorkspaceAgentMember } from '../../ipc/types';

export function TeamsPanel() {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const { teams, definitions, loadTeams, deleteTeam } = useAgentStore();
  const [createOpen, setCreateOpen] = useState(false);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);

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
      <div className="px-4 py-3 flex items-center gap-2 border-b border-subtle shrink-0">
        <span className="inline-flex items-center gap-1.5 text-lg font-semibold">
          <Users size={16} strokeWidth={1.75} aria-hidden />
          团队
        </span>
        <div className="ml-auto flex gap-2">
          <Button type="button" onClick={() => setCreateOpen(true)}>
            + 新建团队
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-3">
        {teams.map((team) => (
          <div
            key={team.id}
            className="rounded-lg border border-subtle bg-surface-1 p-3"
            data-team-id={team.id}
          >
            <div className="flex items-center gap-2">
              <span className="text-lg">{team.iconEmoji}</span>
              <span className="font-medium truncate">{team.name}</span>
              <div className="ml-auto flex gap-1">
                <button
                  type="button"
                  onClick={() => setEditingTeam(team)}
                  className="text-xs text-secondary hover:text-primary"
                >
                  编辑
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(team)}
                  className="text-xs text-secondary hover:text-status-error"
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
                    'inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border',
                    m.instanceId === team.leaderInstanceId
                      ? 'border-accent-500/40 bg-surface-active text-accent-600 dark:text-accent-300'
                      : 'border-subtle bg-surface-2 text-secondary',
                  )}
                >
                  {m.instanceId === team.leaderInstanceId && (
                    <Crown size={11} strokeWidth={1.75} aria-hidden className="text-accent-500" />
                  )}
                  {memberLabel(m)}
                </span>
              ))}
              {team.members.length === 0 && (
                <span className="text-xs text-disabled">（无成员）</span>
              )}
            </div>
          </div>
        ))}

        {teams.length === 0 && (
          <EmptyState
            icon={Users}
            title="暂无团队"
            description="点击右上角「+ 新建团队」组建协作团队"
          />
        )}
      </div>

      {createOpen && <TeamDialog onClose={() => setCreateOpen(false)} />}
      {editingTeam && <TeamDialog editing={editingTeam} onClose={() => setEditingTeam(null)} />}
    </div>
  );
}
