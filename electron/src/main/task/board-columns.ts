// 与 renderer/src/ipc/board-columns.ts 镜像(controller 裁决:electron tsconfig
// rootDir=src,主进程源码跨 workspace import 会 TS6059,故整份复制)。
// 两份的同步由 tests/task/board-columns-sync.test.ts 锁死(逐导出断言)——
// 改任一份必须同 commit 改另一份。
// TaskStatus 来源差异:renderer 侧引 ./types,此处引 electron 自己的状态机单源
// (两处同为九值字面量联合,BOARD_COLUMNS 深度相等断言覆盖其值域一致性)。
import type { TaskStatus } from '../storage/tasks/state-machine';

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
  // hint 中文与 renderer STATUS_LABEL 词表一致（UX 修复：列头副标不再英文化）
  { key: 'backlog', label: '待办', statuses: ['draft', 'pending'], hint: '草稿+待分配' },
  { key: 'assigned', label: '已分配', statuses: ['assigned', 'session_queued'], hint: '已分配+排队中' },
  { key: 'active', label: '进行中', statuses: ['in_progress', 'paused'], hint: '进行中+已暂停' },
  { key: 'done', label: '已完成', statuses: ['completed'], hint: '' },
  { key: 'closed', label: '已关闭', statuses: ['failed', 'cancelled'], hint: '失败+已取消' },
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
