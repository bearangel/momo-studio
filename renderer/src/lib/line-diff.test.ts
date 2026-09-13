// renderer/src/lib/line-diff.test.ts
//
// diffLines 纯函数行级 diff 测试（v2.5 Task 8）：
//   - 全改：无公共行 → 先 del 全部旧行，再 add 全部新行（unified 顺序约定）
//   - 部分改：公共行保留 ctx，改动行按 del→add 相邻输出
//   - 新增行：before 是 after 的子序列 → 仅 add，无 del
//   - 删除行：after 是 before 的子序列 → 仅 del，无 add
//   - 空输入：双侧空 → []；before 空 → 全 add；after 空 → 全 del
//   - 大小/顺序保真：输出行拼接后 del+ctx 恢复 before、add+ctx 恢复 after（往返锁）
import { describe, it, expect } from 'vitest';
import { diffLines } from './line-diff';

describe('diffLines — 全改', () => {
  it('无公共行：先全部 del 再全部 add', () => {
    const rows = diffLines(['a', 'b'], ['x', 'y']);
    expect(rows).toEqual([
      { type: 'del', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'x' },
      { type: 'add', text: 'y' },
    ]);
  });
});

describe('diffLines — 部分改', () => {
  it('公共行 ctx 保留，改动块内 del 在前 add 在后', () => {
    const rows = diffLines(['a', 'b', 'c'], ['a', 'x', 'c']);
    expect(rows).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'x' },
      { type: 'ctx', text: 'c' },
    ]);
  });

  it('多处分散改动各自成块', () => {
    const rows = diffLines(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'D']);
    expect(rows).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'ctx', text: 'c' },
      { type: 'del', text: 'd' },
      { type: 'add', text: 'D' },
    ]);
  });
});

describe('diffLines — 新增行', () => {
  it('before 是 after 子序列：仅 add 无 del', () => {
    const rows = diffLines(['a', 'c'], ['a', 'b', 'c']);
    expect(rows).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'add', text: 'b' },
      { type: 'ctx', text: 'c' },
    ]);
  });
});

describe('diffLines — 删除行', () => {
  it('after 是 before 子序列：仅 del 无 add', () => {
    const rows = diffLines(['a', 'b', 'c'], ['a', 'c']);
    expect(rows).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'ctx', text: 'c' },
    ]);
  });
});

describe('diffLines — 空输入', () => {
  it('双侧皆空 → 空数组', () => {
    expect(diffLines([], [])).toEqual([]);
  });

  it('before 空_after 非空 → 全 add（create 场景）', () => {
    expect(diffLines([], ['x', 'y'])).toEqual([
      { type: 'add', text: 'x' },
      { type: 'add', text: 'y' },
    ]);
  });

  it('after 空_before 非空 → 全 del（delete 场景）', () => {
    expect(diffLines(['x', 'y'], [])).toEqual([
      { type: 'del', text: 'x' },
      { type: 'del', text: 'y' },
    ]);
  });
});

describe('diffLines — 往返锁（顺序保真）', () => {
  it('del+ctx 按序拼接恢复 before；add+ctx 按序拼接恢复 after', () => {
    const before = ['line1', 'line2', 'line3', 'line4', 'line5'];
    const after = ['line1', 'line2-mod', 'line3', 'inserted', 'line5'];
    const rows = diffLines(before, after);
    expect(rows.filter((r) => r.type !== 'add').map((r) => r.text)).toEqual(before);
    expect(rows.filter((r) => r.type !== 'del').map((r) => r.text)).toEqual(after);
  });

  it('重复行的 LCS 对齐（相同行多处出现时取一致匹配）', () => {
    const rows = diffLines(['x', 'sep', 'x'], ['sep', 'x']);
    expect(rows).toEqual([
      { type: 'del', text: 'x' },
      { type: 'ctx', text: 'sep' },
      { type: 'ctx', text: 'x' },
    ]);
  });
});

describe('diffLines — 大输入降级（审查 C3：O(n·m) DP 内存/时间尖峰防御）', () => {
  it('n*m 超阈值（3000×2000=6M > 4M）→ 整文件替换视图（单 hunk 全删 + 全增，零 ctx），往返锁仍成立', () => {
    // 前 1000 行公共（真实 LCS 会产 1000 ctx）——降级必须放弃对齐产出零 ctx，
    // 用公共行让「降级与否」可观测（无公共行时两种路径输出恰好同形）
    const before = Array.from({ length: 3000 }, (_, i) => `b-${i}`);
    const after = [...before.slice(0, 1000), ...Array.from({ length: 1000 }, (_, i) => `a-${i}`)];
    const rows = diffLines(before, after);
    // 单 hunk：前 3000 全 del + 后 2000 全增，无任何 ctx
    expect(rows).toHaveLength(5000);
    expect(rows.filter((r) => r.type === 'ctx')).toHaveLength(0);
    expect(rows.slice(0, 3000).every((r) => r.type === 'del')).toBe(true);
    expect(rows.slice(3000).every((r) => r.type === 'add')).toBe(true);
    // 降级路径的往返不变量与正常路径一致
    expect(rows.filter((r) => r.type !== 'add').map((r) => r.text)).toEqual(before);
    expect(rows.filter((r) => r.type !== 'del').map((r) => r.text)).toEqual(after);
  });

  it('n*m 恰好等于阈值（2000×2000=4M）→ 正常 LCS 不降级', () => {
    const before = Array.from({ length: 2000 }, (_, i) => `b-${i}`);
    const after = [...before];
    after[1999] = 'changed';
    const rows = diffLines(before, after);
    // 正常路径：1999 ctx + 1 del + 1 add
    expect(rows).toHaveLength(2001);
    expect(rows.filter((r) => r.type === 'ctx')).toHaveLength(1999);
    expect(rows.filter((r) => r.type === 'del').map((r) => r.text)).toEqual(['b-1999']);
    expect(rows.filter((r) => r.type === 'add').map((r) => r.text)).toEqual(['changed']);
  });

  it('降级边界含空侧：n*m 超限但一侧为空 → 语义与既有空输入路径一致（全 del / 全 add）', () => {
    // before 5000 行 × after 0 行 = 0 ≤ 阈值——走正常空侧路径，非降级；此处锁降级判断不误伤空侧
    const before = Array.from({ length: 5000 }, (_, i) => `b-${i}`);
    expect(diffLines(before, []).every((r) => r.type === 'del')).toBe(true);
  });
});
