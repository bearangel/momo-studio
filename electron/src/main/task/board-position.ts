// board_position 计算与重整(spec §2):浮点中值 + 精度耗尽整列重写。
// 职责切分(context 调整版):placeBetween 是纯函数(无副作用、无列参数);
// 「是否重整」由 needsRebalance 独立判定,Task 5 的 move 编排负责组合
// (先 placeBetween 取值;needsRebalance 为真时 rebalanceColumnPositions + 全列落库 + 本任务取新序中值)。
export const POSITION_GAP = 1024;
/** 相邻位置差低于此值视为挤死(含相等);此时浮点中值已无可用精度,须整列重整 */
const MIN_SPACING = 1e-6;

/**
 * 纯中值计算:取 prev 与 next 之间的落位值。
 * - 双 null(空列)→ 0
 * - prev null(列首)→ next - POSITION_GAP
 * - next null(列尾)→ prev + POSITION_GAP
 * - 否则 (prev + next) / 2(即使相邻已挤死也返回有限中值,不抛错;
 *   挤死场景由调用方经 needsRebalance 走重整路径覆盖)
 */
export function placeBetween(prev: number | null, next: number | null): number {
  if (prev == null) {
    // 列首:next - GAP;双 null(空列)特例为 0
    return next == null ? 0 : next - POSITION_GAP;
  }
  if (next == null) return prev + POSITION_GAP; // 列尾
  return (prev + next) / 2; // 中值(相邻挤死时仍返回有限值,不抛错)
}

/** 列内任务的最小形状:主键 + 当前看板位置(null = 尚未落位) */
export interface BoardPositionTask {
  id: string;
  boardPosition: number | null;
}

/**
 * 判定列是否需要重整:按 boardPosition 升序排列后,
 * 任意相邻「有值对」差 < MIN_SPACING(含相等)即 true。
 * null 位置(未落位)不参与判定。
 */
export function needsRebalance(column: BoardPositionTask[]): boolean {
  const positions = column
    .map((t) => t.boardPosition)
    .filter((p): p is number => p != null)
    .sort((a, b) => a - b);
  let prev: number | null = null;
  for (const p of positions) {
    if (prev != null && p - prev < MIN_SPACING) return true;
    prev = p;
  }
  return false;
}

/** 按传入顺序(调用方先 sortColumn)等距重写,i*GAP */
export function rebalanceColumnPositions(tasks: BoardPositionTask[]): Map<string, number> {
  const map = new Map<string, number>();
  tasks.forEach((t, i) => map.set(t.id, i * POSITION_GAP));
  return map;
}
