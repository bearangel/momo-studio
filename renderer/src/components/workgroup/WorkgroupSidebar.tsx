// renderer/src/components/workgroup/WorkgroupSidebar.tsx
//
// 工作组侧栏（momo-hub M2.1 Task 3，视觉合同 S3 屏；组操作逻辑自 settings/GroupPanel
// 迁移——GroupPanel 本体 T5 才删，两处并存期间共享 hub-group-store 真实现）：
// - 组列表单选：选中行左侧 3px accent 边 + surface-active 底；在线徽标（选中
//   success / 未选中 neutral，计数 hub presence 融合的在线成员数）
// - 成员区（生效选中组）：presence 点 7px + 负载徽标——「在跑 N」计 running+pending
//   两态（与节点卡在跑行同口径）；空闲在线 → 「空闲」；本机/组长 → 「本机 · leader」
//   文本注记（负载优先于注记——在跑信息更关键）；离线成员无徽标
// - 底部组操作：「创建工作组」/「凭邀请码加入」折叠入口（互斥展开）；离线态
//   （configured 但非 online）替换为「连接建立后可…」注记（GroupPanel 迁移语义）
// - 无组空态：创建/加入表单直接展开（引导优先，无折叠入口）
// - 数据源：组/委派 store 的订阅与拉取由 WorkgroupView 统一 init（视图级生命周期），
//   本组件只消费——侧栏与主区共享同一份组列表与选中态
import { useState, type FormEvent } from 'react';
import { ExternalLink, Eye, Plus, Users } from 'lucide-react';
import { effectiveSelectedGroup, useHubGroupStore } from '../../stores/hub-group.store';
import { useHubDelegationStore } from '../../stores/hub-delegation.store';
import { useHubStore } from '../../stores/hub.store';
import { useHubViewStore } from '../../stores/hub-view.store';
import type { HubGroupInfo, HubGroupMember, HubTaskRecord } from '../../ipc/types';
import { cn } from '../../lib/cn';
import { rpcErrorMessage } from '../../lib/rpc-error';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

function runningCountOf(tasks: HubTaskRecord[], nodeId: string): number {
  return tasks.filter((t) => t.targetNodeId === nodeId && (t.status === 'running' || t.status === 'pending')).length;
}

function onlineCount(group: HubGroupInfo): number {
  return group.members.filter((m) => m.online).length;
}

export function WorkgroupSidebar() {
  const online = useHubStore((s) => s.status?.state === 'online');
  const selfNodeId = useHubStore((s) => s.status?.nodeId ?? null);
  const groups = useHubGroupStore((s) => s.groups);
  const selectedGroupId = useHubGroupStore((s) => s.selectedGroupId);
  const selectGroup = useHubGroupStore((s) => s.selectGroup);
  const error = useHubGroupStore((s) => s.error);
  const tasks = useHubDelegationStore((s) => s.tasks);
  // S4 侧栏「查看中」态：查看态（open 且非 picking 前置步）定向的目标成员行
  const viewingNodeId = useHubViewStore((s) => (s.open && !s.picking ? s.targetNodeId : null));
  const [openForm, setOpenForm] = useState<'create' | 'join' | null>(null);

  const group = effectiveSelectedGroup(groups, selectedGroupId);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
        {error !== null && (
          <p className="px-1.5 py-1 text-xs text-status-error" role="alert">
            {error}
          </p>
        )}
        {groups.length === 0 ? (
          <div className="flex flex-col gap-3 px-1.5 pt-1">
            <p className="text-[11px] leading-relaxed text-tertiary">
              {online
                ? '尚未加入任何工作组——创建一个，或凭邀请码加入'
                : '尚未加入任何工作组'}
            </p>
            {online && (
              <>
                <CreateForm />
                <JoinForm />
              </>
            )}
          </div>
        ) : (
          <>
            {groups.map((g) => {
              const selected = group?.groupId === g.groupId;
              return (
                <button
                  key={g.groupId}
                  type="button"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => selectGroup(g.groupId)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-[7px] border-l-[3px] py-1.5 pl-2.5 pr-2 text-left text-[12.5px]',
                    selected
                      ? 'border-accent-500 bg-surface-active font-medium text-accent-600 dark:text-accent-300'
                      : 'border-transparent text-secondary hover:bg-surface-3',
                  )}
                >
                  <Users size={12} strokeWidth={1.75} className="shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{g.groupName}</span>
                  <Badge
                    tone={selected ? 'success' : 'neutral'}
                    className="h-auto shrink-0 px-1.5 py-0.5 text-[10px] leading-none"
                  >
                    {onlineCount(g)} 在线
                  </Badge>
                </button>
              );
            })}
            {group !== null && (
              <div className="mt-1 flex flex-col gap-1 px-1.5 pt-2" aria-label="成员列表">
                <div className="px-2.5 text-[10.5px] text-tertiary">成员</div>
                {group.members.map((m) => (
                  <MemberRow
                    key={m.nodeId}
                    member={m}
                    isSelf={m.nodeId === selfNodeId}
                    isLeader={m.nodeId === group.leaderNodeId}
                    runningCount={runningCountOf(tasks, m.nodeId)}
                    viewing={m.nodeId === viewingNodeId}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {groups.length > 0 &&
        (online ? (
          <div className="flex flex-col gap-1 border-t border-subtle p-2">
            <SidebarActionRow
              icon={<Plus size={12} strokeWidth={1.75} aria-hidden />}
              label="创建工作组"
              open={openForm === 'create'}
              onToggle={() => setOpenForm(openForm === 'create' ? null : 'create')}
            />
            {openForm === 'create' && (
              <div className="px-1.5 pb-1">
                <CreateForm />
              </div>
            )}
            <SidebarActionRow
              icon={<ExternalLink size={12} strokeWidth={1.75} aria-hidden />}
              label="凭邀请码加入"
              open={openForm === 'join'}
              onToggle={() => setOpenForm(openForm === 'join' ? null : 'join')}
            />
            {openForm === 'join' && (
              <div className="px-1.5 pb-1">
                <JoinForm />
              </div>
            )}
          </div>
        ) : (
          <p className="border-t border-subtle px-3 py-2.5 text-[11px] text-tertiary">
            连接建立后可创建或加入工作组
          </p>
        ))}
    </div>
  );
}

function MemberRow({
  member,
  isSelf,
  isLeader,
  runningCount,
  viewing,
}: {
  member: HubGroupMember;
  isSelf: boolean;
  isLeader: boolean;
  runningCount: number;
  /** S4 查看中态：该成员正被本机远程查看（Eye 图标 + violet 徽标取代 presence/负载） */
  viewing: boolean;
}) {
  if (viewing) {
    return (
      <div
        data-member={member.nodeId}
        className="flex items-center gap-2 rounded-[7px] bg-surface-active px-2.5 py-1 text-[12.5px] font-medium text-accent-600 dark:text-accent-300"
      >
        <Eye size={12} strokeWidth={1.75} className="shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{member.name}</span>
        <Badge tone="violet" className="h-auto shrink-0 px-1.5 py-0.5 text-[10px] leading-none">
          查看中
        </Badge>
      </div>
    );
  }
  return (
    <div data-member={member.nodeId} className="flex items-center gap-2 px-2.5 py-1 text-[12.5px] text-secondary">
      <span
        className={cn(
          'h-[7px] w-[7px] shrink-0 rounded-full',
          member.online ? 'bg-status-success' : 'bg-disabled',
        )}
        aria-label={member.online ? '在线' : '离线'}
        role="img"
      />
      <span className="min-w-0 flex-1 truncate">{member.name}</span>
      {runningCount > 0 ? (
        <Badge tone="violet" className="h-auto shrink-0 px-1.5 py-0.5 text-[10px] leading-none">
          在跑 {runningCount}
        </Badge>
      ) : isSelf || isLeader ? (
        <span className="shrink-0 text-[10px] text-tertiary">
          {isSelf ? '本机' : 'leader'}
          {isSelf && isLeader ? ' · leader' : ''}
        </span>
      ) : member.online ? (
        <Badge tone="success" className="h-auto shrink-0 px-1.5 py-0.5 text-[10px] leading-none">
          空闲
        </Badge>
      ) : null}
    </div>
  );
}

function SidebarActionRow({
  icon,
  label,
  open,
  onToggle,
}: {
  icon: React.ReactNode;
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="flex items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-[12.5px] text-secondary hover:bg-surface-3 hover:text-primary"
    >
      {icon}
      {label}
    </button>
  );
}

// ── 组操作表单（自 GroupPanel CreateForm/JoinForm 迁移；trim + 错误原文呈现语义不变）──

function CreateForm() {
  const create = useHubGroupStore((s) => s.create);
  const [groupName, setGroupName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (submitting || groupName.trim() === '') return;
    setSubmitting(true);
    setFormError(null);
    try {
      await create(groupName.trim());
      setGroupName('');
    } catch (err) {
      // store 动作 rethrow 原始 rejection（保留错误身份）——展示层剥 `[code]` 前缀
      setFormError(rpcErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={(e) => void onSubmit(e)}>
      <Input
        label="组名"
        className="w-full"
        value={groupName}
        onChange={(e) => setGroupName(e.target.value)}
        placeholder="家庭工作组"
      />
      <Button type="submit" size="sm" className="self-start" disabled={submitting || groupName.trim() === ''}>
        {submitting ? '创建中…' : '创建'}
      </Button>
      {formError !== null && (
        <p className="text-xs text-status-error" role="alert">
          {formError}
        </p>
      )}
    </form>
  );
}

function JoinForm() {
  const join = useHubGroupStore((s) => s.join);
  const [inviteCode, setInviteCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (submitting || inviteCode.trim() === '') return;
    setSubmitting(true);
    setFormError(null);
    try {
      await join(inviteCode.trim());
      setInviteCode('');
    } catch (err) {
      // 同上：store rethrow 原始 rejection，展示层剥 `[code]` 前缀
      setFormError(rpcErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={(e) => void onSubmit(e)}>
      <Input
        label="邀请码"
        className="w-full font-mono text-[12.5px]"
        value={inviteCode}
        onChange={(e) => setInviteCode(e.target.value)}
        placeholder="凭码加入已有工作组"
      />
      <Button type="submit" size="sm" className="self-start" disabled={submitting || inviteCode.trim() === ''}>
        {submitting ? '加入中…' : '入组'}
      </Button>
      {formError !== null && (
        <p className="text-xs text-status-error" role="alert">
          {formError}
        </p>
      )}
    </form>
  );
}
