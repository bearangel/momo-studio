// electron/tests/agent/tools/write-grant-wait.test.ts
// 写授权硬门控等待循环（spec hard-gate §5）：covered/denied/aborted 三出口、
// 无限等待（无预算）、denied 推送即时解除、非 fork 短路 denied。
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  waitForWriteGrant,
  notifyWriteGrantDenied,
  formatWriteDeniedResult,
  formatWriteTimeoutResult,
  __clearDeniedWaitersForTest,
} from '../../../src/main/agent/tools/write-grant-wait';

const realSend = process.send;

afterEach(() => {
  Object.defineProperty(process, 'send', { value: realSend, configurable: true });
  __clearDeniedWaitersForTest();
  vi.useRealTimers();
});

function fakeFork(): void {
  Object.defineProperty(process, 'send', { value: (): boolean => true, configurable: true });
}

describe('waitForWriteGrant 出口三态（spec §5）', () => {
  it('isCovered 立即 true → covered（零等待）', async () => {
    fakeFork();
    const r = await waitForWriteGrant({ dirs: ['/d'], isCovered: async () => true, tickMs: 10 });
    expect(r).toEqual({ kind: 'covered' });
  });

  it('前两拍 false 第三拍 true → covered（tick 轮询推进）', async () => {
    fakeFork();
    let n = 0;
    const r = await waitForWriteGrant({
      dirs: ['/d'],
      isCovered: async () => { n += 1; return n >= 3; },
      tickMs: 5,
    });
    expect(r).toEqual({ kind: 'covered' });
    expect(n).toBe(3);
  });

  it('等待可跨超时前长时段：9 分钟时 covered 仍生效（F5 超时不提前误伤）', async () => {
    fakeFork();
    vi.useFakeTimers();
    let covered = false;
    const p = waitForWriteGrant({ dirs: ['/d'], isCovered: async () => covered, tickMs: 2_000 });
    const done = p.then((r) => expect(r).toEqual({ kind: 'covered' }));
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000); // 9 分钟 < 10 分钟超时边界
    covered = true;
    await vi.advanceTimersByTimeAsync(2_100);
    await done;
  });

  it('等待中 abort → aborted（即时唤醒，不等下一拍）', async () => {
    fakeFork();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 15);
    const t0 = Date.now();
    const r = await waitForWriteGrant({
      dirs: ['/d'], isCovered: async () => false, tickMs: 60_000, signal: ac.signal,
    });
    expect(r).toEqual({ kind: 'aborted' });
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('非 fork 环境（process.send 缺失）→ 立即 denied（无人可答 = 拒绝收敛）', async () => {
    Object.defineProperty(process, 'send', { value: undefined, configurable: true });
    const t0 = Date.now();
    const r = await waitForWriteGrant({ dirs: ['/d'], isCovered: async () => true, tickMs: 10 });
    expect(r).toEqual({ kind: 'denied' });
    expect(Date.now() - t0).toBeLessThan(100);
  });
});

describe('denied 推送即时解除（spec §4.4 匹配规则）', () => {
  it('等待中收到匹配 dirs 的广播 → 立即 denied（不等下一拍）', async () => {
    fakeFork();
    const p = waitForWriteGrant({ dirs: ['/a', '/b'], isCovered: async () => false, tickMs: 5_000 });
    setTimeout(() => notifyWriteGrantDenied({ type: 'write-grant-denied', dirs: ['/b', '/c'] }), 10);
    const t0 = Date.now();
    expect(await p).toEqual({ kind: 'denied' });
    expect(Date.now() - t0).toBeLessThan(4_000);
  });

  it('dirs 无交集 → 不解除（继续等到 covered）', async () => {
    fakeFork();
    let covered = false;
    const p = waitForWriteGrant({ dirs: ['/a'], isCovered: async () => covered, tickMs: 5 });
    notifyWriteGrantDenied({ type: 'write-grant-denied', dirs: ['/x'] });
    setTimeout(() => { covered = true; }, 20);
    expect(await p).toEqual({ kind: 'covered' });
  });

  it('空对空：广播 dirs=[] 解除等待方 dirs=[]（降级卡关闭链路）', async () => {
    fakeFork();
    const p = waitForWriteGrant({ dirs: [], isCovered: async () => false, tickMs: 5_000 });
    setTimeout(() => notifyWriteGrantDenied({ type: 'write-grant-denied', dirs: [] }), 10);
    expect(await p).toEqual({ kind: 'denied' });
  });

  it('广播 dirs=[] 不解除非空等待方（空对空单向语义）', async () => {
    fakeFork();
    let covered = false;
    const p = waitForWriteGrant({ dirs: ['/a'], isCovered: async () => covered, tickMs: 5 });
    notifyWriteGrantDenied({ type: 'write-grant-denied', dirs: [] });
    setTimeout(() => { covered = true; }, 20);
    expect(await p).toEqual({ kind: 'covered' });
  });

  it('载荷形状防御：type 不符 / dirs 非数组 / 含非字符串 → no-op 不抛', () => {
    expect(() => notifyWriteGrantDenied({ type: 'other', dirs: ['/a'] })).not.toThrow();
    expect(() => notifyWriteGrantDenied({ type: 'write-grant-denied', dirs: 42 })).not.toThrow();
    expect(() => notifyWriteGrantDenied({ type: 'write-grant-denied', dirs: ['/a', 7] })).not.toThrow();
    expect(() => notifyWriteGrantDenied('not-an-object')).not.toThrow();
  });
});

describe('文案与接线锁', () => {
  it('formatWriteDeniedResult 逐字（spec §7）', () => {
    expect(formatWriteDeniedResult(['/a', '/b'])).toBe(
      '用户已拒绝授权（目录：/a、/b）。请勿重试同一目标；如确需写入请与用户协商其他方案。',
    );
    expect(formatWriteDeniedResult([])).toBe(
      '用户已拒绝授权（目录：未能定位）。请勿重试同一目标；如确需写入请与用户协商其他方案。',
    );
  });

  // 接线子串锁：runtime-entry 已路由 write-grant-denied → notifyWriteGrantDenied(msg)，
  // Task 4 接好后此锁上线——防广播链断环（断环即子进程收到广播但无人消费）。
  it('runtime-entry 已路由 write-grant-denied（接线子串锁——防广播链断环）', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../src/main/agent/runtime-entry.ts'),
      'utf-8',
    );
    expect(src).toContain("m.type === 'write-grant-denied'");
    expect(src).toContain('notifyWriteGrantDenied(msg)');
  });
});

// === F5（2026-10-14 后台链授权卡死根因）：等待超时出口 ===
// 无限等待对 dispatch_bg 后台链无「人在场」前提——超时按拒绝收敛。
describe('waitForWriteGrant 超时出口（F5）', () => {
  it('超过 timeoutMs 无 covered/denied/aborted → { kind: "timeout" }', async () => {
    fakeFork();
    const t0 = Date.now();
    const r = await waitForWriteGrant({
      dirs: ['/ws/out'],
      isCovered: async () => false,
      tickMs: 10,
      timeoutMs: 60,
    });
    expect(r).toEqual({ kind: 'timeout' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
  });

  it('covered 先于超时 → 正常返回 covered（超时不误伤）', async () => {
    fakeFork();
    const r = await waitForWriteGrant({
      dirs: ['/ws/out'],
      isCovered: async () => true,
      tickMs: 10,
      timeoutMs: 50,
    });
    expect(r).toEqual({ kind: 'covered' });
  });

  it('formatWriteTimeoutResult 文案含超时成因与目录', () => {
    const text = formatWriteTimeoutResult(['/ws/out']);
    expect(text).toContain('授权等待超时');
    expect(text).toContain('/ws/out');
  });
});
