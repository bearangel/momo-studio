import { describe, it, expect } from 'vitest';
import { serializeRecurrence, humanizeRecurrence } from './recurrence';

describe('serializeRecurrence', () => {
  it('once → null；every/daily/weekly 序列化', () => {
    expect(serializeRecurrence({ kind: 'once' })).toBeNull();
    expect(serializeRecurrence({ kind: 'every', everyN: 30, everyUnit: 'm' })).toBe('every:30m');
    expect(serializeRecurrence({ kind: 'daily', time: '09:00' })).toBe('daily@09:00');
    expect(serializeRecurrence({ kind: 'weekly', weekday: 1, time: '09:00' })).toBe('weekly@1,09:00');
  });
});

describe('humanizeRecurrence', () => {
  it('三种规则 + 未知规则回退原文', () => {
    expect(humanizeRecurrence('every:30m')).toBe('每 30 分钟');
    expect(humanizeRecurrence('every:2h')).toBe('每 2 小时');
    expect(humanizeRecurrence('daily@09:00')).toBe('每天 09:00');
    expect(humanizeRecurrence('weekly@1,09:00')).toBe('每周一 09:00');
    expect(humanizeRecurrence('???')).toBe('???');
  });
});
