// electron/tests/agent/llm/token-bucket.test.ts
//
// ProviderTokenBucket 滑动窗口限流测试。
// 覆盖 6 个核心场景：maxRpm 满、maxTpm 满、时间窗口滚出、不限 RPM、
// usage 计数反映当前窗口、窗口滚动时部分 token 被剔除。

import { describe, it, expect } from 'vitest';
import { ProviderTokenBucket } from '../../../src/main/agent/llm/token-bucket';

describe('ProviderTokenBucket', () => {
  it('maxRpm=10：前 10 次消费通过，第 11 次拒绝', () => {
    const b = new ProviderTokenBucket({ maxRpm: 10 });
    for (let i = 0; i < 10; i++) {
      expect(b.canConsume()).toBe(true);
      b.record(100);
    }
    expect(b.canConsume()).toBe(false);
  });

  it('maxTpm=1000：累计 token 不能超过', () => {
    const b = new ProviderTokenBucket({ maxTpm: 1000 });
    expect(b.canConsume(500)).toBe(true);
    b.record(500);
    expect(b.canConsume(600)).toBe(false); // 500+600=1100 > 1000
    expect(b.canConsume(500)).toBe(true);  // 500+500=1000 OK
  });

  it('时间窗口滚出后额度恢复', () => {
    const b = new ProviderTokenBucket({ maxRpm: 5, windowMs: 60_000 });
    for (let i = 0; i < 5; i++) b.record(100);
    expect(b.canConsume()).toBe(false);
    b.__advanceTime(60_001);
    expect(b.canConsume()).toBe(true);
  });

  it('maxRpm 未设置时不限 RPM', () => {
    const b = new ProviderTokenBucket({ maxTpm: 1000 });
    for (let i = 0; i < 100; i++) {
      expect(b.canConsume(1)).toBe(true);
      b.record(1);
    }
  });

  it('getRpmUsage / getTpmUsage 反映当前窗口', () => {
    const b = new ProviderTokenBucket({ maxRpm: 10, maxTpm: 1000 });
    b.record(100);
    b.record(200);
    expect(b.getRpmUsage()).toBe(2);
    expect(b.getTpmUsage()).toBe(300);
  });

  it('部分 token 超出窗口后被剔除', () => {
    const b = new ProviderTokenBucket({ maxRpm: 10, windowMs: 60_000 });
    b.record(100);
    b.__advanceTime(30_000);
    b.record(200);
    expect(b.getRpmUsage()).toBe(2);
    b.__advanceTime(35_000); // 第一条已 > 60s
    expect(b.getRpmUsage()).toBe(1);
  });
});
