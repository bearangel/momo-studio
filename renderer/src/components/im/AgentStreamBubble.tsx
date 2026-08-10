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
import { TodoSection } from './TodoSection';
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

  const streams = useStreamStore((s) => s.streams);

  const dispatchTotal = stream.dispatchChildren.length;
  const dispatchCompleted = stream.dispatchChildren.filter(
    (c) => c.status === 'completed' || c.status === 'failed',
  ).length;
  const showProgress = dispatchTotal > 0 && dispatchCompleted < dispatchTotal;

  // v1.5.7: 判断是否最后一个事件（用于流式光标定位）
  const lastEvent = stream.events.length > 0 ? stream.events[stream.events.length - 1] : undefined;

  return (
    <MessageFrame
      sender={stream.botUserId}
      isSelf={false}
      senderName={senderName}
      bubbleClassName="bg-bg-tertiary text-neutral-100 border border-border-subtle"
      maxWidthPct={90}
    >
      {/* v1.5.7: 时间线渲染——按事件到达顺序显示 thinking/text/tool_call/todo/dispatch */}
      {stream.events.map((event) => {
        switch (event.type) {
          case 'thinking':
            return (
              <ThinkingSection
                key={event.id}
                content={event.content}
                isStreaming={isStreaming && lastEvent?.id === event.id}
              />
            );
          case 'text':
            return (
              <div
                key={event.id}
                className="overflow-hidden min-w-0 [&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:bg-black/30"
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.content}</ReactMarkdown>
                {isStreaming && lastEvent?.id === event.id && (
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
            );
          case 'tool_call':
            // dispatch 委派渲染为 DispatchChip
            if (event.isDispatch && event.subStreamSessionId) {
              const child = stream.dispatchChildren.find(
                (c) => c.subStreamSessionId === event.subStreamSessionId,
              );
              if (child) {
                return (
                  <DispatchChip
                    key={event.id}
                    child={child}
                    subStream={streams.get(event.subStreamSessionId)}
                  />
                );
              }
            }
            return (
              <ToolCallChip
                key={event.id}
                toolName={event.toolName}
                args={event.args}
                result={event.result}
                success={event.success ?? true}
                isExecuting={event.isExecuting}
                defaultExpanded={false}
              />
            );
          case 'todo':
            return (
              <TodoSection
                key={event.id}
                todos={event.todos}
                isStreaming={isStreaming && lastEvent?.id === event.id}
              />
            );
          default:
            return null;
        }
      })}

      {showProgress && (
        <div style={{ fontSize: 11, color: '#888', margin: '4px 0' }}>
          ⏳ 等待 {dispatchCompleted}/{dispatchTotal} 子任务完成
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

      <style>{`@keyframes momo-stream-blink{0%,50%{opacity:1}51%,100%{opacity:0}}`}</style>
    </MessageFrame>
  );
}
