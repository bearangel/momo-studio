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
// 桥判定（worker 视角单源，与 delegation-sync/delegation-ports 同口径）：
// tasks.delegation_id 非空 且（delegation_role='in' 或 routing node 变体
// targetNodeId=本机——peer-draft 承接行无 delegation_role，按路由判向）。
//
// 纯端口注入（momo-test-rules #5，delegation-answer.ts 同款）：DB 面生产直连
// 真实库，装配在 hub/index ensureRemoteInterveneBridge（仅主进程执行——hub/index
// 模块体虽为 runtime 子进程静态可达，装配调用点 initHub 只在主进程跑）。
import { logger } from '../logger';
import type { HubClient } from './client';
import { TASK_RPC, TASK_HITL_REQUIRED_MINOR, type InterventionKind, type InterventionRequest } from './protocol';
import { TASK_WIRE } from './delegation-wire';
import type { HumanRequestRow } from '../storage/tasks/human-requests-repo';
import type { TaskRow } from '../storage/tasks/repo';
import type { TaskRunRow } from '../storage/tasks/runs-repo';
import type { RemoteInterveneEvent } from '../task/lifecycle-runs';
import { truncateCodePoints } from '../util/redact';

/** hub delegations.ts REASON_MAX 镜像（reason 超限整包拒——deliverable 通道上限） */
const REASON_MAX = 512;
/** 超长 deliverable 降级截断的 summary 预算（JSON 转义膨胀留裕量） */
const SUMMARY_FALLBACK_CODEPOINTS = 400;

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
    if (client === null) {
      logger.warn('干预桥降级：hub 未连接，请求转本地等待（节点所有者自答）', {
        requestId: request.id,
        taskId: task.id,
      });
      return;
    }
    const payload = parsePayloadObject(request);
    const options = parseInterventionOptions(request);
    const intervention: InterventionRequest = {
      interventionId: request.id,
      runNo: ports.getActiveRun(task.id)?.runNo ?? 1,
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
        logger.warn('干预桥降级：task.intervene 失败，请求转本地等待（节点所有者自答）', {
          requestId: request.id,
          taskId: task.delegationId,
          code: err instanceof Error && 'code' in err ? String((err as { code?: unknown }).code) : undefined,
          error: err instanceof Error ? err.message : String(err),
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
