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
// v2.1 会话渲染优化：
//   - 正文经 MarkdownBody 统一入口（SafeAnchor/CodeBlock/表格滚动容器一致）
//   - segments 先经 groupToolSegments 分组（连续只读工具合并 context-group）
//   - MessageFrame 补时间戳；终态显示消息级复制按钮（hover 气泡显形）
import { useMemo } from 'react';
import { Hourglass, CircleCheck, CircleX, CircleSlash, Loader2, Square } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { StreamState } from '../../stores/stream.store';
import { useSessionStore } from '../../stores/session.store';
import { useStreamStore } from '../../stores/stream.store';
import { ipc } from '../../ipc/client';
import type { ImMessage } from '../../ipc/types';
import { MessageFrame } from './MessageFrame';
import { ThinkingSection } from './ThinkingSection';
import { TodoSection } from './TodoSection';
import { ToolCallChip } from './ToolCallChip';
import { ContextGroupChip } from './ContextGroupChip';
import { MarkdownBody } from './MarkdownBody';
import { CopyButton } from '../ui/CopyButton';
import { DispatchChip } from './DispatchChip';
import type { DispatchChild } from './DispatchChip';
import { Button } from '../ui/Button';
import type { StreamSegment } from '../../stores/stream.store';
import { groupToolSegments } from '../../lib/group-tool-segments';

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

/** 状态展示：tone class + lucide 图标（streaming 用旋转 Loader） */
const STATUS_TONE: Record<StreamState['status'], string> = {
  streaming: 'bg-status-warning-tint text-status-warning',
  done: 'bg-status-success-tint text-status-success',
  failed: 'bg-status-error-tint text-status-error',
  aborted: 'bg-status-warning-tint text-status-warning',
};

const STATUS_ICON: Record<StreamState['status'], typeof Loader2> = {
  streaming: Loader2,
  done: CircleCheck,
  failed: CircleX,
  aborted: CircleSlash,
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
  const StatusIcon = STATUS_ICON[stream.status];

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

  // v2.1：渲染前分段分组（连续只读工具合并为 context-group / todowrite 去冗余）
  const renderSegments = useMemo(() => groupToolSegments(stream.segments), [stream.segments]);

  return (
    <MessageFrame
      sender={message.sender}
      isSelf={false}
      senderName={senderName}
      bubbleClassName="group bg-surface-2 text-primary border border-subtle"
      maxWidthPct={90}
      fillWidth
      timestamp={message.createdAt}
    >
      {stream.todos.length > 0 && (
        <TodoSection todos={stream.todos} isStreaming={isStreaming} />
      )}

      {renderSegments.map((seg, i) => {
        const isLastSegment = i === renderSegments.length - 1;
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
          case 'context-group':
            return <ContextGroupChip key={`seg-ctx-${i}`} group={seg} />;
          case 'text':
            return (
              <div key={`seg-text-${i}`} style={{ marginBottom: 8 }}>
                <MarkdownBody deferHighlight={isStreaming && isLastSegment}>{seg.text}</MarkdownBody>
                {isStreaming && isLastSegment && (
                  <span
                    aria-label="流式光标"
                    className="bg-accent-500"
                    style={{
                      display: 'inline-block',
                      width: 2,
                      height: 14,
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
        <div className="my-1 flex items-center gap-1 text-[11px] text-tertiary">
          <Hourglass size={11} strokeWidth={1.75} aria-hidden /> 等待 {dispatchCompleted}/{dispatchTotal} 子任务完成
        </div>
      )}

      <div className="mt-2 flex flex-col gap-1 border-t border-subtle pt-1.5 text-[11px]">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            className={cn(
              'inline-flex h-5 items-center gap-1 rounded px-2 font-medium',
              STATUS_TONE[stream.status],
            )}
          >
            <StatusIcon
              size={11}
              strokeWidth={1.75}
              aria-hidden
              className={isStreaming ? 'animate-spin' : undefined}
            />
            {statusText}
          </span>
          {!isStreaming && (
            <CopyButton
              text={message.body}
              className="ml-auto opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            />
          )}
          {isStreaming && (
            <Button
              variant="secondary"
              size="sm"
              className="ml-auto"
              onClick={() => {
                if (message.streamSessionId) {
                  void ipc.agent.abortStream(message.streamSessionId);
                }
              }}
            >
              <Square size={11} strokeWidth={1.75} aria-hidden /> 停止
            </Button>
          )}
        </div>
        {!isStreaming && stream.error && (
          <div className="whitespace-pre-wrap break-words rounded border border-status-error/40 bg-status-error-tint px-2 py-1.5 font-mono text-[11px] text-status-error">
            {stream.error}
          </div>
        )}
      </div>

      <style>{`@keyframes momo-stream-blink{0%,50%{opacity:1}51%,100%{opacity:0}}`}</style>
    </MessageFrame>
  );
}
