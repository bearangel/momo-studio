// renderer/src/components/im/SegmentStack.tsx
//
// v1.7.4：多段 task_complete 消息的纵向堆叠渲染。
//
// 重启后从 Matrix event 重建时，MessageList 按 segment_of 字段把多段消息
// 聚合为 SegmentGroup，交给本组件渲染。视觉上是一个聚合容器，
// 内部按段顺序（segment_index）纵向堆叠，每段间用段号标签分隔。
// 每段保留独立的 MessageBubble（含自己的 MessageFrame），不破坏现有视觉。

import type { SegmentGroup } from './types';
import { MessageBubble } from './MessageBubble';
import { Layers } from 'lucide-react';

interface SegmentStackProps {
  /** 多段归组数据 */
  group: SegmentGroup;
  /** 是否为当前用户发送（透传给每段 MessageBubble） */
  isSelf?: boolean;
  /** bot 名称（透传给每段 MessageBubble） */
  senderName?: string;
}

export function SegmentStack({
  group,
  isSelf,
  senderName,
}: SegmentStackProps): JSX.Element {
  const { segments } = group;
  const totalSegments = segments.length;

  return (
    <div className="flex flex-col gap-2" data-testid="segment-stack">
      {totalSegments > 1 && (
        <div className="inline-flex items-center gap-1 self-start px-2 font-mono text-xs text-tertiary">
          <Layers size={12} strokeWidth={1.75} aria-hidden className="inline-block align-[-1px]" />
          多段消息（共 {totalSegments} 段）
        </div>
      )}
      {segments.map((seg, idx) => {
        const segIndex = seg.segmentIndex ?? idx + 1;
        const showSegmentLabel = totalSegments > 1;

        return (
          <div key={seg.id} className="flex flex-col gap-1">
            {showSegmentLabel && (
              <div className="text-[10px] text-disabled font-mono px-2 self-start">
                — 第 {segIndex} 段 —
              </div>
            )}
            <MessageBubble
              message={seg}
              isSelf={isSelf ?? false}
              senderName={senderName}
            />
          </div>
        );
      })}
    </div>
  );
}
