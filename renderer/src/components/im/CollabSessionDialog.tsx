// renderer/src/components/im/CollabSessionDialog.tsx
//
// v25 Task 13：创建协作会话弹窗（spec §6.5）。
// 名称输入（留空 = 动态命名，建会后按首条消息自动命名）+「单个 agent / 团队」页签 +
// 目标单选列表（成员行显示在线态 / 团队行显示 Crown leader + 成员数）。
// 提交走 session.store createCollabSession（成功激活新会话）；失败读 store error 展示。
// 入口接线（侧边栏 👥 按钮）由 SessionSidebarHeader（Task14）完成，本组件就绪。
//
// v2.1 P2 Task 15：手写 modal 外壳 → Dialog 原子件；tab strip / 行 hover / 颜色 token 化；
// iconEmoji 缺省 → Avatar bot（对齐 MentionInput / MembersPanel 先例）；
// 👑 → lucide-react Crown（外层 span title="leader：…" 保留）。
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Crown } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
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
    <Dialog open onClose={onClose} title="创建协作会话" width={448}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <Input
          label="会话名称"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="留空则动态命名（按首条消息自动命名）"
          autoFocus
        />

        {/* 目标类型页签 */}
        <div className="flex gap-1 border-b border-subtle">
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
                  ? 'border-accent-500 text-primary'
                  : 'border-transparent text-secondary hover:text-primary',
              )}
              onClick={() => switchTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'agent' ? (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm text-secondary">选择成员</legend>
            {members.length === 0 && (
              <div className="text-xs text-tertiary">
                当前工作空间暂无 agent 成员，请先到「Agent 管理」添加
              </div>
            )}
            {members.map((m) => (
              <label
                key={m.instanceId}
                className="flex items-center gap-2 text-sm text-secondary px-2 py-1.5 rounded hover:bg-surface-3"
              >
                <input
                  type="radio"
                  name="collab-target"
                  aria-label={memberLabel(m)}
                  checked={target?.type === 'agent' && target.instanceId === m.instanceId}
                  onChange={() => setTarget({ type: 'agent', instanceId: m.instanceId })}
                />
                <span>
                  {defMap.get(m.agentDefinitionId)?.iconEmoji ?? (
                    <Avatar name={memberLabel(m)} bot size="sm" />
                  )}
                </span>
                <span>{memberLabel(m)}</span>
                <span
                  className={cn(
                    'ml-auto text-[10px] px-1.5 py-0.5 rounded',
                    m.lastRunning
                      ? 'bg-status-success/20 text-status-success'
                      : 'bg-surface-2 text-tertiary',
                  )}
                >
                  {m.lastRunning ? '在线' : '离线'}
                </span>
              </label>
            ))}
          </fieldset>
        ) : (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm text-secondary">选择团队</legend>
            {teams.length === 0 && (
              <div className="text-xs text-tertiary">
                暂无团队，请先到「Agent 管理 → 团队」组建
              </div>
            )}
            {teams.map((t) => (
              <label
                key={t.id}
                className="flex items-center gap-2 text-sm text-secondary px-2 py-1.5 rounded hover:bg-surface-3"
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
                <span
                  className="inline-flex items-center text-xs"
                  title={`leader：${teamLeaderLabel(t)}`}
                >
                  <Crown size={11} strokeWidth={1.75} aria-hidden className="text-accent-500" />
                </span>
                <span className="ml-auto text-xs text-tertiary">{t.members.length} 成员</span>
              </label>
            ))}
          </fieldset>
        )}

        {error && <div className="text-status-error text-sm">{error}</div>}
        <div className="flex gap-2 justify-end mt-2">
          <Button variant="ghost" type="button" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={creating}>
            {creating ? '创建中…' : '创建'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
