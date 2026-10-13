// renderer/src/components/im/SystemEventCard.tsx
//
// 系统事件卡（spec §5.3）：sender='system' 行专属渲染——居中窄卡（非气泡）。
// 现承载 dispatch 回执；首行结构化解析失败降级 80 字符纯文本摘要。
import { useState } from 'react';
import { BellRing, ChevronDown, ChevronRight } from 'lucide-react';
import type { ImMessage } from '../../ipc/types';

const RECEIPT_HEAD_RE = /^【dispatch 回执自动送达】任务链 \S+（第 (\d+) 轮）已(完成|失败)（工具调用 (\d+) 次）。\n?/;

export function SystemEventCard({ message }: { message: ImMessage }) {
  const [expanded, setExpanded] = useState(false);
  const m = RECEIPT_HEAD_RE.exec(message.body);
  const summary = m ? `子任务回执 · 已${m[2]} · 第 ${m[1]} 轮 · 工具调用 ${m[3]} 次` : message.body.slice(0, 80);
  return (
    <div className="my-1 flex justify-center">
      <div className="w-full max-w-[80%] rounded border border-subtle bg-surface-2 px-2.5 py-1.5 text-xs text-secondary">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full cursor-pointer items-center gap-1.5"
        >
          <BellRing size={12} strokeWidth={1.75} aria-hidden className="shrink-0 text-accent-500" />
          <span className="truncate">{summary}</span>
          {expanded
            ? <ChevronDown size={11} strokeWidth={1.75} aria-hidden />
            : <ChevronRight size={11} strokeWidth={1.75} aria-hidden />}
        </button>
        {expanded && (
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-tertiary">
            {message.body}
          </pre>
        )}
      </div>
    </div>
  );
}
