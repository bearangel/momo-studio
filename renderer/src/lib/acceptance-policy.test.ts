// 推断矩阵锁（与 electron/tests/task/acceptance-policy.test.ts 同矩阵——双侧实现共享同一语义契约）。
import { describe, it, expect } from 'vitest';
import { inferAutoAccept } from './acceptance-policy';

describe('inferAutoAccept（D8 验收策略推断单源）', () => {
  it('带循环规则 → 自动验收（巡检/循环零打扰）', () => {
    expect(inferAutoAccept('every:1h')).toBe(true);
    expect(inferAutoAccept('daily@09:00')).toBe(true);
    expect(inferAutoAccept('weekly@1,09:00')).toBe(true);
  });
  it('一次性（null / 空串 / 纯空白）→ 人工验收', () => {
    expect(inferAutoAccept(null)).toBe(false);
    expect(inferAutoAccept('')).toBe(false);
    expect(inferAutoAccept('   ')).toBe(false);
  });
});
