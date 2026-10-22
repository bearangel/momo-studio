// renderer/src/components/im/CollabSessionDialog.tsx
//
// v25 Task 13：创建协作会话弹窗（spec §6.5）。
// 名称输入（留空 = 动态命名，建会后按首条消息自动命名）+「选择成员 / 选择团队」页签 +
// 成员多选列表（在线态徽标）或团队单选列表（Crown leader + 成员数）。
// 提交走 session.store createCollabSession（成功激活新会话）；失败读 store error 展示。
// 入口接线（侧边栏 👥 按钮）由 SessionSidebarHeader（Task14）完成，本组件就绪。
//
// v2.1 P2 Task 15：手写 modal 外壳 → Dialog 原子件；tab strip / 行 hover / 颜色 token 化；
// iconEmoji 缺省 → Avatar bot（对齐 MentionInput / MembersPanel 先例）；
// 👑 → lucide-react Crown（外层 span title="leader：…" 保留）。
//
// 2026-10-22 Task 11（spec §5.3，预览 B rev2 批准交互）：agent 页签 radio 单选 →
// checkbox 多选卡 + 主 agent 指定（已选卡底部 radio 行，>1 已选时显示）+ leader 名旁
// Crown 徽标（非交互）；提交 payload 恒 members 形态（单选亦然）；页签改名。
// 不变量（§5.3）：首个选中默认 leader；取消 leader 回落剩余首个；切页签清空勾选与 leader。
import { useEffect, useState, type FormEvent } from 'react';
import { Crown } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import { useUiStore } from '../../stores/ui.store';
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
  const { members, teams, definitions, loadMembers, loadTeams, loadDefinitions, addMember } =
    useAgentStore();
  const createCollabSession = useSessionStore((s) => s.createCollabSession);

  const [title, setTitle] = useState('');
  const [tab, setTab] = useState<TargetTab>('agent');
  // Task 11 多选状态：勾选序 selectedIds + 主 agent leaderId（agent 页签）；
  // 团队页签仍单选（teamId），两页签目标不同构、互不共享
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [leaderId, setLeaderId] = useState<string | null>(null);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // 加入中的 def id——addMember IPC 含 agent 启动（秒级），按钮进 pending 态防重复点击/误解
  const [joiningId, setJoiningId] = useState<string | null>(null);

  useEffect(() => {
    if (workspace) {
      void loadMembers(workspace.id);
      void loadTeams(workspace.id);
      void loadDefinitions(workspace.id);
    }
  }, [workspace, loadMembers, loadTeams, loadDefinitions]);

  // 已启用（def 在库）但未加入本空间的 agent——启用是全局的、成员是按空间的；
  // 就近提供「加入」入口，免得用户去资源库停用重启用绕一圈（2026-10-10 走查反馈）
  const notJoined = workspace
    ? definitions.filter((d) => !members.some((m) => m.agentDefinitionId === d.id))
    : [];

  // v2.2：agentName/iconEmoji 由后端 JOIN definitions 产出（members 数据面），
  // 不再依赖 definitions 的加载时序——此前 defMap 恒空时落到 agentUserId 显示 ID。
  const memberLabel = (m: WorkspaceAgentMember): string => m.agentName;
  const teamLeaderLabel = (t: Team): string => {
    const leader = t.members.find((m) => m.instanceId === t.leaderInstanceId);
    return leader ? memberLabel(leader) : '';
  };

  // 勾选/取消一个成员。不变量（spec §5.3）：
  // 取消的恰是当前 leader → 回落剩余首个；新勾选时若无 leader → 首个选中者默认当选
  const toggle = (id: string): void => {
    if (selectedIds.includes(id)) {
      const next = selectedIds.filter((x) => x !== id);
      setSelectedIds(next);
      if (leaderId === id) setLeaderId(next[0] ?? null);
    } else {
      setSelectedIds([...selectedIds, id]);
      setLeaderId((cur) => cur ?? id);
    }
  };

  // 切页签时清空已选目标（agent 目标与 team 目标不同构）
  const switchTab = (next: TargetTab): void => {
    setTab(next);
    setSelectedIds([]);
    setLeaderId(null);
    setTeamId(null);
  };

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!workspace) {
      setError('无激活工作空间');
      return;
    }
    // 按页签构造目标：agent 页签恒 members 形态（单选亦然，spec §5.3）
    let target: CollabTarget;
    if (tab === 'agent') {
      if (selectedIds.length === 0 || leaderId === null) {
        setError('请选择会话成员');
        return;
      }
      target = { type: 'members', instanceIds: selectedIds, leaderInstanceId: leaderId };
    } else {
      if (teamId === null) {
        setError('请选择会话目标');
        return;
      }
      target = { type: 'team', teamId };
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

        {/* 目标类型页签（Task 11 改名：单个 agent→选择成员、团队→选择团队，预览 B rev2 批准） */}
        <div className="flex gap-1 border-b border-subtle">
          {(
            [
              { key: 'agent', label: '选择成员' },
              { key: 'team', label: '选择团队' },
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
            {members.length === 0 && notJoined.length === 0 && (
              <div className="text-xs text-tertiary">
                当前工作空间暂无智能体成员，请先到「智能体」页添加
              </div>
            )}
            {/* 多选引导文案（已选 >1 时出现，预览 B rev2 批准文案） */}
            {selectedIds.length > 1 && (
              <p className="text-xs text-tertiary">
                已选 {selectedIds.length} 个成员——指定一名主 agent 负责接待与任务分派
              </p>
            )}
            {members.map((m) => (
              <div key={m.instanceId} className="rounded hover:bg-surface-3">
                <label className="flex items-center gap-2 text-sm text-secondary px-2 py-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    aria-label={memberLabel(m)}
                    checked={selectedIds.includes(m.instanceId)}
                    onChange={() => toggle(m.instanceId)}
                  />
                  <span>
                    {m.iconEmoji || <Avatar name={memberLabel(m)} bot size="sm" />}
                  </span>
                  <span>{memberLabel(m)}</span>
                  {/* Crown 徽标（rev2：非交互徽标，随 leader 迁移；恰 1 个已选时不显示） */}
                  {selectedIds.length > 1 && leaderId === m.instanceId && (
                    <span
                      data-testid={`leader-badge-${m.instanceId}`}
                      title="主 agent：负责接待用户输入与任务分派"
                      className="shrink-0 text-accent-500"
                    >
                      <Crown size={12} strokeWidth={1.75} aria-hidden />
                    </span>
                  )}
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
                {/* 主 agent 指定行（>1 已选时显示于已选卡底部；name 同组互斥） */}
                {selectedIds.length > 1 && selectedIds.includes(m.instanceId) && (
                  <label className="mt-1 flex items-center gap-1.5 text-xs text-secondary px-2 pb-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="collab-leader"
                      data-testid={`leader-radio-${m.instanceId}`}
                      checked={leaderId === m.instanceId}
                      onChange={() => setLeaderId(m.instanceId)}
                    />
                    主 agent
                  </label>
                )}
              </div>
            ))}
            {notJoined.length > 0 && (
              <div className="border-t border-subtle pt-2 mt-1 flex flex-col gap-1">
                <div className="text-xs text-tertiary">已启用、未加入本工作空间（加入后可选）</div>
                {notJoined.map((d) => (
                  <div
                    key={d.id}
                    className="flex items-center gap-2 text-sm text-secondary px-2 py-1 rounded hover:bg-surface-3"
                  >
                    <span>{d.iconEmoji || <Avatar name={d.name} bot size="sm" />}</span>
                    <span className="truncate">{d.name}</span>
                    <button
                      type="button"
                      aria-label={`加入 ${d.name}`}
                      disabled={joiningId !== null}
                      className="ml-auto text-xs text-accent-600 dark:text-accent-300 hover:underline disabled:opacity-50"
                      onClick={() => {
                        if (!workspace) return;
                        setJoiningId(d.id);
                        void addMember(workspace.id, d.id)
                          .catch(() => undefined)
                          .finally(() => setJoiningId(null));
                      }}
                    >
                      {joiningId === d.id ? '加入中…' : '+ 加入'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </fieldset>
        ) : (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm text-secondary">选择团队</legend>
            {teams.length === 0 && (
              <div className="flex items-center gap-2 text-xs text-tertiary">
                <span>暂无团队</span>
                <Button
                  variant="ghost"
                  onClick={() => {
                    // P3-3（2026-10-15）：空态直通——跳智能体页（团队 tab 由该页入口进入）
                    useUiStore.getState().setActiveView('agents');
                    onClose();
                  }}
                >
                  去创建团队
                </Button>
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
                  checked={teamId === t.id}
                  onChange={() => setTeamId(t.id)}
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
