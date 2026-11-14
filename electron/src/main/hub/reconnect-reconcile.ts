// electron/src/main/hub/reconnect-reconcile.ts
//
// 任务生命周期 v2 P2 S7：断线重连对账幂等收敛（spec 2026-11-13 §8.6——
// S3/S4/S5 事件消费的断连窗口补偿；onEvent 只在 online 后触发，错过的
// interventionAnswered / intervention / submitted 无事件补偿，重连拉取兜底）。
//
//   ── worker 侧 ──
//   task.interventions {}（缺省=本节点相关全部）→ status='answered' 的记录
//   经 handleInterventionAnswered（S3 同一函数）应用答复——interventionId 即
//   本地 human_requests.id（S2 桥单点生成约定），幂等由行状态守卫（已非
//   pending 静默丢弃）。发起方角色的记录在本地无同 id 行，天然落空。
//
//   ── 发起方侧 ──
//   逐本机非终态 'out' 行调 task.interventions {taskId}（投影不带委派 id——
//   本地行枚举补上下文）：
//   - pending 且无镜像行 → handleTaskInterventionMirror（S5 同一函数）补
//     镜像 + 里程碑，幂等键 UNIQUE(origin_node_id, remote_id)
//   - answered 且本地镜像行 pending → tryAnswer 收敛行状态（**不注入不
//     唤醒**——唤醒发生在 worker 侧；发起方只更新行状态供面板收敛）
//
//   ── submitted 漏事件补收 ──
//   task.list {status:'submitted'} → 逐条 handleTaskSubmittedMirror（S5 同一
//   函数）：run 懒建 + 行态直写 + acceptance 镜像行（remote_id=
//   `${delegationId}#${runNo}` 幂等键）；镜像行已存在即整单跳过。
//
// 全程失败容忍：任一 RPC 失败 logger.warn 继续，绝不向上抛（装配点
// hub/index onStateChange(online) fire-and-forget——与 handleOnline 并列，
// 对账故障不得阻塞重连主链）。
import { logger } from '../logger';
import type { HubClient } from './client';
import { TASK_RPC, type InterventionRecord, type TaskRecord } from './protocol';
import { getDb } from '../storage/db';
import { getTask } from '../storage/tasks/repo';
import { isTerminal } from '../storage/tasks/state-machine';
import { findRemoteMirrorRequest, tryAnswer } from '../storage/tasks/human-requests-repo';
import { emitHumanChanged } from '../task/lifecycle-runs';
import {
  handleInterventionAnswered,
  handleTaskInterventionMirror,
  handleTaskSubmittedMirror,
  outRowWorkerNodeId,
} from './remote-intervene-bridge';

/** 对账依赖（唯一 mock 面：hub client；DB 面生产直连真实库——S3-S5 同款纪律） */
export interface ReconnectReconcileDeps {
  client: HubClient;
}

/** answered 记录应用（S3 同语义；answer 缺席按空对象消费——协议保证在场，防御降级） */
function applyAnsweredRecord(rec: InterventionRecord): void {
  handleInterventionAnswered({
    interventionId: rec.interventionId,
    answer: rec.answer ?? {},
    answeredBy: rec.answeredBy ?? 'hub',
  });
}

/** 发起方镜像行 answered 收敛：tryAnswer 原子门闩幂等 + human:changed 推送；不注入不唤醒 */
function convergeMirrorAnswered(rec: InterventionRecord, workerNodeId: string): void {
  const mirror = findRemoteMirrorRequest(workerNodeId, rec.interventionId);
  if (mirror === null || mirror.status !== 'pending') return;
  const res = tryAnswer(
    mirror.id,
    JSON.stringify(rec.answer ?? {}),
    `remote:${rec.answeredBy ?? 'worker'}`,
  );
  if (res.ok) {
    emitHumanChanged({ sessionId: mirror.sessionId, requestId: mirror.id, kind: 'answered' });
    logger.info('重连对账：发起方镜像行已随远端答复收敛（不注入）', {
      interventionId: rec.interventionId,
      requestId: mirror.id,
      sessionId: mirror.sessionId,
    });
  }
}

/**
 * 重连对账单点（hub/index onStateChange(online) 装配，fire-and-forget）。
 * 三个阶段各自失败容忍（warn 继续），全函数不抛。
 */
export async function reconcileOnReconnect(deps: ReconnectReconcileDeps): Promise<void> {
  // ── 阶段一：worker 侧——断线期远端代答补应用 ──
  try {
    const res = await deps.client.request<{ interventions: InterventionRecord[] }>(
      TASK_RPC.interventions,
      {},
    );
    for (const rec of res.interventions ?? []) {
      if (rec.status === 'answered') applyAnsweredRecord(rec);
    }
  } catch (err) {
    logger.warn('重连对账：task.interventions 拉取失败（下次重连再对账）', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── 阶段二：发起方侧——断线期 worker 干预补镜像 / answered 镜像行收敛 ──
  const outRows = (() => {
    try {
      return getDb()
        .prepare(
          `SELECT id, delegation_id FROM tasks
           WHERE delegation_role = 'out' AND delegation_id IS NOT NULL`,
        )
        .all() as Array<{ id: string; delegation_id: string }>;
    } catch (err) {
      logger.warn('重连对账：外派行枚举失败（跳过发起方阶段，下次重连再对账）', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  })();
  for (const row of outRows) {
    const task = getTask(row.id);
    if (task === null || isTerminal(task.status)) continue;
    let records: InterventionRecord[];
    try {
      const res = await deps.client.request<{ interventions: InterventionRecord[] }>(
        TASK_RPC.interventions,
        { taskId: row.delegation_id },
      );
      records = res.interventions ?? [];
    } catch (err) {
      logger.warn('重连对账：外派干预拉取失败（该任务跳过，下次重连再对账）', {
        taskId: row.id,
        delegationId: row.delegation_id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const workerNodeId = outRowWorkerNodeId(task);
    for (const rec of records) {
      // S7 评审 Minor：镜像应用总语义在消费函数内部，此处再包一层防
      // convergeMirrorAnswered 的 repo 调用抛错打断整行/整轮对账
      try {
        if (rec.status === 'pending') {
          handleTaskInterventionMirror({ taskId: row.delegation_id, intervention: rec });
        } else if (rec.status === 'answered' && workerNodeId !== null) {
          convergeMirrorAnswered(rec, workerNodeId);
        }
      } catch (err) {
        logger.warn('重连对账：发起方镜像应用失败（该记录跳过，下次重连再对账）', {
          taskId: row.id,
          delegationId: row.delegation_id,
          interventionId: rec.interventionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── 阶段三：submitted 漏事件补收（S5 镜像语义；幂等键同款）──
  try {
    const list = await deps.client.request<{ tasks: TaskRecord[] }>(TASK_RPC.list, {
      status: 'submitted',
    });
    for (const t of list.tasks ?? []) {
      handleTaskSubmittedMirror({ taskId: t.taskId, runNo: t.runNo ?? 1 });
    }
  } catch (err) {
    logger.warn('重连对账：task.list submitted 拉取失败（下次重连再对账）', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
