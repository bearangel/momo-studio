// electron/src/main/agent/router-service.ts
//
// 主进程消息路由中心——task-driven 架构的核心。所有输入源统一经此分流：
//   - im/session-service（用户会话消息）→ routeUserChat
//   - internal-event-bridge（子进程 dispatch / task_reply / abort_dispatch 内部事件）
//     → routeDispatch / routeTaskReply / routeAbortDispatch
//   - m.room.message 类型保留给旧 event shape 适配（shape → plain 转换后委托 routeUserChat）
//
// 第 4 个参数 directTargetAssignmentId 是已解析好的目标 runner key，
// RouterService 自身不做目标判定，只负责按 event 类型构造 task 并派发。
//
// T4 解耦：routeUserChat 是 public plain 参数入口——其他输入源
// （session-ops、IPC handler、CLI）不经过 event shape 也可直接派发 chat task。

import { randomUUID } from 'node:crypto';
import { logger } from '../logger';
import { DISPATCH_EVENT_TYPE, TASK_REPLY_EVENT_TYPE, ABORT_DISPATCH_EVENT_TYPE } from './dispatch';
import type { AgentRunner, TaskConfig } from './agent-runner';
import type { TaskDispatcher } from '../task/dispatcher';

/** RouterService 构造选项 */
export interface RouterServiceOpts {
  /** assignmentId（instance_id）→ runner */
  runners: Map<string, AgentRunner>;
  /** 任务调度器（pickup 决策 + 三层并发控制；routeUserChat 不经过它——ephemeral chat 直接派发） */
  dispatcher: TaskDispatcher;
}

/** notifyTaskReply 的入参（camelCase；由 task_reply event 的 snake_case content 转换而来） */
export interface TaskReplyNotification {
  taskId: string;
  status: string;
  body: string;
  progressPct?: number;
  toolCallsUsed?: number;
}

/** routeUserChat 的 plain 入参——任意输入源（event shape 适配、IPC、CLI）共用 */
export interface RouteUserChatInput {
  /** 目标会话 id（session_id 或未来的 CLI session id） */
  sessionId: string;
  /** 目标 runner 的 assignmentId（runners Map 的 key） */
  assignmentId: string;
  /** 用户输入正文 */
  body: string;
  /** 可选：外部已生成的流 id；缺省自动 randomUUID() */
  streamSessionId?: string;
}

/**
 * RouterService 内部消费的 event 形状（历史沿用 Matrix event 的方法式接口）。
 * 桥接层（internal-event-bridge）从子进程 IPC 消息按此 shape 构造。
 */
export interface InternalEvent {
  getType(): string;
  getContent(): Record<string, unknown>;
  getSender(): string | undefined;
  getRoomId(): string | undefined;
}

export class RouterService {
  constructor(private readonly opts: RouterServiceOpts) {}

  /**
   * Plain 参数入口——不依赖 event shape。
   * 把 plain 入参构造为 ephemeral chat TaskConfig 派发给目标 runner。
   *
   * 不经过 TaskDispatcher——ephemeral chat 是即时响应，不走 assigned 任务队列。
   *
   * @returns 派发完成（runner.executeTask 自身 resolve 后本方法 resolve）；
   *          runner 不存在时静默跳过并 warn 日志，不抛错。
   */
  async routeUserChat(input: RouteUserChatInput): Promise<void> {
    const runner = this.opts.runners.get(input.assignmentId);
    if (!runner) {
      logger.warn('routeUserChat 未找到 runner', { assignmentId: input.assignmentId });
      return;
    }

    const task: TaskConfig = {
      taskId: null,
      executionSessionId: input.sessionId,
      body: input.body,
      streamSessionId: input.streamSessionId ?? randomUUID(),
    };
    await runner.executeTask(task);
  }

  /**
   * 路由单个内部 event。按 event 类型分流，找不到匹配类型时静默忽略。
   * 任一路由分支抛错都被 catch 记录，不阻塞调用方的后续 event 处理。
   *
   * @param event 内部 event（getType/getContent/getSender/getRoomId）
   * @param _ownerUserId workspace owner 的 userId（保留给 abort/权限判定）
   * @param _targetAssignmentId 房间级目标 assignment（群组默认接待 agent）；当前 3 条路由
   *   都用 directTargetAssignmentId 精确派发，此参数预留给群组广播场景
   * @param directTargetAssignmentId 单聊/已解析的直接目标 runner key。
   *   m.room.message 未传时不派发；dispatch 未传时 routeDispatch 内部从 dispatch_to 反查。
   */
  async routeEvent(
    event: InternalEvent,
    _ownerUserId: string,
    _targetAssignmentId: string | null,
    directTargetAssignmentId?: string,
  ): Promise<void> {
    const type = event.getType();
    try {
      switch (type) {
        case 'm.room.message':
          if (directTargetAssignmentId) {
            await this.routeUserChat({
              sessionId: event.getRoomId() ?? '',
              assignmentId: directTargetAssignmentId,
              body: this.extractBody(event.getContent()),
            });
          }
          break;
        case DISPATCH_EVENT_TYPE:
          // dispatch 目标由 content.dispatch_to 决定——即使 directTargetAssignmentId
          // 未传时 routeDispatch 内部会从 dispatch_to 反查。
          await this.routeDispatch(event, directTargetAssignmentId);
          break;
        case TASK_REPLY_EVENT_TYPE:
          await this.routeTaskReply(event, directTargetAssignmentId);
          break;
        case ABORT_DISPATCH_EVENT_TYPE:
          await this.routeAbortDispatch(event);
          break;
      }
    } catch (err) {
      logger.error('RouterService 路由失败', { type, error: String(err) });
    }
  }

  /** 从 event content 提取 body 文本；非 string 时降级为空串。 */
  private extractBody(content: Record<string, unknown>): string {
    const body = content.body;
    return typeof body === 'string' ? body : '';
  }

  /**
   * PM dispatch event → sub-agent 的 dispatch ephemeral task。
   * 把 dispatch content 的 dispatch_from / task_id / tool_budget / tool_stream_session_id
   * 组装成 dispatchContext 注入 executeTask，子进程 runtime-entry 据此跑 handleDispatch 流程。
   *
   * 目标 assignment 解析优先级（v2 Task 10：dispatch_to 值即 assignmentId，无需反查）：
   *   1. directAssignmentId（调用方已解析的直接目标）
   *   2. content.dispatch_to → 直接作 runners key
   */
  private async routeDispatch(event: InternalEvent, directAssignmentId?: string): Promise<void> {
    const content = event.getContent();
    const dispatchFrom = content.dispatch_from;
    const taskId = content.task_id;
    // 关键字段缺失 → 无法关联 task_reply，直接丢弃
    if (typeof dispatchFrom !== 'string' || typeof taskId !== 'string') {
      logger.warn('routeDispatch content 缺关键字段', { content });
      return;
    }

    const assignmentId =
      directAssignmentId ?? (typeof content.dispatch_to === 'string' ? content.dispatch_to : undefined);
    if (!assignmentId) {
      logger.warn('routeDispatch 无法解析目标 assignment', {
        dispatchTo: content.dispatch_to, taskId,
      });
      return;
    }

    const runner = this.opts.runners.get(assignmentId);
    if (!runner) {
      logger.warn('routeDispatch 未找到 runner', { assignmentId, dispatchTo: content.dispatch_to });
      return;
    }

    const body = this.extractBody(content);
    const streamSessionId = randomUUID();
    const task: TaskConfig = {
      taskId,
      executionSessionId: event.getRoomId() ?? '',
      body,
      streamSessionId,
      dispatchContext: {
        fromAssignmentId: dispatchFrom,
        task_id: taskId,
        ...(typeof content.tool_budget === 'number' ? { tool_budget: content.tool_budget } : {}),
        ...(typeof content.tool_stream_session_id === 'string'
          ? { tool_stream_session_id: content.tool_stream_session_id }
          : {}),
      },
    };
    await runner.executeTask(task);
  }

  /**
   * task_reply event → 通知正在执行该 task 的 PM runtime。
   * 把 snake_case content 转成 camelCase notification 后调用 AgentRunner.notifyTaskReply，
   * runner 内部按 taskId 匹配 activeTasks 找到对应子进程并 IPC 推送。
   *
   * 路由优先级（v2 Task 10：reply_to 值即 PM 的 assignmentId，直接定位 runner）：
   *   1. assignmentId 参数（调用方已解析）→ 精确通知
   *   2. event content.reply_to 存在 → 直接作 runners key 精确通知
   *   3. 都没有 → 广播给所有 runner（向后兼容旧 task_reply event）
   *
   * @param assignmentId 已知的 PM runner key（精确通知）；未提供时尝试 reply_to 或广播
   */
  private async routeTaskReply(event: InternalEvent, assignmentId?: string): Promise<void> {
    const content = event.getContent();
    const taskId = content.task_id;
    if (typeof taskId !== 'string') return;

    const notification: TaskReplyNotification = {
      taskId,
      status: typeof content.status === 'string' ? content.status : '',
      body: this.extractBody(content),
      ...(typeof content.progress_pct === 'number' ? { progressPct: content.progress_pct } : {}),
      ...(typeof content.tool_calls_used === 'number'
        ? { toolCallsUsed: content.tool_calls_used }
        : {}),
    };

    // reply_to 存在时直接定位目标 PM runner（避免广播）
    const targetAssignmentId =
      assignmentId ?? (typeof content.reply_to === 'string' ? content.reply_to : undefined);

    if (targetAssignmentId) {
      const runner = this.opts.runners.get(targetAssignmentId);
      if (runner) {
        await runner.notifyTaskReply(notification);
      }
      return;
    }
    // 未指定 runner → 广播（保留给调用方未解析目标时的兜底）
    for (const runner of this.opts.runners.values()) {
      await runner.notifyTaskReply(notification);
    }
  }

  /**
   * abort_dispatch event → 级联中断子 agent 的 dispatch task。
   *
   * PM 子进程的 dispatch-wait onAbort 发出此 event（content 携带
   * sub_stream_session_id = 子 agent 流 session id，见 dispatch.ts
   * buildAbortDispatchMessage）。此处对全部 runner 广播
   * runner.abortStream(subStreamSessionId)——与 notifyTaskReply 广播语义一致，
   * 各 runner 的 activeTasks 活跃表自然过滤，只有持有该子流的 runner
   * 真正向子进程下发 abort IPC；找不到目标（流已结束/子 agent 未启动）时
   * 各 runner 均为 no-op，仅记 warn，不抛错。
   *
   * 注意：PM 自身 stream 的中止走 'agent:abortStream' IPC 直达路径
   * （renderer → abortStreamBySessionId → runtime-registry 广播），不经本路由。
   */
  private async routeAbortDispatch(event: InternalEvent): Promise<void> {
    const content = event.getContent();
    const taskId = content.task_id;
    const subStreamSessionId = content.sub_stream_session_id;
    // 关键字段缺失 → 无法定位子 agent 流，丢弃（warn 不抛错，避免阻塞桥的后续 event）
    if (typeof taskId !== 'string' || typeof subStreamSessionId !== 'string') {
      logger.warn('routeAbortDispatch content 缺关键字段（task_id / sub_stream_session_id）', { content });
      return;
    }
    if (this.opts.runners.size === 0) {
      // 无 runner 可广播——子 agent 未启动 / 已停止 / 进程重启中。abort 信号丢失，
      // 兜底交给 PM 侧 abort 后 reject（dispatch-wait onAbort）+ 子 agent 自身的
      // 渐进式超时——上游不需要「已广播」信息（实际并未广播）。
      logger.warn('routeAbortDispatch 无 runner 可广播（子 agent 未启动或已停止）', {
        taskId,
        subStreamSessionId,
      });
      return;
    }
    for (const runner of this.opts.runners.values()) {
      runner.abortStream(subStreamSessionId);
    }
    logger.info('abort_dispatch 已广播', {
      taskId,
      subStreamSessionId,
      runnerCount: this.opts.runners.size,
    });
  }

  /** 启动钩子（当前仅日志；RouterService 为 lazy 单例，无其他初始化职责） */
  start(): void {
    logger.info('RouterService 已启动');
  }
}
