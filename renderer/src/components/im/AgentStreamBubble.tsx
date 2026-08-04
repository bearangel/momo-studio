// renderer/src/components/im/AgentStreamBubble.tsx
//
// 流式响应临时气泡：把一次 agent 流式响应（thinking + 工具调用 + 正文）
// 聚合渲染成单个消息气泡。数据来自 stream.store 的 StreamState。
// MessageFrame 提供头像/名字/对齐外壳；内含 ThinkingSection、ToolCallChip、
// 流式正文（含闪烁光标）和底部状态栏（status 文案 + 停止按钮）。
// 收到 Matrix 最终消息后由 MessageList/clearCompleted 移除本气泡。
import type { StreamState } from '../../stores/stream.store';
import { useStreamStore } from '../../stores/stream.store';
import { ipc } from '../../ipc/client';
import { MessageFrame } from './MessageFrame';
import { ThinkingSection } from './ThinkingSection';
import { ToolCallChip } from './ToolCallChip';
import { DispatchChip } from './DispatchChip';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  stream: StreamState;
  /** bot 配置名（优先于 shortName 显示） */
  senderName?: string;
}

const STATUS_TEXT: Record<StreamState['status'], string> = {
  streaming: '流式中',
  done: '已完成',
  interrupted: '已中断',
  error: '出错',
};

const STATUS_COLOR: Record<StreamState['status'], string> = {
  streaming: '#60a5fa',
  done: '#4ade80',
  interrupted: '#fbbf24',
  error: '#f87171',
};

const STATUS_DOT: Record<StreamState['status'], string> = {
  streaming: '●',
  done: '✓',
  interrupted: '⏹',
  error: '⚠',
};

export function AgentStreamBubble({ stream, senderName }: Props) {
  const isStreaming = stream.status === 'streaming';
  const statusText = STATUS_TEXT[stream.status];
  const statusColor = STATUS_COLOR[stream.status];
  const statusDot = STATUS_DOT[stream.status];

  // v1.4 嵌套：从 store 查找子 agent 的 StreamState（按 subStreamSessionId），
  // 透传给 DispatchChip 以便展开时渲染 SubAgentSection
  const streams = useStreamStore((s) => s.streams);

  // 进度指示器：有未完成的 dispatch 时显示「等待 X/Y 子任务完成」
  const dispatchTotal = stream.dispatchChildren.length;
  const dispatchCompleted = stream.dispatchChildren.filter(
    (c) => c.status === 'completed' || c.status === 'failed',
  ).length;
  const showProgress = dispatchTotal > 0 && dispatchCompleted < dispatchTotal;

  return (
    <MessageFrame
      sender={stream.botUserId}
      isSelf={false}
      senderName={senderName}
      bubbleClassName="bg-bg-tertiary text-neutral-100 border border-border-subtle"
    >
      <ThinkingSection content={stream.thinking} isStreaming={isStreaming} />

      {stream.toolCalls.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          {stream.toolCalls.map((tc, i) => (
            <ToolCallChip
              key={`${tc.toolName}-${i}`}
              toolName={tc.toolName}
              args={tc.args}
              result={tc.result}
              success={tc.success ?? true}
              isExecuting={tc.isExecuting}
              defaultExpanded={false}
            />
          ))}
        </div>
      )}

      {/* v1.4 嵌套：dispatch 委派 chips（在工具卡片之后、正文之前渲染） */}
      {dispatchTotal > 0 && (
        <div style={{ marginBottom: 8 }}>
          {stream.dispatchChildren.map((child) => (
            <DispatchChip
              key={child.subStreamSessionId}
              child={child}
              subStream={streams.get(child.subStreamSessionId)}
            />
          ))}
        </div>
      )}

      {/* v1.4 嵌套：进度指示器（全部完成时不渲染） */}
      {showProgress && (
        <div style={{ fontSize: 11, color: '#888', margin: '4px 0' }}>
          ⏳ 等待 {dispatchCompleted}/{dispatchTotal} 子任务完成
        </div>
      )}

      {stream.text && (
        <div className="overflow-hidden min-w-0 [&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:bg-black/30">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{stream.text}</ReactMarkdown>
          {isStreaming && (
            <span
              aria-label="流式光标"
              style={{
                display: 'inline-block',
                width: 2,
                height: 14,
                background: statusColor,
                marginLeft: 2,
                verticalAlign: 'text-bottom',
                animation: 'momo-stream-blink 1s infinite',
              }}
            />
          )}
        </div>
      )}

      <div
        style={{
          marginTop: 8,
          paddingTop: 6,
          borderTop: '1px solid #333',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11,
        }}
      >
        <span style={{ color: statusColor }}>
          {statusDot} {statusText}
        </span>
        {stream.error && (
          <span style={{ color: '#888', overflow: 'hidden', textOverflow: 'ellipsis' }} title={stream.error}>
            {stream.error}
          </span>
        )}
        {isStreaming && (
          <button
            type="button"
            onClick={() => {
              void ipc.agent.abortStream(stream.roomId);
            }}
            style={{
              marginLeft: 'auto',
              fontSize: 12,
              padding: '2px 10px',
              background: '#333',
              border: '1px solid #444',
              borderRadius: 4,
              color: '#ccc',
              cursor: 'pointer',
            }}
          >
            ⏹ 停止
          </button>
        )}
      </div>

      {/* 流式光标闪烁动画（作用域到本气泡） */}
      <style>{`@keyframes momo-stream-blink{0%,50%{opacity:1}51%,100%{opacity:0}}`}</style>
    </MessageFrame>
  );
}
