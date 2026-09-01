// renderer/src/components/im/CollabSessionDialog.tsx
//
// v25 Task 13：创建协作会话弹窗（spec §6.5）。
// 名称输入（留空 = 动态命名，建会后按首条消息自动命名）+「单个 agent / 团队」页签 +
// 目标单选列表（成员行显示在线态 / 团队行显示 👑 + 成员数）。
// 提交走 session.store createCollabSession（成功激活新会话）；失败读 store error 展示。
// 入口接线（侧边栏 👥 按钮）归后续任务，本组件先就绪。
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSessionStore } from '../../stores/session.store';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { cn } from '../../lib/cn';
import type { CollabTarget, Team, WorkspaceAgentMember } from '../../ipc/types';

interface Props {
  onClose: () => void;
}

type TargetTab = 'agent' | 'team';

export function CollabSessionDialog({ onClose }: Props) {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const { members, teams, definitions, loadMembers, loadTeams } = useAgentStore();
  const createCollabSession = useSessionStore((s) => s.createCollabSession);

  const [title, setTitle] = useState('');
  const [tab, setTab] = useState<TargetTab>('agent');
  const [target, setTarget] = useState<CollabTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (workspace) {
      void loadMembers(workspace.id);
      void loadTeams(workspace.id);
    }
  }, [workspace, loadMembers, loadTeams]);

  const defMap = useMemo(() => new Map(definitions.map((d) => [d.id, d])), [definitions]);
  const memberLabel = (m: WorkspaceAgentMember): string =>
    defMap.get(m.agentDefinitionId)?.name ?? m.agentName ?? m.agentUserId;
  const teamLeaderLabel = (t: Team): string => {
    const leader = t.members.find((m) => m.instanceId === t.leaderInstanceId);
    return leader ? memberLabel(leader) : '';
  };

  // 切页签时清空已选目标（agent 目标与 team 目标不同构）
  const switchTab = (next: TargetTab): void => {
    setTab(next);
    setTarget(null);
  };

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!target) {
      setError('请选择会话目标');
      return;
    }
    if (!workspace) {
      setError('无激活工作空间');
      return;
    }
    setCreating(true);
    setError(null);
    const ok = await createCollabSession(workspace.id, title.trim() || undefined, target);
    setCreating(false);
    if (ok) {
      onClose();
    } else {
      // createCollabSession 失败时把错误写进 store（真实 action 语义），此处读出展示
      setError(useSessionStore.getState().error ?? '创建会话失败');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="bg-bg-secondary rounded-xl border border-border-subtle p-6 w-full max-w-md max-h-[85vh] overflow-y-auto"
      >
        <h2 className="text-xl font-bold mb-4">创建协作会话</h2>
        <div className="flex flex-col gap-3">
          <Input
            label="会话名称"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="留空则动态命名（按首条消息自动命名）"
            autoFocus
          />

          {/* 目标类型页签 */}
          <div className="flex gap-1 border-b border-border-subtle">
            {(
              [
                { key: 'agent', label: '单个 agent' },
                { key: 'team', label: '团队' },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                type="button"
                className={cn(
                  'px-3 py-1.5 text-sm -mb-px border-b-2 transition-colors',
                  tab === t.key
                    ? 'border-accent-blue text-neutral-100'
                    : 'border-transparent text-neutral-400 hover:text-neutral-200',
                )}
                onClick={() => switchTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'agent' ? (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-sm text-neutral-300">选择成员</legend>
              {members.length === 0 && (
                <div className="text-xs text-neutral-500">
                  当前工作空间暂无 agent 成员，请先到「Agent 管理」添加
                </div>
              )}
              {members.map((m) => (
                <label
                  key={m.instanceId}
                  className="flex items-center gap-2 text-sm text-neutral-300 px-2 py-1.5 rounded hover:bg-bg-tertiary/50"
                >
                  <input
                    type="radio"
                    name="collab-target"
                    aria-label={memberLabel(m)}
                    checked={target?.type === 'agent' && target.instanceId === m.instanceId}
                    onChange={() => setTarget({ type: 'agent', instanceId: m.instanceId })}
                  />
                  <span>{defMap.get(m.agentDefinitionId)?.iconEmoji ?? '🤖'}</span>
                  <span>{memberLabel(m)}</span>
                  <span
                    className={cn(
                      'ml-auto text-[10px] px-1.5 py-0.5 rounded',
                      m.lastRunning
                        ? 'bg-status-success/20 text-status-success'
                        : 'bg-bg-tertiary text-neutral-500',
                    )}
                  >
                    {m.lastRunning ? '在线' : '离线'}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-sm text-neutral-300">选择团队</legend>
              {teams.length === 0 && (
                <div className="text-xs text-neutral-500">
                  暂无团队，请先到「Agent 管理 → 团队」组建
                </div>
              )}
              {teams.map((t) => (
                <label
                  key={t.id}
                  className="flex items-center gap-2 text-sm text-neutral-300 px-2 py-1.5 rounded hover:bg-bg-tertiary/50"
                >
                  <input
                    type="radio"
                    name="collab-target"
                    aria-label={t.name}
                    checked={target?.type === 'team' && target.teamId === t.id}
                    onChange={() => setTarget({ type: 'team', teamId: t.id })}
                  />
                  <span>{t.iconEmoji}</span>
                  <span>{t.name}</span>
                  <span className="text-xs text-accent-blue" title={`leader：${teamLeaderLabel(t)}`}>
                    👑
                  </span>
                  <span className="ml-auto text-xs text-neutral-500">{t.members.length} 成员</span>
                </label>
              ))}
            </fieldset>
          )}

          {error && <div className="text-red-400 text-sm">{error}</div>}
          <div className="flex gap-2 justify-end mt-2">
            <Button variant="ghost" type="button" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={creating}>
              {creating ? '创建中…' : '创建'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
