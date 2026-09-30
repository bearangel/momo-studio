// renderer/src/components/task-board/usePendingWrapUp.ts
//
// 派生徽标「待收尾」订阅 hook（turn reconciliation spec §3.5）：
//   - 会话消息行引用变化（receiveMessage / 历史加载）触发重算
//   - stream.store 选择器返回布尔——流式事件批次到达时 Map 引用虽变，
//     但布尔不变即不重渲染（看板 N 张卡不被 50ms 批次抖醒）
//   - task 为 null（TaskDetailPanel 加载中早退前）→ 恒 false
import { useSessionStore } from '../../stores/session.store';
import { useStreamStore } from '../../stores/stream.store';
import { derivePendingWrapUp, sessionHasRunningTurn } from '../../lib/turn-reconcile';
import type { TaskRow } from '../../ipc/types';

export function usePendingWrapUp(
  task: Pick<TaskRow, 'status' | 'executionSessionId'> | null,
): boolean {
  const sessionId = task !== null ? task.executionSessionId : null;
  const messages = useSessionStore((s) =>
    sessionId !== null ? s.messagesBySession.get(sessionId) : undefined,
  );
  const hasRunningTurn = useStreamStore((s) => sessionHasRunningTurn(messages, s.streams));
  return task !== null && derivePendingWrapUp(task, hasRunningTurn);
}
