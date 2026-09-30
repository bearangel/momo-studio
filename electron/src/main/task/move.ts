// electron/src/main/task/move.ts
//
// task.move 编排(看板重构 spec §3.2/§4 语义表)——换列语义动作单点映射 + 换组。
// renderer 拖拽只发目标(column/groupId),不定动作:动作裁决全部收敛在此
// (momo-boundary-rules:契约不漂移的关键)。
//
// 语义表(与 renderer board-columns 的 canDropIntoColumn 列级投影对齐,此处为权威):
//   - 同列同组 = no-op(2026-09-30 排序退役:列内顺序由 pinned/创建时间决定,
//     拖拽不再携带落点锚点,boardPosition 链随迁移 050 删除)
//   - 同列跨组 = 纯换泳道(不动状态;含 paused——controller 修订:断点续跑是
//     重副作用,只走卡片/抽屉按钮(task:resume),不被拖拽手势误触发)
//   - →assigned:draft 须有委派目标;pending 手动放行(均 transition + notify)
//   - →active:assigned/session_queued 走 startTaskAndKickoff
//   - →done:in_progress → completed(+completedAt)+ 循环续期 + notify
//   - →closed:任意非终态走 cancelTask(确认框在 renderer,主进程不二次确认)
//   - →backlog 一律拒(只出不进);终态跨列一律拒
//
// 校验次序纪律:所有纯读校验(存在性/可投性/换组合法性)先于任何写动作——
// 拒绝时零副作用,绝不留「先转了态才发现组非法」的半套写(错误路径铁律)。
import {
  getTask,
  transitionTaskStatus,
  updateTask,
  type TaskRow,
  type TaskStatus,
} from '../storage/tasks/repo';
import { getGroup } from '../storage/task-groups/repo';
import { hasDelegationTarget } from './starter';
import { notifyExecutor } from './executor';
import { spawnNextInstanceIfRecurring } from './recurrence';
import { startTaskAndKickoff, cancelTask } from './lifecycle';
import { columnOf, canDropIntoColumn, type BoardColumnKey } from './board-columns';

export interface MoveTarget {
  column: BoardColumnKey;
  groupId: string | null;
}

export async function executeMove(id: string, target: MoveTarget): Promise<TaskRow> {
  // 预检①:存在性 + 归档(getTask 单点;lifecycle 三函数不再各自预检,Task 4 review 约定)。
  // 归档卡即使同列换组也拒——恢复归任务归档域,不经 move
  const task = getTask(id);
  if (!task) throw new Error(`task ${id} 不存在`);
  if (task.archivedAt != null) throw new Error('任务已归档,请先恢复');

  const fromCol = columnOf(task.status);
  const sameColumn = fromCol === target.column;
  const sameGroup = task.groupId === target.groupId;

  // 同列同组:no-op(排序退役后无落点语义,直接返回当前行)
  if (sameColumn && sameGroup) return task;

  // 预检②:跨列可投性(语义表列级投影;拒绝消息带原因)
  if (!sameColumn && !canDropIntoColumn(task.status, target.column)) {
    throw new Error(dropRejectReason(task.status, target.column));
  }

  // 预检③:换组合法性(目标组存在 + 同 workspace + 未归档)——先于写动作
  if (target.groupId !== task.groupId && target.groupId !== null) {
    const g = getGroup(target.groupId);
    if (!g || g.workspaceId !== task.workspaceId) {
      throw new Error(`目标分组不存在: ${target.groupId}`);
    }
    if (g.archivedAt != null) throw new Error('目标分组已归档,请先取消归档');
  }

  // ① 换列语义动作(spec §4 逐格裁决表为权威;同列不进此分支——
  // 含 paused:resume 无拖拽入口,断点续跑只走 task:resume 按钮)
  if (!sameColumn) {
    switch (target.column) {
      case 'assigned': {
        // draft 无委派目标 → 手动放行只会建出无人接待的空会话(与 starter K2 同语义)
        if (task.status === 'draft' && !hasDelegationTarget(task)) {
          throw new Error('任务未设置委派目标,请先编辑任务指派 agent/团队/会话');
        }
        transitionTaskStatus(id, 'assigned');
        notifyExecutor();
        break;
      }
      case 'active': {
        await startTaskAndKickoff(id); // assigned / session_queued
        break;
      }
      case 'done': {
        transitionTaskStatus(id, 'completed', { completedAt: Date.now() });
        spawnNextInstanceIfRecurring(id); // 循环续期(与 agent complete_task 同语义)
        notifyExecutor();
        break;
      }
      case 'closed': {
        await cancelTask(id);
        break;
      }
      case 'backlog':
        break; // 预检②已拒,不可达;占位保 switch 穷尽
    }
  }

  // ② 写入:换组(同列跨组只改 groupId,列内位置由 pinned/创建时间排序决定)
  updateTask(id, { groupId: target.groupId });
  return getTask(id)!;
}

function dropRejectReason(from: TaskStatus, to: BoardColumnKey): string {
  if (to === 'backlog') return `任务不能移回待办列(状态机不允许 ${from} → draft/pending)`;
  if (from === 'completed' || from === 'failed' || from === 'cancelled') {
    return `终态任务(${from})不可再变更`;
  }
  return `状态机不允许 ${from} → ${to}`;
}
