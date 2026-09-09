// electron/tests/llm/model-catalog.test.ts
//
// 正则兜底层能力查询 + 旗舰缺位补齐（spec §4）：
// 预设表未命中的模型（自定义供应商 / 拉取的未知模型）经此层拿到能力与窗口。
import { describe, it, expect } from 'vitest';
import { lookupModelLimits, lookupReasoningCapability } from '../../src/main/llm/model-catalog';

describe('旗舰补位：窗口目录新条目', () => {
  it('glm-5.x：1M 上下文（须先于 glm-4 通配命中）', () => {
    expect(lookupModelLimits('openai', 'glm-5.3')).toEqual({ contextWindow: 1_000_000, outputTokens: 128_000 });
  });
  it('deepseek-v4：1M / 384K（须先于 chat/reasoner 命中）', () => {
    expect(lookupModelLimits('openai', 'deepseek-v4-pro')).toEqual({ contextWindow: 1_000_000, outputTokens: 384_000 });
  });
  it('kimi-k3：1M', () => {
    expect(lookupModelLimits('openai', 'kimi-k3')).toEqual({ contextWindow: 1_000_000, outputTokens: 32_768 });
  });
  it('gpt-5.2 带版本号变体命中 gpt-5 家族', () => {
    expect(lookupModelLimits('openai', 'gpt-5.2')?.contextWindow).toBe(400_000);
    expect(lookupModelLimits('openai', 'gpt-5')?.contextWindow).toBe(400_000);
  });
  it('gemini-3 命中新条目', () => {
    expect(lookupModelLimits('openai', 'gemini-3-pro-preview')).toEqual({ contextWindow: 1_048_576, outputTokens: 65_536 });
  });
});

describe('lookupReasoningCapability：正则兜底能力查询', () => {
  it('glm-5.x → effort low/high/max；glm-4.x → toggle', () => {
    expect(lookupReasoningCapability('openai', 'glm-5.2')).toEqual({ kind: 'effort', values: ['low', 'high', 'max'], default: 'max' });
    expect(lookupReasoningCapability('openai', 'glm-4.6')).toEqual({ kind: 'toggle' });
  });
  it('deepseek-v4 → effort；deepseek-chat → none', () => {
    expect(lookupReasoningCapability('openai', 'deepseek-v4-flash')).toEqual({ kind: 'effort', values: ['low', 'high', 'max'], default: 'high' });
    expect(lookupReasoningCapability('openai', 'deepseek-chat')).toEqual({ kind: 'none' });
  });
  it('kimi-k3 → effort；kimi-k2 → none', () => {
    expect(lookupReasoningCapability('openai', 'kimi-k3').kind).toBe('effort');
    expect(lookupReasoningCapability('openai', 'kimi-k2').kind).toBe('none');
  });
  it('o3 / claude → effort；gpt-4o → none；未收录 → none', () => {
    expect(lookupReasoningCapability('openai', 'o3').kind).toBe('effort');
    expect(lookupReasoningCapability('anthropic', 'claude-sonnet-4-5')).toEqual({ kind: 'effort', values: ['low', 'medium', 'high'], default: 'medium' });
    expect(lookupReasoningCapability('openai', 'gpt-4o')).toEqual({ kind: 'none' });
    expect(lookupReasoningCapability('openai', 'my-private-model')).toEqual({ kind: 'none' });
  });
});
