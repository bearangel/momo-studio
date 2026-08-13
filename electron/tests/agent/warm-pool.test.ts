// electron/tests/agent/warm-pool.test.ts
//
// WarmPool 预启动 runtime 池测试。
// 覆盖 5 个核心场景：池空立即 spawn、初始化预热 poolSize 个、
// acquire 后异步 replenish 到 poolSize、release 销毁、destroyAll 全清。
// ChildProcess 用 mock（避免真实 fork）。

import { describe, it, expect, vi } from 'vitest';
import { WarmPool } from '../../src/main/agent/warm-pool';
import type { ChildProcess } from 'node:child_process';

/** 构造 mock 子进程——只暴露 WarmPool 用到的接口 */
function mkMockChild(): ChildProcess {
  return {
    kill: vi.fn(),
    pid: 12345,
    on: vi.fn(),
    send: vi.fn(),
    connected: true,
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
});
