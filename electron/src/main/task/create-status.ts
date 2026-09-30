// electron/src/main/task/create-status.ts
//
// K1 落态决策单源（spec 2026-09-30 §4.1，取代旧「创建即调度」决策表）：
//   form（表单路径：看板新建 / 会话内创建按钮 / InlineTaskSuggestion）
//     → 一律 draft——创建/编辑是纯数据操作，「启动」是唯一入队动作
//     （拖拽到排队中 / 详情面板启动按钮，均走 executeMove 单点）
//   agent（create_task 工具，用户在会话中已授权）
//     → 有目标 assigned（建即入队；scheduledAt 为未来时间时由 executor
//       闸门等到点，spec §3.2），无目标 undefined（repo insertTask 默认 draft）
// pending 不再产出（迁移 051 退役）。
import type { TaskStatus } from '../storage/tasks/state-machine';

export function resolveCreateStatus(
  input: { hasDelegationTarget: boolean; scheduledAt: number | null },
  source: 'form' | 'agent',
): TaskStatus | undefined {
  if (source === 'form') return 'draft';
  return input.hasDelegationTarget ? 'assigned' : undefined;
}
