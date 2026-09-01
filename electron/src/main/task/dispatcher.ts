// electron/src/main/task/dispatcher.ts
//
// 【2.1 预留——当前未接线】spec §9 范围裁定：TaskDispatcher 的 pickup 链路
// 已从 v2.0.0 生产路径砍除（"砍，留 2.1"）：router-bootstrap 不再构造本类，
// RouterService 不再注入 dispatcher，notifyTaskTerminal 无调用方。文件保留
// 供 2.1 恢复 assigned 任务队列时复用；模块自身保持可独立测试的安全形态
// （tryPickup 状态转换失败不再外抛为 unhandled rejection）。
//
// TaskDispatcher —— pickup 决策 + 三层并发控制（D 子系统核心）。
//
// 决策顺序（短路，任一层失败立即返回 false，不浪费下游检查）：
//   1. per-agent：runner.activeTaskCount() < assignment.maxConcurrentTasks
//   2. 全局：所有 runner 的 activeTaskCount 之和 < globalMax
//   3. provider：bucket.canConsume()（RPM/TPM 滑动窗口未满）
//   4. findNextAssignedTask：取最高优先级且 scheduled_at 已到的 assigned 任务
//   5. transitionTaskStatus(in_progress) → runner.executeTask 启动子进程
//
// 状态机备注：assigned → in_progress 在第 5 步先转换，再 try executeTask。
// 若 executeTask 抛错（子进程启动失败），此时 status 已是 in_progress，
// in_progress → failed 是合法转换（state-machine LEGAL_TRANSITIONS），可安全回退。
//
// 触发时机（2.1 恢复接线后）：
//   - 任务进入 'assigned' 状态（task-router / conflict-executor queue 路径）
//   - 任务终态（释放槽位 → 触发其他 pickup；notifyTaskTerminal）
//   - agent runtime 启动完成（warmPool 注入就绪后）
//   - provider 配额恢复（每分钟滚窗，外层定时器调 scanAll）
//   - 用户点"重试队列"（IPC 显式触发 scanAll）
import { randomUUID } from 'node:crypto';
import { findNextAssignedTask, transitionTaskStatus } from '../storage/tasks/repo';
import { logger } from '../logger';
import type { AgentRunner } from '../agent/agent-runner';
import type { ProviderTokenBucket } from '../agent/llm/token-bucket';

/** agent 成员的并发配置（由上层从 agent_definitions + workspace_agent_members 解析后注入） */
export interface AgentMemberInfo {
  agentDefinitionId: string;
  modelProviderId: string;
  maxConcurrentTasks: number;
}

export interface DispatcherOpts {
  /** instanceId → runner */
  runners: Map<string, AgentRunner>;
  /** providerId → token bucket */
  buckets: Map<string, ProviderTokenBucket>;
  /** 查询某 agent 实例的并发配置（含 modelProviderId 用于查 bucket） */
  getAgentMember: (instanceId: string) => AgentMemberInfo | null;
  /** 全局并发上限（来自 global_settings.max_concurrent_tasks） */
  getGlobalMax: () => number;
  /** 测试用时间注入；默认 Date.now() */
  now?: () => number;
}

export class TaskDispatcher {
  private readonly opts: DispatcherOpts;
  private readonly terminalCallbacks = new Set<(taskId: string) => void>();

  constructor(opts: DispatcherOpts) {
    this.opts = opts;
  }

  /**
   * 检查并发约束并 pickup 一个任务（按优先级）。
   *
   * @returns true = 成功启动一个 task；false = 未启动（并发满 / 限流 / 无可 pickup 任务）
   */
  async tryPickup(assigneeAssignmentId: string): Promise<boolean> {
    const runner = this.opts.runners.get(assigneeAssignmentId);
    if (!runner) return false;

    const member = this.opts.getAgentMember(assigneeAssignmentId);
    if (!member) return false;

    // 1. per-agent 并发：当前 runner 活跃 task 数 < max
    if (runner.activeTaskCount() >= member.maxConcurrentTasks) return false;

    // 2. 全局并发：所有 runner 活跃 task 之和 < globalMax
    const globalActive = Array.from(this.opts.runners.values()).reduce(
      (sum, r) => sum + r.activeTaskCount(),
      0,
    );
    if (globalActive >= this.opts.getGlobalMax()) return false;

    // 3. provider 限流：bucket 不存在 = 该 provider 未配置限流 = 放行
    const bucket = this.opts.buckets.get(member.modelProviderId);
    if (bucket && !bucket.canConsume()) return false;

    // 4. 找下一个 assigned 任务（按 priority DESC + scheduled_at ASC + created_at ASC）
    const now = this.opts.now?.() ?? Date.now();
    const nextTask = findNextAssignedTask(assigneeAssignmentId, now);
    if (!nextTask) return false;

    // 5. 状态机转换 + 启动 runner
    //    先 transition 到 in_progress（占住状态机槽位，避免并发 pickup 同一 task），
    //    再 try executeTask；executeTask 失败时 in_progress → failed 合法回退。
    //    minor-4：transition 自身抛错（并发 pickup 竞态 / 行状态漂移）不再外抛——
    //    调用链 scanAll 是 void fire-and-forget，外抛即 unhandled rejection。
    const streamSessionId = randomUUID();
    const executionSessionId = nextTask.executionSessionId ?? nextTask.sourceSessionId ?? '';
    try {
      // minor-12：原代码把 streamSessionId 当作 runtimeInstanceId 写入 tasks 行
      // ——列名 runtime_instance_id 语义应为 runtime 子进程实例标识，写成
      // streamSessionId 会让未来读该列的下游代码（看板 / 远端镜像 / 重启恢复）
      // 误把流 id 当进程 id 用。dispatcher 当前未接线（2.1 预留），无消费方读到
      // 此列；故显式不写 runtime_instance_id，等 2.1 恢复时按真实 runtime 实例
      // 标识填值或重定义列语义。
      transitionTaskStatus(nextTask.id, 'in_progress', {
        executionSessionId: nextTask.executionSessionId ?? nextTask.sourceSessionId,
        startedAt: now,
      });
    } catch (err) {
      logger.warn('tryPickup 状态转换失败（并发竞态或状态漂移），本次放弃 pickup', {
        taskId: nextTask.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    try {
      await runner.executeTask({
        taskId: nextTask.id,
        executionSessionId,
        // pickup 时 body 为空——子 agent 从 MemoryProvider 拉任务描述，
        // 而不是把 prompt 内联到 executeTask 调用里
        body: '',
        streamSessionId,
      });
      return true;
    } catch (e) {
      // 启动失败：回退状态（in_progress → failed 合法）+ 记录错误信息
      transitionTaskStatus(nextTask.id, 'failed', { errorMessage: String(e) });
      return false;
    }
  }

  /**
   * 全局扫描：遍历所有 runner，逐个 tryPickup。
   *
   * 串行而非并行——并发约束检查依赖各 runner 的实时 activeTaskCount，
   * 串行能让前一个 pickup 占住的槽位立刻反映到后续检查中，避免超额。
   * 实际场景 runner 数量 ≤ 几十个，串行开销可忽略。
   *
   * minor-4：单个 tryPickup 的意外异常被捕获记日志，不中断整轮扫描，
   * 也不外抛（调用方是 void fire-and-forget，外抛即 unhandled rejection）。
   */
  async scanAll(): Promise<void> {
    for (const assignmentId of this.opts.runners.keys()) {
      try {
        await this.tryPickup(assignmentId);
      } catch (err) {
        logger.warn('scanAll 单个 runner pickup 异常（已跳过）', {
          assignmentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * 注册任务终态回调。AgentRunner 在 task 结束（end/error chunk）时
   * 通过 notifyTaskTerminal 通知 dispatcher，dispatcher 再 fan-out 给回调。
   */
  onTaskTerminal(callback: (taskId: string) => void): void {
    this.terminalCallbacks.add(callback);
  }

  /**
   * 【2.1 预留——当前无调用方】设计意图：由调用方在 task 终态时通知
   * dispatcher（fan-out 回调 + 释放槽位重扫）。v2.0.1 起任务终态转换由
   * AgentRunner 的 task-end 处理直接承载（spec §9），本方法保持未接线。
   *
   * 1. fan-out 给所有注册的回调（IPC 推送、UI 更新等）
   * 2. 触发新一轮 scanAll——释放的槽位可能让排队中的 task 得以 pickup
   *
   * 注意：scanAll 是 fire-and-forget（void），不阻塞调用方。
   */
  notifyTaskTerminal(taskId: string): void {
    for (const cb of this.terminalCallbacks) cb(taskId);
    void this.scanAll();
  }
}
