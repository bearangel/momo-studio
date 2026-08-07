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
          // 创建子/父 StreamState（统一初始化 dispatchChildren）
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
          });
          // 嵌套：子 agent start 通知父 stream 把对应 DispatchChild 置为 'executing'
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
        if (!existing) return {}; // 未知 session，忽略（可能 init 前的迟到 chunk）

        const updated: StreamState = { ...existing };
        switch (chunk.type) {
          case 'thinking':
            updated.thinking = existing.thinking + chunk.delta;
            break;
          case 'text':
            updated.text = existing.text + chunk.delta;
            break;
          case 'tool_call':
            if (chunk.isDispatch && chunk.subStreamSessionId) {
              // dispatch 委派：登记到 dispatchChildren（不混入普通 toolCalls）
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
            break;
          case 'tool_result': {
            if (chunk.subStatus) {
              // dispatch 结果：更新最后一个未终结 DispatchChild 的状态
              // completed→completed；failed/timeout→failed
              const finalStatus: DispatchChild['status'] =
                chunk.subStatus === 'completed' ? 'completed' : 'failed';
              updated.dispatchChildren = setLastPendingChildStatus(
                existing.dispatchChildren,
                finalStatus,
              );
            } else {
              // 普通工具结果：从后往前找最后一个同名且仍在执行的工具，置为已完成
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
            break;
          }
          case 'todo_update':
            // v1.5：todowrite 工具全量替换任务列表（覆盖式）
            updated.todos = chunk.todos ?? [];
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
