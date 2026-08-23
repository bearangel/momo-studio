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
import type { WarmPool, WarmRuntime } from './warm-pool';
import type { AgentRuntimeOpts } from './runtime-config';

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
}

/** 活跃 task 记录——keyed by streamSessionId */
interface ActiveTask {
  streamSessionId: string;
  runtime: WarmRuntime;
  taskId: string | null;
  /** 注册到 child 的 message handler，destroy/end 时用于 off 反注册 */
  messageHandler: (msg: unknown) => void;
}

export class AgentRunner {
  private readonly opts: AgentRunnerOpts;
  /** streamSessionId → 活跃 task */
  private readonly activeTasks = new Map<string, ActiveTask>();

  constructor(opts: AgentRunnerOpts) {
    this.opts = opts;
  }

  get assignmentId(): string { return this.opts.agentAssignmentId; }
  get agentUserId(): string { return this.opts.agentUserId; }
  get workspaceId(): string { return this.opts.workspaceId; }

  /**
   * 启动一个 task（含 ephemeral chat）。
   *
   * 流程：acquire warm runtime → 注册 message handler（监听 end/error chunk）→
   * 注入 task config 给子进程 → 返回 streamSessionId。
   *
   * 注意：本方法不等候子进程跑完 chat loop——只负责"注入并启动"。
   * chunk 转发 / 落盘由 runtime-spawner 统一注册的 handler 处理；
   * 本 runner 只关注 end/error 以便 release runtime。
   */
  async executeTask(task: TaskConfig): Promise<{ streamSessionId: string }> {
    const runtime = await this.opts.warmPool.acquire(this.opts.agentAssignmentId);

    // 注册 message handler：过滤本 task 的 streamSessionId，收到 end/error 时 release
    const child = runtime.child;
    const messageHandler = (msg: unknown): void => {
      if (typeof msg !== 'object' || msg === null) return;
      const m = msg as { type?: string; streamSessionId?: string };
      // 只处理本 task 的 chunk（同一 runtime 未来可能复用跑多 task）
      if (m.streamSessionId !== task.streamSessionId) return;
      if (m.type === 'end' || m.type === 'error') {
        // 任务结束 → 反注册 handler + release runtime + 移出活跃表
        child.off('message', messageHandler);
        this.opts.warmPool.release(runtime);
        this.activeTasks.delete(task.streamSessionId);
      }
    };
    child.on('message', messageHandler);

    const active: ActiveTask = {
      streamSessionId: task.streamSessionId,
      runtime,
      taskId: task.taskId,
      messageHandler,
    };
    this.activeTasks.set(task.streamSessionId, active);

    // 注入 task config 给子进程（子进程据此启动 chat loop）
    child.send({
      type: 'task-config',
      taskId: task.taskId,
      executionSessionId: task.executionSessionId,
      body: task.body,
      streamSessionId: task.streamSessionId,
      mentions: task.mentions ?? [],
      ...(task.dispatchContext ? { dispatchContext: task.dispatchContext } : {}),
    });

    return { streamSessionId: task.streamSessionId };
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
   * 反注册所有 message handler + release 每个 runtime（v1 = kill 子进程）+ 清空活跃表。
   * 不销毁 warmPool 本身（warmPool 生命周期由外层管理，可能被其他 runner 共享）。
   */
  destroy(): void {
    for (const active of this.activeTasks.values()) {
      active.runtime.child.off('message', active.messageHandler);
      this.opts.warmPool.release(active.runtime);
    }
    this.activeTasks.clear();
  }
}
