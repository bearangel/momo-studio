// electron/tests/agent/warm-pool.test.ts
//
// WarmPool 预启动 runtime 池测试。
// 覆盖核心场景：池空立即 spawn、初始化预热 poolSize 个、
// acquire 后异步 replenish 到 poolSize、release 销毁、destroyAll 全清。
// C4 回归锁：并发 warm/acquire 不产生孤儿子进程；acquire 健康检查
// 丢弃死亡子进程并重新 spawn。C2 回归锁：evict 剔除指定子进程。
// ChildProcess 用 mock（避免真实 fork）——按 momo-test-rules 仿真真实语义：
// 新鲜 fork 的 child.exitCode === null 且 connected === true；退出后两者翻转。

import { describe, it, expect, vi } from 'vitest';
import { WarmPool } from '../../src/main/agent/warm-pool';
import type { ChildProcess } from 'node:child_process';

/** 构造 mock 子进程——只暴露 WarmPool 用到的接口（默认存活） */
function mkMockChild(overrides: Partial<{ connected: boolean; exitCode: number | null }> = {}): ChildProcess {
  return {
    kill: vi.fn(),
    pid: 12345,
    on: vi.fn(),
    off: vi.fn(),
    send: vi.fn(),
    // 真实 fork 语义：运行中 exitCode 为 null、IPC connected 为 true
    connected: overrides.connected ?? true,
    exitCode: overrides.exitCode ?? null,
  } as unknown as ChildProcess;
}

describe('WarmPool', () => {
  it('池空时 acquire 立即 spawn', async () => {
    const spawn = vi.fn().mockResolvedValue(mkMockChild());
    const pool = new WarmPool({ poolSize: 2, spawn });
    const rt = await pool.acquire('agent-1');
    // 验证返回的是同一子进程
    expect(rt.child.pid).toBe(12345);
    expect(spawn).toHaveBeenCalledWith('agent-1');
    // acquire 后从池中取走，池应为空
    expect(pool.size('agent-1')).toBe(0);
  });

  it('初始化时预 spawn poolSize 个 warm runtime', async () => {
    const spawn = vi.fn().mockResolvedValue(mkMockChild());
    const pool = new WarmPool({ poolSize: 3, spawn });
    await pool.warm('agent-1');
    expect(pool.size('agent-1')).toBe(3);
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('acquire 后异步 replenish 补充到 poolSize', async () => {
    const spawn = vi.fn().mockResolvedValue(mkMockChild());
    const pool = new WarmPool({ poolSize: 2, spawn });
    await pool.warm('agent-1');
    expect(pool.size('agent-1')).toBe(2);
    await pool.acquire('agent-1');
    // 等异步 replenish 完成
    await new Promise((r) => setTimeout(r, 10));
    expect(pool.size('agent-1')).toBe(2);
  });

  it('release 销毁 runtime（v1 简单实现）', async () => {
    const spawn = vi.fn().mockResolvedValue(mkMockChild());
    const pool = new WarmPool({ poolSize: 1, spawn });
    await pool.warm('agent-1');
    const rt = await pool.acquire('agent-1');
    pool.release(rt);
    expect(rt.child.kill).toHaveBeenCalled();
  });

  it('destroyAll 清理所有', async () => {
    const child1 = mkMockChild();
    const child2 = mkMockChild();
    const spawn = vi.fn()
      .mockResolvedValueOnce(child1)
      .mockResolvedValueOnce(child2);
    const pool = new WarmPool({ poolSize: 2, spawn });
    await pool.warm('agent-1');
    pool.destroyAll();
    expect(child1.kill).toHaveBeenCalled();
    expect(child2.kill).toHaveBeenCalled();
  });

  // === C4 回归锁：并发 warm / acquire 不产生孤儿 ===

  it('C4 回归锁：并发 warm() 共享同一次填充——只 spawn poolSize 个（旧实现两批互相覆盖泄漏）', async () => {
    let seq = 0;
    const spawned: ChildProcess[] = [];
    const spawn = vi.fn(async () => {
      // 延迟 spawn 模拟真实 fork 耗时，确保两个 warm 都进入 in-flight 窗口
      await new Promise((r) => setTimeout(r, 5));
      const child = mkMockChild();
      child.pid = 1000 + seq++;
      spawned.push(child);
      return child;
    });
    const pool = new WarmPool({ poolSize: 2, spawn });

    // 两个 warm 并发发起（都不 await）——旧实现各自 pools.get ?? [] 私有数组，
    // 各 spawn 2 个后 pools.set 相互覆盖，先产出的一批 2 个子进程成为孤儿
    await Promise.all([pool.warm('agent-1'), pool.warm('agent-1')]);

    expect(pool.size('agent-1')).toBe(2);
    expect(spawn).toHaveBeenCalledTimes(2); // 恰好 poolSize，无重复批次
    // 全部子进程都登记在池中（destroyAll 可达 = 无孤儿）
    pool.destroyAll();
    for (const c of spawned) expect(c.kill).toHaveBeenCalled();
  });

  it('C4 回归锁：冷池并发 acquire → 调用者各得一个 + 池补满 poolSize，总 spawn 数收敛（无泄漏批次）', async () => {
    let seq = 0;
    const spawned: ChildProcess[] = [];
    const spawn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      const child = mkMockChild();
      child.pid = 2000 + seq++;
      spawned.push(child);
      return child;
    });
    const pool = new WarmPool({ poolSize: 2, spawn });

    const [rtA, rtB] = await Promise.all([
      pool.acquire('agent-1'),
      pool.acquire('agent-1'),
    ]);
    // 等 replenish 收敛
    await new Promise((r) => setTimeout(r, 30));

    // 两个调用者各持有一个 + 池回满 2 个 = 恰好 4 个子进程，无重复批次泄漏
    expect(spawned).toHaveLength(4);
    expect(pool.size('agent-1')).toBe(2);
    expect(rtA.child).not.toBe(rtB.child);

    // 无孤儿判据：最初的 4 个子进程恰好划分为「手上 2 个」∪「池中 2 个」——
    // 从池里排干 2 个（后续 replenish 的新 spawn 不计入），验证互异且都来自首批
    const firstBatch = new Set(spawned);
    const drained: ChildProcess[] = [];
    for (let i = 0; i < 2; i++) {
      const rt = await pool.acquire('agent-1');
      expect(firstBatch.has(rt.child)).toBe(true);
      drained.push(rt.child);
    }
    const allFour = [rtA.child, rtB.child, ...drained];
    expect(new Set(allFour).size).toBe(4); // 互异 → 首批 4 个全部可达，零孤儿
    pool.destroyAll();
  });

  it('C4 回归锁：acquire 弹出已死亡子进程 → 丢弃不外发，改用冷启动 spawn（并触发补池）', async () => {
    const deadChild = mkMockChild({ connected: false, exitCode: 1 });
    const aliveChild = mkMockChild();
    const spawn = vi.fn()
      .mockResolvedValueOnce(deadChild) // warm 先产出（随后死亡）
      .mockResolvedValueOnce(aliveChild);
    const pool = new WarmPool({ poolSize: 2, spawn });
    await pool.warm('agent-1');
    expect(pool.size('agent-1')).toBe(2);

    const rt = await pool.acquire('agent-1');
    // 池里唯一条目已死 → 不得外发；本用例池空后冷启动拿 aliveChild
    expect(rt.child).toBe(aliveChild);
    expect(rt.child).not.toBe(deadChild);
  });

  it('C4 回归锁：池中混有死亡与存活条目 → 跳过死亡的弹出存活的', async () => {
    const deadChild = mkMockChild({ connected: false, exitCode: 0 });
    const aliveChild = mkMockChild();
    // warm 产出 2 个；第一个随后死亡（模拟：池顶死亡 + 池底存活）
    const spawn = vi.fn()
      .mockResolvedValueOnce(deadChild)
      .mockResolvedValueOnce(aliveChild)
      .mockResolvedValue(mkMockChild());
    const pool = new WarmPool({ poolSize: 2, spawn });
    await pool.warm('agent-1');

    const rt = await pool.acquire('agent-1');
    expect(rt.child).toBe(aliveChild);
    expect(rt.child).not.toBe(deadChild);
  });

  // === C2 回归锁：evict 剔除指定子进程 ===

  it('C2 回归锁：evict 按子进程身份从池中剔除（退出清理链入口）', async () => {
    const childA = mkMockChild();
    const childB = mkMockChild();
    const spawn = vi.fn()
      .mockResolvedValueOnce(childA)
      .mockResolvedValueOnce(childB)
      .mockResolvedValue(mkMockChild());
    const pool = new WarmPool({ poolSize: 2, spawn });
    await pool.warm('agent-1');
    expect(pool.size('agent-1')).toBe(2);

    // childA 退出 → 剔除
    pool.evict('agent-1', childA);
    expect(pool.size('agent-1')).toBe(1);

    // 剩下的应是 childB
    const rt = await pool.acquire('agent-1');
    expect(rt.child).toBe(childB);
  });

  it('evict 池中不存在该子进程时 no-op', () => {
    const pool = new WarmPool({ poolSize: 2, spawn: vi.fn() });
    expect(() => pool.evict('agent-x', mkMockChild())).not.toThrow();
  });
});
