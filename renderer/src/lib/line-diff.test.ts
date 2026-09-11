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
