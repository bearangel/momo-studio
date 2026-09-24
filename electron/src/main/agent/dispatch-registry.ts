// electron/src/main/agent/dispatch-registry.ts
//
// v2.9 事件驱动 dispatch（spec 2026-09-24）：主进程跨轮 dispatch 链真相源。
//
// 背景：runtime 子进程每轮 task-end 即退出——PM 子进程内的 pendingReplies /
// bgHandles 状态不跨轮存活。PM 回合结束后子 agent 的迟到回执在
// RouterService.notifyTaskReply 侧因无活跃子进程被静默丢弃；PM 对子 agent
// 是否仍在运行零感知（followup 盲等 9 分钟的根因）。
//
// 本注册表把链状态上移主进程，补齐事件驱动模型的三块基石：
//   1. routeDispatch 注册（同步 dispatch / dispatch_bg / followup 统一入表），
//      routeTaskReply 心跳（in_progress）与终态翻转——链真相跨 PM 轮次存活
//   2. PM 空闲快照（markPmIdle）：在途链置 awaitWake——翻转后自动注入唤醒
//      （dispatch-result 消息行 + routeUserChat 新回合，RouterService 驱动）
//   3. 心跳死亡检测：子 agent 每 HEARTBEAT_INTERVAL_MS 上报 in_progress，
//      超过 HEARTBEAT_DEAD_THRESHOLD_MS 无心跳判无响应——RouterService 清扫
//      后经统一 task_reply 路径回 failed（同步等待立即 reject，不再死等 9 分钟）
//
// 纯逻辑模块：无计时器、无 IPC、无 DB——清扫节奏与投递动作由 RouterService
// 驱动；时钟可注入（单测 fake clock，momo-test-rules 保真度纪律）。

/** 链状态：in_flight 在途 / done 已收终态回执 / cancelled 已取消（abort 止损） */
export type ChainStatus = 'in_flight' | 'done' | 'cancelled';

/** 子任务结局：completed 成功；failed 含 failed / needs_input（与 BgHandle.outcome 同语义） */
export type ChainOutcome = 'completed' | 'failed';

/** 单条 dispatch 链的主进程侧句柄 */
export interface DispatchChainHandle {
  /** 链 ID（dispatch 事件的 task_id，单点生成沿线透传） */
  taskId: string;
  /** PM assignmentId（dispatch_from）——投递唤醒的目标 runner key */
  pmAssignmentId: string;
  /** 子 agent assignmentId（dispatch_to） */
  subAssignmentId: string;
  /** 链所在会话（dispatch 事件 roomId）——投递 routeUserChat 的目标会话 */
  sessionId: string;
  /** 子 agent 流 id（sub_stream_session_id） */
  subStreamSessionId?: string;
  /** PM 当前流 id（tool_stream_session_id）——在途轮被拒时 steer 定位键 */
  pmStreamSessionId?: string;
  /** 本轮是否 followup 追问轮——恒投递（PM 显式在等答案） */
  isFollowupRound: boolean;
  status: ChainStatus;
  outcome?: ChainOutcome;
  body?: string;
  toolCallsUsed?: number;
  startedAt: number;
  /** 最近一次心跳（或注册）时刻——死亡检测基准 */
  lastHeartbeatAt: number;
  completedAt?: number;
  /** PM 空闲快照置位：在途链翻转后自动投递（cancelled 恒不投递） */
  awaitWake: boolean;
  /** 已投递标记——防同一终态重复唤醒 PM */
  delivered: boolean;
  /** 累计轮次：首派 = 1，followup 复用链 ID 递增 */
  round: number;
}

/** 子 agent 心跳上报间隔（runtime-entry runTaskChatLoop 的 interval 周期，契约两侧同步） */
export const HEARTBEAT_INTERVAL_MS = 60_000;
/** 心跳死亡阈值：3 个周期无信号判无响应（覆盖单次长 LLM 生成期间的定时上报） */
export const HEARTBEAT_DEAD_THRESHOLD_MS = 3 * HEARTBEAT_INTERVAL_MS;
/**
 * settled（done/cancelled）链保留上限——防长会话链句柄（含 body）无界累积、
 * 内存单调涨。超限按 Map 插入序驱逐最旧 settled；in_flight 永不驱逐。
 * 与 dispatch-wait BG_SETTLED_CAP 同语义（跨轮侧容量更大：链含注入语义）。
 */
export const CHAIN_SETTLED_CAP = 64;

/** register 入参（routeDispatch 从 dispatch 事件 content 提取） */
export interface RegisterChainInput {
  taskId: string;
  pmAssignmentId: string;
  subAssignmentId: string;
  sessionId: string;
  subStreamSessionId?: string;
  pmStreamSessionId?: string;
  isFollowupRound: boolean;
}

/** sweepDead 返回的死亡链描述（RouterService 据此构造 synthetic task_reply） */
export interface DeadChain {
  taskId: string;
  pmAssignmentId: string;
  /** 判死原因文案（渲染进 synthetic failed reply 的 body） */
  reason: string;
}

/**
 * 主进程 dispatch 链注册表。moduleId 级单例 dispatchRegistry 供生产使用；
 * 测试可 new DispatchRegistry({ now }) 注入 fake clock。
 */
export class DispatchRegistry {
  private readonly chains = new Map<string, DispatchChainHandle>();
  private readonly nowFn: () => number;

  constructor(opts?: { now?: () => number }) {
    this.nowFn = opts?.now ?? ((): number => Date.now());
  }

  /**
   * 注册一轮派发（routeDispatch 消费）。
   * 同链复用（followup / PM 空闲后再次引用）时 round+1 并重置在途态。
   *
   * @returns false = 该链已有在途轮次（重复派发拒绝——调用方负责把拒绝
   *          反馈给 PM，绝不静默丢弃）；true = 注册成功
   */
  register(input: RegisterChainInput): boolean {
    const existing = this.chains.get(input.taskId);
    if (existing) {
      if (existing.status === 'in_flight') return false;
      // 链复用（典型：followup 下一轮）：重置为在途，保留链 ID 与轮次计数
      existing.status = 'in_flight';
      existing.isFollowupRound = input.isFollowupRound;
      existing.outcome = undefined;
      existing.body = undefined;
      existing.toolCallsUsed = undefined;
      existing.completedAt = undefined;
      existing.delivered = false;
      existing.awaitWake = false;
      existing.startedAt = this.nowFn();
      existing.lastHeartbeatAt = existing.startedAt;
      existing.subStreamSessionId = input.subStreamSessionId;
      existing.pmStreamSessionId = input.pmStreamSessionId;
      existing.round += 1;
      return true;
    }
    const now = this.nowFn();
    this.chains.set(input.taskId, {
      taskId: input.taskId,
      pmAssignmentId: input.pmAssignmentId,
      subAssignmentId: input.subAssignmentId,
      sessionId: input.sessionId,
      ...(input.subStreamSessionId !== undefined ? { subStreamSessionId: input.subStreamSessionId } : {}),
      ...(input.pmStreamSessionId !== undefined ? { pmStreamSessionId: input.pmStreamSessionId } : {}),
      isFollowupRound: input.isFollowupRound,
      status: 'in_flight',
      startedAt: now,
      lastHeartbeatAt: now,
      awaitWake: false,
      delivered: false,
      round: 1,
    });
    return true;
  }

  /** 查询单链（dispatch_status 类消费 / 测试断言）；不存在返回 undefined */
  get(taskId: string): DispatchChainHandle | undefined {
    return this.chains.get(taskId);
  }

  /** 心跳更新（in_progress task_reply）。链不存在或非在途 → false（迟到心跳幂等忽略） */
  heartbeat(taskId: string): boolean {
    const h = this.chains.get(taskId);
    if (!h || h.status !== 'in_flight') return false;
    h.lastHeartbeatAt = this.nowFn();
    return true;
  }

  /** 测试用：清空全部链（生产禁用——经模块级 __resetDispatchRegistryForTest） */
  clear(): void {
    this.chains.clear();
  }

  /**
   * 终态翻转（completed / failed / needs_input 统一入口；needs_input 归 failed——
   * 与 dispatch-wait handleTaskReply 的 reject 语义一致）。
   * 幂等：非在途（done / cancelled / 不存在）→ undefined，迟到回执不覆盖终态。
   *
   * @returns 翻转后的句柄快照（调用方据 isFollowupRound / awaitWake 决定投递）
   */
  settle(
    taskId: string,
    status: 'completed' | 'failed' | 'needs_input',
    body: string,
    toolCallsUsed?: number,
  ): DispatchChainHandle | undefined {
    const h = this.chains.get(taskId);
    if (!h || h.status !== 'in_flight') return undefined;
    h.status = 'done';
    h.outcome = status === 'completed' ? 'completed' : 'failed';
    h.body = body;
    h.toolCallsUsed = toolCallsUsed ?? 0;
    h.completedAt = this.nowFn();
    this.enforceSettledCap();
    return { ...h };
  }

  /**
   * 取消在途链（abort_dispatch / dispatch_cancel 消费）：cancelled 恒不投递、
   * 迟到回执经 settle 幂等忽略。非在途 → undefined（幂等取消）。
   */
  cancel(taskId: string): DispatchChainHandle | undefined {
    const h = this.chains.get(taskId);
    if (!h || h.status !== 'in_flight') return undefined;
    h.status = 'cancelled';
    h.completedAt = this.nowFn();
    this.enforceSettledCap();
    return { ...h };
  }

  /**
   * PM 空闲快照（AgentRunner 活跃归零回调消费）：该 PM 全部在途链置 awaitWake——
   * 此后翻转的终态需要自动投递（PM 已结束回合，子进程侧状态随之消失）。
   * PM 仍在回合内翻转的链不经此路径（子进程 bgHandles 已收割，正常流）。
   *
   * B4(i)（质量 review 2026-09-24）：deliverSettledUndelivered = 回合被强制截断
   * （预算耗尽/中断/错误/崩溃）——PM 没有公平机会 gather，已翻转未投递的链
   * 一并置 awaitWake 补投；正常收尾不补投（gather 契约）。
   */
  markPmIdle(pmAssignmentId: string, opts?: { deliverSettledUndelivered?: boolean }): void {
    for (const h of this.chains.values()) {
      if (h.pmAssignmentId !== pmAssignmentId) continue;
      if (h.status === 'in_flight') {
        h.awaitWake = true;
      } else if (
        opts?.deliverSettledUndelivered &&
        h.status === 'done' &&
        !h.delivered &&
        !h.isFollowupRound
      ) {
        h.awaitWake = true;
      }
    }
  }

  /**
   * 取走待投递终态链（RouterService 在 PM 空闲时机调用）：
   * (isFollowupRound || awaitWake) && done && 未投递 → 标记 delivered 并返回快照。
   * cancelled 恒不投递。take 语义（标记后不再返回）——投递失败由调用方记日志，
   * 不回滚标记（重试投递易造成重复唤醒，宁可一次丢失可查日志）。
   */
  takeDeliverable(pmAssignmentId: string): DispatchChainHandle[] {
    const out: DispatchChainHandle[] = [];
    for (const h of this.chains.values()) {
      if (
        h.pmAssignmentId === pmAssignmentId &&
        h.status === 'done' &&
        !h.delivered &&
        (h.isFollowupRound || h.awaitWake)
      ) {
        h.delivered = true;
        out.push({ ...h });
      }
    }
    return out;
  }

  /**
   * B6（质量 review 2026-09-24）：单条取走（条件同 takeDeliverable）——串行投递
   * 循环逐条消费：第一条投递后 PM 占线，余下链不预标 delivered，留给下一个
   * idle 边沿（一回合一条，消除并发唤醒）。无候选返回 undefined。
   */
  takeNextDeliverable(pmAssignmentId: string): DispatchChainHandle | undefined {
    for (const h of this.chains.values()) {
      if (
        h.pmAssignmentId === pmAssignmentId &&
        h.status === 'done' &&
        !h.delivered &&
        (h.isFollowupRound || h.awaitWake)
      ) {
        h.delivered = true;
        return { ...h };
      }
    }
    return undefined;
  }

  /**
   * B4(ii)（质量 review 2026-09-24）：取走 done-未投递链并标记 delivered。
   * routeDispatch 在链复用（register 会重置回执字段）前调用——上一轮终态
   * 从未投递时立即发射投递（注册在同链上进行，不能靠 awaitWake 旗标——
   * 会被复用重置抹掉）。非该状态 → undefined（no-op）。
   */
  requeueUndelivered(taskId: string): DispatchChainHandle | undefined {
    const h = this.chains.get(taskId);
    if (!h || h.status !== 'done' || h.delivered) return undefined;
    h.delivered = true;
    return { ...h };
  }

  /**
   * 心跳死亡清扫（RouterService 定时驱动）：
   * 在途 && now - lastHeartbeatAt > HEARTBEAT_DEAD_THRESHOLD_MS → settle failed。
   * 子 agent 崩溃 / 事件循环冻结 / 进程被回收都表现为心跳静默——统一在此判死。
   *
   * @returns 死亡链清单（调用方逐条构造 synthetic task_reply failed 走统一回传路径）
   */
  sweepDead(): DeadChain[] {
    const now = this.nowFn();
    const dead: DeadChain[] = [];
    for (const h of this.chains.values()) {
      if (h.status !== 'in_flight') continue;
      const silentMs = now - h.lastHeartbeatAt;
      if (silentMs <= HEARTBEAT_DEAD_THRESHOLD_MS) continue;
      h.status = 'done';
      h.outcome = 'failed';
      h.body = `子 agent 心跳超时（${Math.round(silentMs / 1000)} 秒无进度信号），判定无响应`;
      h.toolCallsUsed = h.toolCallsUsed ?? 0;
      h.completedAt = now;
      this.enforceSettledCap();
      dead.push({ taskId: h.taskId, pmAssignmentId: h.pmAssignmentId, reason: h.body });
    }
    return dead;
  }

  /** settled 容量驱逐：超 CHAIN_SETTLED_CAP 时按插入序删最旧 settled（in_flight 不驱逐） */
  private enforceSettledCap(): void {
    let settledCount = 0;
    for (const h of this.chains.values()) {
      if (h.status !== 'in_flight') settledCount++;
    }
    if (settledCount <= CHAIN_SETTLED_CAP) return;
    for (const [taskId, h] of this.chains) {
      if (h.status !== 'in_flight') {
        this.chains.delete(taskId);
        return;
      }
    }
  }
}

/** 生产单例（RouterService / 测试种子共用同一实例——与 dispatch-wait 模块态同型） */
export const dispatchRegistry = new DispatchRegistry();

/** 测试用：清空生产单例链表（用例隔离——registry 生命周期 = 主进程生命周期） */
export function __resetDispatchRegistryForTest(): void {
  dispatchRegistry.clear();
}
