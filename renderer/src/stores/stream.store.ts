// renderer/src/stores/stream.store.ts
//
// 流式 chunk 状态管理（v1.4）。
// init() 注册 ipc.agent.onStream 回调，按 chunk.type 聚合到 StreamState。
// MessageList 读取当前房间的 streaming 状态渲染 AgentStreamBubble；
// 收到 Matrix 最终消息（含 stream_session_id）后调 clearCompleted 清理临时态。
//
// v1.4 嵌套支持（Task 3）：
// - dispatch tool_call 在父 stream 的 dispatchChildren 中登记一个 DispatchChild（status='queued'）
// - 子 agent start chunk（携带 parentStreamSessionId）创建独立 StreamState 存入同一 streams Map，
//   同时把父 stream 对应的 DispatchChild 置为 'executing'
// - 子 agent 的 end chunk 把父 stream 对应的 DispatchChild 置为终态（completed/failed）
// - PM 的 tool_result(subStatus) 是 dispatch 结果，更新对应 DispatchChild 终态
// - 子 stream 的 thinking/text/tool_call/tool_result 正常更新（renderer 通过 parentStreamSessionId
//   判定是否嵌套渲染）
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { StreamChunk, TodoItem } from '../ipc/types';

/** 单次工具调用事件（流式生命周期内可能多次） */
export interface ToolCallEvent {
  toolName: string;
  args: Record<string, unknown>;
  /** 工具结果文本；执行中时 undefined */
  result?: string;
  /** 是否成功；执行中时 undefined */
  success?: boolean;
  /** 是否执行中（true 显示 ⏳） */
  isExecuting?: boolean;
}

/** dispatch chip 内的子 agent 委派状态（v1.4 嵌套） */
export interface DispatchChild {
  subStreamSessionId: string;
  subAgentName: string;
  subAgentAvatar?: string;
  status: 'queued' | 'executing' | 'completed' | 'failed';
}

/**
 * v1.5.7 时间线事件——按 chunk 到达顺序记录，AgentStreamBubble 据此按时间线渲染。
 * 替代旧的 thinking + text + toolCalls 分区式渲染（用户报"无法区分会话链路"）。
 */
export type StreamEvent =
  | { id: string; type: 'thinking'; content: string }
  | { id: string; type: 'text'; content: string }
  | {
      id: string;
      type: 'tool_call';
      toolName: string;
      args: Record<string, unknown>;
      result?: string;
      success?: boolean;
      isExecuting: boolean;
      isDispatch?: boolean;
      subStreamSessionId?: string;
      subAgentName?: string;
      subAgentAvatar?: string;
    }
  | { id: string; type: 'todo'; todos: TodoItem[] };

/** 单次流式响应的聚合状态，对应一个临时气泡 */
export interface StreamState {
  streamSessionId: string;
  roomId: string;
  botUserId: string;
  thinking: string;
  text: string;
  toolCalls: ToolCallEvent[];
  status: 'streaming' | 'done' | 'interrupted' | 'error';
  finishReason?: string;
  error?: string;
  /** v1.4 嵌套：dispatch 委派的子 agent 列表（仅 PM/父 stream 使用） */
  dispatchChildren: DispatchChild[];
  /** v1.4 嵌套：父 agent 的 streamSessionId（仅子 agent stream 使用；为空表示顶层 stream） */
  parentStreamSessionId?: string;
  /** v1.5 todowrite 工具的任务列表（todo_update chunk 全量替换） */
  todos?: TodoItem[];
  /** v1.5.6: start chunk 时间戳——MessageList 据此跟 Matrix 消息混合排序 */
  startedAt: number;
  /** v1.5.7: 时间线事件流——AgentStreamBubble 按此渲染（替代分区字段） */
  events: StreamEvent[];
}

interface StreamStoreState {
  /** streamSessionId → 聚合状态（父/子 stream 共存于同一 Map） */
  streams: Map<string, StreamState>;
  /** 注册 ipc.agent.onStream 回调，返回取消订阅函数（App 挂载时调用） */
  init: () => () => void;
  /** 删除指定 session（收到 Matrix 最终消息后清理临时态） */
  clearCompleted: (streamSessionId: string) => void;
}

/** end chunk 的 finishReason → StreamState.status 映射 */
function statusFromFinishReason(reason: string): StreamState['status'] {
  if (reason === 'stop') return 'done';
  if (reason === 'interrupted') return 'interrupted';
  // budget_exhausted 是计划内终止（agent 达到工具上限后停止），视为已完成而非出错
  if (reason === 'budget_exhausted') return 'done';
  return 'error';
}

/**
 * 更新父 stream 的 dispatchChildren 中匹配 subStreamSessionId 的子项状态（v1.4 嵌套）。
 * 直接 mutate 传入的 streams Map（已在 set() 内拷贝过的副本）。
 */
function setParentDispatchChildStatus(
  streams: Map<string, StreamState>,
  parentStreamSessionId: string,
  childStreamSessionId: string,
  status: DispatchChild['status'],
): void {
  const parent = streams.get(parentStreamSessionId);
  if (!parent) return;
  let touched = false;
  const children = parent.dispatchChildren.map((c) => {
    if (c.subStreamSessionId === childStreamSessionId) {
      touched = true;
      return { ...c, status };
    }
    return c;
  });
  if (!touched) return;
  streams.set(parentStreamSessionId, { ...parent, dispatchChildren: children });
}

/**
 * 更新最后一个未终结的 dispatchChild 状态（tool_result(subStatus) 场景）。
 * 由于 tool_result 不携带 subStreamSessionId，按"最后一个 queued/executing 的子项"匹配。
 * 与子 agent end chunk 的状态更新互为冗余兜底（end chunk 优先命中）。
 */
function setLastPendingChildStatus(
  children: DispatchChild[],
  status: DispatchChild['status'],
): DispatchChild[] {
  const next = [...children];
  for (let i = next.length - 1; i >= 0; i--) {
    const c = next[i]!;
    if (c.status === 'queued' || c.status === 'executing') {
      next[i] = { ...c, status };
      break;
    }
  }
  return next;
}

export const useStreamStore = create<StreamStoreState>((set) => ({
  streams: new Map(),

  init: () => {
    const unsubscribe = ipc.agent.onStream((chunk) => {
      set((state) => {
        const streams = new Map(state.streams);

        if (chunk.type === 'start') {
          streams.set(chunk.streamSessionId, {
            streamSessionId: chunk.streamSessionId,
            roomId: chunk.roomId,
            botUserId: chunk.botUserId,
            thinking: '',
            text: '',
            toolCalls: [],
            status: 'streaming',
            dispatchChildren: [],
            todos: [],
            parentStreamSessionId: chunk.parentStreamSessionId,
            startedAt: Date.now(),
            events: [],
          });
          if (chunk.parentStreamSessionId) {
            setParentDispatchChildStatus(
              streams,
              chunk.parentStreamSessionId,
              chunk.streamSessionId,
              'executing',
            );
          }
          return { streams };
        }

        const existing = streams.get(chunk.streamSessionId);
        if (!existing) return {};

        const updated: StreamState = { ...existing, events: [...existing.events] };
        const evs = updated.events;
        const lastEv = evs.length > 0 ? evs[evs.length - 1] : undefined;

        switch (chunk.type) {
          case 'thinking':
            updated.thinking = existing.thinking + chunk.delta;
            // v1.5.7: 如果上一个事件也是 thinking，追加到它；否则新建
            if (lastEv && lastEv.type === 'thinking') {
              evs[evs.length - 1] = { ...lastEv, content: lastEv.content + chunk.delta };
            } else {
              evs.push({ id: crypto.randomUUID(), type: 'thinking', content: chunk.delta });
            }
            break;
          case 'text':
            updated.text = existing.text + chunk.delta;
            if (lastEv && lastEv.type === 'text') {
              evs[evs.length - 1] = { ...lastEv, content: lastEv.content + chunk.delta };
            } else {
              evs.push({ id: crypto.randomUUID(), type: 'text', content: chunk.delta });
            }
            break;
          case 'tool_call':
            if (chunk.isDispatch && chunk.subStreamSessionId) {
              updated.dispatchChildren = [
                ...existing.dispatchChildren,
                {
                  subStreamSessionId: chunk.subStreamSessionId,
                  subAgentName: chunk.subAgentName ?? '',
                  subAgentAvatar: chunk.subAgentAvatar,
                  status: 'queued',
                },
              ];
            } else {
              updated.toolCalls = [
                ...existing.toolCalls,
                { toolName: chunk.toolName, args: chunk.args, isExecuting: true },
              ];
            }
            // v1.5.7: push 到时间线
            evs.push({
              id: crypto.randomUUID(),
              type: 'tool_call',
              toolName: chunk.toolName,
              args: chunk.args,
              isExecuting: true,
              ...(chunk.isDispatch ? {
                isDispatch: true,
                subStreamSessionId: chunk.subStreamSessionId,
                subAgentName: chunk.subAgentName,
                subAgentAvatar: chunk.subAgentAvatar,
              } : {}),
            });
            break;
          case 'tool_result': {
            if (chunk.subStatus) {
              const finalStatus: DispatchChild['status'] =
                chunk.subStatus === 'completed' ? 'completed' : 'failed';
              updated.dispatchChildren = setLastPendingChildStatus(
                existing.dispatchChildren,
                finalStatus,
              );
            } else {
              const calls = [...existing.toolCalls];
              for (let i = calls.length - 1; i >= 0; i--) {
                if (calls[i]!.toolName === chunk.toolName && calls[i]!.isExecuting) {
                  calls[i] = {
                    ...calls[i]!,
                    result: chunk.result,
                    success: chunk.success,
                    isExecuting: false,
                  };
                  break;
                }
              }
              updated.toolCalls = calls;
            }
            // v1.5.7: 更新时间线中对应的 tool_call 事件
            for (let i = evs.length - 1; i >= 0; i--) {
              const ev = evs[i];
              if (ev && ev.type === 'tool_call' && ev.toolName === chunk.toolName && ev.isExecuting) {
                evs[i] = {
                  ...ev,
                  result: chunk.result,
                  success: chunk.success,
                  isExecuting: false,
                };
                break;
              }
            }
            break;
          }
          case 'todo_update':
            updated.todos = chunk.todos ?? [];
            // v1.5.7: todo 是全量替换，更新最后一个 todo 事件或新建
            let lastTodoIdx = -1;
            for (let i = evs.length - 1; i >= 0; i--) {
              if (evs[i]!.type === 'todo') { lastTodoIdx = i; break; }
            }
            if (lastTodoIdx >= 0) {
              evs[lastTodoIdx] = { ...(evs[lastTodoIdx] as { id: string }), type: 'todo', todos: chunk.todos ?? [] };
            } else {
              evs.push({ id: crypto.randomUUID(), type: 'todo', todos: chunk.todos ?? [] });
            }
            break;
          case 'end':
            updated.status = statusFromFinishReason(chunk.finishReason);
            updated.finishReason = chunk.finishReason;
            updated.error = chunk.error;
            break;
        }
        streams.set(chunk.streamSessionId, updated);

        // 嵌套：子 agent end 通知父 stream 把对应 DispatchChild 置为终态
        if (chunk.type === 'end' && existing.parentStreamSessionId) {
          const childFinalStatus: DispatchChild['status'] =
            chunk.finishReason === 'stop' || chunk.finishReason === 'budget_exhausted'
              ? 'completed'
              : 'failed';
          setParentDispatchChildStatus(
            streams,
            existing.parentStreamSessionId,
            chunk.streamSessionId,
            childFinalStatus,
          );
        }

        return { streams };
      });
    });
    return unsubscribe;
  },

  clearCompleted: (streamSessionId) => {
    set((state) => {
      const streams = new Map(state.streams);
      streams.delete(streamSessionId);
      return { streams };
    });
  },
}));
