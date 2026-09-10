// electron/src/main/llm/model-catalog.ts
//
// 内置模型窗口目录（压缩重构 spec 2026-09-09 §2.2）。
// 按「LLM 协议平台 + 名称正则」首序匹配静态表，产出上下文窗口与输出上限
// + 思维模式能力（v31 起，spec §4）。
//
// 优先级：provider_models.context_window（用户手动覆盖，migration v30 起）
//   → 本目录 → null（未知）。resolve 链见 spawn-helpers.ts resolveModelLimits。
//
// 窗口值查证于各厂商公开文档（查证时间 2026-09-09，见各分组来源注释）。
// 目录是静态默认值：厂商调整限额或接入代理变体时，用户列覆盖是修正通道。
// 条目顺序敏感——专项条目（如 1M 变体、glm-5/deepseek-v4 等旗舰）必须排在
// 通配条目之前；lookupReasoningCapability 与 lookupModelLimits 走同一表。

import type { ReasoningCapability } from './provider-presets';

/** 模型容量上限（token） */
export interface ModelLimits {
  contextWindow: number;
  outputTokens: number;
}

/** 协议平台：与 provider-crud.ts ProviderPlatform 对齐（决定请求体格式，非厂商归属） */
type CatalogPlatform = 'openai' | 'anthropic';

interface CatalogEntry {
  platform: CatalogPlatform;
  pattern: RegExp;
  limits: ModelLimits;
  /** v31：思维模式能力（预设表命中优先于本层，spec §4） */
  reasoning: ReasoningCapability;
}

const CATALOG: CatalogEntry[] = [
  // ── OpenAI 官方（platform.openai.com 模型页，2026-09 查证）───────────────
  // gpt-4o / 4o-mini：128K 上下文，16,384 输出；带 -YYYY-MM-DD 日期变体同规格。
  {
    platform: 'openai',
    pattern: /^gpt-4o(-mini)?(-\d{4}-\d{2}-\d{2})?$/,
    limits: { contextWindow: 128000, outputTokens: 16384 },
    reasoning: { kind: 'none' },
  },
  // gpt-4.1 全系：1,047,576 上下文，32,768 输出。
  {
    platform: 'openai',
    pattern: /^gpt-4\.1(-mini|-nano)?$/,
    limits: { contextWindow: 1048576, outputTokens: 32768 },
    reasoning: { kind: 'none' },
  },
  // gpt-5 全系：400K 总窗口（272K 输入 + 128K 输出）；含 5.1/5.2 带点变体。
  {
    platform: 'openai',
    pattern: /^gpt-5(\.\d)?(-chat|-mini|-nano)?$/,
    limits: { contextWindow: 400000, outputTokens: 128000 },
    reasoning: { kind: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'], default: 'medium' },
  },
  {
    platform: 'openai',
    pattern: /^o1$/,
    limits: { contextWindow: 200000, outputTokens: 100000 },
    reasoning: { kind: 'effort', values: ['low', 'medium', 'high'], default: 'medium' },
  },
  {
    platform: 'openai',
    pattern: /^o1-mini(-\d{4}-\d{2}-\d{2})?$/,
    limits: { contextWindow: 128000, outputTokens: 65536 },
    reasoning: { kind: 'effort', values: ['low', 'medium', 'high'], default: 'medium' },
  },
  // o3 / o3-mini / o4-mini：200K 上下文，100K 输出。
  {
    platform: 'openai',
    pattern: /^o[34](-mini)?(-\d{4}-\d{2}-\d{2})?$/,
    limits: { contextWindow: 200000, outputTokens: 100000 },
    reasoning: { kind: 'effort', values: ['low', 'medium', 'high'], default: 'medium' },
  },

  // ── Anthropic 官方（docs.anthropic.com 模型概览，2026-09 查证）────────────
  // 1M 上下文变体（-1m 后缀，beta 长上下文）：必须先于通用 sonnet-4 条目命中。
  {
    platform: 'anthropic',
    pattern: /^claude-sonnet-4[\w.-]*-1m$/,
    limits: { contextWindow: 1000000, outputTokens: 64000 },
    reasoning: { kind: 'effort', values: ['low', 'medium', 'high'], default: 'medium' },
  },
  // claude 3.5 系：200K 上下文，8,192 输出。
  {
    platform: 'anthropic',
    pattern: /^claude-3-5-sonnet(-\d{8})?$/,
    limits: { contextWindow: 200000, outputTokens: 8192 },
    reasoning: { kind: 'effort', values: ['low', 'medium', 'high'], default: 'medium' },
  },
  {
    platform: 'anthropic',
    pattern: /^claude-3-5-haiku(-\d{8})?$/,
    limits: { contextWindow: 200000, outputTokens: 8192 },
    reasoning: { kind: 'effort', values: ['low', 'medium', 'high'], default: 'medium' },
  },
  // claude-3-7-sonnet：200K 上下文，64K 输出（128K 输出需 beta 头，目录按标准档）。
  {
    platform: 'anthropic',
    pattern: /^claude-3-7-sonnet(-\d{8})?$/,
    limits: { contextWindow: 200000, outputTokens: 64000 },
    reasoning: { kind: 'effort', values: ['low', 'medium', 'high'], default: 'medium' },
  },
  // claude sonnet 4 系（4 / 4.1 / 4.5）：200K 上下文，64K 输出。
  {
    platform: 'anthropic',
    pattern: /^claude-sonnet-4/,
    limits: { contextWindow: 200000, outputTokens: 64000 },
    reasoning: { kind: 'effort', values: ['low', 'medium', 'high'], default: 'medium' },
  },
  // claude opus 4 系：200K 上下文，32K 输出。
  {
    platform: 'anthropic',
    pattern: /^claude-opus-4/,
    limits: { contextWindow: 200000, outputTokens: 32000 },
    reasoning: { kind: 'effort', values: ['low', 'medium', 'high'], default: 'medium' },
  },
  // claude haiku 4 系：200K 上下文，64K 输出。
  {
    platform: 'anthropic',
    pattern: /^claude-haiku-4/,
    limits: { contextWindow: 200000, outputTokens: 64000 },
    reasoning: { kind: 'effort', values: ['low', 'medium', 'high'], default: 'medium' },
  },

  // ── OpenAI 兼容协议的第三方模型（platform 记 'openai'）───────────────────
  // 智谱 GLM（bigmodel.cn 模型文档，2026-09 查证）：glm-5 系 1M 上下文，128K 输出；
  // effort 档位 low/high/max；glm-4.6/4.7 200K 上下文，96K 最大输出（4.7 与预设表
  // 同值，终审 M-1 对齐）；glm-4.5 及更早 4.x 为 128K。
  {
    platform: 'openai',
    pattern: /^glm-5(\.\d)?/,
    limits: { contextWindow: 1000000, outputTokens: 128000 },
    reasoning: { kind: 'effort', values: ['low', 'high', 'max'], default: 'max' },
  },
  {
    platform: 'openai',
    pattern: /^glm-4\.[67]/,
    limits: { contextWindow: 200000, outputTokens: 96000 },
    reasoning: { kind: 'toggle' },
  },
  {
    platform: 'openai',
    pattern: /^glm-4/,
    limits: { contextWindow: 128000, outputTokens: 96000 },
    reasoning: { kind: 'toggle' },
  },
  // DeepSeek（api-docs.deepseek.com，2026-09 查证）：v4 系 1M 上下文 / 384K 输出，
  // effort 档位 low/high/max；chat/reasoner 旧档 128K 上下文，chat 8K 输出，
  // reasoner（R1-0528 起）32K 输出。
  {
    platform: 'openai',
    pattern: /^deepseek-v4/,
    limits: { contextWindow: 1000000, outputTokens: 384000 },
    reasoning: { kind: 'effort', values: ['low', 'high', 'max'], default: 'high' },
  },
  {
    platform: 'openai',
    pattern: /^deepseek-chat/,
    limits: { contextWindow: 128000, outputTokens: 8192 },
    reasoning: { kind: 'none' },
  },
  {
    platform: 'openai',
    pattern: /^deepseek-reasoner/,
    limits: { contextWindow: 128000, outputTokens: 32768 },
    reasoning: { kind: 'none' },
  },
  // 通义千问（阿里云百炼模型列表，2026-09 查证）：qwen3-max 256K 上下文 / 65536 输出；
  // qwen-plus 1M 上下文（终审 M-1 对齐：预设表查证 1M，旧快照 131072 已过时）；
  // qwen-max 历史档 32K。输出未注明则 8K。
  {
    platform: 'openai',
    pattern: /^qwen3-max/,
    limits: { contextWindow: 262144, outputTokens: 65536 },
    reasoning: { kind: 'none' },
  },
  {
    platform: 'openai',
    pattern: /^qwen-plus/,
    limits: { contextWindow: 1000000, outputTokens: 8192 },
    reasoning: { kind: 'none' },
  },
  {
    platform: 'openai',
    pattern: /^qwen-max/,
    limits: { contextWindow: 32768, outputTokens: 8192 },
    reasoning: { kind: 'none' },
  },
  // Kimi（platform.moonshot.cn 模型文档，2026-09 查证）：kimi-k3 1M 上下文 / 32K 输出，
  // effort 档位 low/high/max；kimi-k2.6 256K 上下文 / 8K 输出，effort low/high/max；
  // kimi-k2 历史档 128K 上下文 / 8K 输出。
  {
    platform: 'openai',
    pattern: /^kimi-k3/,
    limits: { contextWindow: 1000000, outputTokens: 32768 },
    reasoning: { kind: 'effort', values: ['low', 'high', 'max'], default: 'max' },
  },
  {
    platform: 'openai',
    pattern: /^kimi-k2\.6/,
    limits: { contextWindow: 262144, outputTokens: 8192 },
    reasoning: { kind: 'effort', values: ['low', 'high', 'max'], default: 'high' },
  },
  {
    platform: 'openai',
    pattern: /^kimi-k2/,
    limits: { contextWindow: 128000, outputTokens: 8192 },
    reasoning: { kind: 'none' },
  },
  // Google Gemini（ai.google.dev 模型页，2026-09 查证；经 OpenAI 兼容端点接入）：
  // 3 系 1M 上下文 / 65,536 输出；2.5 系 1M 上下文 / 65,536 输出；
  // 2.0-flash 1M 上下文 / 8,192 输出。gemini-3 OpenAI 兼容端点接受 reasoning_effort
  // 并映射 thinking_level（终审 M-1 对齐预设表）；Pro 仅 low/high（medium 被拒），
  // 通用正则条目取保守档位集。
  {
    platform: 'openai',
    pattern: /^gemini-3/,
    limits: { contextWindow: 1048576, outputTokens: 65536 },
    reasoning: { kind: 'effort', values: ['low', 'high'], default: 'high' },
  },
  {
    platform: 'openai',
    pattern: /^gemini-2\.5-pro/,
    limits: { contextWindow: 1048576, outputTokens: 65536 },
    reasoning: { kind: 'none' },
  },
  {
    platform: 'openai',
    pattern: /^gemini-2\.5-flash/,
    limits: { contextWindow: 1048576, outputTokens: 65536 },
    reasoning: { kind: 'none' },
  },
  {
    platform: 'openai',
    pattern: /^gemini-2\.0-flash/,
    limits: { contextWindow: 1048576, outputTokens: 8192 },
    reasoning: { kind: 'none' },
  },
];

/**
 * 按协议平台 + 模型名查内置窗口目录；未命中返回 null（未知窗口）。
 * 返回目录条目的副本，调用方可安全改写。
 */
export function lookupModelLimits(
  platform: 'openai' | 'anthropic',
  modelName: string,
): ModelLimits | null {
  for (const e of CATALOG) {
    if (e.platform === platform && e.pattern.test(modelName)) {
      return { ...e.limits };
    }
  }
  return null;
}

/**
 * 按协议平台 + 模型名查思维模式能力（正则兜底层）；未命中返回 none。
 * 优先级低于预设模型表（provider-presets，spec §4）。
 */
export function lookupReasoningCapability(
  platform: 'openai' | 'anthropic',
  modelName: string,
): ReasoningCapability {
  for (const e of CATALOG) {
    if (e.platform === platform && e.pattern.test(modelName)) {
      return e.reasoning;
    }
  }
  return { kind: 'none' };
}
