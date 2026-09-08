// 会话导出富信息聚合器（rich export，v2.3.2，spec §3/§4）。
// 把单条消息的 message_events 事件流聚合为导出段序列——时间线交错呈现，
// 跳过 thinking_delta（用户裁定：思考不进导出）。
//
// 镜像关系：配对规则镜像 renderer stream-aggregator.ts（callId 配对 /
// isDispatch 分流 / 终态收敛），差异仅三点（见各 case 注释）。主进程无法
// import renderer 源码（electron tsconfig rootDir: src 封死），故镜像实现
// + 本单测锁语义。改 stream-aggregator 配对规则时此处必须同步。
import type { MessageEventRow } from '../storage/messages/events-repo';
import type { TodoItem } from '../agent/tools/todo-types';

export type ExportDispatchStatus = 'queued' | 'executing' | 'completed' | 'failed' | 'timeout' | 'aborted';

export type ExportSegment =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      callId: string;
      toolName: string;
      args: Record<string, unknown>;
      result: string | null; // null = 执行中（终态收敛后不会残留）
      success: boolean | null;
    }
  | {
      kind: 'dispatch';
      callId: string;
      subStreamSessionId: string;
      subAgentName: string;
      task: string;
      status: ExportDispatchStatus;
      /** handler 递归填充：子 agent 回复的已渲染 markdown（引块内嵌） */
      subMarkdown?: string;
      /** 深度上限触发时置 true（与「查不到子行」区分，渲染省略标记） */
      subOmitted?: boolean;
    }
  | { kind: 'todo'; items: TodoItem[] };

export interface ExportAggregateResult {
  segments: ExportSegment[];
  status: 'streaming' | 'done' | 'failed' | 'aborted';
  error?: string;
}

export function exportAggregateEvents(events: MessageEventRow[]): ExportAggregateResult {
  const segments: ExportSegment[] = [];
  let status: ExportAggregateResult['status'] = 'streaming';
  let error: string | undefined;

  const appendText = (delta: string): void => {
    const last = segments[segments.length - 1];
    if (last !== undefined && last.kind === 'text') last.text += delta;
    else segments.push({ kind: 'text', text: delta });
  };
  const patchDispatch = (callId: string, next: ExportDispatchStatus): void => {
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i]!;
      if (seg.kind === 'dispatch' && seg.callId === callId) {
        seg.status = next;
        break;
      }
    }
  };

  for (const e of events) {
    const p = e.payload;
    switch (e.eventType) {
      case 'thinking_delta':
        break; // 导出排除思考（spec §1 用户裁定）
      case 'text_delta':
        if (typeof p.delta === 'string') appendText(p.delta);
        break;
      case 'tool_call_start': {
        if (typeof p.callId !== 'string' || typeof p.toolName !== 'string') break;
        if (p.isDispatch === true && typeof p.subStreamSessionId === 'string') {
          // P0-6：v2 生产链路 dispatch 以 tool_call_start(isDispatch) 落库
          const args = (p.args as Record<string, unknown>) ?? {};
          segments.push({
            kind: 'dispatch',
            callId: p.callId,
            subStreamSessionId: p.subStreamSessionId,
            subAgentName: typeof p.subAgentName === 'string' ? p.subAgentName : '',
            task: typeof args.task === 'string' ? args.task : '',
            status: 'executing',
          });
          break;
        }
        segments.push({
          kind: 'tool',
          callId: p.callId,
          toolName: p.toolName,
          args: (p.args as Record<string, unknown>) ?? {},
          result: null,
          success: null,
        });
        break;
      }
      case 'tool_call_result': {
        if (typeof p.callId !== 'string') break;
        if (p.subStatus === 'completed' || p.subStatus === 'failed' || p.subStatus === 'timeout') {
          patchDispatch(p.callId, p.subStatus);
          break;
        }
        for (let i = segments.length - 1; i >= 0; i--) {
          const seg = segments[i]!;
          if (seg.kind === 'tool' && seg.callId === p.callId && seg.result === null) {
            seg.result = typeof p.result === 'string' ? p.result : '';
            seg.success = p.success === true;
            break;
          }
        }
        break;
      }
      case 'todo_update':
        // 位置快照语义：每次更新一个段（与 UI 时间线一致），非末值胜出
        if (Array.isArray(p.todos)) segments.push({ kind: 'todo', items: p.todos as TodoItem[] });
        break;
      case 'dispatch_start':
        // 旧形状（v2 生产链路不产生，防御保留——镜像 stream-aggregator）
        if (typeof p.callId === 'string' && typeof p.subStreamSessionId === 'string') {
          segments.push({
            kind: 'dispatch',
            callId: p.callId,
            subStreamSessionId: p.subStreamSessionId,
            subAgentName: typeof p.subAgentName === 'string' ? p.subAgentName : '',
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
          patchDispatch(p.callId, p.status);
        }
        break;
      case 'segment_boundary':
        break; // 不参与导出聚合（分段行由 handler 层对齐处理）
      case 'status_change':
      case 'final': {
        if (p.status === 'streaming' || p.status === 'done' || p.status === 'failed' || p.status === 'aborted') {
          status = p.status;
        } else if (e.eventType === 'final' && p.status === undefined) {
          status = 'done'; // 旧形状 final 兜底（镜像 stream-aggregator）
        }
        if (typeof p.error === 'string') error = p.error;
        break;
      }
    }
  }

  // 终态收敛（镜像 stream-aggregator:268-288）：流结束后未回填的 tool/dispatch
  // 收敛为终态展示，防导出里出现永久「执行中」
  if (status !== 'streaming') {
    const pending = status === 'aborted' ? '(已中断)' : '(未返回结果)';
    for (const seg of segments) {
      if (seg.kind === 'tool' && seg.result === null) {
        seg.result = pending;
        seg.success = false;
      } else if (seg.kind === 'dispatch' && (seg.status === 'executing' || seg.status === 'queued')) {
        seg.status = 'aborted';
      }
    }
  }

  return { segments, status, ...(error !== undefined ? { error } : {}) };
}
