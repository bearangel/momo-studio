// 子节点委派执行器（M2e T10/T11，spec §5.3/§8 RF#5 + MC1 + T9 wire 约定）——
// 收 task.assigned → 前置三查（接受开关/并发上限/工作空间存在，§5.3 declined 附因）
// → 建委派会话（MC1：标题=任务书、首条 user 消息=任务书 prompt、成员=按 slug
// 解析的 agent）→ 首拍 running{sessionId}（T9 语义：pending→done 直报被拒）
// → AgentRunner 既有会话执行入口跑回合 → message_events 尾部 500ms 合并批量
// 转发（lastSeq 单调不丢——游标仅在上报成功后推进；断线缓冲保留、重连续传）
// → 完成/失败终态上报。重连恢复：task.list{status:interrupted} 对账本地账本
// （active 复报 running / idle 复用会话注入续跑回合 / 本地无会话上报
// local_session_lost）。取消：运行中停跑不再上报（账本已 cancelled）。
//
// 端口注入纪律（momo-test-rules #5）：进程/DB/会话执行边界全部经 Ports 注入，
// 生产实现在 wireDelegationRunnerPorts（hub/index.ts 消费）；进度拍用真 kv 账本。
import { logger } from '../logger';
import type { TaskAssignedEvent } from './protocol';
import type { TaskReportPayload } from './delegation-wire';
import type { DelegationRecord, HubDelegationStore } from './delegation-store';
import type { HubDelegationSettings } from './delegation-settings';
import { composeTurnBody, normalizeTier, type PermissionTier } from './run-policy';
import { consumeReadonlyDenied, markSessionReadonly, setWriteDeniedBroadcaster } from '../sandbox/write-blocked-emit';
import { broadcastWriteGrantDenied } from '../agent/runtime-registry';
import { STREAM_ERROR_DETAILS_SEP } from '../agent/llm-provider';
import { redactSecrets, truncateCodePoints } from '../util/redact';

// P2-1 即时拒的 deny 广播接线（注册反转——write-blocked-emit 为子进程可达模块，
// 不可顶层依赖 runtime-registry；本模块仅主进程 hub/index 装载，恒先于委派回合）
setWriteDeniedBroadcaster(broadcastWriteGrantDenied);

/**
 * task.assigned 载荷的 studio 侧容错扩展（T10）：协议 1.2.0 的 DelegationTask 无
 * permissionTier（hub parseDelegationTask 白名单重建剥离），本端按可选字段容错
 * 消费（normalizeTier 缺省/非法收敛 confirm），hub 升级透传后直接生效零改动。
 *
 * M4.3 语义裁定（spec §2.1）：协议 1.7.0 的 DelegationTask.dependsOn? 是 leader
 * 本地任务 id——worker 零消费（不进本类型消费面，hub/index.parseTaskAssigned
 * 挑字段时丢弃）：依赖闸在 leader 侧派发前置，blocked 任务不会到达 worker；
 * 若 worker 按其拦截将制造跨节点不可解析的假闸（leader 本地 id 对 worker 无意义）。
 *
 * 1.10.0 平行模式（hub 0.6.0 / 协议 1.10.0）：task.draft?/priority? 透传（peer
 * 组草稿——落绑定空间看板不自动执行，spec 2026-11-05 §5.2）；groupId? 透传
 * （组级绑定解析的判别键——多 peer 组各有绑定）。
 */
export type AssignedTaskEvent = Omit<TaskAssignedEvent, 'task'> & {
  task: TaskAssignedEvent['task'] & {
    permissionTier?: PermissionTier;
    /** M5.3 深度防御：team 段在场但形态非法（parseTaskAssigned 打标）——
     *  runner 按此 decline，不再回落单 agent（静默换班防线） */
    teamInvalid?: true;
  };
  /** 1.10.0：组归属（hub 恒置）——draft 落点绑定解析键 */
  groupId?: string;
};

/** 回合终态（watchTurn 回调载荷——映射 messages.status 终态语义） */
export interface TurnTerminal {
  status: 'done' | 'failed' | 'aborted';
  error?: string;
}

/** 会话尾部增量（进度拍原料）：lastSeq=批尾单调游标、excerpt=末条摘要（恒非空） */
export interface DelegationTail {
  lastSeq: number;
  excerpt: string;
}

/** 委派执行边界端口（生产实现在 wireDelegationRunnerPorts；测试注入 fake） */
export interface DelegationRunPorts {
  /** 设置实时读取（开关/并发上限/超时分钟即时生效） */
  settings(): HubDelegationSettings;
  findWorkspaceByName(name: string): { id: string; name: string } | null;
  /** agentSlug 匹配工作空间成员；缺省→工作空间默认 agent；均无 → null */
  resolveAgentInstance(workspaceId: string, agentSlug: string | undefined): string | null;
  /**
   * M5.3 团队成员按名解析：目标 ws 成员表按 agentName 匹配（镜像成员以
   * agentName 为键——与快照 team.members 名单对齐口径）；无 → null。
   * 与 resolveAgentInstance 的 slug 解析并列（单 agent 路径不消费本端口）。
   */
  resolveAgentInstanceByName(workspaceId: string, agentName: string): string | null;
  /**
   * 建委派会话（MC1：普通 collab 会话 + 标题=任务书摘要）→ 返回 sessionId。
   * M5.3 多成员版：members 在场（团队外派）→ kind='task_execution' 多成员会话
   * （成员全入 session_members、恰一名 leader is_leader=1）；缺省单成员路径
   * （memberInstanceId）形状与行为零变化。
   */
  createDelegatedSession(input: {
    workspaceId: string;
    title: string;
    memberInstanceId?: string;
    members?: Array<{ instanceId: string; isLeader: boolean }>;
  }): string;
  /**
   * L0 权限档位预配（T10 契约签名）：createDelegatedSession 后、startTurn 前调用。
   * 三档语义单源在 run-policy.ts（readonly=零写授权+prompt 只读约束段 /
   * sandbox=预授予镜像工作空间目录 / confirm=不动授权面）。readonly 的行为约束
   * 由 runner 侧 composeTurnBody 前置，本端口只做授权面动作。
   */
  applyRunPolicy(sessionId: string, tier: PermissionTier): void;
  /**
   * L1b 等待信号查询（T11 契约签名）：回合是否正在等待用户输入（写授权卡等）。
   * null = 信号源不支持（降级不检测——零 kind 拍、超时链不触发）。
   */
  sessionWaiting(sessionId: string): { waiting: boolean; summary: string } | null;
  /** L1 超时保守指令注入（T11）：活跃流期间注入当前回合（steer 分流语义） */
  injectSteer(sessionId: string, body: string): void;
  /** 执行一个回合（首拍后注入任务书 prompt；续传时注入续跑指令）。
   *  M5.3：mentionedInstanceIds 在场时显式路由接待目标（多成员团队外派首回合
   *  mention leader——参照本地 executor sendKickoff 机制；单成员路径缺省不带） */
  startTurn(input: { sessionId: string; body: string; mentionedInstanceIds?: string[] }): Promise<void>;
  /** 会话级急停（既有取消入口 RouterService.stopAll） */
  stopSession(sessionId: string): void;
  /** 回合终态订阅 → 返回解订阅函数；baselineOverride（1.10.0 draft 接管）：
   *  接管在回合开始后 attach——传 0 观测会话全部 agent 行（新会话无历史，防基线吞流） */
  watchTurn(sessionId: string, onTerminal: (t: TurnTerminal) => void, baselineOverride?: number): () => void;
  /** 会话尾部增量（afterRowId 之后）；无增量返回 null */
  sessionTail(sessionId: string, afterRowId: number): DelegationTail | null;
  /** 上行 task.report（res 信封 id=taskId）；离线/失败返回 false（调用方缓冲重试） */
  report(taskId: string, payload: TaskReportPayload): Promise<boolean>;
  /** hub 侧中断任务清单（task.list{status:interrupted}，已按本机 targetNodeId 过滤） */
  listInterruptedDelegations(): Promise<Array<{ taskId: string; title: string; workspaceName: string }>>;
  /**
   * 1.10.0 平行模式草稿端口（spec 2026-11-05 §5.2）——生产接线 delegation-ports：
   *  - resolveBindingWorkspace：groupId → 本地绑定空间（hub_group_bindings 权威；
   *    null = 未绑定 → decline 深度防御）
   *  - insertDraftTaskRow：草稿落绑定空间看板（status='draft' / origin='peer_draft' /
   *    delegation_id 挂接）；null = 落板失败（如空间已被删除）→ decline
   *  - findDraftRow：delegation_id 反查本地行（监督器状态机数据源）；null = 行已删
   *  - selfNodeId：routing.targetNodeId 本机视角
   */
  resolveBindingWorkspace(groupId: string): { workspaceId: string; workspaceName: string } | null;
  insertDraftTaskRow(input: {
    workspaceId: string;
    groupId: string;
    title: string;
    description: string;
    priority: number;
    delegationId: string;
  }): { localTaskId: string } | null;
  findDraftRow(delegationId: string): {
    id: string;
    status: string;
    executionSessionId: string | null;
  } | null;
  selfNodeId(): string | null;
}

interface ActiveRun {
  taskId: string;
  sessionId: string;
  /** 进度游标：仅在上报成功后推进（断线不丢增量） */
  cursor: number;
  /** 待发进度拍（合并语义：始终覆盖为最新批尾；waiting 态带 kind 标注） */
  pendingBeat: { lastSeq: number; excerpt: string; kind?: 'waiting-input' | 'denied' } | null;
  /** 首拍 running 之后的回合 prompt 摘要（无文本增量时的 excerpt 兜底） */
  promptExcerpt: string;
  /** L1b：本次持续等待的起点（首次 waiting=true 的拍时刻；恢复清 null——时钟按连续段计时） */
  waitingSince: number | null;
  /** L1：超时注入时刻（denied+steer 已下发；双倍超时兜底判据。恢复清 null 允许再等待周期） */
  hitlInjectedAt: number | null;
  unwatch: () => void;
  terminal: TurnTerminal | null;
}

/** excerpt 截断上限（hub EXCERPT_MAX=512 之内留裕量） */
const EXCERPT_MAX = 200;

/** L1 超时注入的保守指令（plan Task 11 定文） */
const HITL_TIMEOUT_STEER = '用户不在场，请保守处理或结束任务';

/** D6 续传 boot 竞态：startTurn 退避重试次数（重连可早于 RouterService lazy 启动） */
const RESUME_START_ATTEMPTS = 3;
/** 退避间隔（固定 1s——boot 竞态窗口量级；测试用 fake timers 驱动） */
const RESUME_START_BACKOFF_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 任务书首句摘要（首拍/无增量时的 excerpt 兜底——恒非空 wire 契约） */
function excerptOfPrompt(prompt: string): string {
  const firstSentence = prompt.split(/[。！？\n]/).find((s) => s.trim().length > 0) ?? '（无文本增量）';
  return firstSentence.trim().slice(0, EXCERPT_MAX);
}

function excerptOfText(text: string): string {
  const t = text.trim();
  return (t.length > 0 ? t : '（无文本增量）').slice(0, EXCERPT_MAX);
}

export interface DelegationRunnerOpts {
  ports: DelegationRunPorts;
  store: HubDelegationStore;
  /** 进度合并窗口（RF#5 定值 500ms；测试可注入） */
  tickMs?: number;
}

export interface DelegationRunner {
  handleAssigned(evt: AssignedTaskEvent): Promise<void>;
  handleCancelled(payload: { taskId: string }): void;
  /** 重连恢复（onStateChange→online）：中断对账 + 立即冲一拍 */
  handleOnline(): Promise<void>;
  /**
   * S4 验收消费停靠出清：hub task.accepted/rejected 消费后，清掉 settleRun 因
   * 本地 submitted 停靠的 active 项（terminal 已置、tick 惰性跳过、账本零上报）。
   * accepted：本地账本对齐 done（hub 已终局，不上报——再报 done 是对已终态账本
   * 的重复拍）；rejected：账本保持 running，任务回 assigned 由本地 executor 放行
   * 重跑（trigger 自动 initial——本地 run 计数自治，hub runNo 仅展示对账用），
   * 重跑进度经监督器接管（peer-draft）/既有进度拍链自然恢复。
   * 无停靠项（classic 未接管 / 已出清 / 重启丢失）幂等 no-op；accepted 侧账本
   * 对齐仍执行（重启窗口的迟到消费也能终结监督器，防 duplicate 终态直报）。
   */
  settleAcceptance(taskId: string, outcome: 'accepted' | 'rejected'): void;
  destroy(): void;
}

export function createDelegationRunner(opts: DelegationRunnerOpts): DelegationRunner {
  const { ports, store } = opts;
  const tickMs = opts.tickMs ?? 500;
  const active = new Map<string, ActiveRun>(); // key=taskId

  const sendReport = async (taskId: string, payload: TaskReportPayload): Promise<boolean> => {
    try {
      return await ports.report(taskId, payload);
    } catch (err) {
      logger.warn('委派上报发送异常（缓冲待重试）', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };

  const decline = async (taskId: string, detail: string): Promise<void> => {
    logger.info('委派被拒（declined）', { taskId, detail });
    await sendReport(taskId, { status: 'failed', reason: `declined:${detail}` });
  };

  /** provider 流错误双层契约（`STREAM_ERROR_DETAILS_SEP`：前半用户可读主文案、后半技术详情，
   *  StreamErrorBox 依赖它分流）。委派卡不解析该分隔符——卡面 reason 只取主文案，
   *  技术详情落日志保留诊断，不丢信息也不把 `||details||`/JSON 印到卡面。 */
  const splitReasonDetails = (reason: string, taskId: string): string => {
    const idx = reason.indexOf(STREAM_ERROR_DETAILS_SEP);
    if (idx <= 0) return reason;
    const main = reason.slice(0, idx).trim();
    const details = reason.slice(idx + STREAM_ERROR_DETAILS_SEP.length).trim();
    if (details.length > 0) {
      logger.info('委派失败技术详情', {
        taskId,
        details: redactSecrets(details, { includeQueryToken: true }),
      });
    }
    return main.length > 0 ? main : reason;
  };

  /**
   * 委派关联的本地任务是否已提交待验收（S2 执行态挂钩）：findDraftRow 虽以草稿
   * 命名，生产端口实现是 delegation_id → 本地 tasks 行的通用反查（classic 承接行
   * /peer-draft 承接行同键）。查询异常按否处理（保守走既有终态链）。
   */
  const localTaskAwaitingAcceptance = (taskId: string): boolean => {
    try {
      return ports.findDraftRow(taskId)?.status === 'submitted';
    } catch {
      return false;
    }
  };

  const settleRun = (taskId: string, run: ActiveRun, terminal: TurnTerminal): void => {
    if (run.terminal) return; // 幂等：终态只清算一次
    run.terminal = terminal;
    run.unwatch();
    // S2 执行态挂钩：本地任务已提交待验收（submitted）——回合终态不作委派终态。
    // worker 桥已把 hub 账本推到 submitted，此处再报 done/failed 会越过发起方
    // 验收直接终决（hub canTransition 对 submitted→done|failed|running 均放行）；
    // 验收权威在发起方（task.accept/reject，S4 消费回本地终态）。停靠语义：
    // 留在 active（terminal 已置 → tick 惰性跳过；重连对账 peer-draft 记录整段
    // continue、classic 承接行无本地 submitted 面），账本保持 running 零上报——
    // 停靠项出清走 S4：验收消费（settleAcceptance）随终态/返工落定后清出。
    if (terminal.status !== 'aborted' && localTaskAwaitingAcceptance(taskId)) {
      logger.info('回合终态到达但本地任务已提交待验收——停靠等待发起方验收（不上报终态）', {
        taskId,
        sessionId: run.sessionId,
        turnStatus: terminal.status,
      });
      return;
    }
    active.delete(taskId);
    const localState: DelegationRecord['state'] = terminal.status === 'done' ? 'done' : 'failed';
    const reason =
      terminal.status === 'failed'
        ? `执行失败:${terminal.error ?? '未知错误'}`
        : terminal.status === 'aborted'
          ? `已中止${terminal.error ? `:${terminal.error}` : ''}`
          : undefined;
    // P2-1：reason 同源两落——本机账本（worker 卡 title 全文）与 hub 上报载荷
    // M2.4 T2：两处都先过凭证脱敏（含 query token）+ code point 截断，避免
    // provider 原文/URL 里的密钥上行到 hub，也防超长串撑爆卡面。
    const sanitizedReason =
      reason === undefined
        ? undefined
        : truncateCodePoints(
            redactSecrets(splitReasonDetails(reason, taskId), { includeQueryToken: true }),
          );
    store.updateState(taskId, localState, localState === 'failed' ? sanitizedReason : undefined);
    void sendReport(taskId, {
      status: terminal.status === 'done' ? 'done' : 'failed',
      sessionId: run.sessionId,
      ...(sanitizedReason !== undefined ? { reason: sanitizedReason } : {}),
    });
  };

  const attachWatcher = (taskId: string, run: ActiveRun): void => {
    run.unwatch = ports.watchTurn(run.sessionId, (t) => {
      const current = active.get(taskId);
      if (!current || current.sessionId !== run.sessionId) return; // 迟到终态（已取消/已换会话）
      settleRun(taskId, current, t);
    });
  };

  /**
   * L1 超时注入（连续等待超 hitlTimeoutMinutes）：denied 授权面（applyRunPolicy
   * readonly → clearSessionGrants）先于 steer 保守指令；之后正常等 turn 终态
   * （不永卡——RF#4）。注入幂等（每连续等待段至多一次）。
   */
  const injectHitlTimeout = (taskId: string, run: ActiveRun, timeoutMinutes: number): void => {
    logger.info('HITL 无人确认超时，自动拒并注入保守指令', {
      taskId,
      sessionId: run.sessionId,
      waitedMinutes: timeoutMinutes,
    });
    ports.applyRunPolicy(run.sessionId, 'readonly');
    // P2-1：翻转后续写调用为即时拒（当前在途等待卡仍走既有 TTL/处置清除语义）
    markSessionReadonly(run.sessionId, true);
    ports.injectSteer(run.sessionId, HITL_TIMEOUT_STEER);
    run.hitlInjectedAt = Date.now();
  };

  /**
   * 进度拍：合并窗口到期 → 对每个活跃 run 读尾部增量、缓冲合并、上报成功才推进游标。
   * L1b（T11）：sessionWaiting→waiting=true 时 pendingBeat 带 kind:'waiting-input'
   * （excerpt=summary——等待态必须可见，无尾部增量也打拍）；恢复 → 清 waitingSince
   * + 缓冲拍去 kind（RF#3：恢复后 kind 必须消失）；持续等待超时 → 注入链/兜底清算。
   */
  const tick = (): void => {
    const now = Date.now();
    for (const [taskId, run] of active) {
      if (run.terminal) continue;
      const tail = ports.sessionTail(run.sessionId, run.cursor);
      if (tail && tail.lastSeq > run.cursor) {
        run.pendingBeat = { lastSeq: tail.lastSeq, excerpt: excerptOfText(tail.excerpt) };
      }
      // L1b 等待信号（null=不支持 → 降级不检测，既有行为不变）
      const waiting = (() => {
        try {
          return ports.sessionWaiting(run.sessionId);
        } catch (err) {
          logger.warn('等待信号查询异常（本拍降级跳过）', {
            sessionId: run.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      })();
      const timeoutMinutes = ports.settings().hitlTimeoutMinutes;
      const timeoutMs = timeoutMinutes * 60 * 1000;
      if (waiting !== null && waiting.waiting) {
        if (run.waitingSince === null) run.waitingSince = now;
        // 等待拍覆盖 excerpt/kind；lastSeq 取已知最大（单调不回退）
        const lastSeq = Math.max(run.cursor, run.pendingBeat?.lastSeq ?? 0);
        run.pendingBeat = { lastSeq, excerpt: excerptOfText(waiting.summary), kind: 'waiting-input' };
        if (run.hitlInjectedAt === null && now - run.waitingSince > timeoutMs) {
          injectHitlTimeout(taskId, run, timeoutMinutes);
        } else if (run.hitlInjectedAt !== null && now - run.waitingSince > timeoutMs * 2) {
          // RF#4 终态兜底：注入后双倍超时仍在等待——停跑 + failed 人话，不留永卡 running
          ports.stopSession(run.sessionId);
          settleRun(taskId, run, {
            status: 'failed',
            error: `hitl_timeout:等待用户确认超时（${timeoutMinutes} 分钟无人响应，已自动拒绝并注入保守指令后仍无收尾），任务终止`,
          });
          continue;
        }
      } else if (waiting !== null && run.waitingSince !== null) {
        // 恢复（仅显式 waiting===false）：时钟清零（再等待从零计时）；未发的等待拍去 kind（RF#3）
        run.waitingSince = null;
        run.hitlInjectedAt = null;
        if (run.pendingBeat?.kind === 'waiting-input') {
          run.pendingBeat = { lastSeq: run.pendingBeat.lastSeq, excerpt: run.pendingBeat.excerpt };
        }
      }
      // waiting===null（信号源不支持/查询异常，P2-1）：本拍降级——≠ 恢复，
      // waitingSince/hitlInjectedAt 原样保留（时钟按连续段续计、注入幂等跨降级拍
      // 保持），仅跳过本拍等待检测。
      // P2-1 readonly 即时拒事件：write-blocked 漏斗登记的 denial 摘要消费即清——
      // 覆盖为 kind='denied' 拍（excerpt 含「只读档位」文案，leader 侧即时可见
      // 而非挂起；readonly 会话无等待登记，与上方等待拍互斥不冲突）
      const deniedExcerpts = (() => {
        try {
          return consumeReadonlyDenied(run.sessionId);
        } catch (err) {
          logger.warn('即时拒事件消费异常（本拍跳过）', {
            sessionId: run.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          return [] as string[];
        }
      })();
      if (deniedExcerpts.length > 0) {
        const lastSeq = Math.max(run.cursor, run.pendingBeat?.lastSeq ?? 0);
        const excerpt = deniedExcerpts[deniedExcerpts.length - 1]!;
        run.pendingBeat = { lastSeq, excerpt: excerpt.slice(0, EXCERPT_MAX), kind: 'denied' };
      }
      const beat = run.pendingBeat;
      if (!beat) continue; // 无增量不打空拍（等待态除外——上方已置等待拍）
      void sendReport(taskId, {
        status: 'running',
        sessionId: run.sessionId,
        progress: { lastSeq: beat.lastSeq, excerpt: beat.excerpt, ...(beat.kind !== undefined ? { kind: beat.kind } : {}) },
      }).then((ok) => {
        if (!ok) return; // 断线：pendingBeat 保留，游标不推进（重连后按最新批尾续传）
        if (beat.lastSeq > run.cursor) run.cursor = beat.lastSeq;
        if (run.pendingBeat && run.pendingBeat.lastSeq <= beat.lastSeq) run.pendingBeat = null;
      });
    }
    // 1.10.0：草稿生命周期监督（与进度拍同频——draft/arranged/接管/终态/删除）
    superviseDrafts();
  };

  const startRun = async (
    evt: AssignedTaskEvent,
    sessionId: string,
    record: DelegationRecord,
    kickoffMentions?: string[],
  ): Promise<void> => {
    const tier = normalizeTier(evt.task.permissionTier);
    const run: ActiveRun = {
      taskId: evt.taskId,
      sessionId,
      cursor: 0,
      pendingBeat: null,
      promptExcerpt: excerptOfPrompt(evt.task.prompt),
      waitingSince: null,
      hitlInjectedAt: null,
      unwatch: () => undefined,
      terminal: null,
    };
    active.set(evt.taskId, run);
    attachWatcher(evt.taskId, run);
    store.upsert(record);
    // 首拍 running 必发（先于执行——T9 语义 pending→done 直报被拒）；excerpt 恒非空
    const firstOk = await sendReport(evt.taskId, {
      status: 'running',
      sessionId,
      progress: { lastSeq: 0, excerpt: run.promptExcerpt },
    });
    if (!firstOk) run.pendingBeat = { lastSeq: 0, excerpt: run.promptExcerpt };
    try {
      // T10：readonly 档任务书前只读约束段（composeTurnBody 单源）；sandbox/confirm 原文。
      // M5.3 团队外派：kickoffMentions=[leaderInstanceId] 显式路由接待（多成员会话
      // 不带 mention 时虽可经 is_leader 兜底落到 leader，显式 mention 与本地任务
      // kickoff 同机制——语义单源不依赖兜底）
      await ports.startTurn({
        sessionId,
        body: composeTurnBody(tier, evt.task.prompt),
        ...(kickoffMentions !== undefined ? { mentionedInstanceIds: kickoffMentions } : {}),
      });
    } catch (err) {
      logger.warn('委派回合启动失败', {
        taskId: evt.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      settleRun(evt.taskId, run, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
  };

  /**
   * D6：startTurn 带退避重试。恢复路径专用——B 重连常快于 RouterService lazy 启动，
   * 生产端口对未就绪显式拒绝（delegation-ports startTurn 守卫）；首跑路径
   * （handleAssigned）不带重试：任务到达时连接已建立、app 早已 ready，竞争窗口
   * 理论上存在但极窄，且既有 catch→failed 上报语义不留永卡 running。
   * 全部尝试失败 → false（调用方 report failed{reason:'resume_boot_timeout'}）。
   */
  const startTurnWithRetry = async (input: { sessionId: string; body: string }): Promise<boolean> => {
    for (let attempt = 1; attempt <= RESUME_START_ATTEMPTS; attempt++) {
      try {
        await ports.startTurn(input);
        return true;
      } catch (err) {
        logger.warn('委派续跑回合启动失败（退避重试中）', {
          sessionId: input.sessionId,
          attempt,
          attempts: RESUME_START_ATTEMPTS,
          error: err instanceof Error ? err.message : String(err),
        });
        if (attempt < RESUME_START_ATTEMPTS) await sleep(RESUME_START_BACKOFF_MS);
      }
    }
    return false;
  };

  let timer: NodeJS.Timeout | null = null;
  /** 进度拍计时器懒启动（handleAssigned / handleOnline 两个入口共用；空转无开销） */
  const ensureTimer = (): void => {
    if (timer) return;
    timer = setInterval(() => tick(), tickMs);
    timer.unref?.();
  };

  /**
   * 1.10.0 平行模式：草稿落板（spec 2026-11-05 §5.2）。闸序：acceptTasks 已过 →
   * 组绑定解析（本地深度防御——hub 已闸未绑定）→ 落 draft 行（origin='peer_draft'）
   * → received 拍。并发闸不适用（草稿不执行不占槽）。落板/绑定失败 → decline
   * （发送方行 failed 人话，不留幽灵账）。
   */
  const handleDraftAssigned = async (
    evt: AssignedTaskEvent,
    _maxConcurrent: number,
  ): Promise<void> => {
    const groupId = evt.groupId ?? null;
    const binding = groupId !== null ? ports.resolveBindingWorkspace(groupId) : null;
    if (groupId === null || binding === null) {
      await decline(evt.taskId, 'declined:本节点未绑定承接空间（组设置中可绑定）');
      return;
    }
    const row = ports.insertDraftTaskRow({
      workspaceId: binding.workspaceId,
      groupId,
      title: evt.task.title,
      description: evt.task.prompt,
      priority: evt.task.priority ?? 0,
      delegationId: evt.taskId,
    });
    if (row === null) {
      await decline(evt.taskId, `declined:草稿落板失败（绑定空间 ${binding.workspaceName} 不可用）`);
      return;
    }
    const now = Date.now();
    store.upsert({
      taskId: evt.taskId,
      sessionId: '',
      workspaceId: binding.workspaceId,
      workspaceName: binding.workspaceName,
      title: evt.task.title,
      byNode: evt.byNode,
      state: 'draft',
      draft: true,
      localTaskId: row.localTaskId,
      groupId,
      createdAt: now,
      updatedAt: now,
    });
    logger.info('平行草稿已落板', {
      taskId: evt.taskId,
      workspaceId: binding.workspaceId,
      localTaskId: row.localTaskId,
      byNode: evt.byNode,
    });
    await sendReport(evt.taskId, {
      status: 'pending',
      progress: { lastSeq: 0, excerpt: '草稿已接收，等待节点拥有者安排', kind: 'received' },
    });
  };

  /**
   * 1.10.0 草稿生命周期监督器（tick 驱动，与进度拍同频）：按本地行状态机推进——
   *   draft（等待安排）→ 非 draft 且未通知（arranged 拍）→ in_progress 且未接管
   *   （建 ActiveRun 复用既有进度拍/终态链）→ 终态（done/failed 上报）→ 行删除
   *   （declined:对方已删除——杜绝发送方行永挂）。
   * 单一机制覆盖安排/接管/完结/删除四边界（任意更新路径生效，无 IPC 挂钩面）；
   * 幂等锚 = record.state（draft→arranged→running→终态 单向推进，重拍无害）。
   */
  const superviseDrafts = (): void => {
    for (const record of store.list()) {
      if (record.draft !== true || isLocalTerminal(record.state)) continue;
      const row = ports.findDraftRow(record.taskId);
      if (row === null) {
        void sendReport(record.taskId, { status: 'failed', reason: 'declined:对方已删除任务' })
          .then(() => store.updateState(record.taskId, 'failed', 'declined:对方已删除任务'));
        continue;
      }
      const arranged = row.status !== 'draft';
      // arranged 拍仅限「安排后待执行」中间态——executor 快路径（安排即启动，
      // 监督器首拍已 in_progress）不发 arranged、直接进入接管（发送方收到
      // received→running，诚实反映；且避免 record.state 走 arranged 后 syncState
      // 对运行中行的任何回写窗口）
      const arrangedPending =
        arranged && row.status !== 'in_progress' && record.state === 'draft';
      if (arrangedPending) {
        store.updateState(record.taskId, 'arranged');
        void sendReport(record.taskId, {
          status: 'pending',
          progress: { lastSeq: 0, excerpt: '节点拥有者已安排执行', kind: 'arranged' },
        });
      } else if (arranged && record.state === 'draft') {
        // 快路径仍推进 record 态（离开 draft），但不发拍不回写行
        store.updateState(record.taskId, 'arranged');
      }
      const rec = store.get(record.taskId);
      if (rec === null) continue;
      if (row.status === 'in_progress' && !active.has(record.taskId)) {
        const sessionId = row.executionSessionId;
        if (sessionId === null || sessionId === '') continue; // 执行会话未定：下一拍再看
        adoptDraftExecution(rec, sessionId, row.id);
        continue;
      }
      if ((row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled')) {
        // 在跑回合先行清算（手动完结先于回合终态：unwatch 防迟到回调二次结算）
        const live = active.get(record.taskId);
        if (live) {
          live.unwatch();
          live.terminal = { status: row.status === 'completed' ? 'done' : 'aborted' };
          active.delete(record.taskId);
        }
        settleDraftTerminal(rec, row.status);
      }
    }
  };

  /** 草稿执行接管：建 ActiveRun 挂回既有进度拍/终态链（sessionTail 数据源同款）。 */
  const adoptDraftExecution = (record: DelegationRecord, sessionId: string, localTaskId: string): void => {
    const run: ActiveRun = {
      taskId: record.taskId,
      sessionId,
      cursor: 0,
      pendingBeat: null,
      promptExcerpt: excerptOfPrompt(record.title),
      waitingSince: null,
      hitlInjectedAt: null,
      unwatch: () => undefined,
      terminal: null,
    };
    active.set(record.taskId, run);
    // 基线 0：接管时回合可能已在流中（warm 池秒开流）——attach 时刻基线会吞掉
    // 在途 agent 行导致终态永不触发；执行会话为 startTask 新建，无历史 agent 行
    run.unwatch = ports.watchTurn(sessionId, (t) => {
      const current = active.get(record.taskId);
      if (!current || current.sessionId !== sessionId) return;
      settleRun(record.taskId, current, t);
    }, 0);
    // upsert 全量写（保留 draft/localTaskId/groupId）——updateState 只写 state/reason
    store.upsert({ ...record, sessionId, state: 'running', updatedAt: Date.now() });
    logger.info('平行草稿执行接管', { taskId: record.taskId, sessionId, localTaskId });
    void sendReport(record.taskId, {
      status: 'running',
      sessionId,
      progress: { lastSeq: 0, excerpt: excerptOfPrompt(record.title) },
    });
  };

  /** 草稿终态直报（手动完结/本地取消/失败路径；有在跑回合时调用方已先行清算）。
   *  sessionId 仅非空携带（未安排过的记录为 ''——hub 侧有界串校验拒空值）。 */
  const settleDraftTerminal = (record: DelegationRecord, rowStatus: string): void => {
    const sessionId = record.sessionId !== '' ? record.sessionId : undefined;
    if (rowStatus === 'completed') {
      store.updateState(record.taskId, 'done');
      void sendReport(record.taskId, { status: 'done', ...(sessionId !== undefined ? { sessionId } : {}) });
      return;
    }
    const reason = rowStatus === 'cancelled' ? 'declined:本地任务已取消' : '执行失败（本地）';
    store.updateState(record.taskId, 'failed', reason);
    void sendReport(record.taskId, { status: 'failed', ...(sessionId !== undefined ? { sessionId } : {}), reason });
  };

  /** 本地账本态是否终态（done/failed/cancelled——draft/arranged/running 在途）。 */
  const isLocalTerminal = (state: DelegationRecord['state']): boolean =>
    state === 'done' || state === 'failed' || state === 'cancelled';

  return {
    async handleAssigned(evt) {
      // 幂等：已受理/已终态的任务不重复建会
      if (store.get(evt.taskId) || active.has(evt.taskId)) {
        logger.info('委派重复 assigned，忽略', { taskId: evt.taskId });
        return;
      }
      const settings = ports.settings();
      if (!settings.acceptTasks) {
        await decline(evt.taskId, '本节点已关闭任务委派接受');
        return;
      }
      // 1.10.0 平行模式草稿分支（spec 2026-11-05 §5.2）：不建会不执行——落绑定
      // 空间看板 draft 行 + received 拍；后续 arranged/执行接管/终态全由监督器
      // （superviseDrafts，tick 驱动）按本地行状态机推进。
      if (evt.task.draft === true) {
        await handleDraftAssigned(evt, settings.maxConcurrent);
        ensureTimer();
        return;
      }
      if (active.size >= settings.maxConcurrent) {
        await decline(evt.taskId, `并发已达上限（${settings.maxConcurrent}）`);
        return;
      }
      const ws = ports.findWorkspaceByName(evt.workspaceName);
      if (!ws) {
        await decline(evt.taskId, `工作空间不存在:${evt.workspaceName}`);
        return;
      }
      // M5.3 深度防御拒收：team 段在场但形态非法（异构 hub/损坏载荷）——
      // 回落单 agent = 静默换班，decline 人话（先于 team 正常分支与单 agent 分支）
      if (evt.task.teamInvalid === true) {
        await decline(evt.taskId, '任务书 team 段形态非法（深度防御拒收）');
        return;
      }
      // M5.3 团队外派分支（spec §5.3）：team 段在场 → 逐名解析（镜像/本地成员表
      // 按 agentName 匹配——与快照 team.members 名单对齐口径），任一失败 decline
      // 人话名单（裁定 3：不静默降级/缩编）；全部解析 → kind='task_execution'
      // 多成员会话 + 首回合 mention leader（dispatch 注入由 buildDispatchSnapshot
      // 按会话成员快照自然成立，零新增机制）。单 agent 路径（agentSlug/缺省）零变化。
      let kickoffMentions: string[] | undefined;
      let sessionId: string;
      if (evt.task.team) {
        const team = evt.task.team;
        const leaderCount = team.members.filter((m) => m.isLeader).length;
        if (team.members.length < 2 || leaderCount !== 1) {
          await decline(
            evt.taskId,
            `团队段非法（成员 ${team.members.length} 名、leader ${leaderCount} 名——须 2..8 名成员且恰一名 leader）`,
          );
          return;
        }
        const missing: string[] = [];
        const resolved: Array<{ instanceId: string; isLeader: boolean }> = [];
        for (const m of team.members) {
          const instanceId = ports.resolveAgentInstanceByName(ws.id, m.name);
          if (!instanceId) missing.push(m.name);
          else resolved.push({ instanceId, isLeader: m.isLeader });
        }
        if (missing.length > 0) {
          await decline(
            evt.taskId,
            `团队成员无法解析: ${missing.join(', ')}（工作空间 ${evt.workspaceName} 无这些 agent）——请先镜像工作空间或改派`,
          );
          return;
        }
        sessionId = ports.createDelegatedSession({
          workspaceId: ws.id,
          title: evt.task.title,
          members: resolved,
        });
        kickoffMentions = [resolved.find((m) => m.isLeader)!.instanceId];
      } else {
        const instanceId = ports.resolveAgentInstance(ws.id, evt.task.agentSlug);
        if (!instanceId) {
          await decline(
            evt.taskId,
            evt.task.agentSlug
              ? `工作空间内未找到 agent（slug=${evt.task.agentSlug}）`
              : '工作空间未配置默认 agent',
          );
          return;
        }
        sessionId = ports.createDelegatedSession({
          workspaceId: ws.id,
          title: evt.task.title,
          memberInstanceId: instanceId,
        });
      }
      // T10 档位预配：createSession 后、startTurn（startRun 内）前——授权面先于回合注入
      ports.applyRunPolicy(sessionId, normalizeTier(evt.task.permissionTier));
      // P2-1：readonly 档位产物落地标记（write-blocked 漏斗即时拒判据）；sandbox/confirm 显式清标（幂等）
      markSessionReadonly(sessionId, normalizeTier(evt.task.permissionTier) === 'readonly');
      const now = Date.now();
      await startRun(evt, sessionId, {
        taskId: evt.taskId,
        sessionId,
        workspaceId: ws.id,
        workspaceName: evt.workspaceName,
        title: evt.task.title,
        byNode: evt.byNode,
        state: 'running',
        createdAt: now,
        updatedAt: now,
      }, kickoffMentions);
      ensureTimer();
    },

    handleCancelled({ taskId }) {
      const run = active.get(taskId);
      if (run) {
        // 运行中：停跑（既有取消入口）→ 不再上报（hub 账本已 cancelled）
        run.unwatch();
        run.terminal = { status: 'aborted' };
        active.delete(taskId);
        ports.stopSession(run.sessionId);
        store.updateState(taskId, 'cancelled');
        logger.info('委派已取消（运行中停跑）', { taskId, sessionId: run.sessionId });
        return;
      }
      // pending/interrupted：本地无会话动作，仅账本清算（hub 账本 cancelled 是权威终态）
      const record = store.get(taskId);
      if (record && record.state !== 'cancelled') {
        store.updateState(taskId, 'cancelled');
        logger.info('委派已取消（本地无在跑回合，仅清算账本）', { taskId });
      }
    },

    settleAcceptance(taskId, outcome) {
      const run = active.get(taskId);
      if (run) {
        // 停靠出清：unwatch 已在停靠时调用（幂等）；terminal 兜底置位防 tick 拍
        run.unwatch();
        run.terminal = run.terminal ?? { status: 'aborted' };
        active.delete(taskId);
      }
      if (outcome === 'accepted') {
        // hub 账本已 done（本事件的来源即终局）——本地账本对齐 + 零上报；
        // 无停靠项时仍对齐（重启窗口迟到消费终结监督器，防 duplicate done 直报）
        store.updateState(taskId, 'done');
      }
      logger.info('验收结果已消费，停靠项出清', { taskId, outcome, hadDocked: run !== undefined });
    },

    async handleOnline() {
      // 冲一拍（断线期间缓冲的 pendingBeat 立即续传）
      tick();
      let interrupted: Array<{ taskId: string; title: string; workspaceName: string }> = [];
      try {
        interrupted = await ports.listInterruptedDelegations();
      } catch (err) {
        logger.warn('委派中断清单拉取失败（下次重连再对账）', {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      for (const task of interrupted) {
        const record = store.get(task.taskId);
        if (!record) {
          // 重启丢档：本地无此会话——上报 local_session_lost（leader 改派）
          await sendReport(task.taskId, { status: 'failed', reason: 'local_session_lost' });
          continue;
        }
        // 1.10.0 平行草稿不走回合续传：执行是接收方本地任务系统的事——监督器按
        // 本地行状态重新接管上报（in_progress 行经 adoptDraftExecution 续拍）
        if (record.draft === true) continue;
        // 续传首拍必发 running（T9 状态机：interrupted→running 唯一续传入口）
        const tail = ports.sessionTail(record.sessionId, 0);
        await sendReport(record.taskId, {
          status: 'running',
          sessionId: record.sessionId,
          progress: { lastSeq: 0, excerpt: tail ? excerptOfText(tail.excerpt) : excerptOfPrompt(record.title) },
        });
        if (active.has(task.taskId)) continue; // 本地仍在跑：复报即续传，不重复建回合
        if (record.state !== 'running') {
          // 本地已终态（中断前已完成）——补终态拍（running→done/failed 合法链）
          const terminalState = record.state === 'done' ? 'done' : 'failed';
          await sendReport(record.taskId, {
            status: terminalState,
            sessionId: record.sessionId,
            ...(terminalState === 'failed'
              ? { reason: record.reason ?? '中断前本地回合已失败' }
              : {}),
          });
          continue;
        }
        // 本地闲置（应用重启后回合中断）：复用会话注入续跑回合（会话历史含任务书与已有进展）
        const run: ActiveRun = {
          taskId: task.taskId,
          sessionId: record.sessionId,
          cursor: 0,
          pendingBeat: null,
          promptExcerpt: excerptOfPrompt(record.title),
          waitingSince: null,
          hitlInjectedAt: null,
          unwatch: () => undefined,
          terminal: null,
        };
        active.set(task.taskId, run);
        attachWatcher(task.taskId, run);
        ensureTimer();
        const started = await startTurnWithRetry({
          sessionId: record.sessionId,
          body: '【委派续传】hub 连接中断后恢复。请回顾本会话已有进展（含任务书与未完成的输出），从中断处继续完成任务。',
        });
        if (!started) {
          // D6：不留永卡 running 的幽灵委派——人话 reason 供 leader 侧排障
          settleRun(task.taskId, run, {
            status: 'failed',
            error: 'resume_boot_timeout:本机运行时启动超时（已重试 3 次未就绪），请重启本节点后由 leader 重派',
          });
        }
      }
    },

    destroy() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      for (const run of active.values()) run.unwatch();
      active.clear();
    },
  };
}
