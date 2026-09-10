// electron/src/main/llm/provider-presets.ts
//
// 供应商预设目录（spec 2026-09-09-provider-presets §2）。
// 手写静态目录，随版本发布；用户覆盖列（provider_models.context_window /
// thinking_json）是目录错误时的修正通道。
//
// 数字查证：全部 15 家已于 2026-09-09 按官方文档复核（zhipu/deepseek/moonshot/
// openai/anthropic 见 spec 附录 A；xai/gemini/dashscope/volcano-ark/mistral/groq
// 六家来源与分歧见各条目行内注释）。

/** 思维模式 wire 方言：决定请求体注入格式（spec §5.2 映射表） */
export type ThinkingWire = 'toggle' | 'toggle-effort' | 'effort' | 'anthropic-budget';

/** 模型思维模式能力词汇表（Cherry Studio ReasoningControl 精髓子集） */
export type ReasoningCapability =
  | { kind: 'none' }
  | { kind: 'toggle' }
  | { kind: 'effort'; values: readonly string[]; default: string };

/** 用户可配置的思维模式（provider_models / agent_definitions 的 thinking_json） */
export interface ThinkingConfig {
  /** auto=不发参数（厂商默认）；off=显式关闭；on=开启 */
  mode: 'auto' | 'off' | 'on';
  /** mode='on' 且模型 kind='effort' 时的档位；其余为 null */
  effort: string | null;
}

/** AGENT_CONFIG 定型后的思维配置（resolveThinkingConfig 产出，spawn 时快照） */
export interface ThinkingRequest {
  wire: ThinkingWire;
  kind: 'none' | 'toggle' | 'effort';
  mode: 'auto' | 'off' | 'on';
  effort: string | null;
}

/** 预设模型条目 */
export interface PresetModel {
  id: string;
  contextWindow: number;
  outputTokens: number;
  reasoning: ReasoningCapability;
  /** 覆写供应商级方言（缺省继承）——同一供应商混供 toggle-only 与 effort 模型时使用（如 moonshot K3） */
  thinkingWire?: ThinkingWire;
}

/** 供应商预设条目 */
export interface ProviderPreset {
  key: string;
  name: string;
  baseUrl: string;
  platform: 'openai' | 'anthropic';
  thinkingWire: ThinkingWire;
  /** 控制台 / API Key 入口（UI 引导链接） */
  docsUrl?: string;
  /** 聚合/本地商：无预设模型，创建后引导「获取模型列表」 */
  fetchListHint?: boolean;
  models: PresetModel[];
}

const GLM5_EFFORT: ReasoningCapability = { kind: 'effort', values: ['low', 'high', 'max'], default: 'max' };
const V4_EFFORT: ReasoningCapability = { kind: 'effort', values: ['low', 'high', 'max'], default: 'high' };
const CLAUDE_EFFORT: ReasoningCapability = { kind: 'effort', values: ['low', 'medium', 'high'], default: 'medium' };
const GPT5_EFFORT: ReasoningCapability = { kind: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'], default: 'medium' };
const NONE: ReasoningCapability = { kind: 'none' };

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  // ── 国内直连 ──────────────────────────────────────────────────────────────
  {
    key: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    platform: 'openai', thinkingWire: 'toggle-effort',
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: [
      { id: 'glm-5.3', contextWindow: 1_000_000, outputTokens: 128_000, reasoning: GLM5_EFFORT },
      { id: 'glm-5.2', contextWindow: 1_000_000, outputTokens: 128_000, reasoning: GLM5_EFFORT },
      { id: 'glm-4.7', contextWindow: 200_000, outputTokens: 96_000, reasoning: { kind: 'toggle' } },
      { id: 'glm-4.6', contextWindow: 200_000, outputTokens: 96_000, reasoning: { kind: 'toggle' } },
      { id: 'glm-4.5', contextWindow: 128_000, outputTokens: 96_000, reasoning: { kind: 'toggle' } },
    ],
  },
  {
    key: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com',
    platform: 'openai', thinkingWire: 'toggle-effort',
    docsUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { id: 'deepseek-v4-pro', contextWindow: 1_000_000, outputTokens: 384_000, reasoning: V4_EFFORT },
      { id: 'deepseek-v4-flash', contextWindow: 1_000_000, outputTokens: 65_536, reasoning: V4_EFFORT },
      { id: 'deepseek-chat', contextWindow: 128_000, outputTokens: 8_192, reasoning: NONE },
      { id: 'deepseek-reasoner', contextWindow: 128_000, outputTokens: 32_768, reasoning: NONE },
    ],
  },
  {
    key: 'moonshot', name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.ai/v1',
    platform: 'openai', thinkingWire: 'toggle-effort',
    docsUrl: 'https://platform.moonshot.cn/console/api-keys',
    models: [
      // K3 顶层 reasoning_effort、无 thinking 开关 → 模型级覆写 'effort' 方言
      { id: 'kimi-k3', contextWindow: 1_000_000, outputTokens: 32_768, reasoning: { kind: 'effort', values: ['low', 'high', 'max'], default: 'max' }, thinkingWire: 'effort' },
      { id: 'kimi-k2.6', contextWindow: 262_144, outputTokens: 8_192, reasoning: { kind: 'effort', values: ['low', 'high', 'max'], default: 'high' } },
      { id: 'kimi-k2', contextWindow: 128_000, outputTokens: 8_192, reasoning: NONE },
    ],
  },
  {
    key: 'dashscope', name: '通义千问（百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    platform: 'openai', thinkingWire: 'effort',
    docsUrl: 'https://bailian.console.aliyun.com/',
    models: [
      // 来源 help.aliyun.com qwen3-max / qwen-plus 模型页。qwen3-max 思考模式输出上限
      // 32_768，目录按通用档 65_536 记录（用户覆盖列可下修）
      { id: 'qwen3-max', contextWindow: 262_144, outputTokens: 65_536, reasoning: NONE },
      { id: 'qwen-plus', contextWindow: 1_000_000, outputTokens: 32_768, reasoning: NONE },
    ],
  },
  {
    key: 'volcano-ark', name: '火山方舟（豆包）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    platform: 'openai', thinkingWire: 'effort',
    docsUrl: 'https://console.volcengine.com/ark',
    models: [
      // 来源 developer.volcengine.com Seed1.6 技术介绍 + 发布文章。两个条目 id
      // 改为可查证形态：默认输出上限 4K，按最大档 16_384 记录（用户覆盖列可下修）
      { id: 'doubao-seed-1-6-250615', contextWindow: 256_000, outputTokens: 16_384, reasoning: NONE },
      { id: 'doubao-seed-1-6-flash-250615', contextWindow: 256_000, outputTokens: 16_384, reasoning: NONE },
    ],
  },
  // ── 国际直连 ──────────────────────────────────────────────────────────────
  {
    key: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
    platform: 'openai', thinkingWire: 'effort',
    docsUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-5.2', contextWindow: 400_000, outputTokens: 128_000, reasoning: GPT5_EFFORT },
      { id: 'gpt-5.1', contextWindow: 400_000, outputTokens: 128_000, reasoning: { kind: 'effort', values: ['none', 'low', 'medium', 'high'], default: 'medium' } },
      { id: 'gpt-5-mini', contextWindow: 400_000, outputTokens: 128_000, reasoning: { kind: 'effort', values: ['none', 'low', 'medium', 'high'], default: 'medium' } },
      { id: 'gpt-4.1', contextWindow: 1_048_576, outputTokens: 32_768, reasoning: NONE },
      { id: 'gpt-4o', contextWindow: 128_000, outputTokens: 16_384, reasoning: NONE },
    ],
  },
  {
    key: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com',
    platform: 'anthropic', thinkingWire: 'anthropic-budget',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-opus-4-5', contextWindow: 200_000, outputTokens: 32_000, reasoning: CLAUDE_EFFORT },
      { id: 'claude-sonnet-4-5', contextWindow: 200_000, outputTokens: 64_000, reasoning: CLAUDE_EFFORT },
      { id: 'claude-haiku-4-5', contextWindow: 200_000, outputTokens: 64_000, reasoning: CLAUDE_EFFORT },
    ],
  },
  {
    key: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    platform: 'openai', thinkingWire: 'effort',
    docsUrl: 'https://aistudio.google.com/apikey',
    models: [
      // 来源 ai.google.dev/gemini-api/docs/openai + /gemini-3：OpenAI 兼容端点接受
      // reasoning_effort 并映射 thinking_level。Pro 仅支持 low/high（medium 会被 Pro
      // 拒绝，Google 论坛官方回复确认）。
      { id: 'gemini-3.1-pro-preview', contextWindow: 1_048_576, outputTokens: 65_536, reasoning: { kind: 'effort', values: ['low', 'high'], default: 'high' } },
      { id: 'gemini-3-flash-preview', contextWindow: 1_048_576, outputTokens: 65_536, reasoning: { kind: 'effort', values: ['low', 'medium', 'high'], default: 'high' } },
    ],
  },
  {
    key: 'xai', name: 'xAI Grok', baseUrl: 'https://api.x.ai/v1',
    platform: 'openai', thinkingWire: 'effort',
    docsUrl: 'https://console.x.ai',
    models: [
      // grok-4.6 来源 docs.x.ai/developers/grok-4-6 + release notes：contextWindow 500K；
      // 官方标注「无文本输出上限」，按上下文窗口档记录 outputTokens=500K
      { id: 'grok-4.6', contextWindow: 500_000, outputTokens: 500_000, reasoning: { kind: 'effort', values: ['low', 'medium', 'high', 'xhigh'], default: 'high' } },
    ],
  },
  {
    key: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1',
    platform: 'openai', thinkingWire: 'effort',
    docsUrl: 'https://console.mistral.ai/api-keys',
    models: [
      // 来源 Gate.AI Large 3 model card + Sim/FutureAGI 收录，存在分歧取保守值。
      // Large 3 model card 256K；输出上限各来源不一致，按保守 8K 记录。
      { id: 'mistral-large-latest', contextWindow: 262_144, outputTokens: 8_192, reasoning: NONE },
      // magistral-medium 收录 128K；旧版 1.2 为 40K，按最新收录档记录
      { id: 'magistral-medium-latest', contextWindow: 128_000, outputTokens: 8_192, reasoning: NONE },
    ],
  },
  {
    key: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1',
    platform: 'openai', thinkingWire: 'effort',
    docsUrl: 'https://console.groq.com/keys',
    models: [
      // 来源 console.groq.com/docs/models 官方表。llama-3.3-70b 窗口/输出吻合；
      // openai/gpt-oss-120b MAX COMPLETION 65_536（原 32_768 修正）
      { id: 'llama-3.3-70b-versatile', contextWindow: 131_072, outputTokens: 32_768, reasoning: NONE },
      { id: 'openai/gpt-oss-120b', contextWindow: 131_072, outputTokens: 65_536, reasoning: NONE },
    ],
  },
  // ── 聚合 / 本地 ────────────────────────────────────────────────────────────
  { key: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', platform: 'openai', thinkingWire: 'effort', docsUrl: 'https://openrouter.ai/settings/keys', fetchListHint: true, models: [] },
  { key: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', platform: 'openai', thinkingWire: 'effort', docsUrl: 'https://cloud.siliconflow.cn/account/ak', fetchListHint: true, models: [] },
  { key: 'ollama', name: 'Ollama（本地）', baseUrl: 'http://localhost:11434/v1', platform: 'openai', thinkingWire: 'toggle', docsUrl: 'https://ollama.com', fetchListHint: true, models: [] },
  { key: 'lmstudio', name: 'LM Studio（本地）', baseUrl: 'http://localhost:1234/v1', platform: 'openai', thinkingWire: 'effort', docsUrl: 'https://lmstudio.ai', fetchListHint: true, models: [] },
];

/** 全量预设（IPC provider:listPresets 直接返回） */
export function listProviderPresets(): readonly ProviderPreset[] {
  return PROVIDER_PRESETS;
}

export function getProviderPreset(key: string): ProviderPreset | null {
  return PROVIDER_PRESETS.find((p) => p.key === key) ?? null;
}

export function getPresetModel(key: string, modelId: string): PresetModel | null {
  return getProviderPreset(key)?.models.find((m) => m.id === modelId) ?? null;
}

/** thinking_json 列的形状守卫：非法 / 缺失返回 null（DB 坏值不炸，回退 auto） */
export function parseThinkingConfig(raw: unknown): ThinkingConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.mode === 'auto' || o.mode === 'off') return { mode: o.mode, effort: null };
  if (o.mode === 'on') {
    return typeof o.effort === 'string' || o.effort === null
      ? { mode: 'on', effort: o.effort }
      : null;
  }
  return null;
}

/** AGENT_CONFIG 线协议守卫（runtime-config parseConfig 用） */
export function isThinkingRequest(v: unknown): v is ThinkingRequest {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const wires = ['toggle', 'toggle-effort', 'effort', 'anthropic-budget'];
  const kinds = ['none', 'toggle', 'effort'];
  const modes = ['auto', 'off', 'on'];
  return (
    typeof o.wire === 'string' && wires.includes(o.wire) &&
    typeof o.kind === 'string' && kinds.includes(o.kind) &&
    typeof o.mode === 'string' && modes.includes(o.mode) &&
    (o.effort === null || typeof o.effort === 'string')
  );
}
