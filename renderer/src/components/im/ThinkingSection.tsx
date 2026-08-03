// renderer/src/components/im/ThinkingSection.tsx
//
// AI 思考过程折叠区：默认折叠（仅显示 toggle 按钮），点击展开渲染 Markdown 内容。
// content 为空字符串时整体不渲染（返回 null），避免空块占位。
// isStreaming 为占位 prop（v1.4 暂无视觉差异），为后续 streaming 动画预留。
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  /** 思考过程文本（Markdown） */
  content: string;
  /** 是否正在流式接收（预留，当前不影响渲染） */
  isStreaming?: boolean;
}

export function ThinkingSection({ content, isStreaming }: Props) {
  const [expanded, setExpanded] = useState(false);
  // isStreaming 当前仅占位，避免未使用变量告警
  void isStreaming;

  // 空内容不渲染任何节点
  if (!content) return null;

  return (
    <div style={{ marginBottom: 8 }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          background: 'rgba(99,102,241,0.1)',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 12,
          color: '#a5a5c5',
          border: 'none',
          width: '100%',
        }}
      >
        <span aria-hidden>💭</span>
        <span>思考过程</span>
        <span style={{ marginLeft: 'auto' }} aria-hidden>
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && (
        <div
          className="overflow-hidden min-w-0 [&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:bg-black/30"
          style={{
            marginTop: 4,
            padding: 8,
            fontSize: 12,
            color: '#999',
            background: 'rgba(0,0,0,0.2)',
            borderRadius: 4,
            maxHeight: 400,
            overflow: 'auto',
          }}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
