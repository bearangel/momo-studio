// renderer/src/components/im/ThinkingSection.tsx
//
// AI 思考过程折叠区：默认折叠，展开渲染 Markdown（经 MarkdownBody 统一入口）。
// 思考区用 violet tint（v2.1：原 indigo inline hex 退役）。空内容不渲染。
// v2.1：流式态标签显示「思考中…」+ Brain 图标呼吸微光；展开高度收紧到约 10 行。
// 2026-10-14 P0-2：历史加载的终态消息 thinking 在 wire 上被截断（折叠态预览
// 足够）——truncated 置位时展开区尾部提供「展开完整思考」，经
// session:getMessageThinking 拉全量、stream.store.expandThinking 按 seq 归并。
import { useState } from 'react';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
import { MarkdownBody } from './MarkdownBody';
import { ipc } from '../../ipc/client';
import { useStreamStore } from '../../stores/stream.store';

interface Props {
  content: string;
  isStreaming?: boolean;
  /** wire 截断标志（stream.thinkingTruncated）：预览不完整，可展开拉全量 */
  truncated?: boolean;
  /** 关联消息 id（截断展开拉取用；嵌套子流场景由上层传入） */
  messageId?: string;
  /** 正文回退（与 expandThinking 契约一致，零 text_delta 终态消息防洗白） */
  fallbackBody?: string;
}

export function ThinkingSection({ content, isStreaming, truncated, messageId, fallbackBody }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState(false);

  if (!content) return null;

  async function loadFullThinking(): Promise<void> {
    if (!messageId || fetching) return;
    setFetching(true);
    setFetchError(false);
    try {
      const { runs } = await ipc.session.getMessageThinking(messageId);
      useStreamStore.getState().expandThinking(messageId, runs, fallbackBody);
    } catch {
      setFetchError(true); // 失败保留截断预览，可重试
    } finally {
      setFetching(false);
    }
  }

  return (
    <div className="mb-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 rounded bg-status-violet-tint px-2 py-1 text-xs text-status-violet cursor-pointer"
      >
        <Brain size={12} strokeWidth={1.75} aria-hidden className={isStreaming ? 'animate-pulse' : undefined} />
        <span>{isStreaming ? '思考中…' : '思考过程'}</span>
        {truncated && <span className="text-[10px] text-tertiary">预览</span>}
        <span className="ml-auto" aria-hidden>
          {expanded ? <ChevronDown size={12} strokeWidth={1.75} /> : <ChevronRight size={12} strokeWidth={1.75} />}
        </span>
      </button>
      {expanded && (
        <div className="mt-1 max-h-[220px] overflow-auto rounded bg-surface-2 p-2 text-xs text-secondary">
          <MarkdownBody deferHighlight={isStreaming}>{content}</MarkdownBody>
          {truncated && messageId && (
            <button
              type="button"
              onClick={() => void loadFullThinking()}
              disabled={fetching}
              className="mt-1.5 w-full text-center text-[11px] text-accent-600 dark:text-accent-300 hover:underline disabled:cursor-wait"
            >
              {fetching ? '加载完整思考…' : fetchError ? '加载失败，点击重试' : '展开完整思考'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
