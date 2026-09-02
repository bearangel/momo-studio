// renderer/src/components/im/ToolCallChip.tsx
//
// 工具调用卡片：紧凑一行（工具名 + 参数摘要 + 状态图标 + 耗时），点击展开
// 参数 JSON 与结果。三态 tint（执行中 warning / 成功 success / 失败 error）
// 与 Badge tone 同源（v2.1：inline hex STATUS_COLOR/STATUS_BG 退役）。
import { useState } from 'react';
import { CircleCheck, CircleX, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { cn } from '../../lib/cn';

interface Props {
  toolName: string;
  args: Record<string, unknown>;
  result?: string;
  success: boolean;
  durationMs?: number;
  isExecuting?: boolean;
  defaultExpanded?: boolean;
}

/** 把参数对象格式化为单行摘要，最多 60 字符 */
function summarizeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ')
    .slice(0, 60);
}

export function ToolCallChip({
  toolName,
  args,
  result,
  success,
  durationMs,
  isExecuting,
  defaultExpanded,
}: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);

  const toneCls = isExecuting
    ? 'bg-status-warning-tint text-status-warning'
    : success
      ? 'bg-status-success-tint text-status-success'
      : 'bg-status-error-tint text-status-error';
  const StatusIcon = isExecuting ? Loader2 : success ? CircleCheck : CircleX;

  return (
    <div className="mb-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs cursor-pointer transition-colors',
          toneCls,
        )}
      >
        <StatusIcon size={12} strokeWidth={1.75} aria-hidden className={isExecuting ? 'animate-spin' : undefined} />
        <span className="font-mono text-primary">{toolName}</span>
        {summarizeArgs(args) && (
          <span className="truncate text-[11px] text-tertiary" title={summarizeArgs(args)}>
            {summarizeArgs(args)}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[11px] text-tertiary">
          {isExecuting ? '执行中...' : durationMs !== undefined ? `${durationMs}ms` : ''}
        </span>
        {expanded ? (
          <ChevronDown size={12} strokeWidth={1.75} aria-hidden />
        ) : (
          <ChevronRight size={12} strokeWidth={1.75} aria-hidden />
        )}
      </button>
      {expanded && (
        <div className="md-body mt-1 max-h-[300px] overflow-auto whitespace-pre-wrap rounded border border-subtle bg-surface-2 p-2 font-mono text-[11px] text-secondary">
          <div>参数: {JSON.stringify(args, null, 2)}</div>
          {result !== undefined && <div className="mt-1">结果: {result}</div>}
        </div>
      )}
    </div>
  );
}
