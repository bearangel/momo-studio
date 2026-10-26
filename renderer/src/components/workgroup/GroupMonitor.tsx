// renderer/src/components/workgroup/GroupMonitor.tsx
//
// 编队监控台主区（momo-hub M2.1 Task 3，视觉合同 S3 屏 + Task 4 查看入口接线）：
// - 组头：组名 16px + 邀请码 Badge + CopyButton（本机最近生成的码——hub-group-store
//   inviteCodes；无码时「生成邀请码」入口，与 GroupPanel 迁移语义一致：不设 leader 门槛）
// - 「镜像工作空间…」仅 leader 可见（GroupPanel 同语义），点击挂既有 MirrorWizard 原样
// - 节点卡：选中组全部成员（本机节点也在场）；在跑行按 targetNodeId 过滤；
//   「查看」门控 = 组长 × 在线 × 非本机（M2 GroupPanel 迁移语义——hub view.*
//   leader-only 的 UI 前置门控），通过 NodeCard canView 下传；回调 onOpenView
//   由 WorkgroupView 接 S3b 选择器（hub-view.store openPanel）
// - 底部 callout：监控台无创建任务入口——引导回看板（执行位置「组内调度」自动派发）
// - 组选择与侧栏共用 effectiveSelectedGroup 推导（手选组在场 → 手选；否则第一组）
// - 无组空态：引导去侧栏创建/加入（表单在 WorkgroupSidebar）
import { useState } from 'react';
import { HardDriveDownload, Kanban, Users } from 'lucide-react';
import { effectiveSelectedGroup, useHubGroupStore } from '../../stores/hub-group.store';
import { useHubDelegationStore } from '../../stores/hub-delegation.store';
import { useHubMirrorStore } from '../../stores/hub-mirror.store';
import { useHubStore } from '../../stores/hub.store';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { CopyButton } from '../ui/CopyButton';
import { EmptyState } from '../ui/EmptyState';
import { MirrorWizard } from '../hub/MirrorWizard';
import { NodeCard } from './NodeCard';

interface GroupMonitorProps {
  /** T4 接线：进入成员工作空间只读视图（WorkgroupView → S3b 选择器） */
  onOpenView: (nodeId: string, nodeName: string) => void;
}

export function GroupMonitor({ onOpenView }: GroupMonitorProps) {
  const groups = useHubGroupStore((s) => s.groups);
  const selectedGroupId = useHubGroupStore((s) => s.selectedGroupId);
  const inviteCodes = useHubGroupStore((s) => s.inviteCodes);
  const invite = useHubGroupStore((s) => s.invite);
  const openMirrorWizard = useHubMirrorStore((s) => s.openWizard);
  const tasks = useHubDelegationStore((s) => s.tasks);
  const selfNodeId = useHubStore((s) => s.status?.nodeId ?? null);
  const [inviteBusy, setInviteBusy] = useState(false);

  const group = effectiveSelectedGroup(groups, selectedGroupId);

  if (group === null) {
    return (
      <div className="flex flex-1 items-center justify-center bg-canvas">
        <EmptyState
          icon={Users}
          title="尚未加入任何工作组"
          description="在左侧创建工作组，或凭邀请码加入"
          role="status"
        />
      </div>
    );
  }

  const isLeader = selfNodeId === group.leaderNodeId;
  const code = inviteCodes[group.groupId];

  const onInvite = async (): Promise<void> => {
    if (inviteBusy) return;
    setInviteBusy(true);
    try {
      await invite(group.groupId);
    } catch {
      // 生成失败（离线竞态等）人话已落 store.error——侧栏顶部错误行呈现
    } finally {
      setInviteBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-canvas">
      <div className="flex items-center gap-2.5 border-b border-subtle px-4 py-3">
        <h2 className="text-base font-medium text-primary">{group.groupName}</h2>
        {code !== undefined ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <Badge className="font-mono">邀请码 {code}</Badge>
            <CopyButton text={code} label="复制邀请码" />
          </span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={inviteBusy}
            onClick={() => void onInvite()}
          >
            {inviteBusy ? '生成中…' : '生成邀请码'}
          </Button>
        )}
        {isLeader && (
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto"
            onClick={() => openMirrorWizard(group.groupId, group.groupName)}
          >
            <HardDriveDownload size={14} strokeWidth={1.75} aria-hidden />
            镜像工作空间…
          </Button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3.5">
        {group.members.map((m) => (
          <NodeCard
            key={m.nodeId}
            node={m}
            tasks={tasks.filter((t) => t.targetNodeId === m.nodeId)}
            isLeader={m.nodeId === group.leaderNodeId}
            isSelf={m.nodeId === selfNodeId}
            canView={isLeader && m.nodeId !== selfNodeId && m.online}
            onOpenView={onOpenView}
          />
        ))}
        <div className="flex items-start gap-2 rounded-lg bg-surface-2 px-2.5 py-2 text-[11.5px] leading-relaxed text-secondary">
          <Kanban
            size={14}
            strokeWidth={1.75}
            className="mt-0.5 shrink-0 text-accent-600 dark:text-accent-300"
            aria-hidden
          />
          <span>
            编队监控台：任务统一在<b>看板</b>创建（执行位置选「组内调度」即自动派发）；「查看」进入成员工作空间只读视图。
          </span>
        </div>
      </div>
      <MirrorWizard />
    </div>
  );
}
