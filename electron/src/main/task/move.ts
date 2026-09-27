// electron/src/main/task/move.ts
//
// task.move 编排(看板重构 spec §3.2/§4 语义表)——换列语义动作单点映射 +
// 落点计算 + 换组校验。renderer 拖拽只发落点(column/groupId/before/after),
// 不定动作:动作裁决全部收敛在此(momo-boundary-rules:契约不漂移的关键)。
//
// 语义表(与 renderer board-columns 的 canDropIntoColumn 列级投影对齐,此处为权威):
//   - 同列 = 纯排序 / 换泳道(不动状态;含 paused——controller 修订:同列拖动
//     一律纯排序,断点续跑是重副作用,只走卡片/抽屉按钮(task:resume),不被排序手势误触发)
//   - →assigned:draft 须有委派目标;pending 手动放行(均 transition + notify)
//   - →active:assigned/session_queued 走 startTaskAndKickoff
//   - →done:in_progress → completed(+completedAt)+ 循环续期 + notify
//   - →closed:任意非终态走 cancelTask(确认框在 renderer,主进程不二次确认)
//   - →backlog 一律拒(只出不进);终态跨列一律拒
//
// 校验次序纪律:所有纯读校验(存在性/可投性/换组合法性)先于任何写动作——
// 拒绝时零副作用,绝不留「先转了态才发现组非法」的半套写(错误路径铁律)。
import { getDb } from '../storage/db';
import {
  getTask,
  listTasks,
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
import { placeBetween, needsRebalance, rebalanceColumnPositions } from './board-position';

export interface MoveTarget {
  column: BoardColumnKey;
  groupId: string | null;
  /**
   * 落点下方位可见邻居(值大锚——移动卡落在其上方)。
   * computeDropPosition 映射为 nextPos;锚点方向以 move.test.ts 锚点用例为权威
   * (Task 12 review:原注释「上方位邻居」与实现颠倒,已订正对齐 renderer 契约)。
   */
  beforeTaskId?: string;
  /** 落点上方位可见邻居(值小锚——移动卡落在其下方);computeDropPosition 映射为 prevPos */
  afterTaskId?: string;
}

export async function executeMove(id: string, target: MoveTarget): Promise<TaskRow> {
  // 预检①:存在性 + 归档(getTask 单点;lifecycle 三函数不再各自预检,Task 4 review 约定)。
  // 归档卡即使同列纯排序也拒——恢复归任务归档域,不经 move
  const task = getTask(id);
  if (!task) throw new Error(`task ${id} 不存在`);
  if (task.archivedAt != null) throw new Error('任务已归档,请先恢复');

  const fromCol = columnOf(task.status);
  const sameColumn = fromCol === target.column;

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

  // ② 落点计算:目标列(目标组)内任务,按 boardPosition 升序 + createdAt 兜底排。
  // 移动任务自身排除在外——它正被重新落位,旧位置不应参与邻居/挤死判定
  const columnTasks = listTasks({
    workspaceId: task.workspaceId,
    groupId: target.groupId,
    archived: 'exclude',
  }).filter((t) => t.id !== id && columnOf(t.status) === target.column);
  columnTasks.sort(cmpColumn);

  let drop = computeDropPosition(columnTasks, target);
  // Task 3 review minor:中值与邻居浮点重合(如 2^53 量级下 (prev+next)/2 取整
  // 撞回邻居)也并入重整触发——「相等」即无可用精度,与挤死同处理
  const collapsedWithNeighbor =
    (drop.prevPos != null && drop.position === drop.prevPos) ||
    (drop.nextPos != null && drop.position === drop.nextPos);

  // ③ 写入:重整(挤死/重合)时整列重写 i*GAP 后取新序中值;重整 + 落点同事务
  if (needsRebalance(columnTasks) || collapsedWithNeighbor) {
    getDb().transaction(() => {
      const map = rebalanceColumnPositions(columnTasks);
      for (const [tid, p] of map) updateTask(tid, { boardPosition: p });
      const remapped = columnTasks.map((t) => ({
        ...t,
        boardPosition: map.get(t.id) ?? t.boardPosition,
      }));
      drop = computeDropPosition(remapped, target);
      updateTask(id, { groupId: target.groupId, boardPosition: drop.position });
    })();
  } else {
    updateTask(id, { groupId: target.groupId, boardPosition: drop.position });
  }
  return getTask(id)!;
}

/** 列内排序:boardPosition 升序,NULL 视为 +∞(未入板排尾),同值按创建先后 */
function cmpColumn(a: TaskRow, b: TaskRow): number {
  const pa = a.boardPosition ?? Number.MAX_SAFE_INTEGER;
  const pb = b.boardPosition ?? Number.MAX_SAFE_INTEGER;
  return pa !== pb ? pa - pb : a.createdAt - b.createdAt;
}

interface DropAnchor {
  position: number;
  /** 上方位邻居(值更小侧 = afterTaskId 锚)的位置;无锚点/锚点不在列内为 null */
  prevPos: number | null;
  /** 下方位邻居(值更大侧 = beforeTaskId 锚)的位置 */
  nextPos: number | null;
}

function computeDropPosition(column: TaskRow[], target: MoveTarget): DropAnchor {
  const idxBefore = target.beforeTaskId ? column.findIndex((t) => t.id === target.beforeTaskId) : -1;
  const idxAfter = target.afterTaskId ? column.findIndex((t) => t.id === target.afterTaskId) : -1;
  const prevPos = idxAfter >= 0 ? column[idxAfter]!.boardPosition : null; // after=下方位邻居 → 值更小
  const nextPos = idxBefore >= 0 ? column[idxBefore]!.boardPosition : null;
  return { position: placeBetween(prevPos, nextPos), prevPos, nextPos };
}

function dropRejectReason(from: TaskStatus, to: BoardColumnKey): string {
  if (to === 'backlog') return `任务不能移回待办列(状态机不允许 ${from} → draft/pending)`;
  if (from === 'completed' || from === 'failed' || from === 'cancelled') {
    return `终态任务(${from})不可再变更`;
  }
  return `状态机不允许 ${from} → ${to}`;
}
