// electron/src/main/agent/llm-history-repair.ts
//
// 悬空 tool_call 修复门（2026-11-04 生产 HTTP-400 P0）。
//
// 问题：中断续跑（用户「继续」/恢复卡）时组装的 LLMMessage[] 若含
// 「assistant 带 toolCalls，但其后紧邻消息未覆盖每个 tool_call_id 的
// tool 响应」，OpenAI 兼容供应商会整请求 400 拒收：
//   {"error":{"message":"An assistant message with 'tool_calls' must be
//    followed by tool messages responding to each 'tool_call_id'..."}}
// 生产两次事故（任务 a07252ba / cec28988，2026-11-04）。
//
// 修复策略（防御门，挂在历史组装出口）：扫描组装产物，为每个缺失响应的
// toolCallId 就地补一条合成 tool 消息（content 固定中文占位，插在该
// assistant 消息与其后消息之间）。不丢弃任何既有消息——assistant 推理
// 上下文全量保留；只补洞，不删改。
//
// 纯函数、零副作用；完整配对时原数组原引用返回（真实 no-op）。
import type { LLMMessage } from './llm-provider';

/** 悬空 tool_call（组装产物中缺失响应）的合成 tool result 文案 */
export const DANGLING_TOOL_RESULT_TEXT = '[运行中断，未取得结果]';

/**
 * 修复悬空 tool_call 配对：对每个带 toolCalls 的 assistant 消息，检查其
 * 后紧邻的连续 tool 角色消息是否已覆盖每个 toolCallId；缺失的 callId 补
 * 合成 tool 消息（DANGLING_TOOL_RESULT_TEXT），插在 assistant 消息之后、
 * 其余消息之前。其余消息与顺序逐位保留。
 */
export function repairDanglingToolCalls(messages: LLMMessage[]): LLMMessage[] {
  // 快速预扫：无带 toolCalls 的 assistant → 原引用返回（零拷贝 no-op）
  if (!messages.some((m) => m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0)) {
    return messages;
  }
  const out: LLMMessage[] = [];
  let inserted = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    out.push(m);
    if (m.role !== 'assistant' || m.toolCalls === undefined || m.toolCalls.length === 0) {
      continue;
    }
    // 收集紧随的连续 tool 消息已响应的 callId 集合（协议要求 tool 响应
    // 紧跟所属 assistant，先于任何其它角色消息）
    const answered = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j]!.role === 'tool') {
      const tid = messages[j]!.toolCallId;
      if (tid !== undefined) answered.add(tid);
      j++;
    }
    // 缺失响应的 call → 合成 tool 消息，直接插在 assistant 之后
    for (const tc of m.toolCalls) {
      if (!answered.has(tc.id)) {
        out.push({ role: 'tool', content: DANGLING_TOOL_RESULT_TEXT, toolCallId: tc.id });
        inserted = true;
      }
    }
  }
  // 完整配对的历史原引用返回（真实 no-op——逐字节不变，调用方可安全持有引用）
  return inserted ? out : messages;
}
