// electron/tests/llm/provider-presets-vision.test.ts
//
// 预设 vision 能力标志（spec 2026-09-26-image-input-multimodal §3）：
// 全表快照机械强制——手写目录随版本发布，条目漂移在测试层拦截。
import { describe, it, expect } from 'vitest';
import {
  PROVIDER_PRESETS,
  getPresetModel,
} from '../../src/main/llm/provider-presets';

/** spec §3.1 + §3.2 期望全表：true=有 vision；undefined=未打标（缺省 false） */
const EXPECTED_VISION: Record<string, Record<string, boolean | undefined>> = {
  zhipu: {
    'glm-5.3': true,
    'glm-5.3-flash': true,
    'glm-5.3-flashx': true,
    'glm-5.2': undefined,
    'glm-4.7': undefined,
    'glm-4.6': undefined,
    'glm-4.5': undefined,
    'glm-4.6v': true,
    'glm-4.6v-flash': true,
  },
  deepseek: {
    'deepseek-v4-pro': undefined,
    'deepseek-v4-flash': true,
    'deepseek-chat': undefined,
    'deepseek-reasoner': undefined,
  },
  moonshot: {
    'kimi-k3': true,
    'kimi-k2.6': true,
    'kimi-k2': undefined,
  },
  dashscope: {
    'qwen3-max': true,
    'qwen-plus': true,
  },
  'volcano-ark': {
    'doubao-seed-1-6-250615': true,
    'doubao-seed-1-6-flash-250615': true,
  },
  openai: {
    'gpt-5.2': true,
    'gpt-5.1': true,
    'gpt-5-mini': true,
    'gpt-4.1': true,
    'gpt-4o': true,
  },
  anthropic: {
    'claude-opus-4-5': true,
    'claude-sonnet-4-5': true,
    'claude-haiku-4-5': true,
  },
  gemini: {
    'gemini-3.1-pro-preview': true,
    'gemini-3-flash-preview': true,
  },
  xai: {
    'grok-4.6': true,
  },
  mistral: {
    'mistral-large-latest': undefined,
    'magistral-medium-latest': true,
  },
  groq: {
    'llama-3.3-70b-versatile': undefined,
    'openai/gpt-oss-120b': undefined,
    'qwen/qwen3.8-27b': true,
  },
};

describe('provider-presets vision 能力标志（spec §3）', () => {
  it('vision 全表快照：逐供应商逐模型与 spec §3.1/§3.2 完全一致', () => {
    const actual: Record<string, Record<string, boolean | undefined>> = {};
    for (const p of PROVIDER_PRESETS) {
      if (p.models.length === 0) continue; // 聚合/本地商无预设模型
      const row: Record<string, boolean | undefined> = {};
      for (const m of p.models) row[m.id] = m.vision;
      actual[p.key] = row;
    }
    // toStrictEqual 而非 toEqual：undefined 值的键也参与比较，
    // 否则「新增无 vision 条目」/「误删条目」两类漂移依然绿（toEqual 忽略 undefined 键）
    expect(actual).toStrictEqual(EXPECTED_VISION);
  });

  it('2026-09-26 补录 zhipu glm-5.3-flash / flashx：1M 窗口 / 128K 输出 / effort / vision（官方文档）', () => {
    for (const id of ['glm-5.3-flash', 'glm-5.3-flashx']) {
      const m = getPresetModel('zhipu', id);
      expect(m?.contextWindow).toBe(1_000_000);
      expect(m?.outputTokens).toBe(128_000);
      expect(m?.vision).toBe(true);
      expect(m?.reasoning).toEqual({ kind: 'effort', values: ['low', 'high', 'max'], default: 'max' });
    }
  });

  it('新增 zhipu glm-4.6v：128K 窗口 / 32K 输出（保守档）/ NONE / vision', () => {
    const m = getPresetModel('zhipu', 'glm-4.6v');
    expect(m).not.toBeNull();
    expect(m!.contextWindow).toBe(131_072);
    expect(m!.outputTokens).toBe(32_768);
    expect(m!.vision).toBe(true);
    expect(m!.reasoning).toEqual({ kind: 'none' });
  });

  it('新增 zhipu glm-4.6v-flash：128K 窗口 / 16K 输出（保守档）/ vision', () => {
    const m = getPresetModel('zhipu', 'glm-4.6v-flash');
    expect(m).not.toBeNull();
    expect(m!.contextWindow).toBe(131_072);
    expect(m!.outputTokens).toBe(16_384);
    expect(m!.vision).toBe(true);
    expect(m!.reasoning).toEqual({ kind: 'none' });
  });

  it('新增 groq qwen/qwen3.8-27b：131K 窗口 / 32K 输出 / vision', () => {
    const m = getPresetModel('groq', 'qwen/qwen3.8-27b');
    expect(m).not.toBeNull();
    expect(m!.contextWindow).toBe(131_072);
    expect(m!.outputTokens).toBe(32_768);
    expect(m!.vision).toBe(true);
    expect(m!.reasoning).toEqual({ kind: 'none' });
  });

  it('未打标条目 vision 为 undefined（缺省 false 语义）', () => {
    expect(getPresetModel('zhipu', 'glm-4.6')?.vision).toBeUndefined();
    expect(getPresetModel('groq', 'llama-3.3-70b-versatile')?.vision).toBeUndefined();
  });
});
