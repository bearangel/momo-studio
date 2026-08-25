// renderer/src/components/im/AgentStreamBubble.tsx
//
// 流式响应临时气泡：把一次 agent 流式响应（thinking + 工具调用 + 正文 + dispatch）
// 聚合渲染成单个消息气泡。数据来自 stream.store 的 StreamState（A 子系统：基于
// message_events 聚合）。
//
// v2.0 A 子系统重写：
//   - StreamState extends AggregatedStream（按字段渲染，不再按 events 时间线）
//   - 加 message props：从 message 取 sessionId/sender（stream 不再携带这些）
//   - stream.dispatches 替代旧 stream.dispatchChildren（AggregatedDispatch → DispatchChild 映射）
//   - status 枚举改为 streaming/done/failed/aborted
//   - subStream 查找留给 A9（streams Map 改 keyed by messageId，需 streamSessionId→messageId 反查）
import { useMemo } from 'react';
import type { StreamState } from '../../stores/stream.store';
import { useSessionStore } from '../../stores/session.store';
import { useStreamStore } from '../../stores/stream.store';
import { ipc } from '../../ipc/client';
import type { ImMessage } from '../../ipc/types';
import { MessageFrame } from './MessageFrame';
import { ThinkingSection } from './ThinkingSection';
import { TodoSection } from './TodoSection';
import { ToolCallChip } from './ToolCallChip';
import { DispatchChip } from './DispatchChip';
import type { DispatchChild } from './DispatchChip';
import type { StreamSegment } from '../../stores/stream.store';
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

/** AggregatedDispatch.status('timeout') → DispatchChild.status 无 timeout，归并到 'failed'；'aborted' 两端同名直通 */
function mapDispatchStatus(s: StreamState['dispatches'][number]['status']): DispatchChild['status'] {
  if (s === 'timeout') return 'failed';
  return s;
}

/**
 * 单个 dispatch 段的渲染单元：独立订阅子 agent 的流式状态。
 * 反查链：subStreamSessionId → 会话消息行（streamSessionId 字段）→ streams Map key。
 * 子消息未到达（派单空窗）时 subStream 为 undefined——DispatchChip 显示等待启动提示。
 */
function DispatchSegment({
  segment,
  streamIdToMessageId,
}: {
  segment: Extract<StreamSegment, { kind: 'dispatch' }>;
  streamIdToMessageId: Map<string, string>;
}) {
  const subMessageId = streamIdToMessageId.get(segment.subStreamSessionId);
  const subStream = useStreamStore((s) =>
    subMessageId !== undefined ? s.streams.get(subMessageId) : undefined,
  );
  const child: DispatchChild = {
    subStreamSessionId: segment.subStreamSessionId,
    subAgentName: segment.subAgentName,
    ...(segment.subAgentAvatar !== undefined ? { subAgentAvatar: segment.subAgentAvatar } : {}),
    status: mapDispatchStatus(segment.status),
  };
  return (
    <div style={{ marginBottom: 8 }}>
      <DispatchChip child={child} subStream={subStream} />
    </div>
  );
}

export function AgentStreamBubble({ stream, message, senderName }: Props) {
  const isStreaming = stream.status === 'streaming';
  const statusText = STATUS_TEXT[stream.status];
  const statusColor = STATUS_COLOR[stream.status];
  const statusDot = STATUS_DOT[stream.status];

  // 子 agent 流反查表：会话消息行的 streamSessionId → 消息 id（streams Map 的 key）。
  // 子 agent 消息行带 parentStreamSessionId，被 MessageList 过滤出顶层列表，
  // 但仍留在 messagesBySession——此处全量取用。
  const sessionMessages = useSessionStore((s) => s.messagesBySession.get(message.sessionId));
  const streamIdToMessageId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of sessionMessages ?? []) {
      if (m.streamSessionId) map.set(m.streamSessionId, m.id);
    }
    return map;
  }, [sessionMessages]);

  const dispatchTotal = stream.dispatches.length;
  // aborted（用户停止收敛）与 completed/failed/timeout 同为终态——不再计入「等待完成」
  const dispatchCompleted = stream.dispatches.filter(
    (d) => d.status === 'completed' || d.status === 'failed' || d.status === 'timeout' || d.status === 'aborted',
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
      {stream.todos.length > 0 && (
        <TodoSection todos={stream.todos} isStreaming={isStreaming} />
      )}

      {stream.segments.map((seg, i) => {
        const isLastSegment = i === stream.segments.length - 1;
        switch (seg.kind) {
          case 'thinking':
            return (
              <ThinkingSection
                key={`seg-thinking-${i}`}
                content={seg.text}
                isStreaming={isStreaming && isLastSegment}
              />
            );
          case 'tool_call':
            return (
              <ToolCallChip
                key={`seg-tool-${seg.callId}-${i}`}
                toolName={seg.toolName}
                args={seg.args}
                result={seg.result ?? undefined}
                success={seg.success ?? true}
                isExecuting={seg.result === null}
                defaultExpanded={false}
              />
            );
          case 'dispatch':
            return (
              <DispatchSegment
                key={`seg-dispatch-${seg.callId}-${i}`}
                segment={seg}
                streamIdToMessageId={streamIdToMessageId}
              />
            );
          case 'text':
            return (
              <div
                key={`seg-text-${i}`}
                className="overflow-hidden min-w-0 [&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:bg-black/30"
                style={{ marginBottom: 8 }}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{seg.text}</ReactMarkdown>
                {isStreaming && isLastSegment && (
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
          flexDirection: 'column',
          gap: 4,
          fontSize: 11,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: statusColor }}>
            {statusDot} {statusText}
          </span>
          {isStreaming && (
            <button
              type="button"
              onClick={() => {
                if (message.streamSessionId) {
                  void ipc.agent.abortStream(message.streamSessionId);
                }
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
        {!isStreaming && stream.error && (
          <div
            style={{
              color: '#fca5a5',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: '#3b1d1d',
              border: '1px solid #5b2929',
              borderRadius: 4,
              padding: '6px 8px',
              fontFamily: 'ui-monospace, SFMono-Regular, monospace',
              fontSize: 11,
            }}
          >
            {stream.error}
          </div>
        )}
      </div>

      <style>{`@keyframes momo-stream-blink{0%,50%{opacity:1}51%,100%{opacity:0}}`}</style>
    </MessageFrame>
  );
}
