// renderer/src/lib/stream-aggregator.ts
//
// message_events → AggregatedStream 共用聚合函数。
//
// 这是 A 子系统的核心不变量：
//   实时显示（增量 events 推送）和重启显示（一次性 loadAll events）
//   都用同一份 events 数组 + 这个函数，保证 UI 完全一致。
//
// 输入约定：events 必须按 seq 升序（DB 层 ORDER BY seq ASC 已保证）。
// 输出：聚合后的 StreamState-like 结构（与 stream.store 的 StreamState 兼容字段）。
import type { MessageEventRow, TodoItem } from '../ipc/types';

export interface AggregatedToolCall {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: string | null; // null = 执行中
  success: boolean | null; // null = 执行中
}

export interface AggregatedDispatch {
  callId: string;
  subStreamSessionId: string;
  subAgentName: string;
  subAgentAvatar?: string;
  task: string;
  status: 'queued' | 'executing' | 'completed' | 'failed' | 'timeout';
}

export interface AggregatedStream {
  thinking: string;
  text: string;
  toolCalls: AggregatedToolCall[];
  todos: TodoItem[];
  dispatches: AggregatedDispatch[];
  status: 'streaming' | 'done' | 'failed' | 'aborted';
  /** final 事件携带的错误文本（status='failed' 时存在）；成功/中断流为 undefined */
  error?: string;
  events: Array<{ seq: number; type: string; content?: string }>;
  /**
   * 时间线分段：thinking / text / tool_call / dispatch 按事件实际发生顺序交错。
   * UI 据此线性渲染（先想 → 再调工具 → 后说话），而非按类型分块堆叠。
   */
  segments: StreamSegment[];
}

export type StreamSegment =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | {
      kind: 'tool_call';
      callId: string;
      toolName: string;
      args: Record<string, unknown>;
      result: string | null;
      success: boolean | null;
    }
  | {
      kind: 'dispatch';
      callId: string;
      subStreamSessionId: string;
      subAgentName: string;
      subAgentAvatar?: string;
      task: string;
      status: AggregatedDispatch['status'];
    };

/**
 * 把一串按 seq 升序的 MessageEventRow 聚合成完整的 stream 状态。
 *
 * 关键配对规则：
 * - tool_call_start / tool_call_result 按 callId 配对（用 Map 暂存 start payload）
 * - dispatch_start / dispatch_result 按 callId 配对（同上）
 * - todo_update 全量替换（最后一次写入胜出）
 * - status_change 显式覆盖 status；final 事件固定为 'done'
 * - segment_boundary 仅写入 events 时间线，不参与任何聚合
 */
export function aggregateEvents(events: MessageEventRow[]): AggregatedStream {
  let thinking = '';
  let text = '';
  let status: AggregatedStream['status'] = 'streaming';
  let streamError: string | undefined;
  let todos: TodoItem[] = [];

  // tool_call / dispatch 按 callId 暂存 start payload，再被 result 配对
  const toolStarts = new Map<string, { toolName: string; args: Record<string, unknown> }>();
  const toolResults = new Map<string, { result: string; success: boolean }>();
  const dispatchStarts = new Map<string, Omit<AggregatedDispatch, 'status'>>();
  const dispatchStatuses = new Map<string, AggregatedDispatch['status']>();

  // 时间线分段（UI 线性渲染的数据源）
  const segments: StreamSegment[] = [];
  const appendTextSegment = (kind: 'thinking' | 'text', delta: string): void => {
    const last = segments[segments.length - 1];
    if (last !== undefined && last.kind === kind) {
      last.text += delta;
    } else {
      segments.push({ kind, text: delta });
    }
  };

  const timeline: AggregatedStream['events'] = [];

  for (const e of events) {
    timeline.push({ seq: e.seq, type: e.eventType });
    const p = e.payload;
    switch (e.eventType) {
      case 'thinking_delta':
        if (typeof p.delta === 'string') {
          thinking += p.delta;
          appendTextSegment('thinking', p.delta);
        }
        break;
      case 'text_delta':
        if (typeof p.delta === 'string') {
          text += p.delta;
          appendTextSegment('text', p.delta);
        }
        break;
      case 'tool_call_start': {
        if (typeof p.callId === 'string' && typeof p.toolName === 'string') {
          // P0-6：dispatch 委派在 v2 生产链路以 tool_call_start(isDispatch) 落库
          //（dispatch_start 事件类型从不产生）——按 isDispatch 分流为 dispatch 段，
          // 否则委派被渲染成普通工具卡片，chip/子流嵌套永远不出现。
          if (p.isDispatch === true && typeof p.subStreamSessionId === 'string') {
            const args = (p.args as Record<string, unknown>) ?? {};
            const start = {
              callId: p.callId,
              subStreamSessionId: p.subStreamSessionId,
              subAgentName: typeof p.subAgentName === 'string' ? p.subAgentName : '',
              ...(typeof p.subAgentAvatar === 'string' ? { subAgentAvatar: p.subAgentAvatar } : {}),
              task: typeof args.task === 'string' ? args.task : '',
            };
            dispatchStarts.set(p.callId, start);
            dispatchStatuses.set(p.callId, 'executing');
            segments.push({ kind: 'dispatch', ...start, status: 'executing' });
            break;
          }
          toolStarts.set(p.callId, {
            toolName: p.toolName,
            args: (p.args as Record<string, unknown>) ?? {},
          });
          segments.push({
            kind: 'tool_call',
            callId: p.callId,
            toolName: p.toolName,
            args: (p.args as Record<string, unknown>) ?? {},
            result: null,
            success: null,
          });
        }
        break;
      }
      case 'tool_call_result': {
        if (typeof p.callId === 'string') {
          // dispatch 回执：subStatus 携带完成/失败/超时——更新 dispatch 段状态，
          // 不进普通 toolResults（避免 dispatch 出现在平铺 toolCalls 造成双重渲染）
          if (p.subStatus === 'completed' || p.subStatus === 'failed' || p.subStatus === 'timeout') {
            dispatchStatuses.set(p.callId, p.subStatus);
            for (let i = segments.length - 1; i >= 0; i--) {
              const seg = segments[i]!;
              if (seg.kind === 'dispatch' && seg.callId === p.callId) {
                seg.status = p.subStatus;
                break;
              }
            }
            break;
          }
          toolResults.set(p.callId, {
            result: typeof p.result === 'string' ? p.result : '',
            success: p.success === true,
          });
          // 从尾部找最近的未配对同 callId tool 段（result 总在 start 之后）
          for (let i = segments.length - 1; i >= 0; i--) {
            const seg = segments[i]!;
            if (seg.kind === 'tool_call' && seg.callId === p.callId) {
              if (seg.result === null) {
                seg.result = typeof p.result === 'string' ? p.result : '';
                seg.success = p.success === true;
              }
              break;
            }
          }
        }
        break;
      }
      case 'todo_update':
        if (Array.isArray(p.todos)) {
          todos = p.todos as TodoItem[];
        }
        break;
      case 'dispatch_start':
        if (typeof p.callId === 'string' && typeof p.subStreamSessionId === 'string') {
          dispatchStarts.set(p.callId, {
            callId: p.callId,
            subStreamSessionId: p.subStreamSessionId,
            subAgentName: typeof p.subAgentName === 'string' ? p.subAgentName : '',
            ...(typeof p.subAgentAvatar === 'string' ? { subAgentAvatar: p.subAgentAvatar } : {}),
            task: typeof p.task === 'string' ? p.task : '',
          });
          dispatchStatuses.set(p.callId, 'executing');
          segments.push({
            kind: 'dispatch',
            callId: p.callId,
            subStreamSessionId: p.subStreamSessionId,
            subAgentName: typeof p.subAgentName === 'string' ? p.subAgentName : '',
            ...(typeof p.subAgentAvatar === 'string' ? { subAgentAvatar: p.subAgentAvatar } : {}),
            task: typeof p.task === 'string' ? p.task : '',
            status: 'executing',
          });
        }
        break;
      case 'dispatch_result':
        if (
          typeof p.callId === 'string' &&
          (p.status === 'completed' || p.status === 'failed' || p.status === 'timeout')
        ) {
          dispatchStatuses.set(p.callId, p.status);
          for (let i = segments.length - 1; i >= 0; i--) {
            const seg = segments[i]!;
            if (seg.kind === 'dispatch' && seg.callId === p.callId) {
              seg.status = p.status;
              break;
            }
          }
        }
        break;
      case 'segment_boundary':
        // 仅时间线记录，不参与聚合
        break;
      case 'status_change':
        if (
          p.status === 'streaming' ||
          p.status === 'done' ||
          p.status === 'failed' ||
          p.status === 'aborted'
        ) {
          status = p.status;
        }
        break;
      case 'final':
        if (
          p.status === 'streaming' ||
          p.status === 'done' ||
          p.status === 'failed' ||
          p.status === 'aborted'
        ) {
          status = p.status;
        } else if (p.status === undefined) {
          // 旧形状 final（segment_boundary 落的 final{body}）无 status 字段——保持 done 兜底
          status = 'done';
        }
        if (typeof p.error === 'string') streamError = p.error;
        break;
    }
  }

  // 配对 tool calls
  const toolCalls: AggregatedToolCall[] = Array.from(toolStarts.entries()).map(
    ([callId, start]) => {
      const result = toolResults.get(callId);
      return {
        callId,
        toolName: start.toolName,
        args: start.args,
        result: result?.result ?? null,
        success: result?.success ?? null,
      };
    },
  );

  // 配对 dispatches
  const dispatches: AggregatedDispatch[] = Array.from(dispatchStarts.values()).map((start) => ({
    ...start,
    status: dispatchStatuses.get(start.callId) ?? 'queued',
  }));

  // 时间线按 seq 升序输出（即使调用方传入乱序 events 也保证稳定顺序，
  // 便于 UI 渲染和调试时间线对比）。DB 层 ORDER BY seq ASC 通常已保证，
  // 这里做防御性排序以容忍批量回填或合并场景。
  const sortedTimeline = [...timeline].sort((a, b) => a.seq - b.seq);

  return {
    thinking,
    text,
    toolCalls,
    todos,
    dispatches,
    status,
    ...(streamError !== undefined ? { error: streamError } : {}),
    events: sortedTimeline,
    segments,
  };
}