// renderer/src/components/im/ToolCallChip.tsx
//
// 工具调用卡片（v2.1 重写，spec §4.3）：
//   折叠行 = 状态图标 + 工具名 + describeToolCall 智能摘要 + 次要参数 chip + 耗时
//   展开   = 结果优先（~10 行折叠 +「展开剩余 N 行」+ 次级「参数」开关）
//   错误   = 压平单行（title 看全文）；「用户拒绝/permission denied」降级 warning
// 2026-10-14 wire 截断第二刀：历史加载的终态结果只送 800 字符预览——
// resultTruncated 置位时展开区提供「展开完整结果」，经 session:getMessageToolResults
// 按消息批量拉全量、stream.store.expandToolResults 按 seq 替换（chip 随段重渲染）。
import { useState } from 'react';
import { CircleCheck, CircleX, ChevronDown, ChevronRight, Loader2, TriangleAlert } from 'lucide-react';
import { cn } from '../../lib/cn';
import { describeToolCall } from '../../lib/describe-tool-call';
import { ipc } from '../../ipc/client';
import { useStreamStore } from '../../stores/stream.store';

interface Props {
  toolName: string;
  args: Record<string, unknown>;
  result?: string;
  success: boolean;
  durationMs?: number;
  isExecuting?: boolean;
  defaultExpanded?: boolean;
  /** wire 截断标志（段级 resultTruncated）：result 是预览，可展开拉全量 */
  resultTruncated?: boolean;
  /** 关联消息 id（截断展开拉取用；嵌套子流场景由上层传入） */
  messageId?: string;
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
  resultTruncated,
  messageId,
}: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const [resultExpanded, setResultExpanded] = useState(false);
  const [argsExpanded, setArgsExpanded] = useState(false);
  const [fetchingFull, setFetchingFull] = useState(false);
  const [fetchError, setFetchError] = useState(false);

  async function loadFullResults(): Promise<void> {
    if (!messageId || fetchingFull) return;
    setFetchingFull(true);
    setFetchError(false);
    try {
      const { results } = await ipc.session.getMessageToolResults(messageId);
      useStreamStore.getState().expandToolResults(messageId, results);
    } catch {
      setFetchError(true); // 失败保留预览，可重试
    } finally {
      setFetchingFull(false);
    }
  }

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
              {resultTruncated && messageId && (
                <button
                  type="button"
                  onClick={() => void loadFullResults()}
                  disabled={fetchingFull}
                  className="mt-1 w-full cursor-pointer text-center text-[11px] text-accent-600 dark:text-accent-300 hover:underline disabled:cursor-wait"
                >
                  {fetchingFull ? '加载完整结果…' : fetchError ? '加载失败，点击重试' : '展开完整结果'}
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
