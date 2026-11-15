// renderer/src/components/im/SteeredMilestoneCard.tsx
//
// 已下发指令里程碑卡（P3 S3，CONTRACT #17）：delegation_milestone 行 meta
// kind='steered' 专属渲染——发起方蓝调（accent 实心点 + steered 徽标 + 左 3px
// accent-500 引线摘要块），区别 task.* 的 success / intervention.* 的 warning。
// 双端同形：发起方跟踪会话（writeOriginSteerMilestone 本地写）与 worker 执行
// 会话（S1 injectSteerIntoExecutionSession）meta.message 同构（≤80 字摘要，
// 渲染面单源）。结构化解析失败 / 非 steered kind 不进本卡（回落 SystemEventCard）。
import { formatHHmm } from '../../lib/time';
import type { ImMessage } from '../../ipc/types';

/**
 * delegation_milestone 行 → steered 摘要（meta.message ≤80 字）；kind='steered'
 * 但 message 缺席/畸形降级 body 80 字切片；非 steered（remote_intervention /
 * remote_submitted / accepted / rejected …）返回 null（SystemEventCard 兜底）。
 */
export function parseSteeredSummary(message: ImMessage): string | null {
  if (message.eventType !== 'delegation_milestone' || message.contextJson === null) return null;
  try {
    const parsed: unknown = JSON.parse(message.contextJson);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const meta = parsed as { kind?: unknown; message?: unknown };
    if (meta.kind !== 'steered') return null;
    return typeof meta.message === 'string' && meta.message !== ''
      ? meta.message
      : message.body.slice(0, 80);
  } catch {
    return null;
  }
}

export function SteeredMilestoneCard({ message }: { message: ImMessage }) {
  const summary = parseSteeredSummary(message) ?? message.body.slice(0, 80);
  return (
    <div className="my-1 flex justify-center">
      <div
        data-testid="steered-milestone-card"
        className="w-full max-w-[80%] rounded-md border border-accent-500/40 bg-accent-500/10 px-2.5 py-1.5"
      >
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 shrink-0 rounded-full bg-accent-500" aria-hidden />
          <span className="text-xs font-semibold text-primary">已下发指令</span>
          <span className="rounded bg-accent-500/15 px-1.5 text-[10px] font-medium text-accent-600 dark:text-accent-300">
            steered
          </span>
          <span className="ml-auto shrink-0 text-[10px] text-tertiary">{formatHHmm(message.createdAt)}</span>
        </div>
        <p className="mt-0.5 pl-3.5 text-[10.5px] text-tertiary">
          指令经 hub task.steer 送达 · 回合边界注入执行上下文
        </p>
        <blockquote className="mt-1 border-l-[3px] border-accent-500 pl-2 text-[11px] leading-relaxed text-secondary">
          {summary}
        </blockquote>
      </div>
    </div>
  );
}
