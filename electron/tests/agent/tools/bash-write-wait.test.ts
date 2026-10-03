// electron/tests/agent/tools/bash-write-wait.test.ts
// 有界阻塞等待循环（spec 2026-10-03 §12）：covered/timeout/abort 三出口 +
// 非 fork 环境短路（无主进程即无卡，等待无意义——同时保护直跑单测不挂满预算）。
import { describe, it, expect, afterEach } from 'vitest';
import { waitForWriteGrant } from '../../../src/main/agent/tools/bash-write-wait';

const realSend = process.send;

afterEach(() => {
  // 恢复 process.send（部分用例临时伪装 fork 环境）
  Object.defineProperty(process, 'send', { value: realSend, configurable: true });
});

function fakeFork(): void {
  Object.defineProperty(process, 'send', { value: (): boolean => true, configurable: true });
}

describe('waitForWriteGrant（spec §12）', () => {
  it('isCovered 立即 true → covered（零等待）', async () => {
    fakeFork();
    const r = await waitForWriteGrant({ dirs: ['/d'], isCovered: async () => true, budgetMs: 1000, tickMs: 10 });
    expect(r).toEqual({ kind: 'covered' });
  });

  it('前两拍 false 第三拍 true → covered（tick 轮询推进）', async () => {
    fakeFork();
    let n = 0;
    const r = await waitForWriteGrant({
      dirs: ['/d'],
      isCovered: async () => { n += 1; return n >= 3; },
      budgetMs: 5000, tickMs: 5,
    });
    expect(r).toEqual({ kind: 'covered' });
    expect(n).toBe(3);
  });

  it('预算耗尽全 false → timeout', async () => {
    fakeFork();
    const t0 = Date.now();
    const r = await waitForWriteGrant({ dirs: ['/d'], isCovered: async () => false, budgetMs: 60, tickMs: 10 });
    expect(r).toEqual({ kind: 'timeout' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
  });

  it('等待中途 abort → aborted（不等预算耗尽）', async () => {
    fakeFork();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 15);
    const t0 = Date.now();
    const r = await waitForWriteGrant({
      dirs: ['/d'], isCovered: async () => false, budgetMs: 5000, tickMs: 1000, signal: ac.signal,
    });
    expect(r).toEqual({ kind: 'aborted' });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('非 fork 环境（process.send 缺失）→ 立即 timeout（无主进程即无卡，等待无意义）', async () => {
    Object.defineProperty(process, 'send', { value: undefined, configurable: true });
    const t0 = Date.now();
    const r = await waitForWriteGrant({ dirs: ['/d'], isCovered: async () => true, budgetMs: 5000, tickMs: 10 });
    expect(r).toEqual({ kind: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(100);
  });
});
