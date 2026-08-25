// electron/src/main/agent/warm-pool.ts
//
// 预启动 runtime 池——消除 spawn 延迟。每个 agent 维护 K 个待命 runtime，
// acquire 时直接拿出可用 runtime，跳过冷启动成本。
//
// 设计要点：
//   - warm(agentId)：预 spawn poolSize 个 runtime 入池（启动时调用）
//   - acquire(agentId)：从池中取一个；池空时立即 spawn（fallback）；
//     弹出的条目先做健康检查（connected && exitCode === null），死亡的丢弃重取
//   - acquire 后异步触发 replenish，把池补回到 poolSize（不等候）
//   - evict(agentId, child)：子进程退出时从池中剔除僵尸条目（C2 清理链入口）
//   - release()：v1 销毁该 runtime（不复用）；v2 可改为重置 + 归还
//   - destroyAll()：进程退出或测试结束时清理所有 runtime
//
// 并发安全（C4 修复）：
//   - warm() 用 per-agentId in-flight Promise 去重——两个并发调用共享同一次
//     填充，不会各自 spawn 一批后 pools.set 相互覆盖（旧实现后写者胜出，
//     先 spawn 的一批子进程成为永不 kill 的孤儿）
//   - warm 循环内每 push 一条立即写回 Map——spawn 中途抛错时已产出的
//     子进程仍在池中可达（destroyAll 可回收），不再泄漏
//
// 性能：spawn 一次通常 200-500ms（fork + DB 加载），WarmPool 把这个开销
// 摊到 idle 阶段，acquire 时 < 1ms 返回。异步 replenish 不会阻塞调用方。

import type { ChildProcess } from 'node:child_process';
import { logger } from '../logger';

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
 * 子进程健康判定：IPC 通道仍在 + 尚未退出（fresh fork 的 child 的
 * exitCode 为 null；退出后 exitCode 变为数字且 connected 变 false）。
 */
function isChildAlive(child: ChildProcess): boolean {
  return child.connected === true && child.exitCode === null;
}

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
  /** agentId → 进行中的 warm 填充 Promise（C4：并发 warm 去重） */
  private readonly warming = new Map<string, Promise<void>>();

  constructor(opts: WarmPoolOpts) {
    this.poolSize = opts.poolSize ?? DEFAULT_POOL_SIZE;
    this.spawn = opts.spawn;
  }

  /**
   * 启动时为指定 agent 预 spawn poolSize 个 runtime。
   * 已存在的池不会被重置（重复调用是幂等的——补到 poolSize 为止）。
   *
   * 并发去重（C4）：同一 agentId 的并发调用共享同一个 in-flight Promise，
   * 总 spawn 次数收敛到「缺口数」而非「缺口数 × 并发数」。
   */
  async warm(agentId: string): Promise<void> {
    const inFlight = this.warming.get(agentId);
    if (inFlight) return inFlight;

    const fill = (async (): Promise<void> => {
      const pool = this.pools.get(agentId) ?? [];
      while (pool.length < this.poolSize) {
        const child = await this.spawn(agentId);
        pool.push({ child, spawnedAt: Date.now(), agentId });
        // 每产出一条立即写回 Map：spawn 中途抛错时已产出的子进程
        // 仍留在池中（destroyAll 可达），不产生孤儿
        this.pools.set(agentId, pool);
      }
    })();

    this.warming.set(agentId, fill);
    try {
      await fill;
    } finally {
      // 失败也移除 in-flight 记录——下次 warm/replenish 可重试
      this.warming.delete(agentId);
    }
  }

  /**
   * 取一个 warm runtime——池中有则 pop，无则立即 spawn（不预热优化）。
   *
   * 健康检查（C4 修复）：弹出的条目若已死亡（IPC 断开 / 已退出）则丢弃，
   * 继续弹下一条；池中全部死亡或为空时走冷启动 spawn 兜底。
   * 调用后异步触发 replenish 把池补回 poolSize，调用方无需等待。
   */
  async acquire(agentId: string): Promise<WarmRuntime> {
    const pool = this.pools.get(agentId) ?? [];
    while (pool.length > 0) {
      const rt = pool.pop()!;
      this.pools.set(agentId, pool);
      if (isChildAlive(rt.child)) {
        this.replenishAsync(agentId);
        return rt;
      }
      // 僵尸池条目（子进程已退出但未被 evict）——丢弃，绝不外发死亡子进程
      logger.warn('WarmPool 丢弃已死亡的 warm runtime（acquire 健康检查）', {
        agentId,
        pid: rt.child.pid,
      });
    }
    // 池空：fallback 立即 spawn（cold start；acquirer 自己承担延迟）
    const child = await this.spawn(agentId);
    const rt: WarmRuntime = { child, spawnedAt: Date.now(), agentId };
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

  /**
   * 从池中剔除指定子进程（C2 清理链：child 'exit' 时调用）。
   * 池中不存在该 child 时 no-op（可能已被 acquire 取走）。
   * 注意：本方法只清池条目，不 kill——调用方负责其余收尾。
   */
  evict(agentId: string, child: ChildProcess): void {
    const pool = this.pools.get(agentId);
    if (!pool) return;
    const next = pool.filter((rt) => rt.child !== child);
    if (next.length !== pool.length) {
      this.pools.set(agentId, next);
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
