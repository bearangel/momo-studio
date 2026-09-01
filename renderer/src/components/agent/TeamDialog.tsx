// renderer/src/components/agent/TeamDialog.tsx
//
// v25 Task 13：创建/编辑团队弹窗（spec §6.4）——同一表单，editing prop 决定模式。
// 创建：图标+名称*、成员多选（当前 ws members，≥2 校验）、leader 从已勾选中单选
// （未勾选时禁用；取消勾选当前 leader 时自动清空选择）。
// 编辑：回填现有团队，提交按 diff 应用——改名 → 加成员 → 换 leader → 移除成员。
// 顺序契约：先 setLeader 再移除旧 leader（后端 removeTeamMember 有 leader 守卫，
// 先转移才能移除）；先加成员再设其为 leader（setLeader 要求新 leader 已在团队内）。
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Button } from '../ui/Button';
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
  const { members, definitions, loadMembers, createTeam, renameTeam, setLeader, addTeamMember, removeTeamMember } =
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

  const defMap = useMemo(() => new Map(definitions.map((d) => [d.id, d])), [definitions]);
  const memberLabel = (m: WorkspaceAgentMember): string =>
    defMap.get(m.agentDefinitionId)?.name ?? m.agentName ?? m.agentUserId;

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
        const currentIds = new Set(editing.members.map((m) => m.instanceId));
        if (name.trim() !== editing.name || iconEmoji !== editing.iconEmoji) {
          await renameTeam(editing.id, name.trim(), iconEmoji);
        }
        for (const id of selected) {
          if (!currentIds.has(id)) await addTeamMember(editing.id, id);
        }
        if (leaderId !== editing.leaderInstanceId) {
          await setLeader(editing.id, leaderId);
        }
        for (const m of editing.members) {
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="bg-bg-secondary rounded-xl border border-border-subtle p-6 w-full max-w-md max-h-[85vh] overflow-y-auto"
      >
        <h2 className="text-xl font-bold mb-4">{editing ? '编辑团队' : '新建团队'}</h2>
        <div className="flex flex-col gap-3">
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

          <fieldset className="flex flex-col gap-1.5 border-t border-border-subtle pt-3">
            <legend className="text-sm text-neutral-300">成员（当前工作空间，至少 2 名）</legend>
            {members.length === 0 && (
              <div className="text-xs text-neutral-500">
                当前工作空间暂无 agent 成员，请先在「Agent 成员」Tab 添加
              </div>
            )}
            {members.map((m) => (
              <label key={m.instanceId} className="flex items-center gap-2 text-sm text-neutral-300">
                <input
                  type="checkbox"
                  aria-label={memberLabel(m)}
                  checked={selected.has(m.instanceId)}
                  onChange={(e) => toggleMember(m.instanceId, e.target.checked)}
                />
                <span>{defMap.get(m.agentDefinitionId)?.iconEmoji ?? '🤖'}</span>
                <span>{memberLabel(m)}</span>
              </label>
            ))}
          </fieldset>

          <fieldset className="flex flex-col gap-1.5 border-t border-border-subtle pt-3">
            <legend className="text-sm text-neutral-300">团队 leader</legend>
            <div className="text-xs text-neutral-500">从已勾选成员中选择；leader 负责接待非 @ 消息</div>
            {members.map((m) => {
              const checked = selected.has(m.instanceId);
              return (
                <label
                  key={m.instanceId}
                  className={cn(
                    'flex items-center gap-2 text-sm',
                    checked ? 'text-neutral-300' : 'text-neutral-600',
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
                </label>
              );
            })}
          </fieldset>

          {error && <div className="text-red-400 text-sm">{error}</div>}
          <div className="flex gap-2 justify-end mt-2">
            <Button variant="ghost" type="button" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? '保存中…' : editing ? '保存' : '创建'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
