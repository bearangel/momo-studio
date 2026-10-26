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

/**
 * task.assigned 载荷的 studio 侧容错扩展（T10）：协议 1.2.0 的 DelegationTask 无
 * permissionTier（hub parseDelegationTask 白名单重建剥离），本端按可选字段容错
 * 消费（normalizeTier 缺省/非法收敛 confirm），hub 升级透传后直接生效零改动。
 */
export type AssignedTaskEvent = Omit<TaskAssignedEvent, 'task'> & {
  task: TaskAssignedEvent['task'] & { permissionTier?: PermissionTier };
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
  /** 设置实时读取（开关/并发上限即时生效） */
  settings(): HubDelegationSettings;
  findWorkspaceByName(name: string): { id: string; name: string } | null;
  /** agentSlug 匹配工作空间成员；缺省→工作空间默认 agent；均无 → null */
  resolveAgentInstance(workspaceId: string, agentSlug: string | undefined): string | null;
  /** 建委派会话（MC1：普通 collab 会话 + 标题=任务书摘要）→ 返回 sessionId */
  createDelegatedSession(input: { workspaceId: string; title: string; memberInstanceId: string }): string;
  /**
   * L0 权限档位预配（T10 契约签名）：createDelegatedSession 后、startTurn 前调用。
   * 三档语义单源在 run-policy.ts（readonly=零写授权+prompt 只读约束段 /
   * sandbox=预授予镜像工作空间目录 / confirm=不动授权面）。readonly 的行为约束
   * 由 runner 侧 composeTurnBody 前置，本端口只做授权面动作。
   */
  applyRunPolicy(sessionId: string, tier: PermissionTier): void;
  /** 执行一个回合（首拍后注入任务书 prompt；续传时注入续跑指令） */
  startTurn(input: { sessionId: string; body: string }): Promise<void>;
  /** 会话级急停（既有取消入口 RouterService.stopAll） */
  stopSession(sessionId: string): void;
  /** 回合终态订阅 → 返回解订阅函数 */
  watchTurn(sessionId: string, onTerminal: (t: TurnTerminal) => void): () => void;
  /** 会话尾部增量（afterRowId 之后）；无增量返回 null */
  sessionTail(sessionId: string, afterRowId: number): DelegationTail | null;
  /** 上行 task.report（res 信封 id=taskId）；离线/失败返回 false（调用方缓冲重试） */
  report(taskId: string, payload: TaskReportPayload): Promise<boolean>;
  /** hub 侧中断任务清单（task.list{status:interrupted}，已按本机 targetNodeId 过滤） */
  listInterruptedDelegations(): Promise<Array<{ taskId: string; title: string; workspaceName: string }>>;
}

interface ActiveRun {
  taskId: string;
  sessionId: string;
  /** 进度游标：仅在上报成功后推进（断线不丢增量） */
  cursor: number;
  /** 待发进度拍（合并语义：始终覆盖为最新批尾） */
  pendingBeat: { lastSeq: number; excerpt: string } | null;
  /** 首拍 running 之后的回合 prompt 摘要（无文本增量时的 excerpt 兜底） */
  promptExcerpt: string;
  unwatch: () => void;
  terminal: TurnTerminal | null;
}

/** excerpt 截断上限（hub EXCERPT_MAX=512 之内留裕量） */
const EXCERPT_MAX = 200;

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

  const settleRun = (taskId: string, run: ActiveRun, terminal: TurnTerminal): void => {
    if (run.terminal) return; // 幂等：终态只清算一次
    run.terminal = terminal;
    run.unwatch();
    active.delete(taskId);
    const localState: DelegationRecord['state'] = terminal.status === 'done' ? 'done' : 'failed';
    store.updateState(taskId, localState);
    const reason =
      terminal.status === 'failed'
        ? `执行失败:${terminal.error ?? '未知错误'}`
        : terminal.status === 'aborted'
          ? `已中止${terminal.error ? `:${terminal.error}` : ''}`
          : undefined;
    void sendReport(taskId, {
      status: terminal.status === 'done' ? 'done' : 'failed',
      sessionId: run.sessionId,
      ...(reason !== undefined ? { reason: reason.slice(0, EXCERPT_MAX) } : {}),
    });
  };

  const attachWatcher = (taskId: string, run: ActiveRun): void => {
    run.unwatch = ports.watchTurn(run.sessionId, (t) => {
      const current = active.get(taskId);
      if (!current || current.sessionId !== run.sessionId) return; // 迟到终态（已取消/已换会话）
      settleRun(taskId, current, t);
    });
  };

  /** 进度拍：合并窗口到期 → 对每个活跃 run 读尾部增量、缓冲合并、上报成功才推进游标 */
  const tick = (): void => {
    for (const [taskId, run] of active) {
      if (run.terminal) continue;
      const tail = ports.sessionTail(run.sessionId, run.cursor);
      if (tail && tail.lastSeq > run.cursor) {
        run.pendingBeat = { lastSeq: tail.lastSeq, excerpt: excerptOfText(tail.excerpt) };
      }
      const beat = run.pendingBeat;
      if (!beat) continue; // 无增量不打空拍
      void sendReport(taskId, {
        status: 'running',
        sessionId: run.sessionId,
        progress: { lastSeq: beat.lastSeq, excerpt: beat.excerpt },
      }).then((ok) => {
        if (!ok) return; // 断线：pendingBeat 保留，游标不推进（重连后按最新批尾续传）
        if (beat.lastSeq > run.cursor) run.cursor = beat.lastSeq;
        if (run.pendingBeat && run.pendingBeat.lastSeq <= beat.lastSeq) run.pendingBeat = null;
      });
    }
  };

  const startRun = async (evt: AssignedTaskEvent, sessionId: string, record: DelegationRecord): Promise<void> => {
    const tier = normalizeTier(evt.task.permissionTier);
    const run: ActiveRun = {
      taskId: evt.taskId,
      sessionId,
      cursor: 0,
      pendingBeat: null,
      promptExcerpt: excerptOfPrompt(evt.task.prompt),
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
      // T10：readonly 档任务书前只读约束段（composeTurnBody 单源）；sandbox/confirm 原文
      await ports.startTurn({ sessionId, body: composeTurnBody(tier, evt.task.prompt) });
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
      if (active.size >= settings.maxConcurrent) {
        await decline(evt.taskId, `并发已达上限（${settings.maxConcurrent}）`);
        return;
      }
      const ws = ports.findWorkspaceByName(evt.workspaceName);
      if (!ws) {
        await decline(evt.taskId, `工作空间不存在:${evt.workspaceName}`);
        return;
      }
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
      const sessionId = ports.createDelegatedSession({
        workspaceId: ws.id,
        title: evt.task.title,
        memberInstanceId: instanceId,
      });
      // T10 档位预配：createSession 后、startTurn（startRun 内）前——授权面先于回合注入
      ports.applyRunPolicy(sessionId, normalizeTier(evt.task.permissionTier));
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
      });
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
            ...(terminalState === 'failed' ? { reason: '中断前本地回合已失败' } : {}),
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
