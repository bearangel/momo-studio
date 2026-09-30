// electron/src/main/task/scheduler.ts
//
// TaskScheduler —— 到点唤醒加速器（D 子系统 D6 → 2026-09-30 泳道语义重构 §4.3）。
//
// 职责：
//   - 每 intervalMs 扫描排队中（assigned/session_queued）且 scheduled_at <= now
//     的任务；命中任意行 → 触发一次 scanPickup（runtime-init 注入的是
//     notifyExecutor 包装），加速到点放行
//   - 纯加速器：零转态、零广播——转态由 executor 放行链完成；executor 自身
//     30s 兜底扫描天然覆盖本扫描缺失（丢了通知自愈）
//
// 设计要点：
//   - checkOnce 是 public 方法，外部可以手动触发（测试 / 调试 / IPC "重试队列"）
//   - start/stop 维护一个 setInterval 句柄；幂等（重复 start 不叠加定时器）
//   - scanPickup 是 fire-and-forget（void 包装），不阻塞定时器 tick；
//     传参空串占位（runtime-init 注入的 scanPickup 只调 notifyExecutor 不看参数）
//   - 原「pending→assigned 升级 + 快照广播」路径随 pending 退役（迁移 051）：
//     定时任务现以 assigned + scheduled_at 落库，由 executor 闸门（§3.2）等到点
import { getDb } from '../storage/db';

export interface SchedulerOpts {
  /** 触发一次 dispatcher pickup（外部注入，便于测试和模块解耦） */
  scanPickup: (assigneeAssignmentId: string) => Promise<boolean>;
  /** 扫描间隔（毫秒），默认 30s */
  intervalMs?: number;
  /** 测试用时间注入；默认 Date.now() */
  now?: () => number;
}

const DEFAULT_INTERVAL_MS = 30_000;

export class TaskScheduler {
  private readonly opts: SchedulerOpts;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: SchedulerOpts) {
    this.opts = opts;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /**
   * 启动定时扫描。幂等：已启动时重复调用不会叠加定时器。
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkOnce(), this.intervalMs);
  }

  /**
   * 停止定时扫描。幂等：未启动时调用是 no-op。
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 立即执行一次扫描（2026-09-30 泳道语义重构，spec §4.3）。
   *
   * due-wakeup：排队中（assigned/session_queued）存在 scheduled_at <= now
   * 的任务时触发一次 scanPickup（executor notify），加速到点放行。
   * 纯加速器：零转态、零广播（转态由 executor 放行链完成；executor 自身
   * 30s 兜底扫描天然覆盖本扫描缺失）。原「pending→assigned 升级 + 快照
   * 广播」随 pending 退役（迁移 051）。
   */
  checkOnce(): void {
    const now = this.opts.now?.() ?? Date.now();
    const due = getDb()
      .prepare(
        `SELECT 1 FROM tasks
         WHERE status IN ('assigned', 'session_queued') AND scheduled_at <= ?
         LIMIT 1`,
      )
      .get(now);
    if (due) void this.opts.scanPickup('');
  }
}