// electron/src/main/agent/internal-event.ts
//
// 子进程 → 主进程的内部事件协议（2.0.0 P1：取代 Matrix 自定义 event 传输）。
// runtime-entry 不再持有 Matrix client：dispatch / task_reply / abort_dispatch
// 经 child IPC 发给主进程，由 internal-event-bridge 路由到 RouterService。
// 消息体复用 dispatch.ts 的 content 构造器（buildDispatchMessage 等），零转换成本。

import {
  DISPATCH_EVENT_TYPE,
  TASK_REPLY_EVENT_TYPE,
  ABORT_DISPATCH_EVENT_TYPE,
  TASK_REPLY_ACK_EVENT_TYPE,
} from './dispatch';

export const INTERNAL_EVENT_MSG = 'momo-internal-event';

/** child → main 的内部事件信封 */
export interface InternalEventMsg {
  type: typeof INTERNAL_EVENT_MSG;
  eventType: string;
  /** 目标会话（原 Matrix roomId） */
  sessionId: string;
  /** 发送者（assignmentId 或 'owner'） */
  sender: string;
  content: Record<string, unknown>;
}

/**
 * child→main IPC 通道发送权判定：仅 runtime-spawner fork 的真实子进程持有
 * （spawnForAgent 注入 MOMO_RUNTIME_CHILD=1 哨兵）。宿主进程的 process.send
 * 属他者协议（如 vitest forks worker 的 tinypool IPC），一律禁发——
 * 2026-10-20 forks 池污染实证（"Unexpected call to process.send()"）。
 */
export function hasChildIpcChannel(): boolean {
  return process.env.MOMO_RUNTIME_CHILD === '1' && typeof process.send === 'function';
}

export function sendInternalEvent(evt: Omit<InternalEventMsg, 'type'>): void {
  if (!hasChildIpcChannel()) return;
  process.send?.({ type: INTERNAL_EVENT_MSG, ...evt });
}

// 便捷构造器：runtime-entry 现有调用点一一对应替换
export function sendDispatchEvent(sessionId: string, from: string, content: Record<string, unknown>): void {
  sendInternalEvent({ eventType: DISPATCH_EVENT_TYPE, sessionId, sender: from, content });
}
export function sendTaskReplyEvent(sessionId: string, from: string, content: Record<string, unknown>): void {
  sendInternalEvent({ eventType: TASK_REPLY_EVENT_TYPE, sessionId, sender: from, content });
}
export function sendAbortDispatchEvent(sessionId: string, from: string, content: Record<string, unknown>): void {
  sendInternalEvent({ eventType: ABORT_DISPATCH_EVENT_TYPE, sessionId, sender: from, content });
}
export function sendTaskReplyAckEvent(sessionId: string, from: string, content: Record<string, unknown>): void {
  sendInternalEvent({ eventType: TASK_REPLY_ACK_EVENT_TYPE, sessionId, sender: from, content });
}
