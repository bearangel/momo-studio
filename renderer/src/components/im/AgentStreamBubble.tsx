// renderer/src/components/im/AgentStreamBubble.tsx
//
// 流式响应临时气泡：把一次 agent 流式响应（thinking + 工具调用 + 正文 + dispatch）
// 聚合渲染成单个消息气泡。数据来自 stream.store 的 StreamState（A 子系统：基于
// message_events 聚合）。
//
// v2.0 A 子系统重写：
//   - StreamState extends AggregatedStream（按字段渲染，不再按 events 时间线）
//   - 加 message props：从 message 取 roomId/sender（stream 不再携带这些）
//   - stream.dispatches 替代旧 stream.dispatchChildren（AggregatedDispatch → DispatchChild 映射）
//   - status 枚举改为 streaming/done/failed/aborted
//   - subStream 查找留给 A9（streams Map 改 keyed by messageId，需 streamSessionId→messageId 反查）
import type { StreamState } from '../../stores/stream.store';
import { ipc } from '../../ipc/client';
import type { ImMessage } from '../../ipc/types';
import { MessageFrame } from './MessageFrame';
import { ThinkingSection } from './ThinkingSection';
import { TodoSection } from './TodoSection';
import { ToolCallChip } from './ToolCallChip';
import { DispatchChip } from './DispatchChip';
import type { DispatchChild } from './DispatchChip';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  stream: StreamState;
  /** 关联的 ImMessage：A 子系统补充会话上下文（roomId/sender 从 message 取） */
  message: ImMessage;
  /** bot 配置名（优先于 shortName 显示） */
  senderName?: string;
}

const STATUS_TEXT: Record<StreamState['status'], string> = {
  streaming: '流式中',
  done: '已完成',
  failed: '出错',
  aborted: '已中断',
};

const STATUS_COLOR: Record<StreamState['status'], string> = {
  streaming: '#60a5fa',
  done: '#4ade80',
  failed: '#f87171',
  aborted: '#fbbf24',
};

const STATUS_DOT: Record<StreamState['status'], string> = {
  streaming: '●',
  done: '✓',
  failed: '⚠',
  aborted: '⏹',
};

/** AggregatedDispatch.status('timeout') → DispatchChild.status 无 timeout，归并到 'failed' */
function mapDispatchStatus(s: StreamState['dispatches'][number]['status']): DispatchChild['status'] {
  if (s === 'timeout') return 'failed';
  return s;
}

export function AgentStreamBubble({ stream, message, senderName }: Props) {
  const isStreaming = stream.status === 'streaming';
  const statusText = STATUS_TEXT[stream.status];
  const statusColor = STATUS_COLOR[stream.status];
  const statusDot = STATUS_DOT[stream.status];

  const dispatchTotal = stream.dispatches.length;
  const dispatchCompleted = stream.dispatches.filter(
    (d) => d.status === 'completed' || d.status === 'failed' || d.status === 'timeout',
  ).length;
  const showProgress = dispatchTotal > 0 && dispatchCompleted < dispatchTotal;

  return (
    <MessageFrame
      sender={message.sender}
      isSelf={false}
      senderName={senderName}
      bubbleClassName="bg-bg-tertiary text-neutral-100 border border-border-subtle"
      maxWidthPct={90}
      fillWidth
    >
      {stream.thinking && (
        <ThinkingSection content={stream.thinking} isStreaming={isStreaming} />
      )}

      {stream.todos.length > 0 && (
        <TodoSection todos={stream.todos} isStreaming={isStreaming} />
      )}

      {stream.toolCalls.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          {stream.toolCalls.map((tc, i) => (
            <ToolCallChip
              key={`${tc.toolName}-${i}`}
              toolName={tc.toolName}
              args={tc.args}
              result={tc.result ?? undefined}
              success={tc.success ?? true}
              isExecuting={tc.result === null}
              defaultExpanded={false}
            />
          ))}
        </div>
      )}

      {stream.dispatches.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          {stream.dispatches.map((d) => {
            const child: DispatchChild = {
              subStreamSessionId: d.subStreamSessionId,
              subAgentName: d.subAgentName,
              ...(d.subAgentAvatar !== undefined ? { subAgentAvatar: d.subAgentAvatar } : {}),
              status: mapDispatchStatus(d.status),
            };
            // A9 完整实现：按 subStreamSessionId 反查子 message.id 后从 streams Map 取 subStream
            return <DispatchChip key={d.callId} child={child} />;
          })}
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
        {isStreaming && (
          <button
            type="button"
            onClick={() => {
              void ipc.agent.abortStream(message.roomId);
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
