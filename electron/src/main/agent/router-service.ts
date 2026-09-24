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
import {
  DISPATCH_EVENT_TYPE,
  TASK_REPLY_EVENT_TYPE,
  ABORT_DISPATCH_EVENT_TYPE,
  parseHistoryPrefix,
} from './dispatch';
import {
  dispatchRegistry,
  HEARTBEAT_INTERVAL_MS,
  type DispatchChainHandle,
} from './dispatch-registry';
import { insertMessage } from '../storage/messages/repo';
import { getDb } from '../storage/db';
import type { AgentRunner, TaskConfig } from './agent-runner';
import type { TaskDispatcher } from '../task/dispatcher';
import { registerLane, getLane } from './session-lane';
import { getSession } from '../storage/sessions/repo';
import { expandMessageContext } from '../im/context-expander';
import type { MessageContext } from '../../../../renderer/src/ipc/types';

// === v2.9 事件驱动 dispatch：runner 空闲通知通道（依赖注入，与 setBridgeRouter 同法） ===
// runtime-registry 构造 AgentRunner 时注入 onIdle = notifyRunnerIdle；router-bootstrap
// 启动时经 setRunnerIdleHandler 绑定到当前 RouterService 实例。模块级间接避免
// runtime-registry → RouterService 的构造期循环依赖。

/** 模块级空闲处理器（ensureRouterService 注入 / destroyRouterService 置空） */
let runnerIdleHandler: ((assignmentId: string, forcedExit: boolean) => void) | null = null;

export function setRunnerIdleHandler(
  handler: ((assignmentId: string, forcedExit: boolean) => void) | null,
): void {
  runnerIdleHandler = handler;
}

/** AgentRunner onIdle 回调的注入目标（回调抛错只记日志——不拖垮收尾链路） */
export function notifyRunnerIdle(assignmentId: string, forcedExit = false): void {
  try {
    runnerIdleHandler?.(assignmentId, forcedExit);
  } catch (err) {
    logger.warn('runner 空闲通知处理失败', { assignmentId, error: String(err) });
  }
}

// === B2/B3（安全 review 2026-09-24）：内部事件身份与 taskId 加固 ===

/** B3：taskId 进入注册表 / 文件名 / 提示文本前的合法形状（拒绝路径穿越与控制字符） */
const SAFE_TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** B3：taskId 进入提示文本前的净化——剥离控制字符（防伪造消息结构注入 PM 上下文） */
function safeTaskIdText(taskId: string): string {
  return taskId.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 64);
}

/**
 * B2（安全复审 R2 修正）：sender（agentUserId）→ assignmentId 反查结果。
 *
 * 三态而非二值：降级与拒绝必须区分——
 * - ok：解析成功（assignment 可与 dispatch_from / subAssignmentId 比对）
 * - degrade：环境性失败（DB 不可用）——降级放行 + 日志（桥层身份绑定仍是
 *   主防线：sender 无法跨身份伪造，环境失败不等于攻击）
 * - reject：会话不存在 / 发送者非该会话 workspace 成员 / 非法身份（owner/空）。
 *   这些状态可被攻击者经 envelope sessionId **主动安排**（跨 workspace 会话 /
 *   不存在的会话 → 反查必然落空），必须 fail-closed——否则 round-1 HIGH-A
 *   （持久化 owner 行注入 + 任意 PM 唤醒 + 第三方链 settle 劫持）经此复活。
 */
type SenderLookup =
  | { outcome: 'ok'; assignment: string }
  | { outcome: 'degrade' }
  | { outcome: 'reject' };

function resolveSender(sender: string | undefined, sessionId: string): SenderLookup {
  if (typeof sender !== 'string' || sender.length === 0 || sender === 'owner') {
    return { outcome: 'reject' };
  }
  let ws: string | null;
  try {
    ws = getSession(sessionId)?.workspaceId ?? null;
  } catch {
    return { outcome: 'degrade' };
  }
  // 合法子进程的内部事件必引用真实会话——不存在的会话是攻击面（伪造 sessionId）
  if (!ws) return { outcome: 'reject' };
  try {
    const row = getDb()
      .prepare(
        'SELECT instance_id FROM workspace_agent_members WHERE agent_user_id = ? AND workspace_id = ?',
      )
      .get(sender, ws) as { instance_id: string } | undefined;
    return row ? { outcome: 'ok', assignment: row.instance_id } : { outcome: 'reject' };
  } catch {
    return { outcome: 'degrade' };
  }
}

/** RouterService 构造选项 */
export interface RouterServiceOpts {
  /** assignmentId（instance_id）→ runner */
  runners: Map<string, AgentRunner>;
  /**
   * 任务调度器——v2.0.1（spec §9）pickup 链路砍除后不再接线，字段仅作
   * 2.1 预留（可选）；RouterService 现役三条路由均不经过 dispatcher。
   * routeUserChat 是即时响应，不走 assigned 任务队列。
   */
  dispatcher?: TaskDispatcher;
  /**
   * 自动拉起（v25 Task 9，spec §4.6「目标成员离线时自动拉起」）：runner 缺失时
   * 先经此回调走 agent start 链（构建 spawn opts + 注册 runner），完成后再派发。
   * 未注入（测试/旧构造）时保持旧语义：runner 缺失 → warn 跳过。
   * 生产接线：router-bootstrap 注入 start-chain 的 ensureMemberRuntime。
   */
  ensureRunner?: (assignmentId: string) => Promise<void>;
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
  /** v2.3：系统 kickoff 消息（车道无条件派发；steer 分流跳过） */
  systemKickoff?: boolean;
  /** v2.3：kickoff 来源任务 id（车道注册；手输为 null） */
  sourceTaskId?: string | null;
  /** v2.11：输入框上下文（metadata 级；展开为 ExpandedContext 后随 task-config / steer 下发） */
  context?: MessageContext;
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
  /** v2.9：心跳死亡清扫计时器（start() 武装 / stop() 清除；unref 不阻塞退出） */
  private sweepTimer?: NodeJS.Timeout;

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
    let runner = this.opts.runners.get(input.assignmentId);
    if (!runner && this.opts.ensureRunner) {
      // Task 9 自动拉起：接待者 lastRunning=false（无 runner）→ start 后派发。
      // 拉起失败不向调用方抛错——消息已落库，发送链路不因 agent 启动失败而失败。
      try {
        await this.opts.ensureRunner(input.assignmentId);
      } catch (err) {
        logger.warn('routeUserChat 自动拉起失败，放弃派发', {
          assignmentId: input.assignmentId,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      runner = this.opts.runners.get(input.assignmentId);
    }
    if (!runner) {
      logger.warn('routeUserChat 未找到 runner', { assignmentId: input.assignmentId });
      return;
    }

    // v2.11：上下文在 steer 分支前展开一次，executeTask 与 steer 两分支共用
    //（expander 永不抛错，无需 try/catch；workspaceId 解析失败降级 null →
    //  文件引用全降级，消息派发不受影响）
    const expandedContext = input.context
      ? await expandMessageContext(this.resolveWorkspaceId(input.sessionId), input.context)
      : undefined;

    // v2.3 steer 分流（spec §5.1）：活跃流期间用户手输 → 注入当前流而非新流。
    // 分流键 = (sessionId, assignmentId)：@ 其他成员不 steer（目标 runner 不同）
    // typeof guard：真实 AgentRunner 必有 steer；测试中 mock 是结构子集（仅 executeTask/notifyTaskReply），
    //   兼容旧测试避免 steer undefined 崩溃（生产路径不变）
    if (!input.systemKickoff && typeof runner.steer === 'function') {
      const laneEntry = getLane(input.sessionId);
      if (laneEntry && laneEntry.assignmentId === input.assignmentId) {
        const steered = runner.steer(laneEntry.streamSessionId, input.body, expandedContext);
        if (steered) return;
        // 死通道回退（spec §5.4）：流恰好结束——继续走正常派发，消息不丢
        logger.info('steer 通道已关，回退正常派发', {
          sessionId: input.sessionId,
          streamSessionId: laneEntry.streamSessionId,
        });
      }
    }

    const task: TaskConfig = {
      taskId: null,
      executionSessionId: input.sessionId,
      body: input.body,
      streamSessionId: input.streamSessionId ?? randomUUID(),
      ...(expandedContext ? { context: expandedContext } : {}),
    };
    await runner.executeTask(task);
    // v2.3 会话车道注册（spec §4.1）：顶层流派发即占道；dispatch 子流走
    // routeDispatch 不经此路径，天然不注册（并行委派能力保留）
    registerLane(
      input.sessionId,
      {
        taskId: input.sourceTaskId ?? null,
        streamSessionId: task.streamSessionId,
        assignmentId: input.assignmentId,
      },
      { kickoff: input.systemKickoff === true },
    );
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
   * sessionId → workspaceId（v2.11：文件上下文展开需要 workspace 根目录）。
   * DB 异常（未初始化/表缺失）降级 null——上下文是增强不是前提，
   * 与 expander「永不抛错」契约对齐，绝不阻塞消息派发。
   */
  private resolveWorkspaceId(sessionId: string): string | null {
    try {
      return getSession(sessionId)?.workspaceId ?? null;
    } catch {
      return null;
    }
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

    // v2.9 事件驱动 dispatch：链注册进主进程 DispatchRegistry（跨轮真相源——
    // PM 子进程状态随回合消亡，主进程链态承担迟到回执投递与死亡检测）。
    // B2（安全 review）：dispatch_from 必须与事件真实 sender 反查一致——
    // 子进程不得冒充其它 agent 派发（会话成员身份经 workspace 反查）。
    // B3：taskId 形状门（拒绝路径穿越字符/超长——注册表键与落盘文件名的上游）。
    // 同链在途重复轮（并行批次重复 followup 的竞态兜底）→ 拒绝且绝不静默：
    // PM 回合内经 steer 注入拒绝提示；流已关则仅记日志（下一轮追问由链态兜底拒绝）。
    const roomId = event.getRoomId() ?? '';
    if (!SAFE_TASK_ID_RE.test(taskId)) {
      logger.warn('routeDispatch taskId 形状非法，丢弃', { taskId });
      return;
    }
    // B2（R2 fail-closed）：dispatch_from 必须与事件真实 sender 反查一致。
    // reject（会话不存在/非成员/非法身份——攻击者可经 sessionId 安排）与
    // 不匹配一律丢弃；仅环境性 DB 失败降级放行（记日志）
    const senderLookup = resolveSender(event.getSender(), roomId);
    if (senderLookup.outcome === 'degrade') {
      logger.warn('routeDispatch sender 反查环境性失败，降级放行', { taskId });
    } else if (senderLookup.outcome !== 'ok' || senderLookup.assignment !== dispatchFrom) {
      logger.warn('routeDispatch sender 身份校验失败，丢弃', {
        taskId,
        dispatchFrom,
        outcome: senderLookup.outcome,
      });
      return;
    }
    const chainStreamId =
      typeof content.sub_stream_session_id === 'string' ? content.sub_stream_session_id : undefined;
    const pmStreamSessionId =
      typeof content.tool_stream_session_id === 'string' ? content.tool_stream_session_id : undefined;
    // B4(ii)（R3 复审修正）：链复用会重置 done 链的回执字段——复用前若上一轮
    // 终态从未投递，取快照入 pendingDeliveries 队列，经 tryDeliver 的 busy 门
    // 与串行化循环消费（PM 派发时必然在回合中，直接投递会造成并发顶层流）
    const priorUndelivered = dispatchRegistry.requeueUndelivered(taskId);
    if (priorUndelivered) {
      logger.info('routeDispatch 链复用前补投上一轮未投递回执', { taskId });
      const q = this.pendingDeliveries.get(priorUndelivered.pmAssignmentId);
      if (q) q.push(priorUndelivered);
      else
        this.pendingDeliveries.set(priorUndelivered.pmAssignmentId, [priorUndelivered]);
      this.tryDeliver(priorUndelivered.pmAssignmentId);
    }
    const registered = dispatchRegistry.register({
      taskId,
      pmAssignmentId: dispatchFrom,
      subAssignmentId: assignmentId,
      sessionId: roomId,
      ...(chainStreamId !== undefined ? { subStreamSessionId: chainStreamId } : {}),
      ...(pmStreamSessionId !== undefined ? { pmStreamSessionId } : {}),
      isFollowupRound: content.followup_round === true,
    });
    if (!registered) {
      logger.warn('routeDispatch 同链在途轮次，拒绝重复派发', { taskId, assignmentId });
      // 拒绝必须让 PM 感知（绝不静默丢）：PM 回合内 → steer 注入提示到 PM 的
      // 当前流（注意目标是 PM 的 runner，不是本 dispatch 的目标子 agent）；
      // PM 空闲/流已关 → 仅记日志（下一轮追问由主进程链态兜底拒绝）
      const pmRunner = this.opts.runners.get(dispatchFrom);
      if (pmStreamSessionId && pmRunner && typeof pmRunner.steer === 'function') {
        pmRunner.steer(
          pmStreamSessionId,
          `【系统提示】任务链 ${safeTaskIdText(taskId)} 已有在途轮次，本次重复派发被拒绝——回执完成后会自动送达，无需重发。`,
        );
      }
      return;
    }

    const body = this.extractBody(content);
    // P0-7：优先用 PM 预生成的 sub_stream_session_id（与 renderer chip 的查找键
    // 一致）；旧消息无此字段时回退 randomUUID（嵌套展示缺查找键，仅顶层可见）
    const streamSessionId =
      typeof content.sub_stream_session_id === 'string' ? content.sub_stream_session_id : randomUUID();
    // v2.8.0 Orchestration（Task 6）：followup 续聊前缀——dispatch_followup 派发的
    // content.history_prefix（rebuildSubConversation 重建的子会话历史）映射为
    // TaskConfig.historyPrefix，子 agent runChatLoop 拼接在 system 之后。非法载荷
    // 整字段丢弃（降级方向安全——子 agent 按全新任务处理），不拒整条 dispatch。
    const historyPrefix = parseHistoryPrefix(content.history_prefix);
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
      ...(historyPrefix !== undefined ? { historyPrefix } : {}),
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

    // v2.9 事件驱动 dispatch：主进程链注册表更新（心跳 / 终态翻转 + 投递判定）。
    // 先于下方转发——PM 空闲时的投递唤醒依赖链态已就绪。
    // B2（R2 fail-closed）：settle/心跳只接受链的目标子 agent 本人回执——
    // reject（会话不存在/非成员——攻击者可经 envelope sessionId 安排）或
    // 反查不一致一律忽略；仅环境性 DB 失败降级放行。第三方子进程经此路径
    // 既不能翻转他人链终态，也不能用伪造心跳为死亡链续命
    this.applyRegistryReply(
      content,
      resolveSender(event.getSender(), event.getRoomId() ?? ''),
    );

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
    // v2.9：链注册表取消——cancelled 恒不投递（abort 止损后的迟到回执不唤醒 PM）
    dispatchRegistry.cancel(taskId);
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

  // === v2.9 事件驱动 dispatch：链注册表联动 + 自动投递 ===

  /**
   * task_reply content → DispatchRegistry 更新 + 投递判定（routeTaskReply 消费）。
   * in_progress → 心跳续命；终态 → 翻转后按 isFollowupRound / awaitWake 决定投递。
   * 未注册链（历史遗留 / 伪造 task_id）→ no-op，不影响既有转发路径。
   * B2（R2 fail-closed）：链存在时，reject 或反查 ≠ subAssignmentId 一律忽略；
   * degrade（环境性 DB 失败）降级放行（桥层绑定已保证 sender 不可伪造）。
   */
  private applyRegistryReply(
    content: Record<string, unknown>,
    senderLookup: SenderLookup,
  ): void {
    const taskId = content.task_id;
    if (typeof taskId !== 'string') return;
    const status = content.status;
    if (typeof status !== 'string') return;
    const chain = dispatchRegistry.get(taskId);
    if (chain) {
      if (senderLookup.outcome === 'reject') {
        logger.warn('task_reply sender 身份校验失败，忽略', { taskId });
        return;
      }
      if (
        senderLookup.outcome === 'ok' &&
        senderLookup.assignment !== chain.subAssignmentId
      ) {
        logger.warn('task_reply sender 与链的目标子 agent 不符，忽略', {
          taskId,
          senderAssignment: senderLookup.assignment,
          subAssignmentId: chain.subAssignmentId,
        });
        return;
      }
    }
    if (status === 'in_progress') {
      dispatchRegistry.heartbeat(taskId);
      return;
    }
    if (status !== 'completed' && status !== 'failed' && status !== 'needs_input') return;
    const body = typeof content.body === 'string' ? content.body : '';
    const toolCallsUsed =
      typeof content.tool_calls_used === 'number' ? content.tool_calls_used : undefined;
    const handle = dispatchRegistry.settle(taskId, status, body, toolCallsUsed);
    if (handle && (handle.isFollowupRound || handle.awaitWake)) {
      this.tryDeliver(handle.pmAssignmentId);
    }
  }

  /**
   * 投递自动送达结果（PM 空闲时机）。
   *
   * B6（质量 review 2026-09-24）：per-runner 串行投递——逐条 takeNextDeliverable
   * + await deliverChainResult + 每条前重查 busy。deliverChainResult 会完整 await
   * routeUserChat（含 executeTask 的 activeTasks.set），因此下一条投递时 PM 已
   * 占线 → 本批中断，余下链留给下一个 onIdle 边沿（连续投递自然级联，一回合
   * 一条）——消除同会话并发 PM 回合与 session-lane 互相覆盖。
   * delivering 守卫防 onPmIdle 与 applyRegistryReply 的同步重入。
   */
  private readonly delivering = new Set<string>();

  /**
   * B4(ii)（R3 复审修正）：链复用前补投的暂存队列（pmAssignmentId → 待投递快照）。
   * 旧实现直接 deliverChainResult——但 routeDispatch 时 PM 必然在回合中（其
   * dispatch 事件刚到达），直接投递绕过 busy 门与 delivering 守卫，会在 PM
   * 回合中并发拉起第二条顶层流（恰是 B6 要消除的形态）。改经本队列由
   * tryDeliver 的串行化循环消费——busy 时挂起，idle 边沿逐条投递。
   */
  private readonly pendingDeliveries = new Map<string, DispatchChainHandle[]>();

  tryDeliver(pmAssignmentId: string): void {
    if (this.delivering.has(pmAssignmentId)) return;
    this.delivering.add(pmAssignmentId);
    void (async () => {
      try {
        for (;;) {
          // runner 缺失不阻断（routeUserChat 的 ensureRunner 可自动拉起）；
          // busy 才中断——余下链留给下一个 idle 边沿
          const runner = this.opts.runners.get(pmAssignmentId);
          if (runner?.busy) break;
          // R3：复用前补投的暂存队列优先于注册表（快照不经 takeNextDeliverable）
          const queue = this.pendingDeliveries.get(pmAssignmentId);
          const h =
            queue && queue.length > 0
              ? queue.shift()!
              : dispatchRegistry.takeNextDeliverable(pmAssignmentId);
          if (queue && queue.length === 0) this.pendingDeliveries.delete(pmAssignmentId);
          if (!h) break;
          await this.deliverChainResult(h).catch((err: unknown) =>
            logger.error('dispatch 回执自动送达失败', {
              taskId: h.taskId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      } finally {
        this.delivering.delete(pmAssignmentId);
      }
    })();
  }

  /**
   * 自动送达一条链终态（v2.9 核心）：
   * 1. 落库 dispatch-result 消息行（sender='owner' + taskId=链 ID——行因此
   *    进链历史，后续 followup 的 rebuildSubConversation 天然聚合本轮结果；
   *    streamSessionId 单点生成，与唤醒流共用 = routeUserChat 的输入流）
   * 2. routeUserChat(systemKickoff) 唤醒 PM 新回合——PM 上下文重建时该行
   *    即用户轮输入，结果全文随历史进入推理
   */
  private async deliverChainResult(h: DispatchChainHandle): Promise<void> {
    const streamSessionId = randomUUID();
    const statusText = h.outcome === 'failed' ? '失败' : '完成';
    // B3：taskId 经净化插值（防伪造消息结构注入 PM 上下文）
    const chainIdText = safeTaskIdText(h.taskId);
    const body =
      `【dispatch 回执自动送达】任务链 ${chainIdText}（第 ${h.round} 轮）已${statusText}` +
      `（工具调用 ${h.toolCallsUsed ?? 0} 次）。\n` +
      `--- 回执正文 ---\n${h.body ?? ''}\n--- 回执结束 ---\n` +
      '如需就该结果继续追问，使用 dispatch_followup(taskId)；本通知已持久化到会话历史。';
    try {
      insertMessage({
        sessionId: h.sessionId,
        sender: 'owner',
        eventType: 'm.room.message',
        body,
        taskId: h.taskId,
        streamSessionId,
      });
    } catch (err) {
      // 行落库失败不阻断唤醒（会话历史少一行，但 PM 本轮仍能拿到结果正文）
      logger.warn('dispatch 回执注入行落库失败（继续唤醒）', {
        taskId: h.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await this.routeUserChat({
      sessionId: h.sessionId,
      assignmentId: h.pmAssignmentId,
      body,
      streamSessionId,
      systemKickoff: true,
    });
  }

  /**
   * PM 空闲入口（AgentRunner.onIdle → notifyRunnerIdle → 本方法）：
   * 空闲快照（在途链置 awaitWake）+ 投递已就绪结果。连续投递自然级联——
   * 每次唤醒回合结束再次触发本方法，直至无待投递。
   * B4(i)（质量 review）：forcedExit = 回合被强制截断（预算耗尽 / 中断 /
   * 错误 / 子进程崩溃）——此时 PM 没有公平机会 gather，已翻转未投递的链
   * 一并置 awaitWake 补投；正常收尾（stop）维持 gather 契约不补投。
   */
  onPmIdle(assignmentId: string, forcedExit = false): void {
    dispatchRegistry.markPmIdle(assignmentId, forcedExit ? { deliverSettledUndelivered: true } : undefined);
    this.tryDeliver(assignmentId);
  }

  /**
   * 心跳死亡清扫（周期 = HEARTBEAT_INTERVAL_MS）：判死链已由 sweepDead 在
   * 注册表内 settle failed，此处走终态统一后半段——转发 PM（同步等待立即
   * reject，替代盲等 9 分钟）+ 投递判定。
   * B6（质量 review）：notifyTaskReply 补 .catch——主进程不残留 unhandled
   * rejection 崩溃面（child.send 通道异常时的 reject 路径）。
   */
  private sweepOnce(): void {
    for (const d of dispatchRegistry.sweepDead()) {
      logger.warn('dispatch 链心跳超时判死', { taskId: d.taskId, reason: d.reason });
      const handle = dispatchRegistry.get(d.taskId);
      if (!handle) continue;
      const runner = this.opts.runners.get(handle.pmAssignmentId);
      runner
        ?.notifyTaskReply({ taskId: d.taskId, status: 'failed', body: d.reason })
        .catch((err: unknown) =>
          logger.warn('死亡清扫通知 PM 失败', {
            taskId: d.taskId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      if (handle.isFollowupRound || handle.awaitWake) {
        this.tryDeliver(handle.pmAssignmentId);
      }
    }
  }

  /** 启动钩子：日志 + v2.9 心跳死亡清扫计时器（unref——不阻塞进程退出） */
  start(): void {
    logger.info('RouterService 已启动');
    this.sweepTimer = setInterval(() => this.sweepOnce(), HEARTBEAT_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  /** 停止清扫计时器（destroyRouterService / 测试清理调用；幂等） */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }
}
