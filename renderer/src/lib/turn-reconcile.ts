// renderer/src/lib/turn-reconcile.ts
//
// 任务回合对账（turn reconciliation spec 2026-09-28 §3.5/§3.6）renderer 侧：
//   - derivePendingWrapUp：派生徽标「待收尾」纯状态谓词（不依赖 hook 事件，
//     覆盖强停路径——F1/sweep 均不跑的盲区）
//   - buildTurnReconcileNotice：electron runtime-entry.ts 同名模板的镜像
//     （措辞逐字同步，由 turn-reconcile.test.ts 文件读取 + 正则提取锁死；
//     board-columns 双镜像 TS6059 先例——runtime-entry 全模块过重不宜直接 import）
import type { ImMessage, TaskRow } from '../ipc/types';
import type { StreamState } from '../stores/stream.store';

/** todo 未清项状态（与 electron tools/todo-types.ts TodoItem['status'] 对齐） */
export type ReconcileTodoStatus = 'pending' | 'in_progress' | 'completed';

/** 未清项状态中文标注（仅未清项 + 当前状态进入提醒列表，spec §3.2） */
const TODO_STATUS_LABEL: Record<ReconcileTodoStatus, string> = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
};

/**
 * 回合收尾核对合成条前缀（spec §3.2）。
 * 镜像自 electron/src/main/agent/runtime-entry.ts 的 TURN_RECONCILE_NOTICE_PREFIX，
 * 测试锁逐字相等。
 */
export const TURN_RECONCILE_NOTICE_PREFIX = '[系统] 回合收尾核对';

/**
 * 任务回合收尾核对合成条全文（spec §3.2 逐字，双逃生门措辞）。
 * 与 electron buildTurnReconcileNotice 双镜像：items 为空（待办全 completed 或
 * renderer 拿不到待办数据）时列表行降级为占位说明——闭合言语行为缺失单独
 * 触发是 spec §3.1 明确要求的分支。
 */
export function buildTurnReconcileNotice(
  taskId: string,
  items: Array<{ subject: string; status: ReconcileTodoStatus }>,
): string {
  const list =
    items.length > 0
      ? items.map((t) => `  - ${t.subject}（${TODO_STATUS_LABEL[t.status]}）`).join('\n')
      : '  （无未清待办——但任务尚未调用 complete_task / fail_task 关闭）';
  return (
    `${TURN_RECONCILE_NOTICE_PREFIX}（非新任务请求）：任务 ${taskId} 仍处于 in_progress，待办存在未清项：\n` +
    `${list}\n` +
    '请二选一：\n' +
    '(a) 完成剩余项，调用 todowrite 如实更新，并调用 complete_task 关闭任务；\n' +
    '(b) 确认剩余项不应/不能现在完成：调用 todowrite 如实更新状态，在终文中说明原因，\n' +
    '    任务保持 in_progress 留待用户处理。\n' +
    '严禁重复执行已完成的事项。本提醒一次性，不会再触发。'
  );
}

/**
 * 派生徽标「待收尾」谓词（spec §3.5，纯状态推导，不动任务状态机）：
 *   task in_progress && 有执行会话 && 宿主会话当前无运行回合。
 * 应用重启后 stream store 无活跃流——仅凭 in_progress 即成立（强停路径覆盖）。
 * 无 executionSessionId 的 in_progress 不判（语义边界，spec §3.5）。
 */
export function derivePendingWrapUp(
  task: Pick<TaskRow, 'status' | 'executionSessionId'>,
  sessionHasRunningTurn: boolean,
): boolean {
  return task.status === 'in_progress' && task.executionSessionId !== null && !sessionHasRunningTurn;
}

/**
 * 宿主会话是否有运行回合：会话任一消息在 stream.store 聚合状态为 streaming。
 * 会话消息未加载（从未打开）/ 应用重启 → 无活跃流 → false（待收尾成立）。
 * 参数取结构最小面（仅读 status），消费方传完整 streams Map 亦可。
 */
export function sessionHasRunningTurn(
  messages: readonly ImMessage[] | undefined,
  streams: ReadonlyMap<string, { status: StreamState['status'] }>,
): boolean {
  if (messages === undefined) return false;
  for (const m of messages) {
    if (streams.get(m.id)?.status === 'streaming') return true;
  }
  return false;
}

/**
 * 从宿主会话可见的 todo 源收集未清项（spec §3.6「一键催」占位填实）：
 * 自最新消息向旧扫描，取第一个带 todos 的流聚合，滤出非 completed 项。
 * 找不到任何 todo 源（renderer 拿不到待办数据）→ null——调用方退化为
 * 不含列表项的模板版本并在按钮 title 说明。
 */
export function collectOpenTodoItems(
  messages: readonly ImMessage[] | undefined,
  streams: ReadonlyMap<string, { todos: StreamState['todos'] }>,
): Array<{ subject: string; status: ReconcileTodoStatus }> | null {
  if (messages === undefined) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const todos = streams.get(messages[i]!.id)?.todos;
    if (todos && todos.length > 0) {
      return todos
        .filter((t) => t.status !== 'completed')
        .map((t) => ({ subject: t.subject, status: t.status }));
    }
  }
  return null;
}
