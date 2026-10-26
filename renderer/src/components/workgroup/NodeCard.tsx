// renderer/src/components/workgroup/NodeCard.tsx
//
// 编队监控台节点卡（momo-hub M2.1 Task 3，视觉合同 .omo/previews/hub-ia-fullapp.html S3）：
// - 30px 圆角 icon 槽（surface-active 底 + accent 前景）+ 名称 13px/600 + leader/本机徽标
// - mono 行 node:前4…后4 + 已镜像空间名——镜像状态无按节点暴露的数据源
//   （hub-mirror-store 只管向导态、onWorkspaceMirrored 无 renderer 消费方），
//   空间名由该节点的委派任务史推导（任务能在该节点跑 = 空间已镜像过去），
//   T4/后续接 mirror 事件源时可替换
// - 「查看」是 T4 接口桩：禁用态 + title 提示，onOpenView 回调留给 T4 接线
// - 在跑行：running → violet spinner +「执行中」；pending → 警示图标 +「等待节点确认」
//   （「在跑」语义同侧栏负载计数：两态同计）；终态任务不进行
import { CircleHelp, Eye, Monitor } from 'lucide-react';
import type { HubGroupMember, HubTaskRecord } from '../../ipc/types';
import { cn } from '../../lib/cn';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';

interface NodeCardProps {
  node: HubGroupMember;
  isLeader: boolean;
  isSelf: boolean;
  /** 该节点的全部委派任务（已按 targetNodeId 过滤；在跑行/镜像推导均在此消费） */
  tasks: HubTaskRecord[];
  /** T4 接入：进入成员工作空间只读视图（本任务为禁用桩） */
  onOpenView: (nodeId: string, nodeName: string) => void;
}

function shortNodeId(nodeId: string): string {
  return nodeId.length > 8 ? `${nodeId.slice(0, 4)}…${nodeId.slice(-4)}` : nodeId;
}

export function NodeCard({ node, isLeader, isSelf, tasks, onOpenView }: NodeCardProps) {
  const runningTasks = tasks.filter((t) => t.status === 'running' || t.status === 'pending');
  const mirroredNames = [...new Set(tasks.map((t) => t.workspaceName))];
  const idle = runningTasks.length === 0;

  return (
    <div
      aria-label={`节点 ${node.name}`}
      className="flex flex-col gap-2 rounded-[10px] border border-subtle bg-surface-1 p-3"
    >
      <div className="flex items-center gap-2">
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-surface-active text-accent-600 dark:text-accent-300">
          <Monitor size={16} strokeWidth={1.75} aria-hidden />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5 text-[13px] font-semibold text-primary">
            <span className="truncate">{node.name}</span>
            {isLeader && (
              <Badge tone="accent" className="h-auto px-1.5 py-0.5 text-[10px] leading-none">
                leader
              </Badge>
            )}
            {isSelf && <Badge className="h-auto px-1.5 py-0.5 text-[10px] leading-none">本机</Badge>}
          </span>
          <span className="truncate font-mono text-[10.5px] text-tertiary">
            node:{shortNodeId(node.nodeId)}
            {mirroredNames.length > 0 && ` · 已镜像 ${mirroredNames.join(' · ')}`}
          </span>
        </div>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {idle &&
            (node.online ? (
              <Badge tone="success" className="h-auto px-1.5 py-0.5 text-[10px] leading-none">
                空闲
              </Badge>
            ) : (
              <Badge className="h-auto px-1.5 py-0.5 text-[10px] leading-none">离线</Badge>
            ))}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled
            title="T4 接入"
            onClick={() => onOpenView(node.nodeId, node.name)}
          >
            <Eye size={12} strokeWidth={1.75} aria-hidden />
            查看
          </Button>
        </span>
      </div>
      {runningTasks.map((t) => (
        <RunningRow key={t.taskId} task={t} />
      ))}
    </div>
  );
}

function RunningRow({ task }: { task: HubTaskRecord }) {
  const running = task.status === 'running';
  return (
    <div className="flex items-center gap-2 rounded-md bg-surface-2 px-[9px] py-1.5 text-xs">
      {running ? (
        <span
          role="img"
          aria-label="执行中"
          className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-status-violet border-t-transparent"
        />
      ) : (
        <CircleHelp size={12} strokeWidth={1.75} className="shrink-0 text-status-warning" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate text-secondary">{task.title}</span>
      <Badge
        tone={running ? 'violet' : 'warning'}
        className={cn('h-auto px-1.5 py-0.5 text-[10px] leading-none')}
      >
        {running ? '执行中' : '等待节点确认'}
      </Badge>
    </div>
  );
}
