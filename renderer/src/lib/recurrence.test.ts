import { describe, it, expect } from 'vitest';
import {
  serializeRecurrence,
  parseRecurrence,
  humanizeRecurrence,
  type RecurrencePreset,
} from './recurrence';

describe('serializeRecurrence', () => {
  it('once → null；every/daily/weekly 序列化', () => {
    expect(serializeRecurrence({ kind: 'once' })).toBeNull();
    expect(serializeRecurrence({ kind: 'every', everyN: 30, everyUnit: 'm' })).toBe('every:30m');
    expect(serializeRecurrence({ kind: 'daily', time: '09:00' })).toBe('daily@09:00');
    expect(serializeRecurrence({ kind: 'weekly', weekday: 1, time: '09:00' })).toBe('weekly@1,09:00');
  });
});

describe('parseRecurrence（K5 编辑预填反解析）', () => {
  it('三种规则 + null/未知格式回退 once', () => {
    expect(parseRecurrence('every:30m')).toEqual({ kind: 'every', everyN: 30, everyUnit: 'm' });
    expect(parseRecurrence('every:2h')).toEqual({ kind: 'every', everyN: 2, everyUnit: 'h' });
    expect(parseRecurrence('daily@09:00')).toEqual({ kind: 'daily', time: '09:00' });
    expect(parseRecurrence('weekly@1,09:00')).toEqual({ kind: 'weekly', weekday: 1, time: '09:00' });
    expect(parseRecurrence(null)).toEqual({ kind: 'once' });
    expect(parseRecurrence('garbage')).toEqual({ kind: 'once' });
  });

  it('与 serializeRecurrence 对偶：往返恒等（once 除外——serialize 为 null）', () => {
    const presets: RecurrencePreset[] = [
      { kind: 'every', everyN: 45, everyUnit: 'd' },
      { kind: 'daily', time: '18:30' },
      { kind: 'weekly', weekday: 0, time: '08:00' },
    ];
    for (const p of presets) {
      expect(parseRecurrence(serializeRecurrence(p))).toEqual(p);
    }
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
