// renderer/src/components/agent/TeamDialog.tsx
//
// v25 Task 13：创建/编辑团队弹窗（spec §6.4）——同一表单，editing prop 决定模式。
// 创建：图标+名称*、成员多选（当前 ws members，≥2 校验）、leader 从已勾选中单选
// （未勾选时禁用；取消勾选当前 leader 时自动清空选择）。
// 编辑：回填现有团队，提交按 diff 应用——改名 → 加成员 → 换 leader → 移除成员。
// 顺序契约：先 setLeader 再移除旧 leader（后端 removeTeamMember 有 leader 守卫，
// 先转移才能移除）；先加成员再设其为 leader（setLeader 要求新 leader 已在团队内）。
//
// v2.1 P3：手写 modal 外壳 → Dialog 原子件；成员行/leader 行 token 化 + hover surface-3；
// 成员图标缺省 → Avatar bot（对齐 CollabSessionDialog / MembersPanel 先例）；
// 当前 leader 行 Crown 标记（TeamsPanel 同款 title="团队 leader"）。
// 成员 checkbox / leader radio 保留原生 input（P2 Task 15 先例：行内单/多选原生 + aria-label）。
import { useEffect, useState, type FormEvent } from 'react';
import { Crown } from 'lucide-react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { cn } from '../../lib/cn';
import type { Team, WorkspaceAgentMember } from '../../ipc/types';

interface Props {
  /** 编辑模式传入现有团队；缺省 = 创建模式 */
  editing?: Team;
  onClose: () => void;
}

export function TeamDialog({ editing, onClose }: Props) {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const { members, loadMembers, createTeam, renameTeam, setLeader, addTeamMember, removeTeamMember } =
    useAgentStore();

  const [name, setName] = useState(editing?.name ?? '');
  const [iconEmoji, setIconEmoji] = useState(editing?.iconEmoji ?? '👥');
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(editing?.members.map((m) => m.instanceId) ?? []),
  );
  const [leaderId, setLeaderId] = useState(editing?.leaderInstanceId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (workspace) void loadMembers(workspace.id);
  }, [workspace, loadMembers]);

  // v2.2：agentName 由后端 JOIN definitions 产出（members 数据面），不依赖 defMap
  const memberLabel = (m: WorkspaceAgentMember): string => m.agentName;

  const toggleMember = (instanceId: string, checked: boolean): void => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (checked) next.add(instanceId);
      else next.delete(instanceId);
      return next;
    });
    // 取消勾选当前 leader → 选择复位（leader 只能来自已勾选成员）
    if (!checked && leaderId === instanceId) setLeaderId('');
  };

  const validate = (): string | null => {
    if (!name.trim()) return '团队名称不能为空';
    if (selected.size < 2) return '至少选择 2 名团队成员';
    if (!leaderId) return '请选择团队 leader';
    return null;
  };

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }
    if (!workspace) {
      setError('无激活工作空间');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (!editing) {
        await createTeam(workspace.id, {
          name: name.trim(),
          iconEmoji,
          memberInstanceIds: [...selected],
          leaderInstanceId: leaderId,
        });
      } else {
        // diff 基准 = 提交时 store 现状。editing prop 是打开弹窗时的快照——
        // 部分失败后 store action 已自动刷新 teams，同弹窗重试若仍按快照 diff，
        // 会重放已成功的 addTeamMember（后端 dup 显式 throw，非幂等）导致死循环。
        const base =
          useAgentStore.getState().teams.find((t) => t.id === editing.id) ?? editing;
        if (base === editing) {
          setError('团队状态已过期（可能已被删除），建议刷新团队列表后重试');
        }
        const currentIds = new Set(base.members.map((m) => m.instanceId));
        if (name.trim() !== base.name || iconEmoji !== base.iconEmoji) {
          await renameTeam(editing.id, name.trim(), iconEmoji);
        }
        for (const id of selected) {
          if (!currentIds.has(id)) await addTeamMember(editing.id, id);
        }
        if (leaderId !== base.leaderInstanceId) {
          await setLeader(editing.id, leaderId);
        }
        for (const m of base.members) {
          if (!selected.has(m.instanceId)) await removeTeamMember(editing.id, m.instanceId);
        }
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={editing ? '编辑团队' : '新建团队'} width={448}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex gap-3">
          <div className="w-20">
            <Input label="图标" value={iconEmoji} onChange={(e) => setIconEmoji(e.target.value)} />
          </div>
          <div className="flex-1">
            <Input
              label="名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：攻坚组"
              autoFocus
            />
          </div>
        </div>

        <fieldset className="flex flex-col gap-1.5 border-t border-subtle pt-3">
          <legend className="text-sm text-secondary">成员（当前工作空间，至少 2 名）</legend>
          {members.length === 0 && (
            <div className="text-xs text-tertiary">
              当前工作空间暂无 agent 成员，请先在「Agent 成员」Tab 添加
            </div>
          )}
          {members.map((m) => (
            <label
              key={m.instanceId}
              className="flex items-center gap-2 text-sm text-secondary px-2 py-1.5 rounded hover:bg-surface-3"
            >
              <input
                type="checkbox"
                aria-label={memberLabel(m)}
                checked={selected.has(m.instanceId)}
                onChange={(e) => toggleMember(m.instanceId, e.target.checked)}
              />
              <span>
                {m.iconEmoji || (
                  <Avatar name={memberLabel(m)} bot size="sm" />
                )}
              </span>
              <span>{memberLabel(m)}</span>
            </label>
          ))}
        </fieldset>

        <fieldset className="flex flex-col gap-1.5 border-t border-subtle pt-3">
          <legend className="text-sm text-secondary">团队 leader</legend>
          <div className="text-xs text-tertiary">从已勾选成员中选择；leader 负责接待非 @ 消息</div>
          {members.map((m) => {
            const checked = selected.has(m.instanceId);
            return (
              <label
                key={m.instanceId}
                className={cn(
                  'flex items-center gap-2 text-sm px-2 py-1.5 rounded',
                  checked ? 'text-secondary hover:bg-surface-3' : 'text-disabled',
                )}
              >
                <input
                  type="radio"
                  name="team-leader"
                  aria-label={`设为 leader：${memberLabel(m)}`}
                  checked={leaderId === m.instanceId}
                  disabled={!checked}
                  onChange={() => setLeaderId(m.instanceId)}
                />
                {memberLabel(m)}
                {leaderId === m.instanceId && (
                  <span
                    className="inline-flex items-center text-accent-600 dark:text-accent-300"
                    title="团队 leader"
                  >
                    <Crown size={11} strokeWidth={1.75} aria-hidden className="text-accent-500" />
                  </span>
                )}
              </label>
            );
          })}
        </fieldset>

        {error && <div className="text-status-error text-sm">{error}</div>}
        <div className="flex gap-2 justify-end mt-2">
          <Button variant="ghost" type="button" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? '保存中…' : editing ? '保存' : '创建'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
