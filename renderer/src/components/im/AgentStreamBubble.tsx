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
// v2.1 D4 计数聚合（spec 2026-10-13 §8.2）：
//   - 状态行计数族化：流式「处理中 · 已调用工具 X 次（含子链 Y）· Z 个子任务在途」，
//     终态保留「工具 X 次（含子链 Y）」摘要（数据来自 stream-family，roll 不归零）
import { useMemo } from 'react';
import { Hourglass, CircleCheck, CircleX, CircleSlash, Loader2, PauseCircle } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { StreamState } from '../../stores/stream.store';
import { useSessionStore } from '../../stores/session.store';
import { useStreamStore } from '../../stores/stream.store';
import type { ImMessage } from '../../ipc/types';
import { MessageFrame } from './MessageFrame';
import { ThinkingSection } from './ThinkingSection';
import { ToolCallChip } from './ToolCallChip';
import { ContextGroupChip } from './ContextGroupChip';
import { MarkdownBody } from './MarkdownBody';
import { TodoSection } from './TodoSection';
import { DispatchChip } from './DispatchChip';
import type { DispatchChild } from './DispatchChip';
import { ChangesChip } from './ChangesChip';
import { BubbleToolbar } from './BubbleToolbar';
import { BudgetRenewalCard } from './BudgetRenewalCard';
import type { StreamSegment } from '../../stores/stream.store';
import { groupToolSegments } from '../../lib/group-tool-segments';
import { countFamilyToolCalls } from '../../lib/stream-family';

interface Props {
  stream: StreamState;
  /** 关联的 ImMessage：A 子系统补充会话上下文（roomId/sender 从 message 取） */
  message: ImMessage;
  /** bot 配置名（优先于 shortName 显示） */
  senderName?: string;
}

const STATUS_TEXT: Record<StreamState['status'], string> = {
  streaming: '处理中',
  // 词汇专用原则(turn reconciliation spec §3.7):「完成」全系统保留给任务状态机,
  // 流式正常结束只说「已结束」——措辞不得暗示工作已完成(T-060 割裂面之一)
  done: '已结束',
  failed: '出错',
  aborted: '已中断',
  // 软续期：预算耗尽待用户决策（续期卡承载动作）
  awaiting_renewal: '待续期',
};

/** 状态展示：tone class + lucide 图标（streaming 用旋转 Loader） */
const STATUS_TONE: Record<StreamState['status'], string> = {
  streaming: 'bg-status-warning-tint text-status-warning',
  done: 'bg-status-success-tint text-status-success',
  failed: 'bg-status-error-tint text-status-error',
  aborted: 'bg-status-warning-tint text-status-warning',
  awaiting_renewal: 'bg-status-warning-tint text-status-warning',
};

const STATUS_ICON: Record<StreamState['status'], typeof Loader2> = {
  streaming: Loader2,
  done: CircleCheck,
  failed: CircleX,
  aborted: CircleSlash,
  awaiting_renewal: PauseCircle,
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
      <DispatchChip child={child} subStream={subStream} subMessageId={subMessageId} />
    </div>
  );
}

/** 主进程 llm-provider 的流式错误双层分隔符（契约：electron/src/main/agent/llm-provider.ts） */
const STREAM_ERROR_DETAILS_SEP = '\n||details||\n';

function StreamErrorBox({ error }: { error: string }) {
  const sepIdx = error.indexOf(STREAM_ERROR_DETAILS_SEP);
  const main = sepIdx > 0 ? error.slice(0, sepIdx) : error;
  const details = sepIdx > 0 ? error.slice(sepIdx + STREAM_ERROR_DETAILS_SEP.length) : null;
  return (
    <div className="rounded border border-status-error/40 bg-status-error-tint px-2.5 py-1.5">
      <p className="break-words text-xs text-status-error">{main}</p>
      {details !== null && (
        <details className="mt-1">
          <summary className="cursor-pointer select-none text-[11px] text-tertiary hover:text-secondary">
            技术详情
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-tertiary">
            {details}
          </pre>
        </details>
      )}
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
  // P1-1（2026-10-14 流式期 O(n²) 修复）：不再整表订阅 rawStreams（每 50ms flush
  // 换 Map 引用 → 全部已挂载气泡重渲染 + 族计数重算）。改为 selector 返回原始值
  // 字符串——族内各流工具数不变时 Object.is 命中，零重渲染；计数变化只重渲染
  // 受影响气泡。countFamilyToolCalls 的全量扫描由 key 变化门控。
  const familyMessageIds = useMemo(() => {
    if (!message.streamSessionId) return [];
    const base = message.streamSessionId.split('#')[0]!;
    const ids: string[] = [];
    for (const m of sessionMessages ?? []) {
      if (m.segmentOf !== null) continue;
      const inFamily =
        (m.parentStreamSessionId !== null && m.parentStreamSessionId.split('#')[0] === base) ||
        (m.parentStreamSessionId === null && m.streamSessionId !== null && m.streamSessionId.split('#')[0] === base);
      if (inFamily) ids.push(m.id);
    }
    return ids;
  }, [sessionMessages, message.streamSessionId]);
  const familyCountKey = useStreamStore((s) => {
    let key = '';
    for (const id of familyMessageIds) key += `${(s.streams.get(id)?.toolCalls.length ?? 0).toString()},`;
    return key;
  });
  const streamIdToMessageId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of sessionMessages ?? []) {
      if (m.streamSessionId) map.set(m.streamSessionId, m.id);
    }
    return map;
  }, [sessionMessages]);

  // spec §8 族计数：own 含 roll 族（roll 不归零），sub 为直接子链求和（裁剪行
  // 如实降级 0）。streamSessionId 为空 → 无族概念，降级显示本行可见值
  // （spec §8.2 降级条款：不伪造合计）
  const familyCount = useMemo(
    () =>
      message.streamSessionId
        ? countFamilyToolCalls(sessionMessages ?? [], useStreamStore.getState().streams, message.streamSessionId)
        : { own: stream.toolCalls.length, sub: 0 },
    // familyCountKey 门控：族内工具数无变化时不重算（streams 非响应式读取）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionMessages, message.streamSessionId, stream.toolCalls.length, familyCountKey],
  );
  const familyTotal = familyCount.own + familyCount.sub;

  const dispatchTotal = stream.dispatches.length;
  // aborted（用户停止收敛）与 completed/failed/timeout 同为终态——不再计入「等待完成」
  const dispatchCompleted = stream.dispatches.filter(
    (d) => d.status === 'completed' || d.status === 'failed' || d.status === 'timeout' || d.status === 'aborted',
  ).length;
  // spec §8.1 在途子任务 Z：非终态派单数（复用 dispatchTotal/dispatchCompleted）
  const inFlightSubs = dispatchTotal - dispatchCompleted;
  const showProgress = inFlightSubs > 0;

  // 流式态进度线索（spec §8.2，D6 计数的族化扩展）：计数含子链 + 在途数。
  // sub=0 不拼「含子链」段（单 agent 无子链不加噪声，保留 D6 旧文案形态）；
  // 零工具降级纯「处理中」
  const countText =
    familyCount.sub > 0
      ? `已调用工具 ${familyCount.own} 次（含子链 ${familyCount.sub}）`
      : `已调用工具 ${familyCount.own} 次`;
  const streamingLabel =
    familyTotal > 0
      ? `处理中 · ${countText}` + (inFlightSubs > 0 ? `· ${inFlightSubs} 个子任务在途` : '')
      : '处理中';

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
                truncated={stream.thinkingTruncated}
                messageId={message.id}
                fallbackBody={message.body}
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
                resultTruncated={seg.resultTruncated}
                messageId={message.id}
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

      {/* v2.5 变更 chip：纯查看（diff 浏览），终态（非 streaming 且非 aborted）才挂载懒查；
          无变更时组件自渲染 null。不进工具条——工具条是动作区，chip 是查看元素 */}
      {!isStreaming && stream.status !== 'aborted' && <ChangesChip message={message} />}

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
            {isStreaming ? streamingLabel : statusText}
          </span>
          {/* spec §8.2 终态摘要：计数不随流式结束消失（roll/子链工作量留痕） */}
          {!isStreaming && familyTotal > 0 && (
            <span className="text-tertiary">
              工具 {familyCount.own} 次{familyCount.sub > 0 ? `（含子链 ${familyCount.sub}）` : ''}
            </span>
          )}
          <BubbleToolbar
            message={message}
            isStreaming={isStreaming}
            canUndo={!isStreaming && stream.status !== 'aborted'}
          />
        </div>
        {/* 软续期卡：预算耗尽待决策（错误框与卡片互斥——卡片自身承载完整语义） */}
        {!isStreaming && stream.status === 'awaiting_renewal' && (
          <BudgetRenewalCard sessionId={message.sessionId} toolCallsUsed={stream.toolCalls.length} />
        )}

        {!isStreaming && stream.error && stream.status !== 'awaiting_renewal' && (
          <StreamErrorBox error={stream.error} />
        )}
      </div>

      <style>{`@keyframes momo-stream-blink{0%,50%{opacity:1}51%,100%{opacity:0}}`}</style>
    </MessageFrame>
  );
}
