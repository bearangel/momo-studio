// renderer/src/components/workgroup/RunRoutingField.tsx
//
// 「执行位置」三选 radio 卡行（M2.1 T8，视觉合同 S2——.omo/previews/hub-ia-fullapp.html）：
//   本机执行（默认） / 组内调度（badge 组名） / 指定节点（高级 + 成员下拉）
// 守门（Review Focus #1）：预检未镜像 / hub 不可达 / 加载中 → 仅「本机」+ 对应 hint，
// 无灰选项无报错。组内调度不预演具体节点名（简化裁定：「自动选择空闲节点」，
// 真实调度在 dispatch-submit IPC 内 pickWorker 单点执行，renderer 不重复调度逻辑）。
// 数据失配防御：value 引用的组已不在预检清单 → 展示回退本机，不崩溃（提交侧另有校验）。
//
// M2.1 T10：外派模式（group/node）下追加「权限策略」档位三选 chip（默认 confirm）——
// 只读 / 沙箱全权 / 执行端确认；本机模式与守门降级退场（权限档位只随委派载荷有意义）。
//
// 1.10.0 平行模式（spec 2026-11-05 §5.1）：所选组 mode='peer' 时渲染草稿形态——
// 仅「本机执行 / 指定节点」两选项（平行组无 least-busy 组内调度）；成员下拉标注
// 绑定态（已绑定✓空间名 / 未绑定✗ disabled——peer 委派要求目标已绑定）；权限
// 档位区退场（平行草稿无档位，执行档位由接收方本地决定）。
import { useId } from 'react';
import { cn } from '../../lib/cn';
import { Badge } from '../ui/Badge';
import { Select } from '../ui/Select';
import { Segmented } from '../ui/Segmented';
import type { PermissionTier, RoutingPrecheckResult, TaskRouting } from '../../ipc/types';

interface RunRoutingFieldProps {
  /** 预检概要（hub:routingPrecheck）；null=加载中（仅本机 + 检查中 hint） */
  precheck: RoutingPrecheckResult | null;
  value: TaskRouting;
  onChange: (routing: TaskRouting) => void;
  /** 批量模式任务数（>1 时 label「执行位置（N 个任务统一定）」+ 预检行文案） */
  taskCount?: number;
  /** 权限档位（T10）：外派模式下渲染三选 chip，提交链随委派载荷 */
  permissionTier: PermissionTier;
  onPermissionTierChange: (tier: PermissionTier) => void;
}

interface RadioRowProps {
  checked: boolean;
  title: string;
  hint: string;
  name: string;
  badge?: string;
  onSelect: () => void;
  children?: React.ReactNode;
  /** 平行模式建组卡等复用场景：整行禁用（title 提示禁用原因） */
  disabled?: boolean;
  disabledTitle?: string;
}

export function RadioRow({
  checked,
  title,
  hint,
  name,
  badge,
  onSelect,
  children,
  disabled = false,
  disabledTitle,
}: RadioRowProps) {
  return (
    <div
      // 仅在未选中时整行可点（已选行内点成员下拉不重复触发选择）；禁用行不可点
      onClick={checked || disabled ? undefined : onSelect}
      title={disabled && disabledTitle !== undefined ? disabledTitle : undefined}
      className={cn(
        'flex flex-col gap-1.5 rounded-[10px] border p-2.5 transition-colors',
        checked ? 'border-focus bg-surface-2' : 'border-subtle hover:border-focus',
        disabled && 'cursor-not-allowed opacity-50 hover:border-subtle',
        !disabled && !checked && 'cursor-pointer',
      )}
    >
      <div className="flex items-start gap-2.5">
        <span className="relative mt-0.5 inline-flex h-4 w-4 shrink-0">
          <input
            type="radio"
            name={name}
            aria-label={title}
            checked={checked}
            disabled={disabled}
            onChange={onSelect}
            className="peer h-4 w-4 appearance-none rounded-full border border-strong bg-surface-2 checked:border-accent-500 disabled:cursor-not-allowed"
          />
          <span className="pointer-events-none absolute inset-0 m-auto h-2 w-2 rounded-full bg-accent-500 opacity-0 peer-checked:opacity-100" />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-primary">
            {title}
            {badge !== undefined && (
              <Badge tone="accent" className="h-auto px-1.5 py-0.5 text-[10px] leading-none">
                {badge}
              </Badge>
            )}
          </span>
          <span className="text-xs text-tertiary">{hint}</span>
        </span>
      </div>
      {children}
    </div>
  );
}

/** T10 档位说明文案（S2「权限策略：只读+白名单」hint 语境；与主进程 run-policy 语义对齐） */
const TIER_HINTS: Record<PermissionTier, string> = {
  // readonly 边界注记（T10b 评审 Minor）：零授权只作用于本次委派会话，工作空间级既有授权不受影响
  readonly: '仅可读操作 · 任务书前置只读约束，违反将被拒绝 · 会话级零授权（工作空间级既有授权不受影响）',
  sandbox: '预授予镜像工作空间目录写授权 · 目录内自由写入',
  confirm: '越界写入需执行端用户确认（默认）',
};

const TIER_OPTIONS: Array<{ value: PermissionTier; label: string }> = [
  { value: 'readonly', label: '只读' },
  { value: 'sandbox', label: '沙箱全权' },
  { value: 'confirm', label: '执行端确认' },
];

export function RunRoutingField({
  precheck,
  value,
  onChange,
  taskCount,
  permissionTier,
  onPermissionTierChange,
}: RunRoutingFieldProps) {
  const nameBase = useId();
  const batch = (taskCount ?? 1) > 1;
  const groups = precheck?.groups ?? [];

  // 守门三态：加载中 / 未镜像 / 组清单空（hub 不可达或未入组）→ 仅本机
  const gateHint =
    precheck === null
      ? '正在检查镜像状态…'
      : precheck.mirrored
        ? '工作组不可达（hub 离线？），当前仅可本机执行'
        : '未镜像到任何工作组——先在监控台镜像工作空间后可外派';
  // 1.10.0 修正：镜像前置仅约束 lf 委派（worker 按名解析镜像副本）；平行组
  // 草稿落接收方绑定空间、与镜像无关——存在 peer 组（或当前值即 peer 节点）
  // 时不再整体降级仅本机（否则未镜像环境永远选不了节点，spec §2 裁定 4）
  const peerReachable =
    groups.some((g) => g.mode === 'peer') ||
    (value.mode !== 'local' && groups.find((g) => g.groupId === value.groupId)?.mode === 'peer');
  const gated =
    precheck === null ||
    groups.length === 0 ||
    (precheck.mirrored === false && !peerReachable);

  // 数据失配防御：value 引用的组已不在清单 → 展示回退本机；peer 组无组内调度
  // （value 残留 group 变体时同样回退本机展示——提交侧另有校验）
  const valueGroupKnown =
    value.mode === 'local' || groups.some((g) => g.groupId === value.groupId);
  const currentGroup =
    groups.find((g) => g.groupId === (value.mode === 'local' ? undefined : value.groupId)) ??
    groups[0];
  // 1.10.0：平行组草稿形态（无组内调度行/权限档位；成员下拉标绑定态）
  const peerForm = currentGroup?.mode === 'peer';
  const effectiveMode: TaskRouting['mode'] =
    valueGroupKnown && !(peerForm && value.mode === 'group') ? value.mode : 'local';

  const localHint = gated ? gateHint : batch ? '按本机并发上限排队' : '默认 · 你在场盯进度，人在环';
  const groupHint = currentGroup
    ? batch
      ? `预检：${currentGroup.onlineCount} 节点在线 · ${currentGroup.mirroredCount} 已镜像 · 依次派给空闲节点`
      : '按负载自动选择空闲节点'
    : '';
  const nodeHint = peerForm ? '选择承接成员 · 草稿由对方自行安排执行' : '高级 · 手动选组成员执行（忽略自动调度）';

  // peer 形态下合法目标 = 已绑定成员（hub 委派闸：未绑定 → forbidden）
  const firstMemberId = peerForm
    ? currentGroup?.members.find((m) => m.bound)?.nodeId ?? ''
    : currentGroup?.members[0]?.nodeId ?? '';
  // TS 收窄辅助：目标成员 select 的受控值（node 模式外不访问 targetNodeId）
  const selectedNodeId = value.mode === 'node' ? value.targetNodeId : '';

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-sm text-secondary">
        {batch ? `执行位置（${taskCount} 个任务统一定）` : '执行位置'}
      </div>
      <div role="radiogroup" aria-label="执行位置" className="flex flex-col gap-1.5">
        <RadioRow
          name={nameBase}
          checked={effectiveMode === 'local'}
          title="本机执行"
          hint={localHint}
          onSelect={() => onChange({ mode: 'local' })}
        />
        {!gated && currentGroup && !peerForm && (
          <RadioRow
            name={nameBase}
            checked={effectiveMode === 'group'}
            title="组内调度"
            hint={groupHint}
            badge={groups.length === 1 ? currentGroup.groupName : undefined}
            onSelect={() => onChange({ mode: 'group', groupId: currentGroup.groupId })}
          >
            {effectiveMode === 'group' && groups.length > 1 && (
              <Select
                label="工作组"
                value={currentGroup.groupId}
                onChange={(e) => onChange({ mode: 'group', groupId: e.target.value })}
              >
                {groups.map((g) => (
                  <option key={g.groupId} value={g.groupId}>
                    {g.groupName}
                  </option>
                ))}
              </Select>
            )}
          </RadioRow>
        )}
        {!gated && currentGroup && (
          <RadioRow
            name={nameBase}
            checked={effectiveMode === 'node'}
            title="指定节点"
            hint={nodeHint}
            onSelect={() =>
              onChange({
                mode: 'node',
                groupId: currentGroup.groupId,
                targetNodeId: firstMemberId,
              })
            }
          >
            {effectiveMode === 'node' && (
              <div className="flex flex-col gap-2 pl-6">
                {groups.length > 1 && (
                  <Select
                    label="工作组"
                    value={currentGroup.groupId}
                    onChange={(e) =>
                      onChange({
                        mode: 'node',
                        groupId: e.target.value,
                        targetNodeId:
                          groups.find((g) => g.groupId === e.target.value)?.members.find(
                            (m) => m.bound,
                          )?.nodeId ??
                          groups.find((g) => g.groupId === e.target.value)?.members[0]?.nodeId ??
                          '',
                      })
                    }
                  >
                    {groups.map((g) => (
                      <option key={g.groupId} value={g.groupId}>
                        {g.groupName}
                      </option>
                    ))}
                  </Select>
                )}
                <Select
                  label="目标成员"
                  value={
                    currentGroup.members.some((m) => m.nodeId === selectedNodeId && (!peerForm || m.bound))
                      ? selectedNodeId
                      : firstMemberId
                  }
                  onChange={(e) =>
                    onChange({
                      mode: 'node',
                      groupId: currentGroup.groupId,
                      targetNodeId: e.target.value,
                    })
                  }
                >
                  {currentGroup.members.map((m) => (
                    <option key={m.nodeId} value={m.nodeId} disabled={peerForm && !m.bound}>
                      {peerForm
                        ? m.bound
                          ? `${m.name}（已绑定 · ${m.boundWorkspaceName ?? '未知空间'}）`
                          : `${m.name}（未绑定，不可选）`
                        : m.online
                          ? m.name
                          : `${m.name}（离线）`}
                    </option>
                  ))}
                </Select>
                {peerForm && firstMemberId === '' && (
                  <p className="text-xs leading-relaxed text-status-warning">
                    组内暂无已绑定承接空间的成员——对方需在组设置中绑定后才可接收草稿
                  </p>
                )}
              </div>
            )}
          </RadioRow>
        )}
      </div>
      {effectiveMode !== 'local' && !peerForm && (
        <div className="flex flex-col gap-1 pl-1 pt-0.5">
          <div className="flex items-center gap-2.5">
            <span className="shrink-0 text-xs text-tertiary">权限策略</span>
            <Segmented
              aria-label="权限策略"
              options={TIER_OPTIONS}
              value={permissionTier}
              onChange={onPermissionTierChange}
            />
          </div>
          <span className="text-xs leading-relaxed text-tertiary">{TIER_HINTS[permissionTier]}</span>
        </div>
      )}
    </div>
  );
}
