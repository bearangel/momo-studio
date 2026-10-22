// renderer/src/lib/session-type.ts
//
// 会话类型判定（spec 2026-10-22 §3.1）：kind 优先 → sessionType → 成员数兜底（旧库防御）。
// RoomList 用它选行内类型图标（Zap/Users/ListTodo）。
import type { SessionSummary } from '../ipc/types';

export type SessionType = 'quick' | 'collab' | 'task_execution';

export function deriveSessionType(
  s: Pick<SessionSummary, 'kind' | 'sessionType' | 'members'>,
): SessionType {
  if (s.kind === 'task_execution') return 'task_execution';
  if (s.sessionType) return s.sessionType;
  return s.members.length > 1 ? 'collab' : 'quick';
}
