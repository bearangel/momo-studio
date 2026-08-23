// electron/src/main/agent/stream-chunk.ts
//
// 流式 chunk 类型——agent 子进程通过 process.send 发给主进程，
// 主进程转发到 renderer 渲染流式 UI。
// 每个 chunk 都带 streamSessionId，renderer 用它聚合到同一个临时消息气泡。

import type { TodoItem } from './tools/todo-types';

/**
 * 流式 IPC 消息（子进程 → 主进程 → renderer）。
 *
 * 生命周期：start → (thinking | text | tool_call | tool_result | todo_update)* → end
 * - start: 标记流式会话开始（renderer 据此创建临时气泡）
 * - thinking: 思维链增量（折叠区）
 * - text: 正文文本增量（逐字流式）
 * - tool_call: 工具调用发起（卡片）
 * - tool_result: 工具调用完成（卡片更新结果）
 * - todo_update: v1.5 todowrite 全量替换任务列表（携带完整 todos 数组）
 * - end: 流式会话结束（finishReason 区分正常/预算耗尽/中断/错误）
 *
 * v1.4 嵌套字段（仅在嵌套场景出现）：
 * - start.parentStreamSessionId: 子 agent 标识其所属 PM 的 stream session，renderer 据此把子流
 *   嵌套渲染到 PM 气泡内的 dispatch chip 下方
 * - start.subAgentName / subAgentAvatar: 子 agent 的展示名与头像（chip 头部用）
 * - tool_call.isDispatch: 标记该 tool_call 是 PM 的 dispatch 委派（与普通工具调用区分）
 * - tool_call.subStreamSessionId: PM 发起的本次子 agent 流 session ID（与子 start 的
 *   streamSessionId 对应，renderer 据此把子 stream 关联到 dispatch chip）
 * - tool_result.subStatus: dispatch 完成状态（completed / failed / timeout），用于更新 chip 状态
 */
export type StreamChunk =
  | {
      type: 'start';
      streamSessionId: string;
      /**
       * Task 6 字段迁移：原 roomId。会话 ID（v2 语义：messages.session_id 的值）。
       * 发端（runtime-entry runChatLoop）传入执行房间的 roomId，值语义与迁移前一致。
       */
      sessionId: string;
      /**
       * Task 6 字段迁移：原 botUserId。发送方 agent 标识——本任务仅重命名，
       * 值仍为 bot 的 Matrix userId；Task 7/10 起发端改传 assignmentId。
       */
      senderAgentId: string;
      /** v1.4 嵌套：父 agent 的 streamSessionId（子 agent 用，标识所属 PM 会话） */
      parentStreamSessionId?: string;
      /** v1.4 嵌套：子 agent 展示名（dispatch chip 头部显示） */
      subAgentName?: string;
      /** v1.4 嵌套：子 agent emoji 头像（dispatch chip 头部显示） */
      subAgentAvatar?: string;
    }
  | { type: 'thinking'; streamSessionId: string; delta: string }
  | { type: 'text'; streamSessionId: string; delta: string }
  | {
      type: 'tool_call';
      streamSessionId: string;
      /**
       * A7：工具调用唯一 ID（tool_call ↔ tool_result 配对用）。
       * MessageEventBuffer 的 tool_call_start/tool_call_result 事件按此配对；
       * 由 runtime-entry 在发 chunk 前生成（优先用 LLM 返回的 toolCall.id，fallback randomUUID）。
       */
      callId: string;
      toolName: string;
      args: Record<string, unknown>;
      /** v1.4 嵌套：标记此 tool_call 为 PM 的 dispatch 委派（区分普通工具调用） */
      isDispatch?: boolean;
      /** v1.4 嵌套：本次委派创建的子 agent 流 session ID（关联子 agent start chunk） */
      subStreamSessionId?: string;
      /** v1.4 嵌套：被委派子 agent 的展示名 */
      subAgentName?: string;
      /** v1.4 嵌套：被委派子 agent 的 emoji 头像 */
      subAgentAvatar?: string;
    }
  | {
      type: 'tool_result';
      streamSessionId: string;
      /** A7：配对的 tool_call callId（与对应 tool_call chunk 的 callId 一致） */
      callId: string;
      toolName: string;
      result: string;
      success: boolean;
      /** v1.4 嵌套：dispatch 完成状态（completed=成功 / failed=子 agent 报错 / timeout=超时） */
      subStatus?: 'completed' | 'failed' | 'timeout';
    }
  | {
      /** v1.5 todowrite 全量替换任务列表。每次调用 todowrite 都发一个 chunk，携带完整 todos。 */
      type: 'todo_update';
      streamSessionId: string;
      /** Task 6 字段迁移：原 roomId。会话 ID（与 start.sessionId 同值语义）。 */
      sessionId: string;
      /** 完整任务列表（覆盖式）；空数组 = 清空 */
      todos: TodoItem[];
      /** v1.5 嵌套：父 agent 的 streamSessionId（子 agent 调 todowrite 时携带） */
      parentStreamSessionId?: string;
    }
  | {
      type: 'end';
      streamSessionId: string;
      finishReason: 'stop' | 'budget_exhausted' | 'interrupted' | 'error';
      error?: string;
    }
  | {
      /**
       * A7 fix：task_complete 主动分段边界信号。
       *
       * runtime-entry 在 task_complete 分段持久化（Matrix event 已发）后发此 chunk，
       * 主进程 routeChunkToBuffer 据此 INSERT 一条独立的分段 message row
       * （segment_of=父 streamSessionId, segment_index=N, status='done'）。
       *
       * 设计选择（简化方案）：分段 message 仅存本段 body 快照（已经写入 Matrix），
       * 不切换后续 chunk 的路由——后续 thinking/text/tool_call 仍关联到父 message。
       * 这样 aggregateEvents 在父 message 上看到完整执行流，分段 message 只承载"分段产出"。
       */
      type: 'segment_boundary';
      /** 父 stream session id（本段归属的会话） */
      streamSessionId: string;
      /** 第几段（1-based） */
      segmentIndex: number;
      /** 本段最终 body 快照 */
      segmentBody: string;
      /** 本段独立的 stream session id（如 "ss-1#seg1"，与 Matrix event 内一致） */
      segmentStreamSessionId: string;
    };

/**
 * 构造并发送 chunk 的辅助函数（子进程侧）。
 * process.send 在非子进程环境下为 undefined，可选链调用确保 no-op。
 */
export function sendStreamChunk(chunk: StreamChunk): void {
  process.send?.(chunk);
}
