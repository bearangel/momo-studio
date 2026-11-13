// electron/src/main/task/lifecycle-runs.ts
//
// 任务生命周期 v2 服务核心（spec 2026-11-13-task-lifecycle-v2 §5.1/§5.2/§6.6）。
//
// 职责：run 生命周期管理（startRun / 等待投影 / failRun / cancel / pause / resume）
// + 任务状态投影单点（不变量 §5.1-6：task.status 只经本服务调 transitionTaskStatus
// 写入，绝不 updateTask({status})；同态与非法边一律跳过不抛）。
//
// 设计要点：
//   - startRun 是 ensure 语义（Review Focus #3）：已有活动 run 直接返回（幂等）；
//     idx_task_runs_active 唯一索引竞态兜底——insertRun 抛 SQLITE_CONSTRAINT 时
//     重新 getActiveRun 返回既有行（双触发 / boot 重扫安全）
//   - 状态写入一律走 transitionTaskStatus（合法边），投影前先判
//     canTransition && current !== target（transitionTaskStatus 对同态会抛）
//   - paused 是用户权威态（spec §6.6）：pauseForTask 只改任务态不动 run；
//     投影（refreshTaskProjection / startRun 的 in_progress 推进）不覆盖 paused
//   - 三步写（插 run + currentRunId 回写 + 任务态转换）包同一事务；
//     被 starter.ts 事务嵌套调用时 better-sqlite3 自动降级为 SAVEPOINT
//   - submitRun / acceptTask / rejectTask 两段式完成语义（Task 10，spec §6.5）：
//     提交生成 acceptance 请求（keep_waiting + 24h 提醒），验收/打回 tryAnswer
//     原子答复；打回不建新 run——任务回 assigned，下次放行 startRun(trigger='rework')
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { getTask, transitionTaskStatus, updateTask, type TaskRow } from '../storage/tasks/repo';
import { canTransition, isTerminal, type TaskStatus } from '../storage/tasks/state-machine';
import {
  insertRun,
  getActiveRun,
  updateRun,
  countRuns,
  type TaskRunRow,
  type TaskRunStatus,
  type TaskRunTrigger,
} from '../storage/tasks/runs-repo';
import {
  supersedePendingByRun,
  countPendingNonAcceptance,
  insertHumanRequest,
  getHumanRequest,
  listByTask,
  tryAnswer,
  type HumanRequestRow,
  type HumanTimeoutPolicy,
} from '../storage/tasks/human-requests-repo';
import {
  humanAnswerBody,
  sendSystemKickoffMessage,
  type HumanAnswerInput,
} from './human-answer-inject';

/** 单任务执行尝试上限（spec §5.2：防打回-重跑死循环） */
export const MAX_RUNS_PER_TASK = 10;

/** 判定 better-sqlite3 唯一索引冲突（idx_task_runs_active 单活动 run 竞态信号） */
function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    String((err as { code?: unknown }).code).startsWith('SQLITE_CONSTRAINT')
  );
}

/**
 * 投影单点守卫：目标态可达才走 transitionTaskStatus（同态 / 非法边跳过）。
 * 只服务本模块内的任务态写入——所有路径都不得绕过此处直写 status。
 * extraPatch 透传副作用字段（submittedAt / acceptedAt 等时间戳，repo 自动合并）。
 */
function projectTaskStatus(taskId: string, target: TaskStatus, extraPatch?: Partial<TaskRow>): void {
  const task = getTask(taskId);
  if (!task) throw new Error(`task ${taskId} 不存在`);
  if (task.status === target) return; // 同态 no-op（transitionTaskStatus 对同态会抛）
  if (!canTransition(task.status, target)) return; // 非法边不抛——投影是纠偏不是断言
  transitionTaskStatus(taskId, target, extraPatch);
}

/**
 * run 记账单点：currentRunId 指向活动 run + 任务态投影 in_progress。
 * 漂移才写（幂等调用零多余 UPDATE）；终态不动（迟到结算）；
 * paused 不覆盖（§6.6 用户权威态）。
 * 只有 running run 才推进 in_progress——waiting_human/submitted 的任务投影由
 * HITL 链 / submitRun 各自落定，startRun 补记账不得越权回推（Task 9 review 修订）。
 */
function ensureRunBookkeeping(taskId: string, runId: string, runStatus: TaskRunStatus): void {
  const task = getTask(taskId)!;
  if (task.currentRunId !== runId) {
    updateTask(taskId, { currentRunId: runId });
  }
  if (runStatus === 'running' && !isTerminal(task.status) && task.status !== 'paused') {
    projectTaskStatus(taskId, 'in_progress');
  }
}

/**
 * 启动（或幂等复用）任务的当前 run——ensure 语义（Review Focus #3）。
 *
 * 流程：已有活动 run → 补记账后返回既有行；countRuns 达 MAX_RUNS_PER_TASK →
 * 人话抛错；否则事务内三步写：insertRun(running) + updateTask({currentRunId}) +
 * 任务态投影 in_progress（非终态且合法时；starter 先 transition 的时序下同态跳过）。
 *
 * paused 恢复不走 startRun（resumePaused 保留 paused → in_progress 边）；
 * 终态任务不转 in_progress，但 run 记账照常（迟到结算场景）。
 */
export function startRun(
  taskId: string,
  opts?: { trigger?: TaskRunTrigger; executionSessionId?: string | null },
): TaskRunRow {
  // 幂等快路径：已有活动 run（running/waiting_human/submitted）——补记账防漂移
  // （currentRunId 未回写 / 任务态滞留），不重插不抛；等人体/待验收态不被回推
  const existing = getActiveRun(taskId);
  if (existing) {
    ensureRunBookkeeping(taskId, existing.id, existing.status);
    return existing;
  }

  if (countRuns(taskId) >= MAX_RUNS_PER_TASK) {
    throw new Error(
      `任务 ${taskId} 执行尝试已达上限（${MAX_RUNS_PER_TASK} 次），不能再次启动；` +
        `如需继续请新建任务或清理历史 run`,
    );
  }

  return getDb().transaction((): TaskRunRow => {
    let run: TaskRunRow;
    try {
      run = insertRun({
        taskId,
        status: 'running',
        trigger: opts?.trigger ?? 'manual',
        executionSessionId: opts?.executionSessionId ?? null,
      });
    } catch (err) {
      // 单活动 run 唯一索引竞态兜底：并发双触发时后到者读到既有行返回
      if (isUniqueConstraintError(err)) {
        const raced = getActiveRun(taskId);
        if (raced) {
          ensureRunBookkeeping(taskId, raced.id, raced.status);
          return raced;
        }
      }
      throw err;
    }
    ensureRunBookkeeping(taskId, run.id, run.status);
    return run;
  })();
}

/** 取活动 run；无则人话抛错（服务入口的前置契约，调用方无需自行判空） */
function requireActiveRun(taskId: string): TaskRunRow {
  const active = getActiveRun(taskId);
  if (!active) {
    throw new Error(`任务 ${taskId} 无活动 run，不能执行该操作`);
  }
  return active;
}

/**
 * 进入等待人工（HITL 挂起）：活动 run → waiting_human + 任务 → waiting_human。
 * 任务 paused 时只改 run（paused 是用户权威态，不被等人语义覆盖）。
 */
export function enterWaitingHuman(taskId: string): void {
  const active = requireActiveRun(taskId);
  updateRun(active.id, { status: 'waiting_human' });

  const task = getTask(taskId)!;
  if (task.status !== 'paused') {
    projectTaskStatus(taskId, 'waiting_human');
  }
}

/**
 * 人工答复后恢复执行：活动 run → running + 任务 waiting_human → in_progress。
 * paused 不动（恢复走 resumePaused）。
 */
export function resumeFromWaiting(taskId: string): void {
  const active = requireActiveRun(taskId);
  updateRun(active.id, { status: 'running' });

  const task = getTask(taskId)!;
  if (task.status !== 'paused') {
    projectTaskStatus(taskId, 'in_progress');
  }
}

/**
 * run 失败收尾：活动 run → failed(endedAt) + 未决非验收请求 superseded +
 * 任务 → failed（errorMessage=reason）。
 */
export function failRun(taskId: string, reason: string): void {
  const active = requireActiveRun(taskId);
  updateRun(active.id, { status: 'failed', endedAt: Date.now() });
  supersedePendingByRun(active.id);

  const task = getTask(taskId)!;
  // 失败原因无条件落账（run 终结证据）；paused 下任务态 paused → failed 非法边
  // 由投影守卫跳过（用户恢复时由 resumePaused 重新归位）
  updateTask(taskId, { errorMessage: reason });
  if (task.status !== 'paused') {
    projectTaskStatus(taskId, 'failed');
  }
}

/**
 * 取消活动 run：活动 run → cancelled(endedAt) + 未决非验收请求 superseded +
 * 任务 → cancelled。reason 记入 run 的 reject_reason（取消原因审计）。
 */
export function cancelActiveRun(taskId: string, reason?: string): void {
  const active = requireActiveRun(taskId);
  updateRun(active.id, {
    status: 'cancelled',
    endedAt: Date.now(),
    ...(reason !== undefined ? { rejectReason: reason } : {}),
  });
  supersedePendingByRun(active.id);

  const task = getTask(taskId)!;
  // paused 下不投影 cancelled（与 failRun 同语义：取消证据已落 run 终态，
  // 任务态让位于用户权威态，由用户恢复 / 显式取消动作另行裁决）
  if (task.status !== 'paused') {
    projectTaskStatus(taskId, 'cancelled');
  }
}

/**
 * 用户暂停/抢占（非等人，spec §6.6）：任务 → paused（in_progress / waiting_human
 * 边合法），run 状态不动——执行中断由调用方联动（lifecycle 中止链），此处只落任务态。
 */
export function pauseForTask(taskId: string, errorMessage?: string): void {
  const task = getTask(taskId);
  if (!task) throw new Error(`task ${taskId} 不存在`);
  if (task.status === 'paused') return; // 同态幂等
  if (!canTransition(task.status, 'paused')) {
    throw new Error(`任务 ${taskId} status=${task.status}，不能暂停（必须为 in_progress / waiting_human）`);
  }
  transitionTaskStatus(taskId, 'paused', errorMessage !== undefined ? { errorMessage } : {});
}

/**
 * 恢复暂停任务：paused →（活动 run 有未决非验收请求 ? waiting_human : in_progress）。
 * 有人还等着 → 恢复到等人态而不是直接开跑（答复优先，防答案丢失后盲跑）。
 */
export function resumePaused(taskId: string): void {
  const task = getTask(taskId);
  if (!task) throw new Error(`task ${taskId} 不存在`);
  if (task.status !== 'paused') return; // 非暂停态幂等 no-op

  const active = getActiveRun(taskId);
  const pending = active ? countPendingNonAcceptance(active.id) : 0;
  projectTaskStatus(taskId, pending > 0 ? 'waiting_human' : 'in_progress');
}

/**
 * 投影重算（不变量 §5.1-6 单点）：按活动 run 状态 + paused + 未决请求重算任务态。
 * 已在目标态 no-op；paused / 终态不覆盖（用户权威态优先）。
 */
export function refreshTaskProjection(taskId: string): void {
  const task = getTask(taskId)!;
  // paused（用户权威）与终态（不可转出）都不参与投影重算
  if (task.status === 'paused' || isTerminal(task.status)) return;

  const active = getActiveRun(taskId);
  if (!active) return; // 无 run 无从投影（assigned/pending 等待态保持）

  switch (active.status) {
    case 'running':
      projectTaskStatus(taskId, 'in_progress');
      break;
    case 'waiting_human':
      projectTaskStatus(taskId, 'waiting_human');
      break;
    case 'submitted':
      projectTaskStatus(taskId, 'submitted');
      break;
  }
}

// ── 两段式完成语义：提交验收 / 验收通过 / 打回（Task 10，spec §6.5）──

/** 提交载荷（spec §5.2 deliverable_json 与 §5.3.1 acceptance 载荷同构） */
export interface DeliverableInput {
  summary: string;
  files?: string[];
  artifacts?: Array<{ label: string; value: string }>;
}

/** 验收请求提醒期限（§6.7：acceptance 默认 keep_waiting，24h 提醒） */
const ACCEPTANCE_DEADLINE_MS = 24 * 3600_000;

/** 本地人工验收的答复节点（Task 16 IPC 接用户身份时替换为真实 node id） */
const LOCAL_ACCEPT_BY = 'user:local';

/**
 * 提交验收（两段式第一段，spec §6.5）：活动 run → submitted（deliverable_json
 * 落库）+ 任务 → submitted（submitted_at）+ 生成 acceptance 请求。
 * 提交闸（不变量 §5.1-2）：countPendingNonAcceptance(run) 必须为 0；
 * 验收请求 sessionId 挂任务 execution_session_id（无则 source_session_id，
 * 皆无人话拒——请求必须有可操作会话）。
 * auto_accept=1（dispatch 簿记行回填）→ 提交即验收，system:auto 答复。
 */
export async function submitRun(id: string, opts: DeliverableInput): Promise<void> {
  const task = getTask(id);
  if (!task) throw new Error(`任务 ${id} 不存在`);
  const active = requireActiveRun(id);
  if (active.status === 'submitted') {
    throw new Error(`任务 ${id} 已提交待验收（run #${active.runNo}），请等待验收或打回`);
  }
  const pending = countPendingNonAcceptance(active.id);
  if (pending > 0) {
    throw new Error(`任务 ${id} 有 ${pending} 条未决人工请求，请先处理未决请求后再提交验收`);
  }
  const sessionId = task.executionSessionId ?? task.sourceSessionId;
  if (!sessionId) {
    throw new Error(`任务 ${id} 无关联会话（执行/来源会话均缺失），无法生成验收请求`);
  }

  const files = opts.files ?? [];
  const artifacts = opts.artifacts ?? [];
  const now = Date.now();
  getDb().transaction(() => {
    updateRun(active.id, {
      status: 'submitted',
      deliverableJson: JSON.stringify({ summary: opts.summary, files, artifacts }),
    });
    projectTaskStatus(id, 'submitted', { submittedAt: now });
    insertHumanRequest({
      sessionId,
      taskId: id,
      runId: active.id,
      kind: 'acceptance',
      title: `${id} 提交验收（run #${active.runNo}）`,
      payloadJson: JSON.stringify({
        acceptance: { runNo: active.runNo, summary: opts.summary, files, artifacts },
      }),
      deadlineAt: now + ACCEPTANCE_DEADLINE_MS,
      timeoutPolicy: 'keep_waiting',
    });
  })();

  if (task.autoAccept) {
    completeAcceptance(id, 'system:auto');
  }
}

/** 找 run 下未决验收请求（submitRun 生成的 acceptance 单；无则 null） */
function findPendingAcceptance(taskId: string, runId: string): HumanRequestRow | null {
  return (
    listByTask(taskId).find(
      (r) => r.runId === runId && r.kind === 'acceptance' && r.status === 'pending',
    ) ?? null
  );
}

/**
 * 验收请求答复单点：pending 单 tryAnswer；请求已被取消/顶替（如任务同时被取消）
 * 时不强行答——任务态转移随后照走，任务若已终态由状态机抛人话边界（Task 10 裁定）。
 */
function answerAcceptance(
  taskId: string,
  runId: string,
  answer: { decision: 'accept' } | { decision: 'reject'; reason: string },
  byNodeId: string,
): void {
  const req = findPendingAcceptance(taskId, runId);
  if (!req) return;
  const res = tryAnswer(req.id, JSON.stringify(answer), byNodeId);
  if (!res.ok) {
    throw new Error(`验收请求已被关闭（${res.reason}），请刷新任务状态后重试`);
  }
}

/**
 * 验收通过主体（acceptTask 与 auto_accept「提交即验收」共用）：
 * run → accepted(endedAt) + acceptance answered + 任务 → completed
 * （accepted_at + completed_at 同刻落账）。run 非 submitted 人话拒（Review Focus #4）。
 */
function completeAcceptance(taskId: string, byNodeId: string): void {
  const active = requireActiveRun(taskId);
  if (active.status !== 'submitted') {
    throw new Error(
      `任务 ${taskId} 当前 run（run #${active.runNo}）状态为 ${active.status}，` +
        `只有已提交待验收（submitted）的 run 可执行验收操作`,
    );
  }
  const now = Date.now();
  getDb().transaction(() => {
    updateRun(active.id, { status: 'accepted', endedAt: now });
    answerAcceptance(taskId, active.id, { decision: 'accept' }, byNodeId);
    projectTaskStatus(taskId, 'completed', { acceptedAt: now, completedAt: now });
  })();
}

/** 验收通过（两段式第二段）：completeAcceptance 的对外入口（人工验收） */
export async function acceptTask(id: string): Promise<void> {
  if (!getTask(id)) throw new Error(`任务 ${id} 不存在`);
  completeAcceptance(id, LOCAL_ACCEPT_BY);
}

/**
 * 打回（spec §6.5）：reason 空白人话拒（与 move 校验双保险）；run → rejected
 * （reject_reason 落库）+ acceptance 答复 reject(reason)；任务 → assigned。
 * 打回不建新 run——回 assigned 排队，下次放行 startRun(trigger='rework')；
 * 返工上限（§5.2）：下一 run 序号将超 MAX_RUNS_PER_TASK 时人话拒并建议取消。
 */
export async function rejectTask(id: string, reason: string): Promise<void> {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error('打回必须填写理由');
  if (!getTask(id)) throw new Error(`任务 ${id} 不存在`);
  const active = requireActiveRun(id);
  if (active.status !== 'submitted') {
    throw new Error(
      `任务 ${id} 当前 run（run #${active.runNo}）状态为 ${active.status}，` +
        `只有已提交待验收（submitted）的 run 可执行验收操作`,
    );
  }
  if (countRuns(id) + 1 > MAX_RUNS_PER_TASK) {
    throw new Error(
      `任务 ${id} 打回重建 run 将超出执行尝试上限（${MAX_RUNS_PER_TASK} 次），不能再打回；` +
        `如确认无法通过验收，请取消该任务`,
    );
  }
  const now = Date.now();
  getDb().transaction(() => {
    updateRun(active.id, { status: 'rejected', endedAt: now, rejectReason: trimmed });
    answerAcceptance(id, active.id, { decision: 'reject', reason: trimmed }, LOCAL_ACCEPT_BY);
    projectTaskStatus(id, 'assigned');
  })();
}

// ── HITL 请求 / 答复链（Task 11，spec §6）──

/** 人工答复载荷（Task 13 tool_gate / Task 14 request_human / Task 16 IPC 消费） */
export type { HumanAnswerInput } from './human-answer-inject';

/** tool_gate 答复回调（Task 13 注册：approve → grantWriteDirs / deny → broadcastWriteGrantDenied） */
export type ToolGateAnswerHandler = (requestId: string, answer: HumanAnswerInput) => void;

/** tool_gate 答复回调容器（Task 13 装配时注册；null 注销） */
let toolGateHandler: ToolGateAnswerHandler | null = null;

export function setToolGateHandler(fn: ToolGateAnswerHandler | null): void {
  toolGateHandler = fn;
}

/**
 * 发起人工请求（spec §6 HITL）：插 human_requests 行 + 有任务且有活动 run 时
 * enterWaitingHuman（run 层 + 任务 waiting_human 投影由其落定）。
 * 不结束回合——回合收尾由调用方 runtime 决定。
 * timeoutPolicy 缺省按 kind：question → keep_waiting；manual_action → escalate
 * （P1 的 escalate 无跨节点动作，与 keep_waiting 同行为，P2 接通知升级链）。
 * runId 透传不代填——显式 null 表示请求不绑 run（不参与 run 收尾顶替，终态窗口
 * 判定见 answerHuman）。
 */
export function requestHuman(input: {
  sessionId: string;
  kind: 'question' | 'manual_action';
  title: string;
  prompt: string;
  taskId?: string | null;
  runId?: string | null;
  optionsJson?: string | null;
  payloadJson?: string | null;
  deadlineMinutes?: number;
  timeoutPolicy?: HumanTimeoutPolicy;
}): HumanRequestRow {
  const active = input.taskId ? getActiveRun(input.taskId) : null;
  const row = insertHumanRequest({
    sessionId: input.sessionId,
    kind: input.kind,
    title: input.title,
    prompt: input.prompt,
    taskId: input.taskId ?? null,
    runId: input.runId ?? null,
    optionsJson: input.optionsJson ?? null,
    payloadJson: input.payloadJson ?? null,
    deadlineAt:
      input.deadlineMinutes !== undefined ? Date.now() + input.deadlineMinutes * 60_000 : null,
    timeoutPolicy:
      input.timeoutPolicy ?? (input.kind === 'manual_action' ? 'escalate' : 'keep_waiting'),
  });
  if (active) enterWaitingHuman(input.taskId!);
  return row;
}

/**
 * 答复人工请求（tryAnswer 原子防双答，spec §6）：
 *   - 请求不存在 → 人话抛错；已答 / 已被顶替（cancelActiveRun / failRun superseded）
 *     → {disposition:'stale'}，零注入零唤醒（Review Focus #1：终态任务的迟到答复
 *     不惊动会话）
 *   - acceptance kind → 契约错（验收走 acceptTask / rejectTask 通道）
 *   - 请求仍 pending 但任务已终态的窗口（run 已终结、请求未绑 run 未被顶替）：
 *     答复照落 answered，但注入 / 唤醒 / 恢复全部跳过（disposition:'answered'——
 *     落账诚实，动作克制，Review Focus #1 后半）
 *   - kind 分派：tool_gate → 注册回调（无注册只记日志，答复仍落库）；
 *     question | manual_action → resumeFromWaiting + 【人工答复】系统消息唤醒
 */
export function answerHuman(
  requestId: string,
  answer: HumanAnswerInput,
  byNodeId: string,
): { disposition: 'answered' | 'stale' } {
  const req = getHumanRequest(requestId);
  if (!req) throw new Error(`人工请求 ${requestId} 不存在`);
  if (req.kind === 'acceptance') {
    throw new Error('acceptance 请求不走 answerHuman 通道——验收请走 acceptTask / rejectTask');
  }

  const res = tryAnswer(requestId, JSON.stringify(answer), byNodeId);
  if (!res.ok) return { disposition: 'stale' };

  // 上下文存活性（Review Focus #1）：无任务会话级请求恒活；有任务时须任务非终态
  // 且仍有活动 run，否则只落 answered 不注入 / 不唤醒 / 不回调
  const task = req.taskId ? getTask(req.taskId) : null;
  const active = req.taskId ? getActiveRun(req.taskId) : null;
  const live = !req.taskId || (task !== null && !isTerminal(task.status) && active !== null);

  if (req.kind === 'tool_gate') {
    if (!live) {
      logger.warn('tool_gate 答复到达时任务已终态——回调跳过', { requestId, taskId: req.taskId });
      return { disposition: 'answered' };
    }
    if (toolGateHandler) {
      toolGateHandler(req.id, answer);
    } else {
      logger.warn('tool_gate 答复无注册回调（Task 13 未装配）——答复已落库', { requestId });
    }
    return { disposition: 'answered' };
  }

  // question | manual_action
  if (!live) {
    logger.warn('人工答复到达时任务/run 已终态——注入与唤醒跳过', {
      requestId,
      taskId: req.taskId,
    });
    return { disposition: 'answered' };
  }
  // 只从等人体恢复（run 非 waiting_human 的窗口态不动 run——如已 submitted）
  if (req.taskId && active?.status === 'waiting_human') {
    resumeFromWaiting(req.taskId);
  }
  sendSystemKickoffMessage(req.sessionId, humanAnswerBody(req.title, answer));
  return { disposition: 'answered' };
}
