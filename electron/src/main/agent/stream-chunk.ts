// electron/src/main/agent/stream-chunk.ts
//
// 流式 chunk 类型——agent 子进程通过 process.send 发给主进程，
// 主进程转发到 renderer 渲染流式 UI。
// 每个 chunk 都带 streamSessionId，renderer 用它聚合到同一个临时消息气泡。

/**
 * 流式 IPC 消息（子进程 → 主进程 → renderer）。
 *
 * 生命周期：start → (thinking | text | tool_call | tool_result)* → end
 * - start: 标记流式会话开始（renderer 据此创建临时气泡）
 * - thinking: 思维链增量（折叠区）
 * - text: 正文文本增量（逐字流式）
 * - tool_call: 工具调用发起（卡片）
 * - tool_result: 工具调用完成（卡片更新结果）
 * - end: 流式会话结束（finishReason 区分正常/预算耗尽/中断/错误）
 */
export type StreamChunk =
  | { type: 'start'; streamSessionId: string; roomId: string; botUserId: string }
  | { type: 'thinking'; streamSessionId: string; delta: string }
  | { type: 'text'; streamSessionId: string; delta: string }
  | {
      type: 'tool_call';
      streamSessionId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      streamSessionId: string;
      toolName: string;
      result: string;
      success: boolean;
    }
  | {
      type: 'end';
      streamSessionId: string;
      finishReason: 'stop' | 'budget_exhausted' | 'interrupted' | 'error';
      error?: string;
    };

/**
 * 构造并发送 chunk 的辅助函数（子进程侧）。
 * process.send 在非子进程环境下为 undefined，可选链调用确保 no-op。
 */
export function sendStreamChunk(chunk: StreamChunk): void {
  process.send?.(chunk);
}
