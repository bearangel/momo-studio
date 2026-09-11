// renderer/src/lib/line-diff.ts
//
// 纯函数行级 unified diff（v2.5 Task 8）。无新依赖，手写 LCS：
//   - DP 表求最长公共子序列长度（后缀法），回溯产出 ctx/add/del 行
//   - 同一改动块内约定 del 在前、add 在后（unified diff 惯例）
//   - 空 before → 全 add（create）；空 after → 全 del（delete）
//
// 性能注记：blob 文本经主进程截断 100KB，行数级别（数千行）下
// O(n·m) 的 Int32Array DP 表（~25MB @ 2500²）在渲染进程可接受。

/** 单行 diff 类型：ctx 公共 / add 新增 / del 删除 */
export type DiffLineType = 'ctx' | 'add' | 'del';

/** 单行 diff 结果 */
export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/**
 * 行级 LCS diff：返回按文档序排列的行序列。
 * 往返保证：del+ctx 按序拼接 = before；add+ctx 按序拼接 = after。
 */
export function diffLines(before: string[], after: string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;
  // dp[i][j] = before[i..] 与 after[j..] 的 LCS 长度（后缀表，回溯方向即输出方向）
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  const at = (i: number, j: number): number => dp[i * width + j] ?? 0;

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const b = before[i];
      const a = after[j];
      dp[i * width + j] =
        b !== undefined && a !== undefined && b === a
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const rows: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const b = before[i];
    const a = after[j];
    if (b === undefined || a === undefined) break; // 不可达（循环条件已限界），防御窄化
    if (b === a) {
      rows.push({ type: 'ctx', text: b });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      // 优先消耗 before 行 → 改动块内 del 先于 add
      rows.push({ type: 'del', text: b });
      i++;
    } else {
      rows.push({ type: 'add', text: a });
      j++;
    }
  }
  while (i < n) {
    const b = before[i];
    if (b !== undefined) rows.push({ type: 'del', text: b });
    i++;
  }
  while (j < m) {
    const a = after[j];
    if (a !== undefined) rows.push({ type: 'add', text: a });
    j++;
  }
  return rows;
}
