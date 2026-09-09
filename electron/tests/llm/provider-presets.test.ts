// electron/tests/llm/provider-presets.test.ts
//
// 预设目录数据完整性（spec §9）：schema 合法性机械强制——
// 手写目录随版本发布，错误在测试层拦截，不流入运行时。
import { describe, it, expect } from 'vitest';
import {
  PROVIDER_PRESETS,
  getProviderPreset,
  getPresetModel,
  parseThinkingConfig,
  isThinkingRequest,
} from '../../src/main/llm/provider-presets';

const WIRES = ['toggle', 'toggle-effort', 'effort', 'anthropic-budget'];

describe('provider-presets 数据完整性', () => {
  it('key 全局唯一', () => {
    const keys = PROVIDER_PRESETS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('baseUrl 全部合法 http(s) URL', () => {
    for (const p of PROVIDER_PRESETS) {
      const u = new URL(p.baseUrl); // 非法即抛
      expect(['http:', 'https:']).toContain(u.protocol);
    }
  });

  it('每家：platform 合法、方言合法、模型 id 供应商内唯一', () => {
    for (const p of PROVIDER_PRESETS) {
      expect(['openai', 'anthropic']).toContain(p.platform);
      expect(WIRES).toContain(p.thinkingWire);
      const ids = p.models.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('每模型：窗口正整数、能力形状合法、default ∈ values', () => {
    for (const p of PROVIDER_PRESETS) {
      for (const m of p.models) {
        expect(m.contextWindow).toBeGreaterThan(0);
        expect(m.outputTokens).toBeGreaterThan(0);
        if (m.reasoning.kind === 'effort') {
          expect(m.reasoning.values.length).toBeGreaterThan(0);
          expect(m.reasoning.values).toContain(m.reasoning.default);
        }
        if (m.thinkingWire !== undefined) expect(WIRES).toContain(m.thinkingWire);
      }
    }
  });

  it('fetchListHint 商无预设模型（聚合/本地商引导拉取）', () => {
    for (const p of PROVIDER_PRESETS) {
      if (p.fetchListHint) expect(p.models).toHaveLength(0);
    }
  });

  it('收录 ≥15 家且覆盖用户点名的 glm/deepseek/moonshot', () => {
    expect(PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(15);
    for (const k of ['zhipu', 'deepseek', 'moonshot']) {
      expect(getProviderPreset(k)).not.toBeNull();
    }
  });
});

describe('查找与解析', () => {
  it('getProviderPreset 未知 key 返回 null', () => {
    expect(getProviderPreset('nope')).toBeNull();
  });
  it('getPresetModel 命中预设模型（kimi-k3 带方言覆写）', () => {
    const m = getPresetModel('moonshot', 'kimi-k3');
    expect(m?.thinkingWire).toBe('effort');
    expect(m?.reasoning.kind).toBe('effort');
  });
  it('parseThinkingConfig：合法形状 / 非法返回 null', () => {
    expect(parseThinkingConfig({ mode: 'auto', effort: null })).toEqual({ mode: 'auto', effort: null });
    expect(parseThinkingConfig({ mode: 'on', effort: 'high' })).toEqual({ mode: 'on', effort: 'high' });
    expect(parseThinkingConfig({ mode: 'off', effort: 'high' })).toEqual({ mode: 'off', effort: null });
    expect(parseThinkingConfig(null)).toBeNull();
    expect(parseThinkingConfig({ mode: 'bad' })).toBeNull();
    expect(parseThinkingConfig('x')).toBeNull();
  });
  it('isThinkingRequest：结构守卫', () => {
    expect(isThinkingRequest({ wire: 'effort', kind: 'effort', mode: 'on', effort: 'low' })).toBe(true);
    expect(isThinkingRequest({ wire: 'bad', kind: 'effort', mode: 'on', effort: 'low' })).toBe(false);
    expect(isThinkingRequest(undefined)).toBe(false);
  });
});