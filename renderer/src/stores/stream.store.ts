// renderer/src/stores/stream.store.ts
//
// 流式 chunk 状态管理（v1.4）。
// init() 注册 ipc.agent.onStream 回调，按 chunk.type 聚合到 StreamState。
// MessageList 读取当前房间的 streaming 状态渲染 AgentStreamBubble；
// 收到 Matrix 最终消息（含 stream_session_id）后调 clearCompleted 清理临时态。
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { StreamChunk } from '../ipc/types';

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
}

interface StreamStoreState {
  /** streamSessionId → 聚合状态 */
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
  return 'error';
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
          });
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
            updated.toolCalls = [
              ...existing.toolCalls,
              { toolName: chunk.toolName, args: chunk.args, isExecuting: true },
            ];
            break;
          case 'tool_result': {
            // 从后往前找最后一个同名且仍在执行的工具，置为已完成
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
            break;
          }
          case 'end':
            updated.status = statusFromFinishReason(chunk.finishReason);
            updated.finishReason = chunk.finishReason;
            updated.error = chunk.error;
            break;
        }
        streams.set(chunk.streamSessionId, updated);
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
