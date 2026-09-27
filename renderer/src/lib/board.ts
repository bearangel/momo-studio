// renderer/src/lib/board.ts
// 看板列组装纯函数（看板重构 Task 9）：排序 / 泳道切分 / 过滤 / 组色映射。
// 全部无副作用——调用方先 sortColumn 再按列 filter，列分组是渲染层 BoardColumn 的职责。
import type { GroupRow, TaskRow, TaskStatus } from '../ipc/types';

/**
 * 终态集合（看板 done/closed 两列合并的底层状态；与 electron state-machine
 * TERMINAL 集合同步）——归档等终态限定入口（spec §5.2 终态卡片右键归档）的判定单源。
 */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled'];

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * boardPosition 升序排序，NULL 垫底（spec §3 NULLS-LAST）。
 * NULL 之间按 createdAt 升序兜底；返回新数组，不修改输入。
 */
export function sortColumn(tasks: TaskRow[]): TaskRow[] {
  return [...tasks].sort((a, b) => {
    const pa = a.boardPosition;
    const pb = b.boardPosition;
    if (pa !== null && pb !== null) return pa - pb;
    if (pa !== null) return -1; // 有值在前
    if (pb !== null) return 1; // NULL 垫底
    return a.createdAt - b.createdAt; // 双 NULL：createdAt 升序
  });
}

/** 泳道（BoardLane）：一个组（或未分组）+ 其归属任务 */
export interface BoardLane {
  /** 组行；null=未分组道 / 平铺单道 */
  group: GroupRow | null;
  /** 组内任务（保持输入序——列内序由调用方的 sortColumn 决定） */
  tasks: TaskRow[];
}

/**
 * 按组切分泳道。
 * - lanes：活跃组按 position 升序各成道（空组保留），未分组（groupId=null）垫底为 group:null 道；
 *   归属未知组 id 的任务也归入未分组道（防御：组刚被删但任务行还带旧 id）。
 * - flat：单道全量（group:null），保持输入序。
 * 只按组切分，不排序不滤列。
 */
export function splitLanes(
  tasks: TaskRow[],
  groups: GroupRow[],
  mode: 'lanes' | 'flat',
): BoardLane[] {
  if (mode === 'flat') return [{ group: null, tasks }];

  const ordered = [...groups].sort((a, b) => a.position - b.position);
  const byGroup = new Map<string | null, TaskRow[]>();
  for (const t of tasks) {
    const key = t.groupId !== null && ordered.some((g) => g.id === t.groupId) ? t.groupId : null;
    const bucket = byGroup.get(key);
    if (bucket) bucket.push(t);
    else byGroup.set(key, [t]);
  }
  const lanes: BoardLane[] = ordered.map((g) => ({
    group: g,
    tasks: byGroup.get(g.id) ?? [],
  }));
  const ungrouped = byGroup.get(null);
  if (ungrouped && ungrouped.length > 0) lanes.push({ group: null, tasks: ungrouped });
  return lanes;
}

/** 看板过滤条件：文本 AND 指派人（字段空值表示该维度不过滤） */
export interface BoardTaskFilter {
  /** 不区分大小写包含 title 或 description；空串不过滤 */
  text: string;
  /** 匹配 assigneeAgentId；null 不过滤 */
  assigneeId: string | null;
}

/**
 * 看板任务过滤：text 命中 title/description（不区分大小写包含）AND assigneeId 匹配。
 */
export function filterBoardTasks(tasks: TaskRow[], filter: BoardTaskFilter): TaskRow[] {
  const needle = filter.text.trim().toLowerCase();
  return tasks.filter((t) => {
    if (filter.assigneeId !== null && t.assigneeAgentId !== filter.assigneeId) return false;
    if (needle === '') return true;
    return t.title.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle);
  });
}

/** 语义色名 → inline style 颜色串（token 单源，spec §5）；未知名返回 null 由调用方回退 */
const GROUP_COLOR_VARS: Record<string, string> = {
  accent: 'rgb(var(--accent-500))',
  success: 'rgb(var(--status-success))',
  warning: 'rgb(var(--status-warning))',
  error: 'rgb(var(--status-error))',
  violet: 'rgb(var(--status-violet))',
};

/**
 * 组色语义名映射为 CSS 颜色串。
 * null 或未知名 → null（调用方自定回退，如中性色）。
 */
export function groupColorStyle(color: string | null): string | null {
  if (color === null) return null;
  return GROUP_COLOR_VARS[color] ?? null;
}
