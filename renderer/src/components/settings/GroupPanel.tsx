// renderer/src/components/settings/GroupPanel.tsx
//
// 工作组管理面板（momo-hub M2b T4，spec §5.1）——嵌在 HubSettingsPanel「节点互联」
// 已接入视图下方区段。RM2-3 豁免：复用既有表单（Input/Button）与列表（在线节点
// 同款 ul/li + 绿灰点）模式，无新布局形态。
// - 无组：创建组表单 + 凭码入组表单
// - 有组：组卡（组名 + 成员列表〔在线点/组长 Badge/本机 Badge〕）+ 组操作行
//   （生成邀请码〔展示+复制〕/ 转移组长 / 退组〔两步确认——「断开并忘记」范式〕）
// - 成员行的「设为组长」即转移入口（leader-only 由 hub 层强制，非 leader 点击后
//   错误文案原样呈现）
// - group.changed 推送 → store 重拉（事件驱动列表刷新）
import { useEffect, useState, type FormEvent } from 'react';
import { Eye, HardDriveDownload, Send, Users } from 'lucide-react';
import { useHubStore } from '../../stores/hub.store';
import { useHubGroupStore } from '../../stores/hub-group.store';
import { useHubMirrorStore } from '../../stores/hub-mirror.store';
import { useHubDelegationStore } from '../../stores/hub-delegation.store';
import { useHubViewStore } from '../../stores/hub-view.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { CopyButton } from '../ui/CopyButton';
import { Input } from '../ui/Input';
import { MirrorWizard } from '../hub/MirrorWizard';
import { DelegationPanel } from '../hub/DelegationPanel';
import { DelegationWizard } from '../hub/DelegationWizard';
import { ViewPanel } from '../hub/ViewPanel';

export function GroupPanel() {
  const online = useHubStore((s) => s.status?.state === 'online');
  const groups = useHubGroupStore((s) => s.groups);
  const loading = useHubGroupStore((s) => s.loading);
  const error = useHubGroupStore((s) => s.error);
  const init = useHubGroupStore((s) => s.init);
  const load = useHubGroupStore((s) => s.load);

  // 离线不订阅不拉取（组操作面仅在线可用）；online 翻转重挂订阅（重连后自恢复）
  useEffect(() => {
    if (!online) return;
    return init();
  }, [online, init]);

  if (!online) {
    return (
      <section className="flex flex-col gap-2 border-t border-subtle pt-6" aria-label="工作组">
        <h3 className="flex items-center gap-2 text-sm font-medium text-primary">
          <Users size={16} strokeWidth={1.75} aria-hidden />
          工作组
        </h3>
        <p className="text-xs text-tertiary">连接建立后可创建或加入工作组</p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4 border-t border-subtle pt-6" aria-label="工作组">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium text-primary">
          <Users size={16} strokeWidth={1.75} aria-hidden />
          工作组
        </h3>
        <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>
          刷新
        </Button>
      </div>

      {error !== null && (
        <p className="text-xs text-status-error" role="alert">
          {error}
        </p>
      )}

      {groups.length === 0 ? (
        <NoGroupsForms />
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <GroupCard key={g.groupId} group={g} />
          ))}
          <JoinForm compact />
        </div>
      )}
      <MirrorWizard />
      <DelegationWizard />
      <ViewPanel />
      <div className="border-t border-subtle pt-4">
        <DelegationPanel />
      </div>
    </section>
  );
}

function NoGroupsForms() {
  return (
    <div className="flex flex-col gap-4">
      <CreateForm />
      <JoinForm />
    </div>
  );
}

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
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="flex max-w-[460px] flex-col gap-3" onSubmit={(e) => void onSubmit(e)}>
      <Input
        label="组名"
        className="w-full"
        value={groupName}
        onChange={(e) => setGroupName(e.target.value)}
        placeholder="家庭工作组"
      />
      <div>
        <Button type="submit" size="sm" disabled={submitting || groupName.trim() === ''}>
          {submitting ? '创建中…' : '创建工作组'}
        </Button>
      </div>
      {formError !== null && (
        <p className="text-xs text-status-error" role="alert">
          {formError}
        </p>
      )}
    </form>
  );
}

function JoinForm({ compact = false }: { compact?: boolean }) {
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
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className={compact ? 'flex max-w-[460px] flex-col gap-3' : 'flex max-w-[460px] flex-col gap-3 border-t border-subtle pt-4'} onSubmit={(e) => void onSubmit(e)}>
      <Input
        label="邀请码"
        className="w-full font-mono text-[12.5px]"
        value={inviteCode}
        onChange={(e) => setInviteCode(e.target.value)}
        placeholder="凭码加入已有工作组"
      />
      <div>
        <Button type="submit" size="sm" variant="secondary" disabled={submitting || inviteCode.trim() === ''}>
          {submitting ? '加入中…' : '凭码入组'}
        </Button>
      </div>
      {formError !== null && (
        <p className="text-xs text-status-error" role="alert">
          {formError}
        </p>
      )}
    </form>
  );
}

interface GroupCardProps {
  group: {
    groupId: string;
    groupName: string;
    leaderNodeId: string;
    members: Array<{ nodeId: string; name: string; online: boolean }>;
  };
}

function GroupCard({ group }: GroupCardProps) {
  const selfNodeId = useHubStore((s) => s.status?.nodeId ?? null);
  const inviteCodes = useHubGroupStore((s) => s.inviteCodes);
  const invite = useHubGroupStore((s) => s.invite);
  const transfer = useHubGroupStore((s) => s.transfer);
  const leave = useHubGroupStore((s) => s.leave);
  const openMirrorWizard = useHubMirrorStore((s) => s.openWizard);
  const openDelegationWizard = useHubDelegationStore((s) => s.openWizard);
  const openViewPanel = useHubViewStore((s) => s.openPanel);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const [busy, setBusy] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const isLeader = selfNodeId === group.leaderNodeId;

  useEffect(() => {
    if (!confirmingLeave) return;
    const timer = setTimeout(() => setConfirmingLeave(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmingLeave]);

  /** 「查看工作空间」入口：仅 leader + 在线成员 + 非本机（本机空间直接打开，离线无入口） */
  const onViewWorkspace = (m: { nodeId: string; name: string }): void => {
    openViewPanel({ targetNodeId: m.nodeId, targetName: m.name, workspaces: workspaces.map((w) => ({ id: w.id, name: w.name })) });
  };

  const code = inviteCodes[group.groupId];

  const onInvite = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await invite(group.groupId);
    } catch {
      // store.error 已呈现（生成失败罕见——多为离线竞态）
    } finally {
      setBusy(false);
    }
  };

  const onTransfer = async (toNodeId: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await transfer(group.groupId, toNodeId);
    } catch {
      // hub 侧 forbidden 人话已落 store.error
    } finally {
      setBusy(false);
    }
  };

  const onLeave = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await leave(group.groupId);
    } catch {
      setConfirmingLeave(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-subtle bg-surface-1 p-3" aria-label={`工作组 ${group.groupName}`}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-primary">{group.groupName}</span>
        <span className="text-xs text-tertiary">{group.members.length} 名成员</span>
      </div>
      <ul className="divide-y divide-subtle rounded-lg border border-subtle bg-surface-1">
        {group.members.map((m) => (
          <li key={m.nodeId} className="flex min-h-9 items-center gap-2.5 px-3 py-2 text-[13px] text-primary">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${m.online ? 'bg-status-success' : 'bg-disabled'}`}
              aria-hidden
            />
            {m.name}
            {m.nodeId === group.leaderNodeId && <Badge tone="accent">组长</Badge>}
            {m.nodeId === selfNodeId && <Badge>本机</Badge>}
            {isLeader && m.nodeId !== selfNodeId && m.online && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-6 px-2 text-xs"
                onClick={() => onViewWorkspace(m)}
              >
                <Eye size={12} strokeWidth={1.75} aria-hidden />
                查看工作空间
              </Button>
            )}
            {m.nodeId !== group.leaderNodeId && m.nodeId !== selfNodeId && (
              <Button
                variant="ghost"
                size="sm"
                className={`${isLeader ? '' : 'ml-auto'} h-6 px-2 text-xs`}
                disabled={busy}
                onClick={() => void onTransfer(m.nodeId)}
              >
                设为组长
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {isLeader && (
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => openMirrorWizard(group.groupId, group.groupName)}
            >
              <HardDriveDownload size={14} strokeWidth={1.75} aria-hidden />
              镜像工作空间…
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => openDelegationWizard(group.groupId, group.groupName)}
            >
              <Send size={14} strokeWidth={1.75} aria-hidden />
              委派任务…
            </Button>
          </>
        )}
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onInvite()}>
          {busy ? '生成中…' : code ? '重新生成邀请码' : '生成邀请码'}
        </Button>
        {code !== undefined && (
          <span className="flex items-center gap-1.5 font-mono text-[12.5px] text-secondary">
            <span className="max-w-[220px] truncate">{code}</span>
            <CopyButton text={code} />
          </span>
        )}
        <span className="ml-auto">
          {confirmingLeave ? (
            <Button variant="danger" size="sm" disabled={busy} onClick={() => void onLeave()}>
              {busy ? '退组中…' : '再次点击确认退组'}
            </Button>
          ) : (
            <Button variant="danger-outline" size="sm" disabled={busy} onClick={() => setConfirmingLeave(true)}>
              退组
            </Button>
          )}
        </span>
      </div>
    </div>
  );
}
