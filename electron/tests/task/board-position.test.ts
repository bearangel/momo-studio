// board_position 算法测试(看板重构 Task 3)。
// 最终形态(context 调整版):placeBetween 两参纯中值计算,重整判定剥离为 needsRebalance,
// Task 5 的 move 编排负责「先判定 → 重整 → 取新序中值」的组合。
import { describe, it, expect } from 'vitest';
import { placeBetween, rebalanceColumnPositions, needsRebalance, POSITION_GAP } from '../../src/main/task/board-position';

describe('board-position', () => {
  it('中值插入', () => {
    expect(placeBetween(1000, 2000)).toBe(1500);
  });
  it('列首/列尾', () => {
    expect(placeBetween(null, 2000)).toBe(2000 - POSITION_GAP);
    expect(placeBetween(1000, null)).toBe(1000 + POSITION_GAP);
  });
  it('空列', () => {
    expect(placeBetween(null, null)).toBe(0);
  });
  it('精度耗尽返回有限中值不抛错;needsRebalance 拥挤列 true / 健康列 false(Review Focus ⑤)', () => {
    // 挤死区间:中值仍是有限数(可能与端点重合,由调用方经 needsRebalance 走重整路径)
    const pos = placeBetween(1000, 1000 + 1e-9);
    expect(Number.isFinite(pos)).toBe(true);

    const crowded = [
      { id: 'a', boardPosition: 1000 },
      { id: 'b', boardPosition: 1000 + 1e-9 }, // a/b 挤死
      { id: 'c', boardPosition: 2000 },
    ];
    expect(needsRebalance(crowded)).toBe(true);

    const healthy = [
      { id: 'x', boardPosition: 0 },
      { id: 'y', boardPosition: POSITION_GAP },
      { id: 'z', boardPosition: POSITION_GAP * 2 },
    ];
    expect(needsRebalance(healthy)).toBe(false);

    // 重整后间距恢复 GAP 量级
    const map = rebalanceColumnPositions(crowded);
    expect(map.get('a')).toBe(0);
    expect(map.get('b')).toBe(POSITION_GAP);
    expect(map.get('c')).toBe(POSITION_GAP * 2);
  });
  it('needsRebalance 边界:相等即拥挤;乱序输入按升序判定;null 位置不参与判定', () => {
    // 相等(差=0 < MIN_SPACING)也算挤死
    expect(needsRebalance([
      { id: 'a', boardPosition: 512 },
      { id: 'b', boardPosition: 512 },
    ])).toBe(true);
    // 乱序传入:按升序排后相邻判定
    expect(needsRebalance([
      { id: 'c', boardPosition: 2048 },
      { id: 'a', boardPosition: 0 },
      { id: 'b', boardPosition: 1024 },
    ])).toBe(false);
    // null 位置(未落位任务)跳过,不构成拥挤
    expect(needsRebalance([
      { id: 'a', boardPosition: 0 },
      { id: 'n', boardPosition: null },
      { id: 'b', boardPosition: 1024 },
    ])).toBe(false);
    // 单元素 / 空列不拥挤
    expect(needsRebalance([{ id: 'a', boardPosition: 42 }])).toBe(false);
    expect(needsRebalance([])).toBe(false);
  });
});
