// renderer/src/components/im/LastActivity.tsx
//
// D8（2026-10-31 dispatch 卡透明化）：子任务「活动 Ns 前」最后活动指示。
// 数据源 stream.store 的 StreamState.lastEventAt（实时事件批驱动）；本组件只负责
// 展示：1s 跳动重算 + 停滞告警（>STALL_WARN_MS 转 warning 色半粗 + 图标呼吸闪烁）。
// 消费方：DispatchChip 头行 / InFlightPanel 行内。终态渲染与否由消费方判定。
import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { cn } from '../../lib/cn';

/** 停滞告警阈值：超过该时长无实时事件即视为疑似挂死（测试引用断言） */
export const STALL_WARN_MS = 30_000;

/** 「活动 Ns 前」格式：<60s 显示秒；≥60s 显示 Nm（与 ElapsedTimer 同分/秒逻辑） */
function formatAgo(seconds: number): string {
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m` : `${seconds}s`;
}

export function LastActivity({ lastEventAt }: { lastEventAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - lastEventAt) / 1000));
  const stalled = now - lastEventAt > STALL_WARN_MS;
  return (
    <span
      data-testid="last-activity"
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-[11px]',
        stalled ? 'font-medium text-status-warning' : 'text-tertiary',
      )}
    >
      {/* keyframes 组件内注入（仓库惯例，同 AgentStreamBubble momo-stream-blink） */}
      <style>{`
@keyframes momo-activity-blink{0%,100%{opacity:1}50%{opacity:.35}}
.momo-activity-blink{animation:momo-activity-blink 1.6s ease-in-out infinite}
      `}</style>
      <Activity
        size={11}
        strokeWidth={1.75}
        aria-hidden
        className={stalled ? 'momo-activity-blink' : undefined}
      />
      活动 {formatAgo(seconds)} 前
    </span>
  );
}
