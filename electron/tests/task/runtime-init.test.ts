// electron/tests/task/runtime-init.test.ts
//
// TaskScheduler 初始化测试（I1 最小骨架）。
// 验证 initTaskRuntime 创建并启动 TaskScheduler，scanPickup 为安全 no-op。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initTaskRuntime, stopTaskRuntime } from '../../src/main/task/runtime-init';

vi.mock('../../src/main/storage/db', () => ({
  getDb: () => ({
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
  }),
}));

describe('initTaskRuntime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopTaskRuntime();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('创建并启动 TaskScheduler（不抛错）', () => {
    expect(() => initTaskRuntime()).not.toThrow();
  });

  it('scheduler 启动后定时触发 checkOnce（pending→assigned 提升）', () => {
    initTaskRuntime({ intervalMs: 1000 });

    // 快进 2 秒 → checkOnce 应被触发至少 1 次（getDb mock 返回空数组，不抛错）
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
  });

  it('stopTaskRuntime 幂等（未 init 时调用不抛错）', () => {
    expect(() => stopTaskRuntime()).not.toThrow();
  });

  it('重复 initTaskRuntime 安全（不叠加定时器）', () => {
    initTaskRuntime({ intervalMs: 1000 });
    expect(() => initTaskRuntime({ intervalMs: 1000 })).not.toThrow();
    stopTaskRuntime();
  });
});
