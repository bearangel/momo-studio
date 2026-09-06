// renderer/src/components/im/ToolCallChip.tsx
//
// 工具调用卡片（v2.1 重写，spec §4.3）：
//   折叠行 = 状态图标 + 工具名 + describeToolCall 智能摘要 + 次要参数 chip + 耗时
//   展开   = 结果优先（~10 行折叠 +「展开剩余 N 行」+ 次级「参数」开关）
//   错误   = 压平单行（title 看全文）；「用户拒绝/permission denied」降级 warning
import { useState } from 'react';
import { CircleCheck, CircleX, ChevronDown, ChevronRight, Loader2, TriangleAlert } from 'lucide-react';
import { cn } from '../../lib/cn';
import { describeToolCall } from '../../lib/describe-tool-call';

interface Props {
  toolName: string;
  args: Record<string, unknown>;
  result?: string;
  success: boolean;
  durationMs?: number;
  isExecuting?: boolean;
  defaultExpanded?: boolean;
}

/** 结果折叠阈值：超过 N 行显示前 N 行 + 展开条 */
const RESULT_FOLD_LINES = 10;

/** 权限拒绝判定（用户意志非故障，降级 warning） */
function isPermissionDenied(result: string): boolean {
  const lower = result.toLowerCase();
  return (
    lower.includes('用户拒绝') ||
    lower.includes('permission denied') ||
    lower.includes('user denied')
  );
}

/** 多行错误压平为单行 */
function flatten(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' ').trim();
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
  const [resultExpanded, setResultExpanded] = useState(false);
  const [argsExpanded, setArgsExpanded] = useState(false);

  const denied =
    !isExecuting && success === false && result !== undefined && isPermissionDenied(result);
  const toneCls =
    isExecuting || denied
      ? 'bg-status-warning-tint text-status-warning'
      : success
        ? 'bg-status-success-tint text-status-success'
        : 'bg-status-error-tint text-status-error';
  const StatusIcon = isExecuting ? Loader2 : denied ? TriangleAlert : success ? CircleCheck : CircleX;
  const { summary, extraArgs } = describeToolCall(toolName, args);

  const resultLines = result !== undefined ? result.split('\n') : [];
  const folded = !resultExpanded && resultLines.length > RESULT_FOLD_LINES;
  const shownResult = folded ? resultLines.slice(0, RESULT_FOLD_LINES).join('\n') : result;
  const isError = !isExecuting && success === false;

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
        <StatusIcon
          size={12}
          strokeWidth={1.75}
          aria-hidden
          className={isExecuting ? 'animate-spin' : undefined}
        />
        <span className="shrink-0 font-mono text-primary">{toolName}</span>
        {summary !== '' && (
          <span className="min-w-0 truncate text-[11px] text-secondary" title={summary}>
            {summary}
          </span>
        )}
        {extraArgs.map((kv) => (
          <span key={kv} className="shrink-0 rounded bg-surface-3 px-1 text-[10px] text-tertiary">
            {kv}
          </span>
        ))}
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
        <div className="mt-1 rounded border border-subtle bg-surface-1 p-2 font-mono text-[11px] text-secondary">
          {result === undefined ? (
            <div className="text-tertiary">等待工具响应…</div>
          ) : isError ? (
            <div
              className="overflow-hidden text-ellipsis whitespace-nowrap text-status-error"
              title={result}
            >
              错误: {flatten(result)}
            </div>
          ) : (
            <>
              <div className="max-h-[300px] overflow-auto whitespace-pre-wrap break-words">
                {shownResult}
              </div>
              {resultLines.length > RESULT_FOLD_LINES && (
                <button
                  type="button"
                  onClick={() => setResultExpanded(!resultExpanded)}
                  className="mt-1 w-full cursor-pointer border-t border-subtle pt-1 text-center text-[11px] text-tertiary"
                >
                  {resultExpanded ? '收起' : `展开剩余 ${resultLines.length - RESULT_FOLD_LINES} 行`}
                </button>
              )}
            </>
          )}
          <button
            type="button"
            onClick={() => setArgsExpanded(!argsExpanded)}
            className="mt-1 cursor-pointer text-[10px] text-tertiary"
          >
            {argsExpanded ? '▾ 参数' : '▸ 参数'}
          </button>
          {argsExpanded && (
            <div className="mt-1 whitespace-pre-wrap break-words text-tertiary">
              {JSON.stringify(args, null, 2)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
