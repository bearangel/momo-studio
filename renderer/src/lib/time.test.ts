// renderer/src/lib/time.test.ts
import { describe, expect, it } from 'vitest';
import { formatHHmm } from './time';

// 用本地时区构造的 Date 断言（实现读本地 getHours/getMinutes——不钉 UTC 时移）
describe('formatHHmm（2026-11-13 自 MessageFrame 下沉单源）', () => {
  it('个位时/分零填充：09:05', () => {
    expect(formatHHmm(new Date(2026, 0, 1, 9, 5).getTime())).toBe('09:05');
  });

  it('23:59 边界原样', () => {
    expect(formatHHmm(new Date(2026, 5, 15, 23, 59).getTime())).toBe('23:59');
  });

  it('00:00 边界双零填充', () => {
    expect(formatHHmm(new Date(2026, 5, 15, 0, 0).getTime())).toBe('00:00');
  });
});
