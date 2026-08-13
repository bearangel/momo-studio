// electron/src/main/task/dispatcher.ts
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
// 触发时机：
//   - 任务进入 'assigned' 状态（task-router / conflict-executor queue 路径）
//   - 任务终态（释放槽位 → 触发其他 pickup；notifyTaskTerminal）
//   - agent runtime 启动完成（warmPool 注入就绪后）
//   - provider 配额恢复（每分钟滚窗，外层定时器调 scanAll）
//   - 用户点"重试队列"（IPC 显式触发 scanAll）
import { randomUUID } from 'node:crypto';
import { findNextAssignedTask, transitionTaskStatus } from '../storage/tasks/repo';
import type { AgentRunner } from '../agent/agent-runner';
import type { ProviderTokenBucket } from '../agent/llm/token-bucket';

/** agent 实例的并发配置（由上层从 agent_definitions + assignment 解析后注入） */
export interface AgentAssignmentInfo {
  agentDefinitionId: string;
  modelProviderId: string;
  maxConcurrentTasks: number;
}

export interface DispatcherOpts {
  /** assignmentId（instance_id）→ runner */
  runners: Map<string, AgentRunner>;
  /** providerId → token bucket */
  buckets: Map<string, ProviderTokenBucket>;
  /** 查询某 agent 实例的并发配置（含 modelProviderId 用于查 bucket） */
  getAgentAssignment: (instanceId: string) => AgentAssignmentInfo | null;
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

    const assignment = this.opts.getAgentAssignment(assigneeAssignmentId);
    if (!assignment) return false;

    // 1. per-agent 并发：当前 runner 活跃 task 数 < max
    if (runner.activeTaskCount() >= assignment.maxConcurrentTasks) return false;

    // 2. 全局并发：所有 runner 活跃 task 之和 < globalMax
    const globalActive = Array.from(this.opts.runners.values()).reduce(
      (sum, r) => sum + r.activeTaskCount(),
      0,
    );
    if (globalActive >= this.opts.getGlobalMax()) return false;

    // 3. provider 限流：bucket 不存在 = 该 provider 未配置限流 = 放行
    const bucket = this.opts.buckets.get(assignment.modelProviderId);
    if (bucket && !bucket.canConsume()) return false;

    // 4. 找下一个 assigned 任务（按 priority DESC + scheduled_at ASC + created_at ASC）
    const now = this.opts.now?.() ?? Date.now();
    const nextTask = findNextAssignedTask(assigneeAssignmentId, now);
    if (!nextTask) return false;

    // 5. 状态机转换 + 启动 runner
    //    先 transition 到 in_progress（占住状态机槽位，避免并发 pickup 同一 task），
    //    再 try executeTask；executeTask 失败时 in_progress → failed 合法回退。
    const streamSessionId = randomUUID();
    const executionRoomId = nextTask.executionRoomId ?? nextTask.sourceRoomId ?? '';
    transitionTaskStatus(nextTask.id, 'in_progress', {
      executionRoomId: nextTask.executionRoomId ?? nextTask.sourceRoomId,
      startedAt: now,
      runtimeInstanceId: streamSessionId,
    });
    try {
      await runner.executeTask({
        taskId: nextTask.id,
        executionRoomId,
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
   */
  async scanAll(): Promise<void> {
    for (const assignmentId of this.opts.runners.keys()) {
      await this.tryPickup(assignmentId);
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
   * 由 AgentRunner 在 task 终态时调用。
   *
   * 1. fan-out 给所有注册的回调（IPC 推送、UI 更新等）
   * 2. 触发新一轮 scanAll——释放的槽位可能让排队中的 task 得以 pickup
   *
   * 注意：scanAll 是 fire-and-forget（void），不阻塞调用方（AgentRunner 的 message handler）。
   */
  notifyTaskTerminal(taskId: string): void {
    for (const cb of this.terminalCallbacks) cb(taskId);
    void this.scanAll();
  }
}
