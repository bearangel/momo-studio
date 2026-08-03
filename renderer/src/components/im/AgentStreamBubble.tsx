// renderer/src/components/im/AgentStreamBubble.tsx
//
// 流式响应临时气泡：把一次 agent 流式响应（thinking + 工具调用 + 正文）
// 聚合渲染成单个消息气泡。数据来自 stream.store 的 StreamState。
// MessageFrame 提供头像/名字/对齐外壳；内含 ThinkingSection、ToolCallChip、
// 流式正文（含闪烁光标）和底部状态栏（status 文案 + 停止按钮）。
// 收到 Matrix 最终消息后由 MessageList/clearCompleted 移除本气泡。
import type { StreamState } from '../../stores/stream.store';
import { ipc } from '../../ipc/client';
import { MessageFrame } from './MessageFrame';
import { ThinkingSection } from './ThinkingSection';
import { ToolCallChip } from './ToolCallChip';

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
              defaultExpanded={isStreaming}
            />
          ))}
        </div>
      )}

      {stream.text && (
        <div className="overflow-hidden min-w-0 [&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
          <span className="text-sm whitespace-pre-wrap break-words">{stream.text}</span>
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
