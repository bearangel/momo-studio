// electron/src/main/agent/agent-runner.ts
//
// AgentRunner（task-driven runtime 架构核心）——每个 agent_assignment 一个。
//
// v1：单 task 串行（per-agent max=1）。task 到达 → acquire warm runtime →
//     通过 IPC 注入 task config → 子进程跑 chat loop → end chunk → release runtime。
// v2：多 task 并发（warm pool 多 acquire）。
//
// spawn 实现由 runtime-spawner 提供（fork runtime-entry）；配置类型 AgentRuntimeOpts
// 定义在 runtime-config.ts（Task 13 起 v1 runtime-manager 双轨已删除，本模块是
// 唯一的 runtime 执行入口）。
//
// 生命周期契约（C1/C3 修复后的完整链路）：
//   1. executeTask → acquire warm runtime → 注册 message handler → 注入 task-config
//   2. 子进程跑 chat loop，逐 chunk 上报（start/text/.../end）
//   3. 子进程在 end 之后还要发 task_reply（dispatch 场景）与 task-end，再 self-exit
//      ——因此 task-driven（taskId 非空）在收到 end 时【不 kill】，只记录 finish
//      状态并武装 15s 安全兜底计时器；收到 task-end 或 child exit 才收尾
//      （终态转换 → release）。旧实现收到 end 立即 SIGTERM，会掐断子进程
//      尚未 flush 的 task_reply / task-end，PM 侧 dispatch 挂满 9 分钟超时（C3）。
//   4. ephemeral chat（taskId=null）无后续 IPC 依赖，保持旧语义：end 即回收。
import type { ChildProcess } from 'node:child_process';
import type { WarmPool, WarmRuntime } from './warm-pool';
import type { AgentRuntimeOpts } from './runtime-config';
import { logger } from '../logger';
import { getTask, transitionTaskStatus, type TaskRow } from '../storage/tasks/repo';
import { canTransition, isTerminal, type TaskStatus } from '../storage/tasks/state-machine';
import { finalizeStreamOnCrash } from './stream-relay';
import { scheduleExtraction } from '../memory/extraction';
import { resolveMaxToolCalls } from '../settings/crud';

/** task 配置——由上层（消息路由层）构造后传给 executeTask */
export interface TaskConfig {
  /** task 主键；null = ephemeral chat（非 task 调度的即时对话） */
  taskId: string | null;
  /** 执行房间 ID（agent 在此房间输出流式回复） */
  executionSessionId: string;
  /** 用户输入的正文 */
  body: string;
  /** 流式会话 ID（贯穿 start→end chunk 的唯一标识） */
  streamSessionId: string;
  /** 消息 metadata（mentions 等） */
  mentions?: string[];
  /**
   * dispatch 模式：父 agent（PM）派来的任务上下文。
   * 设置时本 task 是 sub-agent 收到 PM 的 dispatch（走 handleDispatch 流程）；
   * 未设置时是顶层用户消息触发的 ephemeral chat。
   * 形状与 runtime-entry 的 TaskConfigMsg.dispatchContext 保持一致。
   */
  dispatchContext?: {
    /** PM 的 assignmentId（dispatch event 的 dispatch_from） */
    fromAssignmentId: string;
    /** dispatch event 的 task_id（用于回 task_reply 关联） */
    task_id: string;
    /** PM 分配给本 sub-agent 的工具预算 */
    tool_budget?: number;
    /** PM 的 streamSessionId（renderer 据此把子 agent 流嵌套渲染到 PM 气泡内对应 chip） */
    tool_stream_session_id?: string;
  };
}

/** notifyTaskReply 的入参——camelCase（由 RouterService 从 task_reply event 转换而来） */
export interface TaskReplyNotification {
  taskId: string;
  status: string;
  body: string;
  progressPct?: number;
  toolCallsUsed?: number;
}

/** AgentRunner 构造选项 */
export interface AgentRunnerOpts {
  /** agent_assignment 主键（instanceId） */
  agentAssignmentId: string;
  /** agent 本地身份（agent_user_id 列；展示名解析用，v2 Task 10 起非 Matrix userId） */
  agentUserId: string;
  /** 所属 workspace ID */
  workspaceId: string;
  /** runtime 配置（task-driven 模式下由 warmPool spawn 注入，runner 自身不直接使用） */
  config?: AgentRuntimeOpts;
  /** 共享 warm pool（多个 AgentRunner 可共用同一 pool） */
  warmPool: WarmPool;
  /**
   * C3 安全兜底宽限期（毫秒）：end chunk 之后等待 task-end / child exit 的
   * 上限，超时强制收尾（kill 子进程 + 终态转换）。缺省 15s；测试可注入小值。
   */
  taskEndGraceMs?: number;
}

/** 活跃 task 记录——keyed by streamSessionId */
interface ActiveTask {
  streamSessionId: string;
  /** 执行会话 ID（任务完成触发记忆提取用；与 TaskConfig.executionSessionId 同源） */
  executionSessionId: string;
  runtime: WarmRuntime;
  taskId: string | null;
  /** 注册到 child 的 message handler，destroy/end 时用于 off 反注册 */
  messageHandler: (msg: unknown) => void;
  /** 最近一次 end chunk 的完成状态（task-end 终态映射依据；未见 end 时 undefined） */
  lastFinish?: { finishReason: 'stop' | 'budget_exhausted' | 'interrupted' | 'error'; error?: string };
  /** C3 安全兜底计时器（end 之后武装，task-end / exit / destroy 时清除） */
  safetyTimer?: NodeJS.Timeout;
}

/** task-end 到达后仍未收尾的兜底宽限上限 */
const DEFAULT_TASK_END_GRACE_MS = 15_000;

export class AgentRunner {
  private readonly opts: AgentRunnerOpts;
  /** streamSessionId → 活跃 task */
  private readonly activeTasks = new Map<string, ActiveTask>();
  private readonly taskEndGraceMs: number;

  constructor(opts: AgentRunnerOpts) {
    this.opts = opts;
    this.taskEndGraceMs = opts.taskEndGraceMs ?? DEFAULT_TASK_END_GRACE_MS;
  }

  get assignmentId(): string { return this.opts.agentAssignmentId; }
  get agentUserId(): string { return this.opts.agentUserId; }
  get workspaceId(): string { return this.opts.workspaceId; }

  /**
   * 启动一个 task（含 ephemeral chat）。
   *
   * 流程：acquire warm runtime → 注册 message handler（监听 end / task-end）→
   * 注入 task config 给子进程 → 返回 streamSessionId。
   *
   * 消息契约（child → main，本 handler 消费；对端生产者 runtime-entry.ts）：
   *   - StreamChunk（start/thinking/text/tool_call/tool_result/end 等）：仅消费
   *     'end'（记录 finish 状态；ephemeral 场景即时回收）
   *   - { type: 'task-end', streamSessionId, taskId, toolCallsUsed?, error? }：
   *     子进程 task 终结信号（end → task_reply → task-end → self-exit 链路的最后一环），
   *     触发任务行终态转换 + runtime 回收
   */
  async executeTask(task: TaskConfig): Promise<{ streamSessionId: string }> {
    const runtime = await this.opts.warmPool.acquire(this.opts.agentAssignmentId);

    // 注册 message handler：过滤本 task 的 streamSessionId，按消息类型收尾
    const child = runtime.child;
    const messageHandler = (msg: unknown): void => {
      if (typeof msg !== 'object' || msg === null) return;
      const m = msg as {
        type?: string;
        streamSessionId?: string;
        finishReason?: 'stop' | 'budget_exhausted' | 'interrupted' | 'error';
        error?: string;
        toolCallsUsed?: number;
      };
      // 只处理本 task 的 chunk（同一 runtime 未来可能复用跑多 task）
      if (m.streamSessionId !== task.streamSessionId) return;
      if (m.type === 'end') {
        const active = this.activeTasks.get(task.streamSessionId);
        if (active) {
          active.lastFinish = {
            finishReason: m.finishReason ?? 'stop',
            ...(m.error !== undefined ? { error: m.error } : {}),
          };
        }
        if (task.taskId === null) {
          // ephemeral chat：无后续 IPC 依赖，保持旧语义——end 即回收
          child.off('message', messageHandler);
          this.opts.warmPool.release(runtime);
          this.activeTasks.delete(task.streamSessionId);
        } else if (active) {
          // task-driven：不 kill（C3）——end 之后子进程还要发 task_reply / task-end；
          // 武装安全兜底，task-end / exit 迟迟不达时强制收尾
          this.armSafetyTimer(active);
        }
        return;
      }
      if (m.type === 'task-end') {
        // C1：task 终结信号——先转换任务行终态，再回收 runtime（顺序见
        // finalizeActiveTask；task_reply 在子进程侧先于 task-end 发送，此处
        // 收到时链路必然已完整）
        this.finalizeActiveTask(task.streamSessionId, {
          ...(m.toolCallsUsed !== undefined ? { toolCallsUsed: m.toolCallsUsed } : {}),
          ...(m.error !== undefined ? { error: m.error } : {}),
        });
      }
    };
    child.on('message', messageHandler);

    const active: ActiveTask = {
      streamSessionId: task.streamSessionId,
      executionSessionId: task.executionSessionId,
      runtime,
      taskId: task.taskId,
      messageHandler,
    };
    this.activeTasks.set(task.streamSessionId, active);

    // v2.2 修复（会话工具预算接线）：按 executionSessionId 现解析有效预算
    // （sessions.settings_json.maxToolCalls → global_settings.maxToolCalls），
    // 每条消息派发时随 task-config 下发——修改会话/全局设置后下一条消息即生效，
    // 不受 warm runtime AGENT_CONFIG 定型影响。解析失败（settings_json 损坏等）
    // 不阻塞消息派发：回退子进程 AGENT_CONFIG 默认。
    let resolvedMaxToolCalls: number | undefined;
    try {
      resolvedMaxToolCalls = resolveMaxToolCalls(task.executionSessionId);
    } catch (err) {
      logger.warn('工具预算解析失败，回退运行时默认', {
        executionSessionId: task.executionSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 注入 task config 给子进程（子进程据此启动 chat loop）
    child.send({
      type: 'task-config',
      taskId: task.taskId,
      executionSessionId: task.executionSessionId,
      body: task.body,
      streamSessionId: task.streamSessionId,
      mentions: task.mentions ?? [],
      ...(resolvedMaxToolCalls !== undefined ? { maxToolCalls: resolvedMaxToolCalls } : {}),
      ...(task.dispatchContext ? { dispatchContext: task.dispatchContext } : {}),
    });

    return { streamSessionId: task.streamSessionId };
  }

  /**
   * 收尾一个活跃 task：反注册 handler → 清兜底计时器 → 任务行终态转换（C1）→
   * 回收 runtime。幂等：活跃表无记录时 no-op（exit 路径可能已清理）。
   *
   * @param taskEndInfo task-end 消息携带的附加信息（error / toolCallsUsed）；
   *        兜底计时器 / exit 路径触发时为 undefined
   */
  private finalizeActiveTask(
    streamSessionId: string,
    taskEndInfo: { toolCallsUsed?: number; error?: string } | undefined,
  ): void {
    const active = this.activeTasks.get(streamSessionId);
    if (!active) return;
    active.runtime.child.off('message', active.messageHandler);
    if (active.safetyTimer) {
      clearTimeout(active.safetyTimer);
      active.safetyTimer = undefined;
    }
    this.activeTasks.delete(streamSessionId);
    // 顺序契约：先转换任务终态（DB 可见），再 kill 子进程——确保看板 /
    // 重启恢复读到的终态不依赖 runtime 存活
    if (active.taskId !== null) {
      this.transitionTaskTerminal(active, taskEndInfo);
    }
    this.opts.warmPool.release(active.runtime);
    // v2.2 记忆 P2（spec §6.4 触发点）：任务正常收尾（非 error/abort）→
    // fire-and-forget 触发记忆提取。gate 口径与 transitionTaskTerminal 的
    // failed/cancelled 判定对齐：task-end 携带 error、或前置 end chunk
    // finishReason 为 error/interrupted 时不触发；绝不 await（铁律：不阻塞收尾链路）。
    const finishReason = active.lastFinish?.finishReason;
    const completedNormally =
      taskEndInfo?.error === undefined && finishReason !== 'error' && finishReason !== 'interrupted';
    if (completedNormally) {
      scheduleExtraction(active.executionSessionId, { taskId: active.taskId });
    }
  }

  /**
   * C1：task-end 终态映射。
   *   - task-end 携带 error（子进程错误路径）→ failed
   *   - 前置 end chunk finishReason=error → failed（防御：error 未透传到 task-end）
   *   - 前置 end chunk finishReason=interrupted（abortStream / abort_dispatch）→ cancelled
   *   - 其余（stop / budget_exhausted 正常返回）→ completed
   * 幂等与合法性：任务行已是终态（如用户提前 task:cancel）或转换不合法时
   * 记日志跳过，绝不抛错（本方法运行在 child message 事件回调里）。
   */
  private transitionTaskTerminal(
    active: ActiveTask,
    taskEndInfo: { toolCallsUsed?: number; error?: string } | undefined,
  ): void {
    const taskId = active.taskId;
    if (taskId === null) return;
    let row: TaskRow | null;
    try {
      row = getTask(taskId);
    } catch (err) {
      logger.warn('task-end 处理：读取任务行失败', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!row) {
      // dispatch 派生的 task_id（routeDispatch 注入）不对应 tasks 表行——跳过
      logger.info('task-end 对应任务行不存在（dispatch 派生 task_id），跳过终态转换', { taskId });
      return;
    }
    if (isTerminal(row.status)) return;
    const failed = taskEndInfo?.error !== undefined || active.lastFinish?.finishReason === 'error';
    const to: TaskStatus = failed ? 'failed'
      : active.lastFinish?.finishReason === 'interrupted' ? 'cancelled'
        : 'completed';
    if (!canTransition(row.status, to)) {
      logger.warn('task-end 终态转换不合法，跳过', { taskId, from: row.status, to });
      return;
    }
    try {
      transitionTaskStatus(taskId, to, {
        completedAt: Date.now(),
        ...(taskEndInfo?.toolCallsUsed !== undefined ? { toolCallsUsed: taskEndInfo.toolCallsUsed } : {}),
        ...(failed
          ? {
              errorMessage:
                taskEndInfo?.error ?? active.lastFinish?.error ?? 'agent 执行出错',
            }
          : {}),
      });
    } catch (err) {
      logger.warn('task-end 终态转换失败', {
        taskId,
        to,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * C3 安全兜底：end 之后若 task-end / child exit 在宽限期内未到
   * （子进程 hang / IPC 丢失），强制收尾（含 kill）。
   */
  private armSafetyTimer(active: ActiveTask): void {
    if (active.safetyTimer) return;
    active.safetyTimer = setTimeout(() => {
      logger.warn('task-end/exit 未在宽限期内到达，强制回收 task-driven runtime', {
        streamSessionId: active.streamSessionId,
        taskId: active.taskId,
      });
      this.finalizeActiveTask(active.streamSessionId, undefined);
    }, this.taskEndGraceMs);
    active.safetyTimer.unref?.();
  }

  /**
   * C2：child 'exit' 清理链的 runner 侧入口（由 runtime-registry 的 spawn
   * onExit 回调接线）。对该子进程上仍未收尾的活跃 task：
   *   - 反注册 message handler + 清兜底计时器 + 移出活跃表
   *   - 仍处 'streaming' 的消息行 → 'failed' + 中文错误 final 事件
   *     （finalizeStreamOnCrash，防止 renderer 永远显示"流式中"）
   *   - 仍处 in_progress 的任务行 → 'failed'（state-machine 合法转换）
   * 幂等：正常 end/task-end 路径已清理的 task 不在活跃表中，天然跳过。
   */
  handleChildExit(child: ChildProcess, code: number | null): void {
    for (const active of [...this.activeTasks.values()]) {
      if (active.runtime.child !== child) continue;
      active.runtime.child.off('message', active.messageHandler);
      if (active.safetyTimer) {
        clearTimeout(active.safetyTimer);
        active.safetyTimer = undefined;
      }
      this.activeTasks.delete(active.streamSessionId);
      finalizeStreamOnCrash(active.streamSessionId, code);
      if (active.taskId !== null) {
        this.failTaskOnCrash(active.taskId, code);
      }
    }
  }

  /** C2：崩溃时把仍处 in_progress 的任务行转 failed（其余状态不动——保持状态机合法性） */
  private failTaskOnCrash(taskId: string, code: number | null): void {
    try {
      const row = getTask(taskId);
      if (!row || row.status !== 'in_progress') return;
      const errorText =
        code === null ? 'agent 运行时异常退出' : `agent 运行时异常退出（exit code=${code}）`;
      transitionTaskStatus(taskId, 'failed', {
        completedAt: Date.now(),
        errorMessage: errorText,
      });
    } catch (err) {
      logger.warn('崩溃任务收尾失败', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 中断指定 task 的 stream。
   * 通过 IPC 发 abort 消息，子进程的 abortListener 据此触发 AbortController.abort()。
   * 找不到活跃 task 时 no-op（可能已结束或从未启动）。
   */
  abortStream(streamSessionId: string): void {
    const active = this.activeTasks.get(streamSessionId);
    if (!active) return;
    active.runtime.child.send({ type: 'abort', streamSessionId });
  }

  /** 当前活跃 task 数（per-agent 并发检查用） */
  activeTaskCount(): number {
    return this.activeTasks.size;
  }

  /**
   * 通知正在执行任务的 runtime 收到了 task_reply（来自子 agent 的回执），
   * 通过 IPC 推给本 runner 的全部活跃子进程，由 runtime-entry 的 pendingReplies
   * 等待逻辑按 task_id 精确匹配消费。
   *
   * 不在 runner 侧按 reply.taskId 过滤：dispatch 的 task_id 由 PM 子进程内的
   * executeDispatch 生成（buildDispatchMessage randomUUID），runner 无法感知；
   * PM 的活跃 task 通常是 ephemeral chat（taskId=null），旧的按 taskId 匹配
   * 永不命中 → 回执静默丢弃。转发给全部活跃子进程是安全的——子进程
   * handleTaskReply 找不到匹配 pending 时仅记录日志。
   */
  async notifyTaskReply(reply: TaskReplyNotification): Promise<void> {
    for (const active of this.activeTasks.values()) {
      active.runtime.child.send({ type: 'task-reply', reply });
    }
  }

  /**
   * 销毁 runner + 释放所有活跃 runtime。
   * 反注册所有 message handler + 清兜底计时器 + release 每个 runtime
   * （v1 = kill 子进程）+ 清空活跃表。
   * 不销毁 warmPool 本身（warmPool 生命周期由外层管理，可能被其他 runner 共享）。
   */
  destroy(): void {
    for (const active of this.activeTasks.values()) {
      active.runtime.child.off('message', active.messageHandler);
      if (active.safetyTimer) {
        clearTimeout(active.safetyTimer);
        active.safetyTimer = undefined;
      }
      this.opts.warmPool.release(active.runtime);
    }
    this.activeTasks.clear();
  }
}
