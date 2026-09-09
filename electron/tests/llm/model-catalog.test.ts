// electron/tests/llm/model-catalog.test.ts
//
// 内置模型窗口目录匹配表测试（压缩重构 Task 1，spec 2026-09-09 §2.2）。
//
// 锁死的契约：
//   - lookupModelLimits(platform, modelName) 按「协议平台 + 名称正则」首序匹配；
//     用户列 provider_models.context_window 优先于此表（resolve 链另有测试）。
//   - 未命中返回 null（未知窗口 → fail-safe，不做自动阈值压缩）。
//   - 1M 变体（-1m 后缀）必须先于通用 sonnet-4 条目命中（数组顺序敏感）。
//   - 返回对象是目录条目的副本（调用方改写不污染静态表）。
//
// 断言的窗口值以各厂商公开文档为准（详见 model-catalog.ts 条目来源注释）。

import { describe, it, expect } from 'vitest';
import { lookupModelLimits } from '../../src/main/llm/model-catalog';

describe('model-catalog：lookupModelLimits 匹配表', () => {
  it('openai / gpt-4o 精确命中：128000 上下文 / 16384 输出', () => {
    expect(lookupModelLimits('openai', 'gpt-4o')).toEqual({
      contextWindow: 128000,
      outputTokens: 16384,
    });
  });

  it('openai / gpt-4o 带日期后缀变体同样命中', () => {
    expect(lookupModelLimits('openai', 'gpt-4o-2024-08-06')?.contextWindow).toBe(128000);
    expect(lookupModelLimits('openai', 'gpt-4o-mini-2024-07-18')?.contextWindow).toBe(128000);
  });

  it('anthropic / claude-sonnet-4-20250514 精确命中：200000 上下文', () => {
    expect(lookupModelLimits('anthropic', 'claude-sonnet-4-20250514')).toEqual({
      contextWindow: 200000,
      outputTokens: 64000,
    });
  });

  it('完全未知的模型名返回 null（未知窗口 fail-safe）', () => {
    expect(lookupModelLimits('openai', 'totally-unknown')).toBeNull();
    expect(lookupModelLimits('anthropic', 'totally-unknown')).toBeNull();
  });

  it('空字符串与边界输入返回 null（错误路径专项）', () => {
    expect(lookupModelLimits('openai', '')).toBeNull();
    expect(lookupModelLimits('anthropic', '')).toBeNull();
  });

  it('平台不匹配返回 null：anthropic 协议下查 gpt-4o 不命中 openai 条目', () => {
    expect(lookupModelLimits('anthropic', 'gpt-4o')).toBeNull();
    expect(lookupModelLimits('openai', 'claude-sonnet-4-20250514')).toBeNull();
  });

  it('anthropic 1M 变体（-1m 后缀）命中 1M 条目而非通用 200k 条目', () => {
    const limits = lookupModelLimits('anthropic', 'claude-sonnet-4-1-20250805-1m');
    expect(limits).not.toBeNull();
    expect(limits?.contextWindow).toBe(1000000);
    expect(limits?.outputTokens).toBe(64000);
  });

  it('glm-4.7 模糊命中 glm 条目（无精确条目时落到 glm-4 通配）', () => {
    const limits = lookupModelLimits('openai', 'glm-4.7');
    expect(limits).not.toBeNull();
    expect(limits?.contextWindow).toBeGreaterThan(0);
    expect(limits?.outputTokens).toBeGreaterThan(0);
  });

  it('glm-4.6 命中 200k 专项条目（先于 glm-4 通配）', () => {
    expect(lookupModelLimits('openai', 'glm-4.6')?.contextWindow).toBe(200000);
    expect(lookupModelLimits('openai', 'glm-4.6-flash')?.contextWindow).toBe(200000);
  });

  it('返回对象是副本：调用方改写不污染目录静态表', () => {
    const first = lookupModelLimits('openai', 'gpt-4o');
    first!.contextWindow = 1;
    const second = lookupModelLimits('openai', 'gpt-4o');
    expect(second?.contextWindow).toBe(128000);
  });

  it('目录覆盖面抽查：各模型族代表均命中（≥15 条目防线）', () => {
    // OpenAI 平台（含 OpenAI 兼容协议的国产/第三方模型）
    const openaiSamples: Array<[string, number]> = [
      ['gpt-4.1', 1048576],
      ['gpt-4.1-mini', 1048576],
      ['gpt-4.1-nano', 1048576],
      ['gpt-5', 400000],
      ['gpt-5-mini', 400000],
      ['o1', 200000],
      ['o1-mini', 128000],
      ['o3', 200000],
      ['o3-mini', 200000],
      ['o4-mini', 200000],
      ['glm-4.5', 128000],
      ['deepseek-chat', 128000],
      ['deepseek-reasoner', 128000],
      ['qwen-plus', 131072],
      ['qwen-max', 32768],
      ['kimi-k2-0711-preview', 128000],
      ['gemini-2.5-pro', 1048576],
      ['gemini-2.5-flash', 1048576],
      ['gemini-2.0-flash', 1048576],
    ];
    for (const [name, window] of openaiSamples) {
      const limits = lookupModelLimits('openai', name);
      expect(limits, `openai/${name} 应命中目录`).not.toBeNull();
      expect(limits?.contextWindow, `openai/${name} 上下文窗口`).toBe(window);
    }
    // Anthropic 平台
    const anthropicSamples: Array<[string, number]> = [
      ['claude-3-5-sonnet-20241022', 200000],
      ['claude-3-5-haiku-20241022', 200000],
      ['claude-3-7-sonnet-20250219', 200000],
      ['claude-opus-4-20250514', 200000],
      ['claude-haiku-4-5-20251001', 200000],
    ];
    for (const [name, window] of anthropicSamples) {
      const limits = lookupModelLimits('anthropic', name);
      expect(limits, `anthropic/${name} 应命中目录`).not.toBeNull();
      expect(limits?.contextWindow, `anthropic/${name} 上下文窗口`).toBe(window);
    }
  });
});
