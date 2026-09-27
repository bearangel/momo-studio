// 看板列契约单源(spec §3.3/§4):renderer 与 electron 主进程(move 校验)共同 import。
// 注意这是 value module(非 .d.ts)——主进程经相对路径引用,与 preload 引 types.d.ts 同款。
import type { TaskStatus } from './types';

export type { TaskStatus };

export const BOARD_COLUMN_KEYS = ['backlog', 'assigned', 'active', 'done', 'closed'] as const;
export type BoardColumnKey = (typeof BOARD_COLUMN_KEYS)[number];

export interface BoardColumnDef {
  key: BoardColumnKey;
  label: string;
  /** 该列合并的底层状态(spec §1 D2) */
  statuses: TaskStatus[];
  /** 列头灰字副标 */
  hint: string;
}

export const BOARD_COLUMNS: readonly BoardColumnDef[] = [
  { key: 'backlog', label: '待办', statuses: ['draft', 'pending'], hint: 'draft+pending' },
  { key: 'assigned', label: '已分配', statuses: ['assigned', 'session_queued'], hint: 'assigned+queued' },
  { key: 'active', label: '进行中', statuses: ['in_progress', 'paused'], hint: 'in_progress+paused' },
  { key: 'done', label: '已完成', statuses: ['completed'], hint: '' },
  { key: 'closed', label: '已关闭', statuses: ['failed', 'cancelled'], hint: 'failed+cancelled' },
];

export function columnOf(status: TaskStatus): BoardColumnKey {
  for (const col of BOARD_COLUMNS) if (col.statuses.includes(status)) return col.key;
  throw new Error(`未知任务状态: ${status}`);
}

/** UI 禁投预判(spec §4 语义表的列级投影);主进程 move 仍是权威裁决 */
export function canDropIntoColumn(from: TaskStatus, to: BoardColumnKey): boolean {
  if (columnOf(from) === to) return true; // 同列(排序/换泳道)恒可
  return allowCross(from, to);
}

function allowCross(from: TaskStatus, to: BoardColumnKey): boolean {
  switch (to) {
    case 'backlog': return false; // 只出不进(draft/pending 已在 backlog,跨列进来的一律禁)
    case 'assigned': return from === 'draft' || from === 'pending';
    // paused 不在此列:paused 本属 active 列,canDropIntoColumn 同列早退恒先命中,
    // 此处列出 paused 分支永不可达(Task 5 review 死代码清理)
    case 'active': return from === 'assigned' || from === 'session_queued';
    case 'done': return from === 'in_progress';
    case 'closed': return from !== 'completed'; // completed→closed 同为关闭语义但无转换意义,禁
  }
}
