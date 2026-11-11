// renderer/src/components/im/ProgressTimelineCard.tsx
//
// 进度分段折叠卡（2026-11-11 展示优化）：MessageList 分组出的连续【进度分段】
// 系统行收敛为一张居中窄卡。N>1 头部可点击展开完整时间线；N=1 无交互单行。
// 结构化解析失败降级原始 body 切片，永不抛错。
import { useState } from 'react';
import { Activity, ChevronDown, ChevronRight } from 'lucide-react';
import type { ImMessage } from '../../ipc/types';
import { formatProgressTime, parseProgressSegmentBody } from '../../lib/progress-segment';

interface Props {
  /** 一段连续进度行（≥1，时间升序） */
  messages: ImMessage[];
}

export function ProgressTimelineCard({ messages }: Props) {
  const [expanded, setExpanded] = useState(false);
  // props 契约保证 messages ≥1（组由 groupProgressSegments 产出），末行取值断言非空
  const latest = messages[messages.length - 1]!;
  const latestData = parseProgressSegmentBody(latest.body);
  const single = messages.length === 1;

  return (
    <div className="my-1 flex justify-center">
      <div
        data-testid="progress-timeline-card"
        data-count={messages.length}
        className="w-full max-w-[80%] rounded-md border border-subtle bg-surface-2 px-2.5 py-1.5 text-xs text-secondary hover:bg-surface-3"
      >
        {single ? (
          <div className="flex w-full items-center gap-1.5">
            <Activity
              size={12}
              strokeWidth={1.75}
              aria-hidden
              className="shrink-0 text-accent-500 dark:text-accent-300"
            />
            <span className="min-w-0 flex-1 truncate">
              {latestData
                ? `${formatProgressTime(latest.createdAt)} · ${latestData.label} 进行中 · 工具累计 ${latestData.toolCalls} 次 · 变更累计 ${latestData.changes} 处`
                : latest.body.slice(0, 80)}
            </span>
          </div>
        ) : (
          <>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              className="flex w-full cursor-pointer items-center gap-1.5"
            >
              <Activity
                size={12}
                strokeWidth={1.75}
                aria-hidden
                className="shrink-0 text-accent-500 dark:text-accent-300"
              />
              <span className="font-medium whitespace-nowrap">进度 · {messages.length} 条</span>
              <span className="min-w-0 flex-1 truncate">
                最新 {formatProgressTime(latest.createdAt)} ·{' '}
                {latestData
                  ? `${latestData.label} 工具累计 ${latestData.toolCalls} 次`
                  : latest.body.slice(0, 60)}
              </span>
              <span className="ml-auto shrink-0 text-tertiary">
                {expanded ? (
                  <ChevronDown size={11} strokeWidth={1.75} aria-hidden />
                ) : (
                  <ChevronRight size={11} strokeWidth={1.75} aria-hidden />
                )}
              </span>
            </button>
            {expanded && (
              <div className="mt-1.5 max-h-60 overflow-y-auto border-t border-subtle pt-1.5 font-mono text-[11px] text-tertiary">
                {messages.map((m) => {
                  // 每行独立解析：任一行格式漂移只影响该行降级，不拖垮整组
                  const row = parseProgressSegmentBody(m.body);
                  return (
                    <div key={m.id} className="flex gap-2.5 leading-[1.9]">
                      <span className="shrink-0 text-disabled">{formatProgressTime(m.createdAt)}</span>
                      <span>
                        {row
                          ? `${row.label} · 工具 ${row.toolCalls} · 变更 ${row.changes}`
                          : m.body.slice(0, 80)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
