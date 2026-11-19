// 推断矩阵锁（与 renderer/src/lib/acceptance-policy.test.ts 同矩阵）+ 工具面枚举映射。
import { describe, it, expect } from 'vitest';
import { inferAutoAccept, parseAcceptancePolicy } from '../../src/main/task/acceptance-policy';

describe('inferAutoAccept（D8，与 renderer 同矩阵）', () => {
  it('带循环规则 → 自动验收；一次性 → 人工验收', () => {
    expect(inferAutoAccept('every:15m')).toBe(true);
    expect(inferAutoAccept(null)).toBe(false);
    expect(inferAutoAccept('')).toBe(false);
  });
});

describe('parseAcceptancePolicy（create_task 工具面映射）', () => {
  it("显式 'auto' / 'manual' 直映；缺省与异形按推断（循环→auto）", () => {
    expect(parseAcceptancePolicy('auto', null)).toBe(true);
    expect(parseAcceptancePolicy('manual', 'every:1h')).toBe(false);
    expect(parseAcceptancePolicy(undefined, 'every:1h')).toBe(true);
    expect(parseAcceptancePolicy(undefined, null)).toBe(false);
    expect(parseAcceptancePolicy('garbage', 'daily@09:00')).toBe(true);
  });
});
