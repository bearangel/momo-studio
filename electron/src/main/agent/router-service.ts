// electron/src/main/agent/router-service.ts
//
// 主进程消息路由中心——task-driven 架构的核心。
// 替代 v1 的 runtime 自己监听 Matrix event：所有 Matrix event 统一经此分流。
//
// 流程：
//   sync-manager 收到 Matrix event → RouterService.routeMatrixEvent
//     → m.room.message                → routeUserMessage（ephemeral chat task → AgentRunner.executeTask）
//     → io.momo-studio.dispatch        → routeDispatch（dispatch ephemeral task，含 dispatchContext → AgentRunner.executeTask）
//     → io.momo-studio.task_reply      → routeTaskReply（通知正在执行的 PM runtime → AgentRunner.notifyTaskReply）
//     → io.momo-studio.abort_dispatch  → routeAbortDispatch（T8 完整实现）
//
// 第 4 个参数 directTargetAssignmentId 是已解析好的目标 runner key
// （由 sync-manager / runtime-entry 根据房间类型 + decideResponse 预先决定），
// 这样 RouterService 自身不做 decideResponse 判定，只负责按 event 类型构造 task 并派发。
// decideResponse / parseMentions 在上层 sync-manager 调用前已使用，此处不再重复。

import { randomUUID } from 'node:crypto';
import { logger } from '../logger';
import { DISPATCH_EVENT_TYPE, TASK_REPLY_EVENT_TYPE, ABORT_DISPATCH_EVENT_TYPE } from './dispatch';
import type { AgentRunner, TaskConfig } from './agent-runner';
import type { TaskDispatcher } from '../task/dispatcher';

/** RouterService 构造选项 */
export interface RouterServiceOpts {
  /** assignmentId（instance_id）→ runner */
  runners: Map<string, AgentRunner>;
  /** 任务调度器（pickup 决策 + 三层并发控制；routeUserMessage 不经过它——ephemeral chat 直接派发） */
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

/** Matrix event 的最小子集形状（与 matrix-js-sdk MatrixEvent 兼容） */
interface RoutedEvent {
  getType(): string;
  getContent(): Record<string, unknown>;
  getSender(): string;
  getRoomId(): string;
}

export class RouterService {
  constructor(private readonly opts: RouterServiceOpts) {}

  /**
   * 路由单个 Matrix event。按 event 类型分流，找不到匹配类型时静默忽略。
   * 任一路由分支抛错都被 catch 记录，不阻塞 sync-manager 的后续 event 处理。
   *
   * @param event Matrix event（getType/getContent/getSender/getRoomId）
   * @param _ownerUserId workspace owner 的 Matrix userId（保留给 T8 abort/权限判定）
   * @param _targetAssignmentId 房间级目标 assignment（群组默认接待 agent）；当前 3 条路由
   *   都用 directTargetAssignmentId 精确派发，此参数预留给 T8 的群组广播场景
   * @param directTargetAssignmentId 单聊/已解析的直接目标 runner key；未传则 m.room.message/dispatch 不派发
   */
  async routeMatrixEvent(
    event: RoutedEvent,
    _ownerUserId: string,
    _targetAssignmentId: string | null,
    directTargetAssignmentId?: string,
  ): Promise<void> {
    const type = event.getType();
    try {
      switch (type) {
        case 'm.room.message':
          if (directTargetAssignmentId) {
            await this.routeUserMessage(event, directTargetAssignmentId);
          }
          break;
        case DISPATCH_EVENT_TYPE:
          if (directTargetAssignmentId) {
            await this.routeDispatch(event, directTargetAssignmentId);
          }
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

  /**
   * 用户文本消息 → ephemeral chat task。
   * 创建一个 taskId=null 的即时对话 task，交给目标 runner 执行。
   * 不经过 TaskDispatcher——ephemeral chat 是即时响应，不走 assigned 任务队列。
   */
  private async routeUserMessage(event: RoutedEvent, assignmentId: string): Promise<void> {
    const content = event.getContent();
    const body = typeof content.body === 'string' ? content.body : '';
    const roomId = event.getRoomId();

    const runner = this.opts.runners.get(assignmentId);
    if (!runner) {
      logger.warn('routeUserMessage 未找到 runner', { assignmentId });
      return;
    }

    const streamSessionId = randomUUID();
    const task: TaskConfig = {
      taskId: null,
      executionRoomId: roomId,
      body,
      streamSessionId,
    };
    await runner.executeTask(task);
  }

  /**
   * PM dispatch event → sub-agent 的 dispatch ephemeral task。
   * 把 dispatch content 的 dispatch_from / task_id / tool_budget / tool_stream_session_id
   * 组装成 dispatchContext 注入 executeTask，子进程 runtime-entry 据此跑 handleDispatch 流程。
   */
  private async routeDispatch(event: RoutedEvent, assignmentId: string): Promise<void> {
    const content = event.getContent();
    const dispatchFrom = content.dispatch_from;
    const taskId = content.task_id;
    // 关键字段缺失 → 无法关联 task_reply，直接丢弃
    if (typeof dispatchFrom !== 'string' || typeof taskId !== 'string') {
      logger.warn('routeDispatch content 缺关键字段', { content });
      return;
    }

    const runner = this.opts.runners.get(assignmentId);
    if (!runner) {
      logger.warn('routeDispatch 未找到 runner', { assignmentId, dispatchTo: content.dispatch_to });
      return;
    }

    const body = typeof content.body === 'string' ? content.body : '';
    const streamSessionId = randomUUID();
    const task: TaskConfig = {
      taskId,
      executionRoomId: event.getRoomId(),
      body,
      streamSessionId,
      dispatchContext: {
        fromBotUserId: dispatchFrom,
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
   * @param assignmentId 已知的 PM runner key（精确通知）；未提供时广播给所有 runner（兼容旧路径）
   */
  private async routeTaskReply(event: RoutedEvent, assignmentId?: string): Promise<void> {
    const content = event.getContent();
    const taskId = content.task_id;
    if (typeof taskId !== 'string') return;

    const notification: TaskReplyNotification = {
      taskId,
      status: typeof content.status === 'string' ? content.status : '',
      body: typeof content.body === 'string' ? content.body : '',
      ...(typeof content.progress_pct === 'number' ? { progressPct: content.progress_pct } : {}),
      ...(typeof content.tool_calls_used === 'number'
        ? { toolCallsUsed: content.tool_calls_used }
        : {}),
    };

    if (assignmentId) {
      const runner = this.opts.runners.get(assignmentId);
      if (runner) {
        await runner.notifyTaskReply(notification);
      }
      return;
    }
    // 未指定 runner → 广播（保留给未来 sync-manager 未解析目标时的兜底）
    for (const runner of this.opts.runners.values()) {
      await runner.notifyTaskReply(notification);
    }
  }

  /**
   * abort_dispatch event → 中断正在执行的 sub-agent task。
   * T8 完整实现：按 task_id 找到 runner → runner.abortStream(streamSessionId)。
   * 当前仅记录日志，不抛错（避免阻塞 sync-manager）。
   */
  private async routeAbortDispatch(event: RoutedEvent): Promise<void> {
    const content = event.getContent();
    const taskId = content.task_id;
    if (typeof taskId !== 'string') return;
    // TODO(T8): 按 task_id 反查正在执行的 runner + streamSessionId → runner.abortStream
    logger.info('abort_dispatch event 收到（T8 完整实现）', { taskId });
  }

  /** 启动钩子（当前仅日志；预留给 T8 注册 dispatcher 终态回调） */
  start(): void {
    logger.info('RouterService 已启动');
  }
}
