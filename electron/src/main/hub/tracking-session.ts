// electron/src/main/hub/tracking-session.ts
//
// 委派跟踪会话（P2 S6，spec 2026-11-13 §8.5 发起方跟踪面）：外派任务
// （delegation_role='out'）的执行会话——sessions 行 kind='task_execution'、
// 无成员，tasks.execution_session_id 指向。S5 里程碑/镜像行（remote_
// intervention / remote_submitted + acceptance 镜像）从此有落点（此前无会话
// 常跳过）。
//
// 创建时机三入口（幂等单源在本模块 ensureTrackingSession）：
//   1. dispatch-submit submitRoutedTask 委派成功回写 delegation_id 时（经端口注入）
//   2. delegation-sync retryDispatch 重派成功时（经端口注入——首派失败留待处理
//      的行此前无会话，重派成功与首派同构补建）
//   3. boot/hub init 对账回填（P1 矩阵遗留项：S6 之前的外派行补建）
//
// DB 面生产直连真实库（remote-intervene-bridge 同款纪律）；唯一网络边界
// （组清单取目标节点名）经 TrackingSessionPorts 注入——tests/hub 注入 fake。
import { logger } from '../logger';
import { getTask, updateTask, findActiveOutboundWithoutSession } from '../storage/tasks/repo';
import { createSession } from '../im/session-ops';
import { outRowWorkerNodeId } from './remote-intervene-bridge';
import type { TaskRow } from '../storage/tasks/repo';

/** 网络边界端口（唯一 mock 面）：组清单（目标节点名解析；不可达 → 标题降级） */
export interface TrackingSessionPorts {
  listGroups(): Promise<
    Array<{ members: Array<{ nodeId: string; name: string }> }>
  >;
}

/** 跟踪会话标题（CONTRACT #6 简化行）：`#T-<id> · → <节点名>`；节点名缺失 → 远端节点 */
export function trackingSessionTitle(taskId: string, nodeName: string | null): string {
  return `#${taskId} · → ${nodeName ?? '远端节点'}`;
}

/**
 * 确保外派任务有跟踪会话（幂等）：已有指向（execution_session_id 非空）即复用
 * 返回既有 id，不重建不改题；行缺失 / 非 'out' → null（调用方零副作用）。
 * 返回新建（或复用）的 sessionId。
 */
export async function ensureTrackingSession(
  input: { taskId: string; targetNodeId: string | null },
  ports: TrackingSessionPorts,
): Promise<string | null> {
  const task = getTask(input.taskId);
  if (task === null || task.delegationRole !== 'out') return null;
  if (task.executionSessionId !== null && task.executionSessionId !== '') {
    return task.executionSessionId; // 幂等复用（retryDispatch 不重建）
  }
  let nodeName: string | null = null;
  if (input.targetNodeId !== null) {
    try {
      const groups = await ports.listGroups();
      nodeName =
        groups.flatMap((g) => g.members).find((m) => m.nodeId === input.targetNodeId)?.name ??
        null;
    } catch {
      // hub 不可达 → 标题降级「远端节点」（会话可改名，标题非权威面）
    }
  }
  const session = createSession({
    workspaceId: task.workspaceId,
    title: trackingSessionTitle(task.id, nodeName),
    kind: 'task_execution',
  });
  updateTask(task.id, { executionSessionId: session.id });
  logger.info('跟踪会话已创建', { taskId: task.id, sessionId: session.id, targetNodeId: input.targetNodeId });
  return session.id;
}

/**
 * 装配对账回填（boot / hub init）：既有 active 外派行（已派发、非终态、无执行
 * 会话）逐行补建跟踪会话。单行失败不断链（warn 继续——回填是辅助面，行状态
 * 不受影响）。返回补建数。
 */
export async function backfillTrackingSessions(ports: TrackingSessionPorts): Promise<number> {
  const candidates: TaskRow[] = findActiveOutboundWithoutSession();
  let created = 0;
  for (const task of candidates) {
    try {
      const sid = await ensureTrackingSession(
        { taskId: task.id, targetNodeId: outRowWorkerNodeId(task) },
        ports,
      );
      if (sid !== null) created += 1;
    } catch (err) {
      logger.warn('跟踪会话回填单任务失败（继续）', {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return created;
}
