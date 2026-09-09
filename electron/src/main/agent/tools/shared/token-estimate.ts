// electron/src/main/agent/tools/shared/token-estimate.ts
//
// 中文混合系数 token 估算（spec §3）：
//   - CJK 字符 ÷1.6，其余 ÷4，向上取整
//   - estimateConversation 串行汇总 system + messages（含 toolCalls JSON）+ tools 定义
//   - 三个 COMPACTION_* 常量透出（子进程与主进程共享同一份真理源）
//
// 系数理由：opencode 用 ÷4 对中文系统性低估 50%+；本实现按 spec §3
// 加权 CJK 字符，误差收敛到 ±20% 区间（足够做阈值触发决策）。
//
// 纯函数：仅依赖 string 类型运算，零 DB/IPC 副作用，子进程与主进程均可直引。

import type { LLMMessage, LLMToolDef } from '../../llm-provider';

/** 输出预留下限：阈值公式 `contextWindow - max(outputTokens, COMPACTION_BUFFER_TOKENS)` */
export const COMPACTION_BUFFER_TOKENS = 20_000;
/** 尾部保留预算：压缩后近几轮原文 verbatim 保留的 token 上限 */
export const COMPACTION_KEEP_TOKENS = 8_000;
/** 估算低于此值不触发压缩（对话太短压缩无意义） */
export const COMPACTION_MIN_TRIGGER = 4_000;

/**
 * CJK 字符识别（CJK Unified Ideographs 主块 + 扩展 A + 兼容 + 全/半角符号 + 日韩假名）。
 *
 * 不区分汉字与日韩字符——spec §3 的「CJK」统指东亚表意字符集，按字符总
 * 数加权即可。空格、ASCII 标点、拉丁字母、数字全部归入「其余」。
 *
 * 实现为纯 codepoint 范围检查（不用 /g 正则的 test()——lastIndex 副作用
 * 在循环里是雷）。
 */
function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x303f) || // CJK Symbols and Punctuation
    (code >= 0x3040 && code <= 0x309f) || // Hiragana
    (code >= 0x30a0 && code <= 0x30ff) || // Katakana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Unified Ideographs Extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs（主块）
    (code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
    (code >= 0xff00 && code <= 0xffef) // Halfwidth and Fullwidth Forms
  );
}

/**
 * 估算文本 token 数：CJK 字符 ÷1.6，其余 ÷4，向上取整。
 *
 * 实现要点：
 *   - 单次扫描按 codepoint 计数（避免 surrogate pair 重复计算造成低估）
 *   - 两部分分别求 ceil 后求和（不等价于「总字符 ceil」——保护不同
 *     CJK 比例下的精度）
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;

  let cjkCount = 0;
  let nonCjkCount = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code !== undefined && isCjkCodePoint(code)) cjkCount++;
    else nonCjkCount++;
  }

  const cjkTokens = Math.ceil(cjkCount / 1.6);
  const nonCjkTokens = Math.ceil(nonCjkCount / 4);
  return cjkTokens + nonCjkTokens;
}

/**
 * 估算整次对话的 token 数（spec §3）。
 *
 * 计算范围：
 *   - system 字符串（顶层 system prompt）
 *   - 每条 LLMMessage 的 content；assistant 角色额外累加 toolCalls.arguments 的 JSON 序列化
 *   - tools 数组中的每个工具定义（name + description + inputSchema JSON 序列化）
 *
 * 串行加法：与 estimateTokens 同系数（中文 ÷1.6，其余 ÷4），不引入
 * 跨段「消息结构开销」之类的修正项——实现简单可审计。
 */
export function estimateConversation(input: {
  system: string;
  messages: LLMMessage[];
  tools?: LLMToolDef[];
}): number {
  let total = estimateTokens(input.system);

  for (const m of input.messages) {
    total += estimateTokens(m.content ?? '');
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) {
        // 工具调用名 + JSON 参数：与 OpenAI/Anthropic 转换路径一致
        total += estimateTokens(tc.name) + estimateTokens(JSON.stringify(tc.arguments));
      }
    }
  }

  if (input.tools) {
    for (const t of input.tools) {
      total +=
        estimateTokens(t.name) +
        estimateTokens(t.description) +
        estimateTokens(JSON.stringify(t.inputSchema));
    }
  }

  return total;
}
