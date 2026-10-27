// renderer/src/components/workgroup/useArmedConfirm.test.ts
//
// P2-10 两步确认公共臂态 hook 契约：arm 进入臂态（剩余秒=窗口秒数）、每秒
// 递减、窗口到期自动回落、disarm 手动回落（菜单关闭路径）、臂态内重新 arm
// 重置窗口（deadline 跟随最新一次 arm）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useArmedConfirm } from './useArmedConfirm';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useArmedConfirm 臂态生命周期', () => {
  it('arm → armed=true 且 remainingSec=3（3s 窗口）', () => {
    const { result } = renderHook(() => useArmedConfirm());
    expect(result.current.armed).toBe(false);
    expect(result.current.remainingSec).toBe(0);

    act(() => result.current.arm());

    expect(result.current.armed).toBe(true);
    expect(result.current.remainingSec).toBe(3);
  });

  it('每秒递减：3 → 2 → 1（不出 0——0 由回落语义承载）', () => {
    const { result } = renderHook(() => useArmedConfirm());
    act(() => result.current.arm());
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.remainingSec).toBe(2);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.remainingSec).toBe(1);
    act(() => vi.advanceTimersByTime(999));
    expect(result.current.remainingSec).toBe(1);
  });

  it('3s 到期自动回落（armed=false / remainingSec=0）', () => {
    const { result } = renderHook(() => useArmedConfirm());
    act(() => result.current.arm());
    act(() => vi.advanceTimersByTime(3100));
    expect(result.current.armed).toBe(false);
    expect(result.current.remainingSec).toBe(0);
  });

  it('disarm 手动回落（菜单关闭路径）——先于到期不再触发', () => {
    const { result } = renderHook(() => useArmedConfirm());
    act(() => result.current.arm());
    act(() => result.current.disarm());
    expect(result.current.armed).toBe(false);
    act(() => vi.advanceTimersByTime(3100));
    expect(result.current.armed).toBe(false); // 无翻转（定时器已随 disarm 清理）
  });

  it('臂态内重新 arm → 窗口重置（deadline 跟随最新一次 arm，不残留旧定时器）', () => {
    const { result } = renderHook(() => useArmedConfirm());
    act(() => result.current.arm());
    act(() => vi.advanceTimersByTime(2000)); // 旧 deadline 只剩 1s
    expect(result.current.remainingSec).toBe(1);

    act(() => result.current.arm()); // 重置：remainingSec 回 3
    expect(result.current.remainingSec).toBe(3);
    act(() => vi.advanceTimersByTime(2500)); // 旧 deadline（若无重置）此刻已触发
    expect(result.current.armed).toBe(true);
    act(() => vi.advanceTimersByTime(600)); // 新 deadline 到点
    expect(result.current.armed).toBe(false);
  });

  it('自定义窗口毫秒（remainingSec=ceil(windowMs/1000)）', () => {
    const { result } = renderHook(() => useArmedConfirm(5000));
    act(() => result.current.arm());
    expect(result.current.remainingSec).toBe(5);
    act(() => vi.advanceTimersByTime(5100));
    expect(result.current.armed).toBe(false);
  });
});
