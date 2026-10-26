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
}

function RadioRow({ checked, title, hint, name, badge, onSelect, children }: RadioRowProps) {
  return (
    <div
      // 仅在未选中时整行可点（已选行内点成员下拉不重复触发选择）
      onClick={checked ? undefined : onSelect}
      className={cn(
        'flex cursor-pointer flex-col gap-1.5 rounded-[10px] border p-2.5 transition-colors',
        checked ? 'border-focus bg-surface-2' : 'border-subtle hover:border-focus',
      )}
    >
      <div className="flex items-start gap-2.5">
        <span className="relative mt-0.5 inline-flex h-4 w-4 shrink-0">
          <input
            type="radio"
            name={name}
            aria-label={title}
            checked={checked}
            onChange={onSelect}
            className="peer h-4 w-4 appearance-none rounded-full border border-strong bg-surface-2 checked:border-accent-500"
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
  const gated = precheck === null || precheck.mirrored === false || groups.length === 0;

  // 数据失配防御：value 引用的组已不在清单 → 展示回退本机
  const valueGroupKnown =
    value.mode === 'local' || groups.some((g) => g.groupId === value.groupId);
  const effectiveMode: TaskRouting['mode'] = valueGroupKnown ? value.mode : 'local';
  const currentGroup =
    groups.find((g) => g.groupId === (value.mode === 'local' ? undefined : value.groupId)) ??
    groups[0];

  const localHint = gated ? gateHint : batch ? '按本机并发上限排队' : '默认 · 你在场盯进度，人在环';
  const groupHint = currentGroup
    ? batch
      ? `预检：${currentGroup.onlineCount} 节点在线 · ${currentGroup.mirroredCount} 已镜像 · 依次派给空闲节点`
      : '按负载自动选择空闲节点'
    : '';
  const nodeHint = '高级 · 手动选组成员执行（忽略自动调度）';

  const firstMemberId = currentGroup?.members[0]?.nodeId ?? '';
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
        {!gated && currentGroup && (
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
                    currentGroup.members.some((m) => m.nodeId === selectedNodeId)
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
                    <option key={m.nodeId} value={m.nodeId}>
                      {m.online ? m.name : `${m.name}（离线）`}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </RadioRow>
        )}
      </div>
      {effectiveMode !== 'local' && (
        <div className="flex items-center gap-2.5 pl-1 pt-0.5">
          <span className="text-xs text-tertiary">权限策略</span>
          <Segmented
            aria-label="权限策略"
            options={TIER_OPTIONS}
            value={permissionTier}
            onChange={onPermissionTierChange}
          />
          <span className="text-xs text-tertiary">{TIER_HINTS[permissionTier]}</span>
        </div>
      )}
    </div>
  );
}
