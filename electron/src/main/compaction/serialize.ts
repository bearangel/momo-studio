// electron/src/main/compaction/serialize.ts
//
// 对话序列化（spec §4.2）：
//   - [用户]: / [助手]: / [系统]: 前缀包文本
//   - assistant 带 toolCalls → [工具调用]: name(JSON) + 后续 role=tool → [工具结果]: ...
//   - tool 结果 >2000 字符截断 + 追加 [truncated]（与 spec §8 prune 同源）
//
// 纯函数：仅依赖 LLMMessage 形态；零 DB/IPC 副作用。
// 工具参数 JSON 序列化与 llm-provider.ts 的 toOpenAIMessage/toAnthropicMessage
// 转换路径保持一致——不另立序列化标准。

import type { LLMMessage } from '../agent/llm-provider';

/** 单工具结果硬上限（字符数，非字节数）。spec §4.2 + §8 同源。 */
const TOOL_RESULT_MAX_LEN = 2000;

/** 截断后追加的固定标记 */
const TRUNCATED_MARKER = '[truncated]';

/**
 * 把 LLMMessage 数组序列化为单一字符串，供摘要 prompt 作为 <conversation> 内容。
 *
 * 序列化策略：
 *   - 一条消息一行（便于 LLM 阅读）
 *   - role 映射：user→[用户]: / assistant→[助手]: / system→[系统]: / tool→[工具结果]:
 *   - assistant 同时含文本与 toolCalls 时，文本在前；toolCalls 每个一行 [工具调用]: name(args)
 *   - tool 角色结果超 TOOL_RESULT_MAX_LEN 截断 + TRUNCATED_MARKER
 *
 * @param messages 已按时间序排列的 LLMMessage 数组（不含 system——system 走顶层不进摘要）
 */
export function serializeMessages(messages: LLMMessage[]): string {
  const lines: string[] = [];

  for (const m of messages) {
    if (m.role === 'assistant') {
      // 文本在前（可能为空）
      if (m.content && m.content.length > 0) {
        lines.push(`[助手]: ${m.content}`);
      }
      // 工具调用逐个
      if (m.toolCalls && m.toolCalls.length > 0) {
        for (const tc of m.toolCalls) {
          lines.push(`[工具调用]: ${tc.name}(${JSON.stringify(tc.arguments)})`);
        }
      }
      continue;
    }

    if (m.role === 'user') {
      lines.push(`[用户]: ${m.content}`);
      continue;
    }

    if (m.role === 'system') {
      // system 实际不进摘要（spec §4.3 单独提取），但函数仍容忍——便于上层
      // 误传时也能跑通不出错
      lines.push(`[系统]: ${m.content}`);
      continue;
    }

    if (m.role === 'tool') {
      const truncated = truncateToolResult(m.content);
      lines.push(`[工具结果]: ${truncated}`);
      continue;
    }
  }

  return lines.join('\n');
}

/**
 * 单条工具结果截断——超长字符串保留前 TOOL_RESULT_MAX_LEN 字符 + 标记。
 *
 * 与 output-truncate.ts.truncateString 的差异：这里按字符数截断（spec
 * 字面规格是「2000 字符」），且不换算字节（避免 UTF-8 多字节字符被截在
 * 中间产生不可解码字符串）。
 */
function truncateToolResult(content: string): string {
  if (content.length <= TOOL_RESULT_MAX_LEN) return content;
  return `${content.slice(0, TOOL_RESULT_MAX_LEN)}\n${TRUNCATED_MARKER}`;
}
