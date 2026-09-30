// 看板列契约单源(spec §3.3/§4)。
// 注意这是 value module(非 .d.ts)——electron 侧不 import 本文件(自有镜像
// electron/src/main/task/board-columns.ts,同步由 tests/task/board-columns-sync.test.ts 锁死);
// BoardColumnKey 联合类型的真源在 types.d.ts(见该文件头注),此处 re-export 保住
// 既有消费方导入路径,并用编译期断言把常量值域与联合锁死。
import type { TaskStatus, BoardColumnKey } from './types';

export type { TaskStatus, BoardColumnKey };

export const BOARD_COLUMN_KEYS = ['backlog', 'assigned', 'active', 'done', 'closed'] as const;

// 编译期双向锁:BOARD_COLUMN_KEYS 常量值域与 types.d.ts 手写联合完全一致,
// 任一侧增删列另一侧未同步,此处立即编译错误(防契约漂移)
type _KeysMatchUnion = [BoardColumnKey] extends [(typeof BOARD_COLUMN_KEYS)[number]]
  ? [(typeof BOARD_COLUMN_KEYS)[number]] extends [BoardColumnKey]
    ? true
    : never
  : never;
const _keysLock: _KeysMatchUnion = true;
void _keysLock;

export interface BoardColumnDef {
  key: BoardColumnKey;
  label: string;
  /** 该列合并的底层状态(spec §1 D2) */
  statuses: TaskStatus[];
  /** 列头灰字副标 */
  hint: string;
}

export const BOARD_COLUMNS: readonly BoardColumnDef[] = [
  // hint 中文与 lib/task-status STATUS_LABEL 词表一致（UX 修复：列头副标不再英文化）
  { key: 'backlog', label: '待办', statuses: ['draft', 'pending'], hint: '草稿' },
  { key: 'assigned', label: '排队中', statuses: ['assigned', 'session_queued'], hint: '等并发/等计划时间/等车道' },
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
