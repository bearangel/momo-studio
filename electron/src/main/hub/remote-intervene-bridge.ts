// electron/src/main/hub/remote-intervene-bridge.ts
//
// 任务生命周期 v2 P2 S2：worker 干预/提交桥（spec 2026-11-13 §8.6）。
// lifecycle-runs 的 RemoteInterveneEvent（request_human / tool_gate 落行 /
// submitRun 提交）在主进程此桥判定 delegation 归属后外发 hub：
//   - request_created → task.intervene（RPC 有应答；失败降级本地等待——请求行
//     保留 pending，节点所有者自答，P1 行为；不重试，幂等重发由重连对账 S7 负责）
//   - run_submitted → task.report {status:'submitted', runNo, reason=deliverable
//     JSON}（res 信封单向无错误回传——版本门 minor≥11 预检 + sendRes false 均走
//     降级：本地验收兜底（acceptTask）收口 completed，P1「单方完成」旧行为；
//     done 终态上报由既有 delegation-runner 监督器/重连对账链承载，此处不双发）
//
// P2 S3（本文件下半部）：worker 消费远端代答——hub 定向 task.interventionAnswered
// 事件 → 本地 answerHuman 统一路由（详见 handleInterventionAnswered 头注释）。
//
// 桥判定（worker 视角单源，与 delegation-sync/delegation-ports 同口径）：
// tasks.delegation_id 非空 且（delegation_role='in' 或 routing node 变体
// targetNodeId=本机——peer-draft 承接行无 delegation_role，按路由判向）。
//
// 纯端口注入（momo-test-rules #5，delegation-answer.ts 同款）：DB 面生产直连
// 真实库，装配在 hub/index ensureRemoteInterveneBridge（仅主进程执行——hub/index
// 模块体虽为 runtime 子进程静态可达，装配调用点 initHub 只在主进程跑）。
import { createHash, randomUUID } from 'node:crypto';
import { logger } from '../logger';
import { getRouterService } from '../agent/router-bootstrap';
import { getSessionMembersInfo } from '../im/session-ops';
import type { HubClient } from './client';
import { TASK_RPC, TASK_HITL_REQUIRED_MINOR, type InterventionKind, type InterventionRequest } from './protocol';
import { TASK_WIRE } from './delegation-wire';
import { getDb } from '../storage/db';
import {
  getHumanRequest,
  insertHumanRequest,
  findRemoteMirrorRequest,
  type HumanRequestRow,
} from '../storage/tasks/human-requests-repo';
import { getTask, updateTask, type TaskRow } from '../storage/tasks/repo';
import { getActiveRun, insertRun, type TaskRunRow } from '../storage/tasks/runs-repo';
import { isTerminal } from '../storage/tasks/state-machine';
import {
  ACCEPTANCE_DEADLINE_MS,
  answerHuman,
  completeAcceptance,
  emitHumanChanged,
  emitRunChanged,
  rejectTask,
  type RemoteInterveneEvent,
} from '../task/lifecycle-runs';
import type { HumanAnswerInput } from '../task/human-answer-shared';
import { truncateCodePoints } from '../util/redact';
import { insertMessage } from '../storage/messages/repo';
import { pushSessionMessage } from '../agent/stream-relay';

/** hub delegations.ts REASON_MAX 镜像（reason 超限整包拒——deliverable 通道上限） */
const REASON_MAX = 512;
/** 超长 deliverable 降级截断的 summary 预算（JSON 转义膨胀留裕量） */
const SUMMARY_FALLBACK_CODEPOINTS = 400;

/**
 * 里程碑落执行会话公用底座（S2 降级 / S4 验收消费同 event_type）：messages 行
 * sender='system'、event_type='delegation_milestone'、结构化 meta 落
 * context_json（repo 的 meta 载体列，human-answer-inject metaJson 同位），
 * 与 S5 发起方侧跟踪会话里程碑同 event_type（双端一致，spec §7.3 契约同型）。
 * 写后 pushSessionMessage 实时推 renderer；**不唤醒 agent**（无 systemKickoff
 * ——里程碑是旁路事件，不消费回合；rejected 的 reason 经会话历史进入返工
 * 上下文，协议「打回理由进 agent 上下文」由此承载）。execution_session_id 空
 * （无会话可写，如 source-only 任务）跳过，logger 兜底（与 dispatch 口径一致）。
 */
function writeSessionMilestone(task: TaskRow, body: string, meta: Record<string, unknown>): void {
  const sessionId = task.executionSessionId;
  if (sessionId === null || sessionId === '') {
    logger.warn('delegation 里程碑未写入（任务无关联执行会话，logger 兜底）', {
      taskId: task.id,
      meta,
    });
    return;
  }
  const row = insertMessage({
    sessionId,
    sender: 'system',
    eventType: 'delegation_milestone',
    body,
    taskId: task.id,
    contextJson: JSON.stringify(meta),
  });
  pushSessionMessage(row);
}

/**
 * 降级里程碑落执行会话（评审轮 1，Review Focus #1——brief「里程碑记录降级原因」）：
 * writeSessionMilestone 的 S2 降级包装（kind/reason/code 结构化 + 人话 body）。
 */
function writeDegradedMilestone(input: {
  task: TaskRow;
  kind: 'intervene_degraded' | 'submit_degraded';
  reason: string;
  code?: string;
  suffix: string;
}): void {
  writeSessionMilestone(
    input.task,
    `${input.kind === 'intervene_degraded' ? '干预上报降级' : '提交上报降级'}（${input.reason}）：${input.suffix}`,
    {
      kind: input.kind,
      reason: input.reason,
      ...(input.code !== undefined ? { code: input.code } : {}),
    },
  );
}

/** 进程/DB 边界端口（唯一 mock 面；生产接线 hub/index.ts） */
export interface RemoteInterveneBridgePorts {
  /** 当前 hub 连接惰性取用（连接随 hubConfigure/Forget 重建——不持有过期引用） */
  clientGetter(): HubClient | null;
  /** 本机 nodeId（peer-draft 承接行 routing.targetNodeId 判向） */
  selfNodeId(): string | null;
  getTask(taskId: string): TaskRow | null;
  getActiveRun(taskId: string): TaskRunRow | null;
  /** 会话 → 最新非终态任务（tool_gate 行无 task_id，按执行会话定位——
   *  requestHumanFromAgent 的 activeTask 解析同口径） */
  findActiveTaskByExecutionSession(sessionId: string): TaskRow | null;
  /** 降级兜底：本地验收（P1「单方完成」语义；lifecycle-runs acceptTask） */
  acceptTask(taskId: string): Promise<void>;
}

/** 桥输入（= lifecycle-runs RemoteInterveneEvent；别名仅为其独立命名面） */
export type RemoteInterveneEventInput = RemoteInterveneEvent;

/** worker 执行方判定：delegation_id 非空 且（delegation_role='in' 或 peer-draft
 *  承接行 routing node 变体指向本机）。外派镜像行（'out'/路由指向远端）不桥——
 *  其执行在远端，本地 lifecycle 事件不外发。 */
function isWorkerExecution(task: TaskRow, selfNodeId: string | null): boolean {
  if (task.delegationRole === 'in') return true;
  if (task.delegationRole === 'out') return false;
  return task.routing.mode === 'node' && selfNodeId !== null && task.routing.targetNodeId === selfNodeId;
}

/** hub 协议版本串（'1.11.0' 形）→ minor；异形/null → null */
function hubMinorOf(ver: string | null): number | null {
  if (ver === null) return null;
  const m = /^(\d+)\.(\d+)(?:\.|$)/.exec(ver);
  return m ? Number(m[2]) : null;
}

/** payload_json → InterventionRequest.payload（畸形/非对象 → undefined 不带键） */
function parsePayloadObject(row: HumanRequestRow): Record<string, unknown> | undefined {
  if (row.payloadJson === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(row.payloadJson);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 畸形载荷不外发（hub 侧会整包拒，降级为不带 payload 键的干净载荷）
  }
  return undefined;
}

/** options_json → InterventionRequest.options（逐项形状校验，任一畸形整段不带键） */
function parseInterventionOptions(
  row: HumanRequestRow,
): Array<{ id: string; label: string; description?: string }> | undefined {
  if (row.optionsJson === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(row.optionsJson);
    if (!Array.isArray(parsed)) return undefined;
    const out: Array<{ id: string; label: string; description?: string }> = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) return undefined;
      const o = item as { id?: unknown; label?: unknown; description?: unknown };
      if (typeof o.id !== 'string' || typeof o.label !== 'string') return undefined;
      out.push({
        id: o.id,
        label: o.label,
        ...(typeof o.description === 'string' ? { description: o.description } : {}),
      });
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * deliverable → report.reason（H7 通道约定：hub JSON.parse 成纯对象则作
 * deliverable 透传；REASON_MAX=512 超限整包拒）。全量 JSON 放得下用全量；
 * 放不下降级为仅 summary 的截断形态（保 JSON 有效性——数字等非对象解析结果
 * 会让 hub 丢弃 deliverable 键，截断循环按 JSON 实长收敛）。
 */
export function buildDeliverableReason(deliverable: {
  summary: string;
  files?: string[];
  artifacts?: Array<{ label: string; value: string }>;
}): string {
  const full = JSON.stringify({
    summary: deliverable.summary,
    files: deliverable.files ?? [],
    artifacts: deliverable.artifacts ?? [],
  });
  if (full.length <= REASON_MAX) return full;
  let take = SUMMARY_FALLBACK_CODEPOINTS;
  let out = JSON.stringify({ summary: truncateCodePoints(deliverable.summary, take) });
  while (out.length > REASON_MAX && take > 0) {
    take = Math.floor(take / 2);
    out = JSON.stringify({ summary: truncateCodePoints(deliverable.summary, take) });
  }
  return out;
}

/**
 * 桥 handler 工厂。total 语义：任何内部异常吞掉只 warn（sink 在
 * requestHuman/submitRun 的落库成功路径上同步调用，桥故障不得打断本地生命周期）。
 * 幂等账：closure 内 Set<`${taskId}#${runNo}`> 记已外发的 submitted report——
 * 同形重放（消息重投递/S7 对账重扫）零重复上报；跨重启重放由 hub 侧
 * 「重复 submitted 幂等忽略」兜底（H7 行为锁）。stale 守卫：任务已离开
 * submitted/completed（打回 assigned / 取消 / 失败）或活动 run 已换号 → 事件过期跳过。
 */
export function createRemoteInterveneHandler(
  ports: RemoteInterveneBridgePorts,
): (e: RemoteInterveneEventInput) => void {
  const reportedSubmitted = new Set<string>();

  const sendIntervene = (request: HumanRequestRow, kind: InterventionKind): void => {
    const task =
      request.taskId !== null
        ? ports.getTask(request.taskId)
        : ports.findActiveTaskByExecutionSession(request.sessionId);
    if (!task || task.delegationId === null) return;
    if (!isWorkerExecution(task, ports.selfNodeId())) return;
    const client = ports.clientGetter();
    // S2 评审顺手项：非 online 连接同 client === null 一并降级（对称 submitToHub——
    // 半开连接上发 RPC 只会挂到超时，降级本地等待是更快收敛路径）
    if (client === null || client.state() !== 'online') {
      logger.warn('干预桥降级：hub 未连接，请求转本地等待（节点所有者自答）', {
        requestId: request.id,
        taskId: task.id,
      });
      writeDegradedMilestone({
        task,
        kind: 'intervene_degraded',
        reason: 'hub 离线',
        suffix: '已转本地等待，节点所有者可在请求面板处理',
      });
      return;
    }
    const payload = parsePayloadObject(request);
    const options = parseInterventionOptions(request);
    const activeRun = ports.getActiveRun(task.id);
    if (activeRun === null) {
      // S2 评审顺手项：?? 1 兜底命中即锚定弱化（hub/对端按 runNo 对不上旧请求）——
      // warn 留痕供排障（多为终态窗口迟到的落行事件）
      logger.warn('干预上报时无活动 run——runNo 兜底 1（锚定弱化）', {
        requestId: request.id,
        taskId: task.id,
        kind: request.kind,
      });
    }
    const intervention: InterventionRequest = {
      interventionId: request.id,
      runNo: activeRun?.runNo ?? 1,
      kind,
      title: request.title,
      prompt: request.prompt,
      ...(payload !== undefined ? { payload } : {}),
      ...(options !== undefined ? { options } : {}),
      ...(request.deadlineAt !== null ? { deadlineAt: request.deadlineAt } : {}),
    };
    // 不重试（S2 单发语义）：失败即降级本地，幂等重发由 S7 重连对账负责
    void client
      .request(TASK_RPC.intervene, { taskId: task.delegationId, intervention })
      .then(() => {
        logger.info('干预请求已上报 hub', {
          requestId: request.id,
          taskId: task.delegationId,
          kind: request.kind,
          runNo: intervention.runNo,
        });
      })
      .catch((err: unknown) => {
        const code = err instanceof Error && 'code' in err ? String((err as { code?: unknown }).code) : undefined;
        logger.warn('干预桥降级：task.intervene 失败，请求转本地等待（节点所有者自答）', {
          requestId: request.id,
          taskId: task.delegationId,
          code,
          error: err instanceof Error ? err.message : String(err),
        });
        writeDegradedMilestone({
          task,
          kind: 'intervene_degraded',
          reason: `task.intervene 失败：${err instanceof Error ? err.message : String(err)}`,
          ...(code !== undefined ? { code } : {}),
          suffix: '已转本地等待，节点所有者可在请求面板处理',
        });
      });
  };

  const degradeSubmit = (taskId: string, delegationId: string, cause: string): void => {
    logger.warn('提交桥降级：report submitted 未送达，回落 P1 单方完成', {
      taskId,
      delegationId,
      cause,
    });
    // P1 旧行为收口：本地验收兜底（auto_accept 已完成的行跳过；done 终态上报由
    // delegation-runner 监督器/重连对账链承载，桥不双发）
    const fresh = ports.getTask(taskId);
    if (fresh) {
      writeDegradedMilestone({
        task: fresh,
        kind: 'submit_degraded',
        reason: cause,
        suffix: '任务按旧语义完成',
      });
    }
    if (fresh && fresh.status === 'submitted') {
      void ports
        .acceptTask(taskId)
        .catch((err: unknown) => {
          logger.warn('提交桥降级验收兜底失败（终态上报交由既有链）', {
            taskId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
  };

  const submitToHub = (e: RemoteInterveneEventInput & { kind: 'run_submitted' }): void => {
    const task = ports.getTask(e.taskId);
    if (!task || task.delegationId === null) return;
    if (!isWorkerExecution(task, ports.selfNodeId())) return;
    const key = `${e.taskId}#${e.runNo}`;
    if (reportedSubmitted.has(key)) return; // 同形重放：零重复 report
    if (task.status !== 'submitted' && task.status !== 'completed') return; // 事件过期（打回/取消/失败后迟到）
    const active = ports.getActiveRun(e.taskId);
    if (active !== null && active.runNo !== e.runNo) return; // 事件属旧 run（打回换号后重放）

    const client = ports.clientGetter();
    if (client === null || client.state() !== 'online') {
      degradeSubmit(e.taskId, task.delegationId, 'hub 未连接');
      return;
    }
    // res 信封单向上报无错误回传通道——旧 hub（<1.11）白名单拒 submitted 只能
    // 静默丢弃，版本门预检是不发半套语义的唯一信号（S8 将重写为四象限门）
    const minor = hubMinorOf(client.hubProtoVer());
    if (minor === null || minor < TASK_HITL_REQUIRED_MINOR) {
      degradeSubmit(e.taskId, task.delegationId, `hub 协议 ${client.hubProtoVer()} < 1.${TASK_HITL_REQUIRED_MINOR}`);
      return;
    }
    const sent = client.sendRes(task.delegationId, TASK_WIRE.report, {
      status: 'submitted',
      runNo: e.runNo,
      reason: buildDeliverableReason(e.deliverable),
    });
    if (!sent) {
      degradeSubmit(e.taskId, task.delegationId, 'sendRes 失败（连接半关）');
      return;
    }
    reportedSubmitted.add(key);
    logger.info('run 提交已上报 hub（submitted）', {
      taskId: e.taskId,
      delegationId: task.delegationId,
      runNo: e.runNo,
    });
  };

  return (e: RemoteInterveneEventInput): void => {
    try {
      if (e.kind === 'request_created') {
        if (
          e.request.kind === 'question' ||
          e.request.kind === 'manual_action' ||
          e.request.kind === 'tool_gate'
        ) {
          sendIntervene(e.request, e.request.kind);
        }
        return;
      }
      submitToHub(e);
    } catch (err) {
      // total 语义：桥故障绝不打断本地生命周期（事件已落库，本地行为完整）
      logger.warn('远程干预桥内部异常（事件丢弃，本地行为不受影响）', {
        kind: e.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

// ── worker 消费远端代答（P2 S3，spec 2026-11-13 §8.6）─────────────────────────

/** 协议 InterventionAnswer → 本地 HumanAnswerInput：字段同名直传
 *  （decision/text/selected/completed），任一字段异形整包丢弃不消费（协议宽容
 *  「hub 不校验组合」——形状守卫是本端唯一防线） */
function parseInterventionAnswer(raw: unknown): HumanAnswerInput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as { decision?: unknown; text?: unknown; selected?: unknown; completed?: unknown };
  if (a.decision !== undefined && a.decision !== 'approve' && a.decision !== 'deny') return null;
  if (a.text !== undefined && typeof a.text !== 'string') return null;
  if (
    a.selected !== undefined &&
    (!Array.isArray(a.selected) || !a.selected.every((s) => typeof s === 'string'))
  ) {
    return null;
  }
  if (a.completed !== undefined && typeof a.completed !== 'boolean') return null;
  return {
    ...(a.decision !== undefined ? { decision: a.decision } : {}),
    ...(a.text !== undefined ? { text: a.text } : {}),
    ...(a.selected !== undefined ? { selected: a.selected } : {}),
    ...(a.completed !== undefined ? { completed: a.completed } : {}),
  };
}

/**
 * task.interventionAnswered 事件消费（hub/index onEvent 装配；hub 定向→本机
 * worker）：interventionId = 本地 human_requests.id（S2 桥单点生成约定，taskId
 * 是 hub 账本 id 非本地 tasks.id——仅日志用）。统一走 answerHuman 一条路覆盖
 * 三 kind（question/manual_action 注入唤醒链、tool_gate 授权回调钩——P1 kind
 * 分派单源，零特判）；answeredBy 记 `remote:<答方节点id>`（区分本地 'local'/
 * 超时 'system:timeout'）。幂等收敛：行不存在 / 已非 pending → 静默丢弃
 * logger.info（hub 侧 first_wins 已收敛，迟到重放无消费面）；total 语义——
 * 事件处理绝不向上抛（onEvent 无错误回传通道）。
 */
export function handleInterventionAnswered(payload: unknown): void {
  try {
    if (typeof payload !== 'object' || payload === null) return;
    const p = payload as {
      taskId?: unknown;
      interventionId?: unknown;
      answer?: unknown;
      answeredBy?: unknown;
    };
    if (typeof p.interventionId !== 'string' || p.interventionId === '') return;
    if (typeof p.answeredBy !== 'string') return;
    const answer = parseInterventionAnswer(p.answer);
    if (answer === null) return;
    const taskIdForLog = typeof p.taskId === 'string' ? p.taskId : undefined;

    const req = getHumanRequest(p.interventionId);
    if (req === null) {
      logger.info('远端代答到达但本地无此人工请求（幂等收敛，丢弃）', {
        interventionId: p.interventionId,
        taskId: taskIdForLog,
      });
      return;
    }
    if (req.status !== 'pending') {
      logger.info('远端代答到达但请求已非 pending（幂等收敛，丢弃）', {
        interventionId: p.interventionId,
        status: req.status,
        kind: req.kind,
      });
      return;
    }
    const disp = answerHuman(req.id, answer, `remote:${p.answeredBy}`);
    logger.info('远端代答已消费（answerHuman 统一路由）', {
      interventionId: req.id,
      taskId: taskIdForLog,
      kind: req.kind,
      disposition: disp.disposition,
      answeredBy: p.answeredBy,
    });
  } catch (err) {
    logger.warn('远端代答消费内部异常（事件丢弃，本地行为不受影响）', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── worker 消费远端验收/打回（P2 S4，spec 2026-11-13 §8.2/§8.6）─────────────────

/** S4 消费端口（hub/index onEvent 装配；事件入口直调 + DB 真实——S3 同款纪律） */
export interface WorkerTerminalConsumePorts {
  /** 本机 nodeId（外派镜像行不消费——isWorkerExecution 判向） */
  selfNodeId(): string | null;
  /** 验收消费后的停靠出清（delegation-runner settleAcceptance；未装配/无停靠项幂等） */
  settleDocked(taskId: string, outcome: 'accepted' | 'rejected'): void;
}

/**
 * 远端验收/打回的答复方标记：协议 1.11 的 TaskAcceptedEvent / TaskRejectedEvent
 * 不携带验收者身份（hub 账本单源定向）——以发起方统称落账，区别本地
 * 'user:local'（LOCAL_ACCEPT_BY）与自动 'system:auto'。
 */
const REMOTE_ORIGIN_BY = 'remote:origin';

/**
 * hub 委派 id → 本地承接行（delegation_id 反查，delegation-sync
 * findTaskByDelegation 同键；classic 'in' 行与 peer-draft 承接行同覆盖）。
 * S4 review Minor#1 裁定（S7 落地）：同节点自委派时 'out' 镜像行与 worker
 * 承接行共享 delegation_id——反查必须限定 delegation_role 消除任意取行：
 * expect='worker' 取 'in'（classic 承接）优先、次选 role NULL（peer-draft
 * 承接行无戳）；expect='origin' 取 'out'（发起方镜像）。无匹配角色行 → null。
 * P2 worker-runner 接线（delegation-ports 产品）复用 'worker' 变体——
 * 一义一名，反查语义单源。
 */
export function findTaskByDelegationId(delegationId: string, expect: 'worker' | 'origin'): TaskRow | null {
  const rows = getDb()
    .prepare('SELECT id, delegation_role FROM tasks WHERE delegation_id = ?')
    .all(delegationId) as Array<{ id: string; delegation_role: string | null }>;
  const wanted =
    expect === 'origin'
      ? rows.find((r) => r.delegation_role === 'out')
      : rows.find((r) => r.delegation_role === 'in') ?? rows.find((r) => r.delegation_role === null);
  if (wanted === undefined) return null;
  return getTask(wanted.id);
}

/** S4 消费公共前置：载荷 taskId（hub 委派 id）→ 本机执行方的本地承接行；
 *  任务不存在 / 非 delegation-bound / 外派镜像行（'out'/路由指向远端）→ null
 *  （静默幂等——镜像行共享 delegation_id，leader 侧状态由 S5 RPC 回执驱动）。
 *  返回 delegationId 已收窄非空（settleDocked 锚定键）。 */
function resolveWorkerTask(
  payloadTaskId: unknown,
  selfNodeId: string | null,
): { task: TaskRow; delegationId: string } | null {
  if (typeof payloadTaskId !== 'string' || payloadTaskId === '') return null;
  const task = findTaskByDelegationId(payloadTaskId, 'worker');
  if (task === null) return null;
  const delegationId = task.delegationId;
  if (delegationId === null) return null;
  if (!isWorkerExecution(task, selfNodeId)) return null;
  return { task, delegationId };
}

/** 载荷 runNo 容错拾取（协议必带；异形剥除——里程碑 meta 对账展示用，不参与判定） */
function payloadRunNo(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/**
 * task.accepted 事件消费（hub/index onEvent 装配；hub 定向→本机 worker）：
 * 发起方验收通过 → 复用 completeAcceptance 写路径（run accepted + acceptance
 * 请求行 tryAnswer 答复 + 任务 completed/accepted_at 同刻落账——§5.1 不变量 6
 * 写路径收敛，不另立终态写入）+ 里程碑 kind='accepted'（meta 记 runNo 对账）+
 * 停靠出清（settleRun docked 项）。
 * 幂等：任务已终态（P1 auto_accept 降级先行收口 / 重放）→ 静默；非 submitted
 * → 静默（迟到或乱序，S7 对账兜底）。total 语义——事件处理绝不向上抛
 * （onEvent 无错误回传通道）。
 */
export async function handleTaskAccepted(
  payload: unknown,
  ports: WorkerTerminalConsumePorts,
): Promise<void> {
  try {
    if (typeof payload !== 'object' || payload === null) return;
    const p = payload as { taskId?: unknown; runNo?: unknown };
    const resolved = resolveWorkerTask(p.taskId, ports.selfNodeId());
    if (resolved === null) {
      logger.info('远端验收通过到达但无本机承接行（幂等收敛，丢弃）', {
        taskId: typeof p.taskId === 'string' ? p.taskId : undefined,
      });
      return;
    }
    const { task, delegationId } = resolved;
    if (isTerminal(task.status)) {
      logger.info('远端验收通过到达但任务已终态（幂等收敛，丢弃）', {
        taskId: task.id,
        status: task.status,
      });
      return;
    }
    if (task.status !== 'submitted') {
      logger.info('远端验收通过到达但任务非 submitted（乱序/迟到，丢弃）', {
        taskId: task.id,
        status: task.status,
      });
      return;
    }
    completeAcceptance(task.id, REMOTE_ORIGIN_BY);
    const runNo = payloadRunNo(p.runNo);
    writeSessionMilestone(task, '验收通过（发起方已确认交付，任务完成）', {
      kind: 'accepted',
      ...(runNo !== undefined ? { runNo } : {}),
    });
    ports.settleDocked(delegationId, 'accepted');
    logger.info('远端验收通过已消费（completeAcceptance 复用路径）', {
      taskId: task.id,
      delegationId,
      status: 'completed',
    });
  } catch (err) {
    logger.warn('远端验收通过消费内部异常（事件丢弃，S7 对账兜底）', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * task.rejected 事件消费（hub/index onEvent 装配；hub 定向→本机 worker）：
 * 发起方打回 → 复用 rejectTask 写路径（run rejected + reject_reason 落库 +
 * acceptance 答复 reject(reason) + 任务回 assigned；返工上限超限走其内建
 * failRun 分支）+ 里程碑 kind='rejected'（body/meta 含 reason，meta 记 runNo）+
 * 停靠出清。返工重启：任务回 assigned 后由本地 executor 正常放行（starter
 * trigger 自动 initial——本地 run 计数自治，与 hub runNo 对齐**不强制**：hub
 * runNo 仅展示对账用）；打回理由经里程碑落执行会话历史，随返工回合进 agent
 * 上下文（协议「reason 进 agent 上下文」的本地承载）。
 * 幂等与 total 语义同 handleTaskAccepted。
 */
export async function handleTaskRejected(
  payload: unknown,
  ports: WorkerTerminalConsumePorts,
): Promise<void> {
  try {
    if (typeof payload !== 'object' || payload === null) return;
    const p = payload as { taskId?: unknown; runNo?: unknown; reason?: unknown };
    if (typeof p.reason !== 'string' || p.reason.trim() === '') return; // 打回必带理由（协议契约）
    const resolved = resolveWorkerTask(p.taskId, ports.selfNodeId());
    if (resolved === null) {
      logger.info('远端打回到达但无本机承接行（幂等收敛，丢弃）', {
        taskId: typeof p.taskId === 'string' ? p.taskId : undefined,
      });
      return;
    }
    const { task, delegationId } = resolved;
    if (isTerminal(task.status)) {
      logger.info('远端打回到达但任务已终态（幂等收敛，丢弃）', {
        taskId: task.id,
        status: task.status,
      });
      return;
    }
    if (task.status !== 'submitted') {
      logger.info('远端打回到达但任务非 submitted（乱序/迟到，丢弃）', {
        taskId: task.id,
        status: task.status,
      });
      return;
    }
    const reason = p.reason.trim();
    await rejectTask(task.id, reason, REMOTE_ORIGIN_BY);
    const runNo = payloadRunNo(p.runNo);
    writeSessionMilestone(task, `任务被打回（需返工）：${reason}`, {
      kind: 'rejected',
      reason,
      ...(runNo !== undefined ? { runNo } : {}),
    });
    ports.settleDocked(delegationId, 'rejected');
    logger.info('远端打回已消费（rejectTask 复用路径，任务回 assigned 待返工）', {
      taskId: task.id,
      delegationId,
      reason,
    });
  } catch (err) {
    logger.warn('远端打回消费内部异常（事件丢弃，S7 对账兜底）', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── worker 消费远端指令（P3 S1，spec 2026-11-13 §8.2 steer 槽位 / §8.6）─────────

/** S1 消费端口（hub/index onEvent 装配）：S4 WorkerTerminalConsumePorts 的
 *  selfNodeId 结构子集——直接复用 terminalConsumePorts() 装配产物（同源防漂移） */
export interface TaskSteeredConsumePorts {
  /** 本机 nodeId（外派镜像行不消费——isWorkerExecution 判向） */
  selfNodeId(): string | null;
}

/** steer 去重窗口（ms）：同 delegation 同文指令的静默窗口 */
const STEER_DEDUPE_WINDOW_MS = 10_000;

/** 去重账：key = `${delegationId}#${sha256(message) 前 16 hex}` → 首见时刻 */
const steerDedupeSeen = new Map<string, number>();

/** 测试用：清空去重账（进程内单例跨用例残留会互串） */
export function __resetSteerDedupeForTest(): void {
  steerDedupeSeen.clear();
}

/**
 * 消息级去重：hub 的 task.steer 无幂等键（幂等语义测试明示「同 message 重发
 * 每次都发事件——消费侧自行去重」），本端以 delegation_id + message hash +
 * 10s 时间窗兜应用层重放。取舍：
 * - 内存 Map 进程内不持久——hub 事件是定向 sendTo 非队列 at-least-once 重投，
 *   重启清零不存在投递来源，可接受；
 * - 窗口内同文重复指令无信息增量（发起方真意重复会在窗口外重发），静默合理；
 * - 顺手清扫过期键（每次消费 O(n)，n=窗口内条目数，量级极小）。
 */
function isDuplicateSteer(delegationId: string, message: string): boolean {
  const key = `${delegationId}#${createHash('sha256').update(message).digest('hex').slice(0, 16)}`;
  const now = Date.now();
  for (const [k, seenAt] of steerDedupeSeen) {
    if (now - seenAt > STEER_DEDUPE_WINDOW_MS) steerDedupeSeen.delete(k);
  }
  if (steerDedupeSeen.has(key)) return true;
  steerDedupeSeen.set(key, now);
  return false;
}

/**
 * 指令注入执行会话（human-answer-inject 三步同构 + injectSteer 管线路由语义）：
 *   1) 里程碑系统消息——writeSessionMilestone 同款（sender='system'、
 *      event_type='delegation_milestone'、meta kind='steered' 含 message 摘要
 *      ≤80 字），但 streamSessionId 与派发回合共享（human-answer-inject 的
 *      回合标识同构）；行落库后经会话历史进入 agent 上下文（sender-role 映射
 *      入 user 轮——在途流结束后的下一回合/返工回合可见）
 *   2) pushSessionMessage 实时推 renderer
 *   3) routeUserChat **不带 systemKickoff**（= delegation-ports injectSteer 的
 *      路由语义，HITL 超时注入同款）：
 *      - 有在途顶层流（车道命中同一接待目标）→ steer 分流即时注入当前流——
 *        子进程 pendingSteers 在 chat loop 下一次构建 LLM 请求前消费，不打断
 *        在途 LLM 调用、不 abort、不开并行回合（Review Focus #1 不撕裂在途流）
 *      - 无在途回合/死通道 → 正常派发开新回合（injectSteer 的回退语义，
 *        即「无在途回合则直接开新回合」）
 *      ※ 经核验 RouterService 并无 kickoff 排队：routeUserChat(systemKickoff)
 *        在回合进行中会立即 executeTask 开并行 ephemeral 回合（session-lane
 *        registerLane 的 kickoff 分支仅 warn 退化为并行）；任务行级排队只在
 *        TaskExecutor（session_queued，任务行专用）。故不走无条件 systemKickoff
 *        唤醒，统一骑 steer 分流——在途/空闲两态由既有路由分支天然覆盖。
 *   唤醒目标：会话 leader 接待（human-answer-inject resolveWakeTarget 同源，
 *   执行会话 assignee 建会时已标 is_leader）；RouterService 未启动/无 leader →
 *   里程碑已落库推送，唤醒跳过 warn 不抛。
 */
function injectSteerIntoExecutionSession(task: TaskRow, message: string): void {
  const sessionId = task.executionSessionId!;
  const body = `【发起方指令】${message}`;
  const streamSessionId = randomUUID();
  const row = insertMessage({
    sessionId,
    sender: 'system',
    eventType: 'delegation_milestone',
    body,
    taskId: task.id,
    streamSessionId,
    contextJson: JSON.stringify({
      kind: 'steered',
      // 摘要 ≤80 字：truncateCodePoints 会追加省略号，预算取 79 使含 '…' 总长不超限
      message: truncateCodePoints(message, 79),
    }),
  });
  pushSessionMessage(row);

  const router = getRouterService();
  const target = getSessionMembersInfo(sessionId).find((m) => m.isLeader)?.instanceId ?? null;
  if (!router || !target) {
    logger.warn('【发起方指令】唤醒跳过（RouterService 未启动或会话无接待目标）', {
      sessionId,
      taskId: task.id,
    });
    return;
  }
  void router
    .routeUserChat({
      sessionId,
      assignmentId: target,
      body,
      streamSessionId,
      // 回合宿主标记：steer 回合归该 delegation 任务语境（车道注册同步记 taskId，
      // abort-by-lane 可锚定）；taskId 通道保持 null——ephemeral 语义不触发
      // task-driven 终态自动转换（routeUserChat 的 TaskConfig 注释同源）
      sourceTaskId: task.id,
    })
    .catch((err: unknown) => {
      logger.warn('【发起方指令】注入派发失败', {
        sessionId,
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

/**
 * task.steered 事件消费（hub/index onEvent 装配；hub 定向→本机 worker）：
 * 发起方补充指令到达 → 里程碑 kind='steered' 落执行会话 + steer 分流注入/唤醒
 * （injectSteerIntoExecutionSession 头注释——RF#1 不撕裂在途流）。
 * 幂等：无本机承接行 / 任务已终态 → 静默 logger.info；同文重发 → 10s 窗口
 * 去重（hub steer 无幂等键）。execution_session_id 空 → warn 跳过（无会话可
 * 注入）。total 语义——事件处理绝不向上抛（onEvent 无错误回传通道）。
 */
export function handleTaskSteered(payload: unknown, ports: TaskSteeredConsumePorts): void {
  try {
    if (typeof payload !== 'object' || payload === null) return;
    const p = payload as { taskId?: unknown; message?: unknown };
    if (typeof p.taskId !== 'string' || p.taskId === '') return;
    if (typeof p.message !== 'string' || p.message.trim() === '') return; // hub 侧已校验 1-4000，防御性挑字段
    const resolved = resolveWorkerTask(p.taskId, ports.selfNodeId());
    if (resolved === null) {
      logger.info('远端指令到达但无本机承接行（幂等收敛，丢弃）', { taskId: p.taskId });
      return;
    }
    const { task, delegationId } = resolved;
    if (isTerminal(task.status)) {
      logger.info('远端指令到达但任务已终态（幂等收敛，丢弃）', {
        taskId: task.id,
        status: task.status,
      });
      return;
    }
    if (task.executionSessionId === null || task.executionSessionId === '') {
      logger.warn('远端指令未注入（任务无关联执行会话）', { taskId: task.id, delegationId });
      return;
    }
    const message = p.message.trim();
    if (isDuplicateSteer(delegationId, message)) {
      logger.info('远端指令窗口内重复（去重丢弃）', { taskId: task.id, delegationId });
      return;
    }
    injectSteerIntoExecutionSession(task, message);
    logger.info('远端指令已消费（里程碑 + steer 分流注入）', { taskId: task.id, delegationId });
  } catch (err) {
    logger.warn('远端指令消费内部异常（事件丢弃，本地行为不受影响）', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── 发起方 steer 里程碑（P3 S3，spec 2026-11-13 §8.2 steer 槽位）───────────────

/**
 * 发起方侧 steer 里程碑去重账（独立于 worker 侧 steerDedupeSeen——两端语义
 * 同构但进程角色不同，测试同进程共跑不互串）：key 形状与 S1 相同
 * （`${delegationId}#${sha256(message) 前 16 hex}`），10s 窗口。
 */
const originSteerDedupeSeen = new Map<string, number>();

/** 测试用：清空发起方去重账（进程内单例跨用例残留会互串） */
export function __resetOriginSteerDedupeForTest(): void {
  originSteerDedupeSeen.clear();
}

/** S3 与 S1 同窗口（10s）——两端对称：窗口内同文重复指令无信息增量 */
const ORIGIN_STEER_DEDUPE_WINDOW_MS = STEER_DEDUPE_WINDOW_MS;

function isDuplicateOriginSteer(delegationId: string, message: string): boolean {
  const key = `${delegationId}#${createHash('sha256').update(message).digest('hex').slice(0, 16)}`;
  const now = Date.now();
  for (const [k, seenAt] of originSteerDedupeSeen) {
    if (now - seenAt > ORIGIN_STEER_DEDUPE_WINDOW_MS) originSteerDedupeSeen.delete(k);
  }
  if (originSteerDedupeSeen.has(key)) return true;
  originSteerDedupeSeen.set(key, now);
  return false;
}

/**
 * 发起方补充指令里程碑（task:steer 成功路径本地写，task/ipc.handlers 消费）：
 * 跟踪会话 = 外派行 execution_session_id（S6 建会话回填）；hub 对 steer 无回执
 * 事件给发起方，即时反馈不等事件——发送成功即落 kind='steered' 行（沿
 * writeSessionMilestone 公用底座：sender='system' + event_type=
 * 'delegation_milestone' + pushSessionMessage 实时推 renderer 蓝调卡）。
 * meta.message ≤80 字摘要（与 S1 worker 侧同构，渲染面单源）；body 携全文
 * （跟踪会话只读无 agent 消费，审计可查）。
 * 防重：delegation_id + message hash + 10s 窗口（hub task.steer 每次调用都发
 * 事件——指令非状态；里程碑去重与 worker 侧消费去重两端对称，双击/重试窗口
 * 内跟踪会话只落一行）。execution_session_id 空（跟踪会话未接通）跳过 + warn，
 * 不影响 steer 本身成功返回。
 */
export function writeOriginSteerMilestone(task: TaskRow, message: string): void {
  if (isDuplicateOriginSteer(task.delegationId ?? '', message)) {
    logger.info('发起方 steer 里程碑窗口内重复（去重跳过）', { taskId: task.id });
    return;
  }
  writeSessionMilestone(task, `已下发指令：${message}`, {
    kind: 'steered',
    message: truncateCodePoints(message, 79),
  });
}

// ── 发起方镜像消费（P2 S5，spec 2026-11-13 §8.3/§8.6）─────────────────────────

/**
 * S5 消费公共前置：载荷 taskId（hub 委派 id）→ 本机发起方的外派行。与 S4
 * resolveWorkerTask 镜像对称：期望 delegation_role='out'（dispatch-submit 委派
 * 成功即戳）；不存在 / 非 delegation-bound / 非 'out'（本机承接行 / 普通本地行）
 * → null（静默幂等——worker 侧事件不会路由到发起方，命中即异形或迟到）。
 */
function resolveOriginTask(
  payloadTaskId: unknown,
): { task: TaskRow; delegationId: string } | null {
  if (typeof payloadTaskId !== 'string' || payloadTaskId === '') return null;
  const task = findTaskByDelegationId(payloadTaskId, 'origin');
  if (task === null) return null;
  const delegationId = task.delegationId;
  if (delegationId === null) return null;
  if (task.delegationRole !== 'out') return null;
  return { task, delegationId };
}

/**
 * 外派行 → 执行节点 id（镜像行 origin_node_id 唯一来源）：dispatch-submit D5
 * 委派回执把已解析目标回写 routing（node 变体本就携带；group 变体补
 * targetNodeId）——「已派到谁」的持久单源。取不到（routing 损坏回退 local /
 * group 未回填）→ null，调用方降级跳过镜像（UNIQUE(origin_node_id, remote_id)
 * 对 NULL 不生效，双 NULL 行不幂等——宁可缺镜像不留不可判重的行）。
 * P2 S6 起导出：tracking-session 回填复用同口径（判组单源纪律）。
 */
export function outRowWorkerNodeId(task: TaskRow): string | null {
  const r = task.routing;
  if (r.mode === 'node') return r.targetNodeId;
  if (r.mode === 'group' && typeof r.targetNodeId === 'string' && r.targetNodeId !== '') {
    return r.targetNodeId;
  }
  return null;
}

/** task.intervention 载荷内层（协议 InterventionRequest 形状；逐字段形状守卫，
 *  任一必带字段异形整包丢弃不消费——presence 桥同款纪律） */
interface MirrorIntervention {
  interventionId: string;
  runNo: number;
  kind: 'tool_gate' | 'question' | 'manual_action';
  title: string;
  prompt: string;
  payload?: Record<string, unknown>;
  options?: Array<{ id: string; label: string; description?: string }>;
  deadlineAt?: number;
}

function parseMirrorIntervention(raw: unknown): MirrorIntervention | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw as {
    interventionId?: unknown;
    runNo?: unknown;
    kind?: unknown;
    title?: unknown;
    prompt?: unknown;
    payload?: unknown;
    options?: unknown;
    deadlineAt?: unknown;
  };
  if (typeof v.interventionId !== 'string' || v.interventionId === '') return null;
  if (typeof v.runNo !== 'number' || !Number.isFinite(v.runNo)) return null;
  if (v.kind !== 'tool_gate' && v.kind !== 'question' && v.kind !== 'manual_action') return null;
  if (typeof v.title !== 'string') return null;
  if (typeof v.prompt !== 'string') return null;
  if (
    v.payload !== undefined &&
    (typeof v.payload !== 'object' || v.payload === null || Array.isArray(v.payload))
  ) {
    return null;
  }
  if (v.options !== undefined) {
    if (!Array.isArray(v.options)) return null;
    for (const item of v.options) {
      if (typeof item !== 'object' || item === null) return null;
      const o = item as { id?: unknown; label?: unknown; description?: unknown };
      if (typeof o.id !== 'string' || typeof o.label !== 'string') return null;
      if (o.description !== undefined && typeof o.description !== 'string') return null;
    }
  }
  if (v.deadlineAt !== undefined && typeof v.deadlineAt !== 'number') return null;
  return {
    interventionId: v.interventionId,
    runNo: v.runNo,
    kind: v.kind,
    title: v.title,
    prompt: v.prompt,
    // 守卫已剥 null/数组，收窄到纯对象（TS 只给 object——cast 是收窄不是逃逸）
    ...(v.payload !== undefined ? { payload: v.payload as Record<string, unknown> } : {}),
    ...(v.options !== undefined
      ? {
          options: v.options as Array<{ id: string; label: string; description?: string }>,
        }
      : {}),
    ...(v.deadlineAt !== undefined ? { deadlineAt: v.deadlineAt } : {}),
  };
}

/**
 * task.submitted 载荷 deliverable（协议自由形状 Record）→ acceptance 镜像载荷：
 * summary/files/artifacts 逐字段形状校验，异形或缺席降级空值（summary='' /
 * files=[] / artifacts=[]）——不因载荷畸形拒绝状态收口（hub 账本才是权威）。
 */
function parseMirrorDeliverable(raw: unknown): {
  summary: string;
  files: string[];
  artifacts: Array<{ label: string; value: string }>;
} {
  const out = { summary: '', files: [] as string[], artifacts: [] as Array<{ label: string; value: string }> };
  if (typeof raw !== 'object' || raw === null) return out;
  const d = raw as { summary?: unknown; files?: unknown; artifacts?: unknown };
  if (typeof d.summary === 'string') out.summary = d.summary;
  if (Array.isArray(d.files) && d.files.every((f) => typeof f === 'string')) out.files = d.files;
  if (
    Array.isArray(d.artifacts) &&
    d.artifacts.every(
      (a) =>
        typeof a === 'object' && a !== null &&
        typeof (a as { label?: unknown }).label === 'string' &&
        typeof (a as { value?: unknown }).value === 'string',
    )
  ) {
    out.artifacts = d.artifacts as Array<{ label: string; value: string }>;
  }
  return out;
}

/**
 * S5 镜像消费端口（S6 Important-1 清偿，S9）：镜像行落库时经组清单解析执行节点
 * 绑定空间名 → payload_json `remote.workstation` 段（面板「来自 {节点} · {工作
 * 站}」徽标数据源）。组清单成员 boundWorkspaceName 仅 peer 组投影携带（lf 组
 * 缺席）→ 解析不到时降级 null（徽标仅节点名，既有行为）。A2（F4 lf 短路）：
 * 仅 origin='peer_draft' 行发起解析（lf 委派组清单恒无该键，免整轮 RPC 放大）。
 * 可选端口：缺席（旧接线/测试直调）→ 镜像行不带 remote 段，既有断言形状零变化。
 */
export interface OriginMirrorPorts {
  workstationOf?(targetNodeId: string, groupId?: string): Promise<string | null>;
}

/**
 * 镜像 payload 合成 remote 标记段：base 缺席且无工作站 → undefined（payloadJson
 * 保持 null 既有形状）；执行方 payload 自带 remote 键一律剥除（展示字段由发起方
 * 单点解析，不留执行方伪造面）。
 */
function withRemoteSegment(
  base: Record<string, unknown> | undefined,
  workstation: string | null,
): Record<string, unknown> | undefined {
  if (base === undefined && workstation === null) return undefined;
  const rest = { ...(base ?? {}) };
  delete rest.remote;
  return { ...rest, ...(workstation !== null ? { remote: { workstation } } : {}) };
}

/**
 * task.intervention 事件消费（hub/index onEvent 装配；hub 定向→本机发起方，
 * lf 组——peer 组不转发本事件）：worker 人工请求 → 本地镜像行
 * （UNIQUE(origin_node_id, remote_id) 幂等键——origin_node_id 取外派行
 * routing 回写的执行节点、remote_id=interventionId，两者取不到则降级跳过镜像
 * + logger.warn）。session_id 挂任务 execution_session_id（S6 跟踪会话接通前
 * 可能为空——同上跳过，S6 建会话后自然落点）。任务态不动（waiting_human 由
 * 镜像行 + 既有 kv waiting 徽标派生）。里程碑 kind='remote_intervention'，
 * 以镜像行存在性判重（行已存在则跳过——取舍：免 messages 表 meta 幂等键查重，
 * UNIQUE 行本身就是事件消费的唯一落点）。total 语义同 S3/S4。
 * S9（A4）：端口在场时先经组清单解析工作站（失败降级 null 不阻断镜像），落
 * payload remote 段；端口缺席 → 全程同步（旧测试直调形状零变化）。
 */
export async function handleTaskInterventionMirror(
  payload: unknown,
  ports?: OriginMirrorPorts,
): Promise<void> {
  try {
    if (typeof payload !== 'object' || payload === null) return;
    const p = payload as { taskId?: unknown; intervention?: unknown };
    const intervention = parseMirrorIntervention(p.intervention);
    if (intervention === null) return;
    const resolved = resolveOriginTask(p.taskId);
    if (resolved === null) {
      logger.info('远端干预到达但无本机外派行（幂等收敛，丢弃）', {
        taskId: typeof p.taskId === 'string' ? p.taskId : undefined,
        interventionId: intervention.interventionId,
      });
      return;
    }
    const { task, delegationId } = resolved;
    if (isTerminal(task.status)) {
      logger.info('远端干预到达但任务已终态（幂等收敛，丢弃）', {
        taskId: task.id,
        status: task.status,
      });
      return;
    }
    const workerNodeId = outRowWorkerNodeId(task);
    if (workerNodeId === null) {
      logger.warn('干预镜像跳过：外派行路由缺执行节点（origin_node_id 不可空——双 NULL 不幂等）', {
        taskId: task.id,
        delegationId,
      });
      return;
    }
    const sessionId = task.executionSessionId;
    if (sessionId === null || sessionId === '') {
      logger.warn('干预镜像跳过：任务无关联执行会话（S6 跟踪会话接通后自然落点）', {
        taskId: task.id,
        delegationId,
      });
      return;
    }
    if (findRemoteMirrorRequest(workerNodeId, intervention.interventionId) !== null) {
      logger.info('干预镜像行已存在（UNIQUE 幂等，跳过镜像与里程碑）', {
        taskId: task.id,
        interventionId: intervention.interventionId,
      });
      return;
    }
    // S9（A4）：工作站解析失败降级 null——不阻断镜像落库（remote 段缺席=面板降级）；
    // A2（F4 lf 短路）：boundWorkspaceName 仅 peer 组投影——非 peer_draft 行整轮
    // 组清单 RPC 恒空手而归，前置短路免 RPC 放大。A3-4：带 routing.groupId 按组
    // 精确解析（多组同名节点不盲选）
    const workstation =
      ports?.workstationOf !== undefined && task.origin === 'peer_draft'
        ? await ports
            .workstationOf(workerNodeId, task.routing.mode === 'local' ? undefined : task.routing.groupId)
            .catch(() => null)
        : null;
    const row = insertHumanRequest({
      sessionId,
      taskId: task.id,
      runId: null,
      kind: intervention.kind,
      title: intervention.title,
      prompt: intervention.prompt,
      payloadJson: (() => {
        const composed = withRemoteSegment(intervention.payload, workstation);
        return composed !== undefined ? JSON.stringify(composed) : null;
      })(),
      optionsJson:
        intervention.options !== undefined ? JSON.stringify(intervention.options) : null,
      deadlineAt: intervention.deadlineAt ?? null,
      delegationId,
      originNodeId: workerNodeId,
      remoteId: intervention.interventionId,
    });
    emitHumanChanged({ sessionId, requestId: row.id, kind: 'inserted' });
    writeSessionMilestone(task, `远端人工请求（${intervention.kind}）：${intervention.title}`, {
      kind: 'remote_intervention',
      interventionId: intervention.interventionId,
      runNo: intervention.runNo,
      delegationId,
    });
    logger.info('远端干预镜像已落库', {
      taskId: task.id,
      delegationId,
      interventionId: intervention.interventionId,
      kind: intervention.kind,
      runNo: intervention.runNo,
    });
  } catch (err) {
    logger.warn('远端干预镜像消费内部异常（事件丢弃，S7 对账兜底）', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * task.submitted 事件消费（hub/index onEvent 装配；hub 定向→本机发起方）：
 * run 懒建（spec §8.4——首个到达的就是 submitted，不伪造 running；trigger
 * 'initial'）+ current_run_id 指针 + 任务态直写 submitted（§5.1 白名单
 * delegation-sync 豁免惯例：外派行状态权威是 hub 账本，发起方任务可能仍在
 * pending/assigned，不经本地状态机链）+ 镜像 acceptance 请求行
 * （remote_id=`${delegationId}#${runNo}` 合成幂等键——事件唯一标识即
 * (委派 id, runNo)）+ 里程碑 kind='remote_submitted'（以镜像行存在性判重）。
 * 任务已终态 → 静默幂等（双通道并存期：delegation-sync done 拍→completed
 * 直写可能先收口，S8 版本门内退役旧通道）。execution_session_id / 执行节点
 * 缺失 → 状态照收口，仅跳过镜像行与里程碑（warn 兜底）。S9（A4）：端口在场
 * 时 acceptance 镜像 payload 落 remote 工作站段（缺席降级，端口缺席同步形状）。
 */
export async function handleTaskSubmittedMirror(
  payload: unknown,
  ports?: OriginMirrorPorts,
): Promise<void> {
  try {
    if (typeof payload !== 'object' || payload === null) return;
    const p = payload as { taskId?: unknown; runNo?: unknown; deliverable?: unknown };
    if (typeof p.taskId !== 'string' || p.taskId === '') return;
    if (typeof p.runNo !== 'number' || !Number.isFinite(p.runNo)) return;
    const resolved = resolveOriginTask(p.taskId);
    if (resolved === null) {
      logger.info('远端提交到达但无本机外派行（幂等收敛，丢弃）', {
        taskId: p.taskId,
        runNo: p.runNo,
      });
      return;
    }
    const { task, delegationId } = resolved;
    if (isTerminal(task.status)) {
      logger.info('远端提交到达但任务已终态（双通道并存期幂等，丢弃）', {
        taskId: task.id,
        status: task.status,
      });
      return;
    }
    const runNo = p.runNo;
    const workerNodeId = outRowWorkerNodeId(task);
    const mirrorRemoteId = `${delegationId}#${runNo}`;
    if (workerNodeId !== null && findRemoteMirrorRequest(workerNodeId, mirrorRemoteId) !== null) {
      logger.info('提交镜像行已存在（UNIQUE 幂等，跳过）', {
        taskId: task.id,
        delegationId,
        runNo,
      });
      return;
    }

    // run 懒建：无活动 run 才建（spec §8.4 首达即 submitted）。既有活动 run
    // runNo 与事件不符（返工重提的迟到锚定）时沿用活动行仅 warn——发起方 run
    // 账目的返工循环对账由 S6/S7 收口，本处不伪造 rejected 换号。
    const existing = getActiveRun(task.id);
    let runId: string;
    if (existing === null) {
      const run = insertRun({
        taskId: task.id,
        runNo,
        status: 'submitted',
        trigger: 'initial',
        executionSessionId: task.executionSessionId,
      });
      runId = run.id;
      emitRunChanged(task.id, run.id, 'submitted');
    } else {
      if (existing.runNo !== runNo) {
        logger.warn('提交镜像锚定弱化：活动 run 号与事件不符（沿用活动行，S7 对账兜底）', {
          taskId: task.id,
          activeRunNo: existing.runNo,
          eventRunNo: runNo,
        });
      }
      runId = existing.id;
    }
    updateTask(task.id, { status: 'submitted', submittedAt: Date.now(), currentRunId: runId });

    if (workerNodeId === null) {
      logger.warn('提交镜像跳过：外派行路由缺执行节点（origin_node_id 不可空——双 NULL 不幂等；状态已收口）', {
        taskId: task.id,
        delegationId,
      });
      return;
    }
    const sessionId = task.executionSessionId;
    if (sessionId === null || sessionId === '') {
      logger.warn('提交镜像跳过：任务无关联执行会话（S6 跟踪会话接通后自然落点；状态已收口）', {
        taskId: task.id,
        delegationId,
      });
      return;
    }
    const deliverable = parseMirrorDeliverable(p.deliverable);
    // S9（A4）：工作站解析失败降级 null——不阻断 acceptance 镜像落库；
    // A2（F4 lf 短路）同 intervention 消费点——非 peer_draft 行免整轮组清单 RPC；
    // A3-4：带 routing.groupId 按组精确解析
    const workstation =
      ports?.workstationOf !== undefined && task.origin === 'peer_draft'
        ? await ports
            .workstationOf(workerNodeId, task.routing.mode === 'local' ? undefined : task.routing.groupId)
            .catch(() => null)
        : null;
    const row = insertHumanRequest({
      sessionId,
      taskId: task.id,
      runId,
      kind: 'acceptance',
      // S9（A5 短 id 统一）：#T-{id} 引用形态（tasks.id 本身即短 T-<seq> 形）
      title: `#${task.id} 提交验收（run #${runNo}）`,
      payloadJson: JSON.stringify(
        withRemoteSegment(
          {
            acceptance: {
              runNo,
              summary: deliverable.summary,
              files: deliverable.files,
              artifacts: deliverable.artifacts,
            },
          },
          workstation,
        ),
      ),
      deadlineAt: Date.now() + ACCEPTANCE_DEADLINE_MS,
      timeoutPolicy: 'keep_waiting',
      delegationId,
      originNodeId: workerNodeId,
      remoteId: mirrorRemoteId,
    });
    emitHumanChanged({ sessionId, requestId: row.id, kind: 'inserted' });
    writeSessionMilestone(task, `远端已提交验收（run #${runNo}）`, {
      kind: 'remote_submitted',
      runNo,
      delegationId,
    });
    logger.info('远端提交镜像已落库（run 懒建 + acceptance 行）', {
      taskId: task.id,
      delegationId,
      runNo,
    });
  } catch (err) {
    logger.warn('远端提交镜像消费内部异常（事件丢弃，S7 对账兜底）', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
