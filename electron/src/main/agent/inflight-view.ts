// electron/src/main/agent/inflight-view.ts
//
// dispatch:listInFlight 数据面（P2-D Task D1，spec 2026-10-13 §9）：
// registry 在途链 → IPC 视图（InFlightChainView）+ 子 agent 展示名主进程解析。
//
// 名映射与 session-tools.ts buildNameMaps 同源同法（Ruling-13）：数据源统一走
// agent-queries 的 listMembers(workspaceId)（JOIN agent_definitions 带出
// agentName），不造第二套映射。subAssignmentId 即 workspace_agent_members.
// instance_id（runners key / routeDispatch 的 dispatch_to，v2 Task 10），经
// 会话 → workspace 反查成员行取 agentName；成员已删 / 会话缺失 / DB 异常 →
// null（不抛错——在途面板不因成员表异常白屏，UI 降级短 taskId 由 D2 处理）。
import { dispatchRegistry } from './dispatch-registry';
import { listMembers } from './agent-queries';
import { getSession } from '../storage/sessions/repo';
import { logger } from '../logger';
import type { InFlightChainView } from '../../../../renderer/src/ipc/types';

/**
 * 某会话的 instanceId → agentName 映射（session-tools buildNameMaps 的
 * byInstanceId 同款：listMembers JOIN 单一数据源；DB 不可用 → 空映射降级，
 * 名字走 null 兜底，绝不阻塞在途视图）。cache 供单次调用内同会话多链复用。
 */
function nameMapForSession(
  sessionId: string,
  cache: Map<string, Map<string, string>>,
): Map<string, string> {
  const cached = cache.get(sessionId);
  if (cached) return cached;
  let map = new Map<string, string>();
  try {
    const workspaceId = getSession(sessionId)?.workspaceId ?? null;
    if (workspaceId !== null) {
      for (const m of listMembers(workspaceId)) map.set(m.instanceId, m.agentName);
    }
  } catch (err) {
    logger.warn('listInFlight 子 agent 名解析失败，降级 null', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    map = new Map<string, string>();
  }
  cache.set(sessionId, map);
  return map;
}

/** 在途链视图（ipc/index.ts deps.listInFlight 真实现）：只含 in_flight，可选按会话过滤 */
export function listInFlightViews(sessionId?: string): InFlightChainView[] {
  const nameMaps = new Map<string, Map<string, string>>();
  return dispatchRegistry.listInFlight(sessionId).map((chain) => {
    const names = nameMapForSession(chain.sessionId, nameMaps);
    return {
      taskId: chain.taskId,
      round: chain.round,
      sessionId: chain.sessionId,
      pmAssignmentId: chain.pmAssignmentId,
      subAssignmentId: chain.subAssignmentId,
      ...(chain.subStreamSessionId !== undefined ? { subStreamSessionId: chain.subStreamSessionId } : {}),
      ...(chain.pmStreamSessionId !== undefined ? { pmStreamSessionId: chain.pmStreamSessionId } : {}),
      startedAt: chain.startedAt,
      subAgentName: names.get(chain.subAssignmentId) ?? null,
    };
  });
}
