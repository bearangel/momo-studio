// renderer/src/components/agent/TeamDialog.tsx
//
// v25 Task 13：创建/编辑团队弹窗（spec §6.4）——同一表单，editing prop 决定模式。
// 创建：图标+名称*、成员多选（当前 ws members，≥2 校验）。
// 编辑：回填现有团队，提交按 diff 应用——改名 → 加成员 → 换 leader → 移除成员。
// 顺序契约：先 setLeader 再移除旧 leader（后端 removeTeamMember 有 leader 守卫，
// 先转移才能移除）；先加成员再设其为 leader（setLeader 要求新 leader 已在团队内）。
//
// 验收补修（2026-11-02，用户实测）：成员列表与 leader 列表合一——每行右侧
// 皇冠 radio 行内指定队长（首个勾选自动成为队长；取消勾选现任队长 → 皇冠自动
// 落到剩余已选首位，消灭「请选择 leader」报错态）；每行名称下新增 agent 简介
// 次行（definitions 按 agentDefinitionId 映射，无简介不渲染）。
//
// v2.1 P3：手写 modal 外壳 → Dialog 原子件；成员行 token 化 + hover surface-3；
// 成员图标缺省 → Avatar bot（对齐 CollabSessionDialog / MembersPanel 先例）。
// checkbox / 皇冠 radio 保留原生 input（P2 Task 15 先例：行内单/多选原生 + aria-label）。
import { useEffect, useState, type FormEvent } from 'react';
import { Crown } from 'lucide-react';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { EmojiPicker } from '../ui/EmojiPicker';
import { Input } from '../ui/Input';
import { cn } from '../../lib/cn';
import type { Team, WorkspaceAgentMember } from '../../ipc/types';

interface Props {
  /** 编辑模式传入现有团队；缺省 = 创建模式 */
  editing?: Team;
  onClose: () => void;
  /** D9：创建成功回调（携带团队 id）——草稿回填链消费 */
  onCreated?: (teamId: string) => void;
}

export function TeamDialog({ onCreated,  editing, onClose }: Props) {
  const workspace = useWorkspaceStore((s) => s.getActive());
  const {
    members, definitions, loadMembers, loadDefinitions,
    createTeam, renameTeam, setLeader, addTeamMember, removeTeamMember,
  } = useAgentStore();

  const [name, setName] = useState(editing?.name ?? '');
  const [iconEmoji, setIconEmoji] = useState(editing?.iconEmoji ?? '👥');
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(editing?.members.map((m) => m.instanceId) ?? []),
  );
  const [leaderId, setLeaderId] = useState(editing?.leaderInstanceId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (workspace) {
      void loadMembers(workspace.id);
      void loadDefinitions();
    }
  }, [workspace, loadMembers, loadDefinitions]);

  // v2.2：agentName 由后端 JOIN definitions 产出（members 数据面），不依赖 defMap
  const memberLabel = (m: WorkspaceAgentMember): string => m.agentName;
  const memberDesc = (m: WorkspaceAgentMember): string =>
    definitions.find((d) => d.id === m.agentDefinitionId)?.description ?? '';

  const toggleMember = (instanceId: string, checked: boolean): void => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (checked) next.add(instanceId);
      else next.delete(instanceId);
      return next;
    });
    if (checked && !leaderId) {
      // 首个勾选成员自动成为队长（皇冠可见，用户可再切换）
      setLeaderId(instanceId);
    } else if (!checked && leaderId === instanceId) {
      // 取消勾选现任队长 → 皇冠自动落到剩余已选首位
      const rest = [...selected].filter((id) => id !== instanceId);
      setLeaderId(rest[0] ?? '');
    }
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
        const created = await createTeam(workspace.id, {
          name: name.trim(),
          iconEmoji,
          memberInstanceIds: [...selected],
          leaderInstanceId: leaderId,
        });
        onCreated?.(created.id); // D9：草稿回填链（编辑路径无此语义）
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
            <EmojiPicker label="图标" value={iconEmoji} onChange={setIconEmoji} />
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

        {/* 验收补修（2026-11-02）：fieldset 默认 min-width:min-content 会被简介行的
            nowrap（truncate）抬高固有宽 → 撑破 448px 对话框出横向滚动条；min-w-0 归零 */}
        <fieldset className="flex min-w-0 flex-col gap-1.5 border-t border-subtle pt-3">
          <legend className="text-sm text-secondary">成员（当前工作空间，至少 2 名）</legend>
          <div className="text-xs text-tertiary">
            勾选加入团队；点右侧皇冠指定队长（默认首个勾选成员，负责接待非 @ 消息）
          </div>
          {members.length === 0 && (
            <div className="text-xs text-tertiary">
              当前工作空间暂无智能体成员，请先在「智能体成员」Tab 添加
            </div>
          )}
          {members.map((m) => {
            const checked = selected.has(m.instanceId);
            const isLeader = leaderId === m.instanceId;
            const desc = memberDesc(m);
            return (
              <div
                key={m.instanceId}
                className={cn('flex items-start gap-2 rounded px-2 py-1.5 hover:bg-surface-3', !checked && 'opacity-60')}
              >
                <label className="flex flex-1 min-w-0 cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    aria-label={memberLabel(m)}
                    checked={checked}
                    onChange={(e) => toggleMember(m.instanceId, e.target.checked)}
                  />
                  <span className="mt-0.5 flex-none">
                    {m.iconEmoji || (
                      <Avatar name={memberLabel(m)} bot size="sm" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="text-[13px] text-primary">{memberLabel(m)}</span>
                      {isLeader && (
                        <span className="rounded-full border border-accent-500/40 px-1.5 py-px text-[10px] font-medium text-accent-600 dark:text-accent-300">
                          {editing && isLeader && editing.leaderInstanceId === m.instanceId ? '现任队长' : '队长'}
                        </span>
                      )}
                    </span>
                    {desc && (
                      <span className="block truncate text-[11px] leading-relaxed text-tertiary">
                        {desc}
                      </span>
                    )}
                  </span>
                </label>
                <label
                  className={cn(
                    'mt-1 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full border',
                    isLeader
                      ? 'border-accent-500 bg-accent-500/15'
                      : checked
                        ? 'cursor-pointer border-border-strong hover:border-accent-500'
                        : 'border-border-subtle opacity-40',
                  )}
                >
                  <input
                    type="radio"
                    name="team-leader"
                    className="sr-only"
                    aria-label={`设为队长：${memberLabel(m)}`}
                    checked={isLeader}
                    disabled={!checked}
                    onChange={() => setLeaderId(m.instanceId)}
                  />
                  {isLeader && (
                    <Crown size={9} strokeWidth={2.25} aria-hidden className="text-accent-500" />
                  )}
                </label>
              </div>
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
