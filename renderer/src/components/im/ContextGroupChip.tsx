// renderer/src/components/im/ContextGroupChip.tsx
//
// 连续只读工具分组合并 chip（spec §4.3）：折叠行「收集上下文 · N 次读取 ·
// M 次搜索」，展开后每条单行摘要（describeToolCall）——8 次文件读取从
// 8 个手风琴变 1 行摘要 + 8 个单行项。
import { useState } from 'react';
import { CircleCheck, CircleX, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import type { ContextGroup } from '../../lib/group-tool-segments';
import { describeToolCall } from '../../lib/describe-tool-call';

const READ_TOOLS = new Set(['read_file', 'list_files']);
const SEARCH_TOOLS = new Set(['grep', 'glob']);

function countLabel(items: ContextGroup['items']): string {
  const reads = items.filter((i) => READ_TOOLS.has(i.toolName)).length;
  const searches = items.filter((i) => SEARCH_TOOLS.has(i.toolName)).length;
  const parts: string[] = [];
  if (reads > 0) parts.push(`${reads} 次读取`);
  if (searches > 0) parts.push(`${searches} 次搜索`);
  return parts.join(' · ');
}

export function ContextGroupChip({ group }: { group: ContextGroup }) {
  const [expanded, setExpanded] = useState(false);
  const allDone = group.items.every((i) => i.result !== null);
  const anyFailed = group.items.some((i) => i.success === false);
  const toneCls = !allDone
    ? 'bg-status-warning-tint text-status-warning'
    : anyFailed
      ? 'bg-status-error-tint text-status-error'
      : 'bg-status-success-tint text-status-success';

  return (
    <div className="mb-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs cursor-pointer transition-colors ${toneCls}`}
      >
        {allDone ? (
          anyFailed ? (
            <CircleX size={12} strokeWidth={1.75} aria-hidden />
          ) : (
            <CircleCheck size={12} strokeWidth={1.75} aria-hidden />
          )
        ) : (
          <Loader2 size={12} strokeWidth={1.75} aria-hidden className="animate-spin" />
        )}
        <span className="shrink-0 text-primary">收集上下文</span>
        <span className="min-w-0 truncate text-[11px] text-secondary">{countLabel(group.items)}</span>
        {expanded ? (
          <ChevronDown size={12} strokeWidth={1.75} aria-hidden />
        ) : (
          <ChevronRight size={12} strokeWidth={1.75} aria-hidden />
        )}
      </button>
      {expanded && (
        <div className="mt-1 rounded border border-subtle bg-surface-1 p-2 font-mono text-[11px]">
          {group.items.map((item) => {
            const { summary } = describeToolCall(item.toolName, item.args);
            const executing = item.result === null;
            const failed = item.success === false;
            const Icon = executing ? Loader2 : failed ? CircleX : CircleCheck;
            return (
              <div key={item.callId} className="flex items-center gap-1.5 py-0.5">
                <Icon
                  size={11}
                  strokeWidth={1.75}
                  aria-hidden
                  className={cnIcon(executing, failed)}
                />
                <span className="shrink-0 text-primary">{item.toolName}</span>
                {summary !== '' && <span className="min-w-0 truncate text-secondary">{summary}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function cnIcon(executing: boolean, failed: boolean): string {
  if (executing) return 'animate-spin text-status-warning';
  if (failed) return 'text-status-error';
  return 'text-status-success';
}
