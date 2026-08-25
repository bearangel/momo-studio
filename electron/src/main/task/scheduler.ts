// electron/src/main/task/scheduler.ts
//
// TaskScheduler —— 定时任务调度器（D 子系统 D6）。
//
// 职责：
//   - 每 intervalMs 扫描 tasks 表中 status='pending' 且 scheduled_at <= now 的记录
//   - 把它们转到 'assigned'（pending → assigned 是合法转换，state-machine 已保证）
//   - 对每条升级的任务调用 scanPickup(assigneeAgentId)——注意：dispatcher pickup
//     链路已按 spec §9 砍除（留 2.1），runtime-init 注入的 scanPickup 当前是
//     安全 no-op；任务终端状态由 AgentRunner 的 task-end 处理（agent-runner.ts）
//     转换，不再由 dispatcher 接力
//
// 设计要点：
//   - checkOnce 是 public 方法，外部可以手动触发（测试 / 调试 / IPC "重试队列"）
//   - start/stop 维护一个 setInterval 句柄；幂等（重复 start 不叠加定时器）
//   - scanPickup 是 fire-and-forget（void 包装），不阻塞定时器 tick
//   - 复杂定时（cron / recurrence_rule）在 v1 简化：仅支持一次性 scheduled_at；
//     v2 加 cron 解析 + 自动续期
//   - scheduler 不直接做并发检查——这是 dispatcher 的职责，分层清晰
//     （scheduler = 触发器；dispatcher = 决策器；runner = 执行器）
//   - P4 Task 2：checkOnce 内有状态升级时 fire-and-forget 广播任务快照
//     （整批合并为一次广播——快照本身是全量扫描）。import 叶子模块
//     task-broadcast 而非 p2p 门面，避免引入 electron / 传输层依赖。
import { getDb } from '../storage/db';
import { transitionTaskStatus } from '../storage/tasks/repo';
import { broadcastLocalTaskSnapshot } from '../p2p/task-broadcast';

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
   * 立即执行一次扫描。
   *
   * 扫描条件：status='pending' AND scheduled_at <= now AND assignee_agent_id IS NOT NULL。
   * 对每条命中的记录：transitionTaskStatus(id, 'assigned')（状态机校验 + bump updated_at）；
   * fire-and-forget 触发 scanPickup。
   *
   * 注意：scanPickup 不 await——它是后台异步工作；本函数只负责"升级状态 + 通知",
   * 并发检查 / 实际执行交给 dispatcher 处理。Promise rejection 也不会影响本次扫描的
   * 其他任务（每个 scanPickup 独立触发）。
   */
  checkOnce(): void {
    const now = this.opts.now?.() ?? Date.now();
    const db = getDb();
    // 找 pending + scheduled_at <= now + 有 assignee 的任务
    const tasks = db
      .prepare(
        `SELECT id, assignee_agent_id FROM tasks
         WHERE status = 'pending' AND scheduled_at <= ? AND assignee_agent_id IS NOT NULL`,
      )
      .all(now) as Array<{ id: string; assignee_agent_id: string }>;

    for (const t of tasks) {
      // minor-5：走 repo 的状态机转换（断言 pending → assigned 合法 + 自动 bump
      // updated_at），不再裸 SQL UPDATE 绕过状态机——行在 SELECT 与 UPDATE 之间
      // 被并发改态时裸写会产出非法迁移，transitionTaskStatus 会显式抛错暴露竞态
      transitionTaskStatus(t.id, 'assigned');
      void this.opts.scanPickup(t.assignee_agent_id);
    }

    // 本 tick 有状态升级 → 广播一次任务快照（全量扫描天然覆盖整批，无升级不广播）
    if (tasks.length > 0) {
      void broadcastLocalTaskSnapshot();
    }
  }
}