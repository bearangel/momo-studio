// renderer/src/components/im/ThinkingSection.tsx
//
// AI 思考过程折叠区：默认折叠，展开渲染 Markdown（经 MarkdownBody 统一入口）。
// 思考区用 violet tint（v2.1：原 indigo inline hex 退役）。空内容不渲染。
// v2.1：流式态标签显示「思考中…」+ Brain 图标呼吸微光；展开高度收紧到约 10 行。
import { useState } from 'react';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
import { MarkdownBody } from './MarkdownBody';

interface Props {
  content: string;
  isStreaming?: boolean;
}

export function ThinkingSection({ content, isStreaming }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (!content) return null;

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
        <span className="ml-auto" aria-hidden>
          {expanded ? <ChevronDown size={12} strokeWidth={1.75} /> : <ChevronRight size={12} strokeWidth={1.75} />}
        </span>
      </button>
      {expanded && (
        <div className="mt-1 max-h-[220px] overflow-auto rounded bg-surface-2 p-2 text-xs text-secondary">
          <MarkdownBody deferHighlight={isStreaming}>{content}</MarkdownBody>
        </div>
      )}
    </div>
  );
}
