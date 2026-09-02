// renderer/src/components/im/DispatchChip.tsx
//
// dispatch 委派 chip：紧凑头行展示子 agent 委派状态，点击展开 SubAgentSection。
// v2.1：状态走 dispatchStatusStyle（tone 同源 Badge）；图标全 lucide；
// 活动提示/计时器/展开箭头去字形。自动展开语义（userToggled）不变。
import { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Brain, ChevronDown, ChevronRight, CircleCheck, CircleSlash, CircleX, Clock, Loader2, PenLine, Send, Timer, Wrench } from 'lucide-react';
import type { StreamState } from '../../stores/stream.store';
import { Avatar } from '../ui/Avatar';
import { dispatchStatusStyle, type DispatchStatus } from '../../lib/task-status';
import { SubAgentSection } from './SubAgentSection';

export interface DispatchChild {
  subStreamSessionId: string;
  subAgentName: string;
  subAgentAvatar?: string;
  status: DispatchStatus;
}

interface DispatchChipProps {
  child: DispatchChild;
  subStream?: StreamState;
}

/** 状态图标：executing 用旋转 Loader（活动指示） */
const STATUS_ICON: Record<DispatchStatus, LucideIcon> = {
  queued: Clock,
  executing: Loader2,
  completed: CircleCheck,
  failed: CircleX,
  aborted: CircleSlash,
};

/** 各状态的自动展开默认值（用户未手动 toggle 前） */
const AUTO_EXPANDED: Record<DispatchStatus, boolean> = {
  executing: true,
  failed: true,
  completed: false,
  queued: false,
  aborted: false,
};

/** 活动提示：最后内容段 → 小图标 + 文案 */
function deriveActivity(subStream: StreamState | undefined): { icon: LucideIcon; text: string } | null {
  if (!subStream) return { icon: Clock, text: '已派出，等待启动…' };
  const last = subStream.segments[subStream.segments.length - 1];
  if (!last) return { icon: Clock, text: '已启动…' };
  switch (last.kind) {
    case 'thinking':
      return { icon: Brain, text: '思考中…' };
    case 'tool_call':
      return { icon: Wrench, text: last.result === null ? last.toolName : `${last.toolName}（完成）` };
    case 'text':
      return { icon: PenLine, text: '输出中…' };
    case 'dispatch':
      return null;
  }
}

/** 每秒跳动的耗时显示（executing 期间） */
function ElapsedTimer({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const text = seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
  return (
    <span className="inline-flex items-center gap-0.5 text-tertiary">
      <Timer size={11} strokeWidth={1.75} aria-hidden />
      {text}
    </span>
  );
}

export function DispatchChip({ child, subStream }: DispatchChipProps) {
  const status = dispatchStatusStyle(child.status);
  const StatusIcon = STATUS_ICON[child.status];
  const isBusy = child.status === 'executing' || child.status === 'queued';
  const activity = isBusy ? deriveActivity(subStream) : null;
  const timerSince = isBusy && subStream ? subStream.startedAt : null;

  const [expanded, setExpanded] = useState(() => AUTO_EXPANDED[child.status]);
  const [userToggled, setUserToggled] = useState(false);

  useEffect(() => {
    if (!userToggled) {
      setExpanded(AUTO_EXPANDED[child.status]);
    }
  }, [child.status, userToggled]);

  const handleToggle = () => {
    setUserToggled(true);
    setExpanded((prev) => !prev);
  };

  return (
    <div className="mb-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={handleToggle}
        className="flex w-full items-center gap-1.5 rounded border border-subtle bg-surface-2 px-2 py-1 text-left text-xs transition-colors hover:bg-surface-3"
      >
        <Send size={12} strokeWidth={1.75} aria-hidden className="shrink-0 text-accent-500" />
        {child.subAgentAvatar ? (
          <span aria-hidden className="shrink-0">{child.subAgentAvatar}</span>
        ) : (
          <Avatar name={child.subAgentName} bot size="sm" />
        )}
        <span className="shrink-0 text-primary">{child.subAgentName}</span>
        <span className={status.className}>
          <StatusIcon size={11} strokeWidth={1.75} aria-hidden className={child.status === 'executing' ? 'animate-spin' : undefined} />
          {status.label}
        </span>
        {activity && (
          <span className="inline-flex items-center gap-0.5 text-[11px] text-tertiary" data-testid="dispatch-activity">
            <activity.icon size={11} strokeWidth={1.75} aria-hidden />
            {activity.text}
          </span>
        )}
        {timerSince !== null && <ElapsedTimer since={timerSince} />}
        <span className="ml-auto shrink-0 text-tertiary" aria-hidden>
          {expanded ? <ChevronDown size={12} strokeWidth={1.75} /> : <ChevronRight size={12} strokeWidth={1.75} />}
        </span>
      </button>

      {expanded && subStream && <SubAgentSection stream={subStream} />}
    </div>
  );
}
