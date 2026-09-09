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

describe('守护恢复：副本语义 / 平台隔离 / 顺序敏感（Task 2 审查裁定）', () => {
  it('lookupModelLimits 返回副本——改写返回值不污染静态目录', () => {
    const a = lookupModelLimits('openai', 'gpt-4o');
    a!.contextWindow = 1;
    expect(lookupModelLimits('openai', 'gpt-4o')).toEqual({ contextWindow: 128000, outputTokens: 16384 });
  });

  it('平台隔离：openai 目录不含 claude，anthropic 目录不含 gpt', () => {
    expect(lookupModelLimits('anthropic', 'gpt-4o')).toBeNull();
    expect(lookupModelLimits('openai', 'claude-3-5-sonnet')).toBeNull();
    // 能力查询同理：跨平台未命中回 none（而非命中对方平台条目）
    expect(lookupReasoningCapability('anthropic', 'gpt-4o')).toEqual({ kind: 'none' });
  });

  it('1M 变体先于 sonnet-4 通配命中（唯一真实正则重叠的顺序对）', () => {
    expect(lookupModelLimits('anthropic', 'claude-sonnet-4-1-20250805-1m')).toEqual({ contextWindow: 1000000, outputTokens: 64000 });
    expect(lookupModelLimits('anthropic', 'claude-sonnet-4-5')).toEqual({ contextWindow: 200000, outputTokens: 64000 });
  });

  it('qwen3-max 独立于旧 qwen-max 正则（值 + 前缀分离双锁）', () => {
    expect(lookupModelLimits('openai', 'qwen3-max')).toEqual({ contextWindow: 262144, outputTokens: 65536 });
    expect(lookupModelLimits('openai', 'qwen-max')).toEqual({ contextWindow: 32768, outputTokens: 8192 });
  });

  it('kimi-k2.6 先于 kimi-k2 通配命中（重排会静默降窗）', () => {
    expect(lookupModelLimits('openai', 'kimi-k2.6')).toEqual({ contextWindow: 262144, outputTokens: 8192 });
    expect(lookupModelLimits('openai', 'kimi-k2')).toEqual({ contextWindow: 128000, outputTokens: 8192 });
  });
});
