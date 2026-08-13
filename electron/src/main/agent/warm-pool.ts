// electron/src/main/agent/warm-pool.ts
//
// 预启动 runtime 池——消除 spawn 延迟。每个 agent 维护 K 个待命 runtime，
// acquire 时直接拿出可用 runtime，跳过冷启动成本。
//
// 设计要点：
//   - warm(agentId)：预 spawn poolSize 个 runtime 入池（启动时调用）
//   - acquire(agentId)：从池中取一个；池空时立即 spawn（fallback）
//   - acquire 后异步触发 replenish，把池补回到 poolSize（不等候）
//   - release()：v1 销毁该 runtime（不复用）；v2 可改为重置 + 归还
//   - destroyAll()：进程退出或测试结束时清理所有 runtime
//
// 性能：spawn 一次通常 200-500ms（fork + Matrix 登录 + DB 加载），
// WarmPool 把这个开销摊到 idle 阶段，acquire 时 < 1ms 返回。
// 异步 replenish 不会阻塞调用方——上层可立即将 runtime 投入任务。

import type { ChildProcess } from 'node:child_process';

/** 池中待命的 runtime——含子进程句柄 + 启动时间戳 + 归属 agentId */
export interface WarmRuntime {
  child: ChildProcess;
  spawnedAt: number;
  agentId: string;
}

/** WarmPool 构造选项 */
export interface WarmPoolOpts {
  /** 每个 agent 池大小；缺省 = 2 */
  poolSize?: number;
  /** spawn 注入——调用方实现实际的 fork/spawn 逻辑（便于测试 mock） */
  spawn: (agentId: string) => Promise<ChildProcess>;
}

/** 默认池大小——K=2 平衡内存与冷启动命中率 */
const DEFAULT_POOL_SIZE = 2;

/**
 * WarmPool——为每个 agentId 维护一组预启动 runtime。
 *
 * 线程安全：v1 设计为单进程主线程使用，未加锁。
 * 跨 agentId 隔离：每个 agentId 独立池（Map 键）。
 */
export class WarmPool {
  private readonly poolSize: number;
  private readonly spawn: (agentId: string) => Promise<ChildProcess>;
  /** agentId → 该 agent 的 warm runtime 池 */
  private readonly pools = new Map<string, WarmRuntime[]>();

  constructor(opts: WarmPoolOpts) {
    this.poolSize = opts.poolSize ?? DEFAULT_POOL_SIZE;
    this.spawn = opts.spawn;
  }

  /**
   * 启动时为指定 agent 预 spawn poolSize 个 runtime。
   * 已存在的池不会被重置（重复调用是幂等的——补到 poolSize 为止）。
   */
  async warm(agentId: string): Promise<void> {
    const pool = this.pools.get(agentId) ?? [];
    while (pool.length < this.poolSize) {
      const child = await this.spawn(agentId);
      pool.push({ child, spawnedAt: Date.now(), agentId });
    }
    this.pools.set(agentId, pool);
  }

  /**
   * 取一个 warm runtime——池中有则 pop，无则立即 spawn（不预热优化）。
   * 调用后异步触发 replenish 把池补回 poolSize，调用方无需等待。
   */
  async acquire(agentId: string): Promise<WarmRuntime> {
    const pool = this.pools.get(agentId) ?? [];
    if (pool.length === 0) {
      // 池空：fallback 立即 spawn（cold start；acquirer 自己承担延迟）
      const child = await this.spawn(agentId);
      const rt: WarmRuntime = { child, spawnedAt: Date.now(), agentId };
      this.replenishAsync(agentId);
      return rt;
    }
    const rt = pool.pop()!;
    this.pools.set(agentId, pool);
    this.replenishAsync(agentId);
    return rt;
  }

  /**
   * 归还 runtime。v1 直接销毁；v2 可在此重置 runtime 内部状态后归还池。
   * 实现策略：
   *   - 销毁路径 catch 异常（子进程可能已退出）
   *   - 不主动等子进程退出——上层拿到 rt 后立即可用，销毁是后台清理
   */
  release(runtime: WarmRuntime): void {
    try {
      runtime.child.kill();
    } catch {
      // 子进程已退出或 kill 失败——v1 静默忽略
    }
  }

  /** 当前池内 warm runtime 数（per agent）。测试 + 监控用。 */
  size(agentId: string): number {
    return this.pools.get(agentId)?.length ?? 0;
  }

  /**
   * 销毁所有 warm runtime——进程退出或单元测试 teardown 时调用。
   * 调用后所有池清空；后续 acquire 会触发 cold spawn。
   */
  destroyAll(): void {
    for (const pool of this.pools.values()) {
      for (const rt of pool) {
        try {
          rt.child.kill();
        } catch {
          // 忽略——见 release()
        }
      }
    }
    this.pools.clear();
  }

  /**
   * 异步补充指定 agent 的池到 poolSize——不阻塞调用方。
   * 失败静默：spawn 失败的 runtime 不会入池，下次 acquire 时会再重试一次。
   */
  private replenishAsync(agentId: string): void {
    void this.warm(agentId).catch(() => {
      // spawn 失败——下次 acquire 时再尝试
    });
  }
}
