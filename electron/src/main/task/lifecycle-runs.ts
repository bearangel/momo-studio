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
// 环检查断言（T15 复核 B3，Task 18）：storage/task-groups/repo.ts（分组归档级联
// 取消）已依赖本模块 markTaskCancelled——本模块及其传递依赖（recurrence 等）
// 不得反向 import storage/task-groups/*，否则成环。新增 import 前先核此约束。
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
  cancelPendingByTask,
  insertHumanRequest,
  getHumanRequest,
  listByTask,
  tryAnswer,
  type HumanRequestRow,
  type HumanTimeoutPolicy,
} from '../storage/tasks/human-requests-repo';
import {
  humanAnswerBody,
  type HumanAnswerInput,
} from './human-answer-shared';
import { spawnNextInstanceIfRecurring } from './recurrence';

/**
 * 人工答复注入回调（Task 14 循环依赖修复）：answerHuman 落【人工答复】系统消息
 * + 唤醒会话的动作。默认未注册（本模块经 starter/executor 被 tools 链静态引用，
 * 不得顶层依赖 human-answer-inject 的重运行时网——router-bootstrap→…→tools/catalog
 * 顶层求值回指 task-tools 模块环，tests/agent/tools 全目录加载即炸）。
 * 主进程装配点（sandbox/ipc.handlers registerSandboxIpc）注册
 * sendSystemKickoffMessage（setToolGateHandler 同款注入器先例）；未注册时答复
 * 照落库，注入跳过并 warn（与 tool_gate 无回调分支同纪律）。
 */
export type HumanAnswerKickoff = (sessionId: string, body: string) => void;

/** 人工答复注入回调容器（装配时注册；null 注销） */
let humanAnswerKickoff: HumanAnswerKickoff | null = null;

export function setHumanAnswerKickoff(fn: HumanAnswerKickoff | null): void {
  humanAnswerKickoff = fn;
}

// ── renderer 推送 sink（Task 16，spec §6 IPC 面）──
//
// 服务层（本模块 / sweeper）不得依赖 electron（本模块经 task-tools 等被
// runtime 子进程静态可达——隔离锁）；human:changed / task:runChanged 推送
// 经 setter 注入（setToolGateHandler / setHumanAnswerKickoff 同款先例），
// 装配点在 human.ipc.handlers registerHumanIpc。未注册时 no-op（测试 /
// 子进程侧调用零负担）。

/** human:changed 推送事件：kind 为变化类型（inserted / answered / expired） */
export interface HumanChangedEvent {
  sessionId: string;
  requestId?: string;
  kind: 'inserted' | 'answered' | 'expired';
}

/** human:changed 推送 sink 容器（装配时注册；null 注销） */
let humanChangedSink: ((e: HumanChangedEvent) => void) | null = null;

export function setHumanChangedSink(fn: ((e: HumanChangedEvent) => void) | null): void {
  humanChangedSink = fn;
}

/** 服务侧发射端（sweeper 等 import 本函数发射；sink 未装配 no-op） */
export function emitHumanChanged(e: HumanChangedEvent): void {
  humanChangedSink?.(e);
}

/** task:runChanged 推送事件：run 状态变化点（新建 / 每次状态转移后） */
export interface TaskRunChangedEvent {
  taskId: string;
  runId: string;
  status: TaskRunStatus;
}

/** task:runChanged 推送 sink 容器（装配时注册；null 注销） */
let taskRunChangedSink: ((e: TaskRunChangedEvent) => void) | null = null;

export function setTaskRunChangedSink(fn: ((e: TaskRunChangedEvent) => void) | null): void {
  taskRunChangedSink = fn;
}

/** run 状态变化推送单点（本模块内各转移点调用；事务提交后发射，sink 未装配 no-op）。
 *  导出供主进程 agent-runner 回放子进程转发的 lifecycle-event（2026-11-14 P1）。 */
export function emitRunChanged(taskId: string, runId: string, status: TaskRunStatus): void {
  taskRunChangedSink?.({ taskId, runId, status });
}

// ── 子进程侧生命周期事件转发（2026-11-14 P1 修复）──
//
// agent 工具（request_human / submit_task / fail_task）在 runtime 子进程执行，
// 本模块随 task-tools 静态进入子进程图——而 sink 只在主进程 registerHumanIpc
// 装配，子进程内上述 emit 恒 no-op（E2E 实证：agent 侧发起的 run/human 推送
// 主进程与 renderer 永远收不到，仅面板重挂载/轮询才更新）。
// 修复：runtime-entry boot 时调 forwardLifecycleEvents 把两 sink 接到
// process.send；主进程 agent-runner 消息泵按 LifecycleEventMessage 形状
// 回放进主进程自己的 sink。两端共用本处的线协议类型（一义一名）。

/** lifecycle-event 转发通道（与 renderer 推送通道名有意同形） */
export type LifecycleEventChannel = 'task:runChanged' | 'human:changed';

/** child → main 生命周期事件转发消息（子进程发送 / agent-runner 消费） */
export interface LifecycleEventMessage {
  type: 'lifecycle-event';
  channel: LifecycleEventChannel;
  payload: TaskRunChangedEvent | HumanChangedEvent;
}

/**
 * 子进程侧转发装配：两 sink 注册成「经 send 回调外发」（runtime-entry 以
 * process.send 接线，真实 send 回调 = 生产子进程）。沿用既有 sink 容器
 * （setter 注入），主进程装配点不受影响——两侧是不同进程的模块实例。
 */
export function forwardLifecycleEvents(
  send: (channel: LifecycleEventChannel, payload: TaskRunChangedEvent | HumanChangedEvent) => void,
): void {
  setTaskRunChangedSink((e) => send('task:runChanged', e));
  setHumanChangedSink((e) => send('human:changed', e));
}

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

  const run = getDb().transaction((): TaskRunRow => {
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
  emitRunChanged(taskId, run.id, 'running');
  return run;
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
  emitRunChanged(taskId, active.id, 'waiting_human');

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
  emitRunChanged(taskId, active.id, 'running');

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
  // 由投影守卫跳过（用户恢复时由 resumePaused 重新归位）。
  // completedAt：终态时间戳（D4 口径——详情面板/统计消费；与旧 runner/ledger
  // 失败路径的 extraPatch 行为对齐）
  updateTask(taskId, { errorMessage: reason, completedAt: Date.now() });
  if (task.status !== 'paused') {
    projectTaskStatus(taskId, 'failed');
  }
  emitRunChanged(taskId, active.id, 'failed');
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
  emitRunChanged(taskId, active.id, 'cancelled');
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
  if (task.status === 'paused') {
    // paused 是用户权威态（§6.6）——暂停中的任务不接受提交，先恢复或取消
    throw new Error(`任务 ${id} 已暂停，先恢复或取消`);
  }
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
  const acceptance = getDb().transaction((): HumanRequestRow => {
    updateRun(active.id, {
      status: 'submitted',
      deliverableJson: JSON.stringify({ summary: opts.summary, files, artifacts }),
    });
    projectTaskStatus(id, 'submitted', { submittedAt: now });
    return insertHumanRequest({
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
  emitRunChanged(id, active.id, 'submitted');
  emitHumanChanged({ sessionId, requestId: acceptance.id, kind: 'inserted' });

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
  emitHumanChanged({ sessionId: req.sessionId, requestId: req.id, kind: 'answered' });
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
  emitRunChanged(taskId, active.id, 'accepted');
  // 循环续期单点（spec §7.2：completed 钩子）——人工验收与 auto_accept
  // 「提交即验收」同点位触发，替代旧 agent-runner / move.ts 各自的调用
  spawnNextInstanceIfRecurring(taskId);
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
 * 返工上限（§5.2）：下一 run 序号将超 MAX_RUNS_PER_TASK 时任务转 failed
 * （errorMessage=返工次数超限，failRun 同链）——拒绝无限返工循环。
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
    // 返工上限（spec §5.2 原文）：run 数达上限后拒绝再次打回——任务转
    // failed（errorMessage=返工次数超限）走 failRun（§6.5 技术性失败表），
    // 防止无限返工循环；未决验收单随任务终态失效（不再被答复）
    failRun(id, '返工次数超限');
    return;
  }
  const now = Date.now();
  getDb().transaction(() => {
    updateRun(active.id, { status: 'rejected', endedAt: now, rejectReason: trimmed });
    answerAcceptance(id, active.id, { decision: 'reject', reason: trimmed }, LOCAL_ACCEPT_BY);
    projectTaskStatus(id, 'assigned');
  })();
  emitRunChanged(id, active.id, 'rejected');
}

// ── HITL 请求 / 答复链（Task 11，spec §6）──

/** 人工答复载荷（Task 13 tool_gate / Task 14 request_human / Task 16 IPC 消费） */
export type { HumanAnswerInput } from './human-answer-shared';

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
  emitHumanChanged({ sessionId: input.sessionId, requestId: row.id, kind: 'inserted' });
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
  emitHumanChanged({ sessionId: req.sessionId, requestId, kind: 'answered' });

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
  if (humanAnswerKickoff) {
    humanAnswerKickoff(req.sessionId, humanAnswerBody(req.title, answer));
  } else {
    logger.warn('【人工答复】注入未装配（setHumanAnswerKickoff 未注册）——答复已落库', {
      requestId,
    });
  }
  return { disposition: 'answered' };
}

// ── 写路径收敛服务面（Task 15，spec §9.3 十处逃生门收口）──
//
// 下列原语供原直调 transitionTaskStatus / updateTask({status}) 的调用方收敛：
// 状态写入全部经本模块（projectTaskStatus / transitionTaskStatus 单点），
// 调用方不得再触碰任务 status 字段。

/**
 * 任务取消的状态面单点（§9.3 行10，lifecycle.cancelTask / 归档级联消费）：
 * 有活动 run → cancelActiveRun（run cancelled + 未决非验收请求 superseded）；
 * 无 run（draft/pending/assigned 等未启动行）→ 投影 cancelled；
 * paused 行显式取消是用户动作——覆盖用户权威态（与 failRun 的静默跳过不同）。
 * 挂起人工请求联动 cancelled（cancelPendingByTask：任务取消即全部请求失效，
 * 含 acceptance——repo 现有 API 语义，不另造 superseded 通路）。
 * 进程级中止（abortTaskExecution）不在此——由 lifecycle.cancelTask 联动。
 */
export function markTaskCancelled(taskId: string, reason?: string): void {
  const task = getTask(taskId);
  if (!task) throw new Error(`task ${taskId} 不存在`);
  if (getActiveRun(taskId)) {
    cancelActiveRun(taskId, reason);
  }
  const after = getTask(taskId)!;
  if (after.status !== 'cancelled') {
    if (!canTransition(after.status, 'cancelled')) {
      throw new Error(`任务 ${taskId} status=${after.status}，不能取消`);
    }
    transitionTaskStatus(taskId, 'cancelled');
  }
  cancelPendingByTask(taskId);
}

/**
 * 任务失败的状态面单点（§9.3 行5，executor failQuietly / lifecycle kickoff
 * 失败 / dispatch 判死消费）：有活动 run → failRun；无 run 的排队行
 * （assigned/session_queued 目标失效等）→ errorMessage + 投影 failed
 * （终态行幂等 no-op，不抛——迟到失败不覆盖先落权威终态）。
 */
export function markTaskFailed(taskId: string, reason: string): void {
  const task = getTask(taskId);
  if (!task) throw new Error(`task ${taskId} 不存在`);
  if (getActiveRun(taskId)) {
    failRun(taskId, reason);
    return;
  }
  if (isTerminal(task.status)) return;
  updateTask(taskId, { errorMessage: reason, completedAt: Date.now() });
  projectTaskStatus(taskId, 'failed');
}

/**
 * 车道排队投影（消费面 ①-12/R6，executor 放行流程专用）：目标会话车道被占时
 * assigned → session_queued（放行边界内的服务单点写，不另立入口）。
 * 非法边静默跳过（投影守卫）——并发改态由兜底扫描重评估。
 */
export function markSessionQueued(taskId: string): void {
  projectTaskStatus(taskId, 'session_queued');
}

/**
 * 入队投影（消费面 ①-16/①-22，move 拖拽排队列 / activation #T 激活消费）：
 * draft/pending → assigned（放行面入口，executor 只认 assigned/session_queued）。
 */
export function enqueueTask(taskId: string): void {
  projectTaskStatus(taskId, 'assigned');
}

/**
 * 外派路由提级（消费面 ①-23，task:update 的 routing 改道消费）：draft → pending
 * （切非 local 路由时服务端派生提级）；非法边（非 draft）静默跳过。
 */
export function promoteDraftToPending(taskId: string): void {
  projectTaskStatus(taskId, 'pending');
}

/**
 * 配额续跑复位（§9.3 行7，quota-resume 消费）：in_progress 行的 429 配额失败
 * 改排自动续跑——活动 run 以 failed 终结（释放单活动 run 槽，重试由
 * startRun 建**新** run），任务权威复位 assigned + scheduled_at
 * （in_progress→assigned 无状态机合法边——调度权威决策，见 authoritativeReset）。
 * errorMessage 保留配额文案（等待期 UI 显示原因）。下次放行
 * startRun(trigger='quota_retry')。
 */
export function resetForQuotaRetry(
  taskId: string,
  opts: { scheduledAt: number; errorMessage: string; routingJson: string },
): void {
  const active = getActiveRun(taskId);
  if (active) {
    updateRun(active.id, { status: 'failed', endedAt: Date.now(), rejectReason: '配额受限自动续跑' });
    emitRunChanged(taskId, active.id, 'failed');
  }
  updateTask(taskId, {
    status: 'assigned',
    scheduledAt: opts.scheduledAt,
    errorMessage: opts.errorMessage,
    routingJson: opts.routingJson,
  });
}

/**
 * 权威复位原语（§9.3 逃生门收敛后的服务内复位通道）：绕过状态机断言直写
 * 任务行——语义是「注册表 / 调度 / 启动对账的权威决策覆写」而非生命周期
 * 转换（spec §3.4 修正案，旧直写路径的语义在服务内保留）。只供三类既有
 * 权威路径消费（调用点注释须注明权威来源）：
 *   - dispatch 账本 followup 复位（registry 复用链 id → in_progress + 新 run）
 *   - dispatch 启动对账（boot 权威：paused → failed，编排链丢失）
 *   - 其余生命周期转换一律走具名服务函数，不得借用本原语
 */
export function authoritativeReset(taskId: string, patch: Partial<TaskRow> & { status: TaskStatus }): void {
  const task = getTask(taskId);
  if (!task) throw new Error(`task ${taskId} 不存在`);
  updateTask(taskId, patch);
}
