// renderer/src/components/workgroup/GroupMonitor.tsx
//
// 编队监控台主区（momo-hub M2.1 Task 3，视觉合同 S3 屏 + Task 4 查看入口接线
// + Task 5 组操作菜单收口 RM-M21-8）：
// - 组头：组名 16px + 邀请码 Badge + CopyButton（本机最近生成的码——hub-group-store
//   inviteCodes；无码时「生成邀请码」入口，与 GroupPanel 迁移语义一致：不设 leader 门槛）
// - 「镜像工作空间…」仅 leader 可见（GroupPanel 同语义），点击挂既有 MirrorWizard 原样
// - 组操作菜单（MoreHorizontal 下拉，自 settings/GroupPanel 收口迁移——删面板前逐
//   操作面核对归宿，缺失三项补齐）：重新生成邀请码〔仅 leader〕/ 转移组长〔仅 leader，
//   展开可选成员子列表〕/ 退出工作组〔菜单内两步确认——「再次点击确认」3s 回落范式〕
// - 节点卡：选中组全部成员（本机节点也在场）；在跑行按 targetNodeId 过滤；
//   「查看」门控 = 组长 × 在线 × 非本机（M2 GroupPanel 迁移语义——hub view.*
//   leader-only 的 UI 前置门控），通过 NodeCard canView 下传；回调 onOpenView
//   由 WorkgroupView 接 S3b 选择器（hub-view.store openPanel）
// - 底部 callout：监控台无创建任务入口——引导回看板（执行位置「组内调度」自动派发）
// - 组选择与侧栏共用 effectiveSelectedGroup 推导（手选组在场 → 手选；否则第一组）
// - 无组空态：引导去侧栏创建/加入（表单在 WorkgroupSidebar）
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HardDriveDownload, Kanban, MoreHorizontal, Users } from 'lucide-react';
import { effectiveSelectedGroup, useHubGroupStore } from '../../stores/hub-group.store';
import { useHubDelegationStore } from '../../stores/hub-delegation.store';
import { useHubMirrorStore } from '../../stores/hub-mirror.store';
import { useHubStore } from '../../stores/hub.store';
import type { HubGroupInfo } from '../../ipc/types';
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
        <GroupActionsMenu
          group={group}
          isLeader={isLeader}
          selfNodeId={selfNodeId}
          className={isLeader ? undefined : 'ml-auto'}
        />
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

interface GroupActionsMenuProps {
  group: HubGroupInfo;
  isLeader: boolean;
  selfNodeId: string | null;
  /** 非 leader 时镜像按钮缺席，菜单自身右对齐补位 */
  className?: string;
}

/** 组操作菜单（MoreHorizontal 下拉；portal 到 body 防主区 overflow 裁切，GroupMenu 同纪律） */
function GroupActionsMenu({ group, isLeader, selfNodeId, className }: GroupActionsMenuProps) {
  const invite = useHubGroupStore((s) => s.invite);
  const transfer = useHubGroupStore((s) => s.transfer);
  const leave = useHubGroupStore((s) => s.leave);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pickingTransfer, setPickingTransfer] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  // 打开时按触发按钮右下角定位（右对齐弹出）；jsdom 无布局回退原点（测试不断言坐标）
  useEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setPos({ left: rect.right, top: rect.bottom + 4 });
  }, [open]);

  // 退组臂确认 3s 自动回落（GroupPanel/ProviderModelPicker 同款防 armed 滞留）
  useEffect(() => {
    if (!confirmingLeave) return;
    const timer = setTimeout(() => setConfirmingLeave(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmingLeave]);

  const close = (): void => {
    setOpen(false);
    setPickingTransfer(false);
    setConfirmingLeave(false);
  };

  const run = (action: () => Promise<unknown>): void => {
    if (busy) return;
    setBusy(true);
    void action()
      .catch(() => {
        // 人话错误已落 hub-group-store.error——侧栏错误行呈现（GroupPanel 同语义）
      })
      .finally(() => {
        setBusy(false);
        close();
      });
  };

  const transferCandidates = group.members.filter(
    (m) => m.nodeId !== selfNodeId && m.nodeId !== group.leaderNodeId,
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`组操作菜单 ${group.groupName}`}
        aria-expanded={open}
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-tertiary hover:bg-surface-3 hover:text-primary ${className ?? ''}`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden />
      </button>
      {open &&
        createPortal(
          <>
            <div aria-hidden className="fixed inset-0 z-40" onClick={close} />
            <div
              style={{ left: pos.left, top: pos.top }}
              className="fixed z-50 w-44 -translate-x-full rounded-md border border-subtle bg-canvas py-1 text-xs shadow-lg"
            >
              {isLeader && (
                <>
                  <MenuItem
                    label="重新生成邀请码"
                    disabled={busy}
                    onClick={() => run(() => invite(group.groupId))}
                  />
                  <MenuItem
                    label="转移组长"
                    disabled={busy}
                    onClick={() => setPickingTransfer((v) => !v)}
                  />
                  {pickingTransfer && (
                    <div className="border-t border-subtle py-1">
                      {transferCandidates.map((m) => (
                        <MenuItem
                          key={m.nodeId}
                          label={`转移给 ${m.name}`}
                          disabled={busy}
                          onClick={() => run(() => transfer(group.groupId, m.nodeId))}
                        />
                      ))}
                      {transferCandidates.length === 0 && (
                        <p className="px-3 py-1.5 text-tertiary">暂无可转移的成员</p>
                      )}
                    </div>
                  )}
                  <div className="my-1 border-t border-subtle" />
                </>
              )}
              {confirmingLeave ? (
                <MenuItem
                  label="再次点击确认退出"
                  danger
                  disabled={busy}
                  onClick={() => run(() => leave(group.groupId))}
                />
              ) : (
                <MenuItem label="退出工作组" danger disabled={busy} onClick={() => setConfirmingLeave(true)} />
              )}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

function MenuItem({
  label,
  onClick,
  disabled,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`block w-full px-3 py-1.5 text-left transition-colors hover:bg-surface-2 disabled:opacity-50 ${
        danger ? 'text-status-error' : 'text-secondary'
      }`}
    >
      {label}
    </button>
  );
}
