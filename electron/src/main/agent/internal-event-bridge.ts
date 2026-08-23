// electron/src/main/agent/internal-event-bridge.ts
//
// 主进程内部事件桥：runtime 子进程经 child IPC 发来的内部事件
// （dispatch / task_reply / abort_dispatch）转发给 RouterService.routeEvent。
// 这些事件是纯路由信号（不 INSERT messages——用户可见的 dispatch 展示
// 已由 message_events 的 dispatch_start/dispatch_result 承载）。
import type { InternalEventMsg } from './internal-event';
import { INTERNAL_EVENT_MSG } from './internal-event';
import { logger } from '../logger';

interface RouteTarget {
  routeEvent(
    event: { getType(): string; getContent(): Record<string, unknown>; getSender(): string | undefined; getRoomId(): string | undefined },
    ownerUserId: string,
    targetAssignmentId: string | null,
    directTargetAssignmentId?: string,
  ): Promise<void>;
}

let router: RouteTarget | null = null;

export function setBridgeRouter(svc: RouteTarget | null): void {
  router = svc;
}

/** child IPC message 分发入口（runtime-spawner 调用）。返回 true 表示已消费。 */
export function handleChildMessage(msg: unknown): boolean {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Partial<InternalEventMsg>;
  if (m.type !== INTERNAL_EVENT_MSG || typeof m.eventType !== 'string') return false;
  if (!router) {
    logger.warn('内部事件到达但 RouterService 未启动，丢弃', { eventType: m.eventType });
    return true;
  }
  // fire-and-forget：routeEvent 失败不影响 child IPC 通道；RouterService 内部已
  // try/catch，此处兜底防极端 reject 造成 unhandled rejection
  router.routeEvent(
    {
      getType: () => m.eventType as string,
      getContent: () => (m.content ?? {}) as Record<string, unknown>,
      getSender: () => m.sender,
      getRoomId: () => m.sessionId,
    },
    'owner',
    null,
  ).catch((err: unknown) => {
    logger.error('内部事件路由失败', { eventType: m.eventType, error: String(err) });
  });
  return true;
}
