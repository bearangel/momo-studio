// electron/tests/task/dependency-graph.test.ts
//
// M3.3 环检测矩阵（spec §2.3）：自环 / 两点环 / 三点环 / 跨 parent 链 + 无环
// 放行 + unsatisfiedDeps 未完成判定（含悬挂边口径）。纯模块零夹具——
// 图数据全为内存边数组，不触 DB（momo-test-rules：mock 收窄到无）。
import { describe, it, expect } from 'vitest';
import { detectCycle, unsatisfiedDeps, type GraphEdge } from '../../src/main/task/dependency-graph';

const e = (from: string, to: string): GraphEdge => ({ from, to });

describe('detectCycle —— 环检测矩阵（合并图 = 现有边 + 拟写新边）', () => {
  it('空图 + 无新边 → null', () => {
    expect(detectCycle([], [])).toBeNull();
  });

  it('无环 DAG（链 + 菱形）→ null；新边并入不改变判定', () => {
    // 菱形 A→B→D / A→C→D（DAG 合法形态）
    const existing = [e('A', 'B'), e('B', 'D'), e('A', 'C'), e('C', 'D')];
    expect(detectCycle(existing, [])).toBeNull();
    expect(detectCycle(existing, [e('D', 'E')])).toBeNull();
  });

  it('自环：新边 A→A → 返回 [A, A]', () => {
    const cycle = detectCycle([], [e('A', 'A')]);
    expect(cycle).toEqual(['A', 'A']);
  });

  it('两点环：新边 B→A 与现有 A→B 合并成环 → 路径首尾相接', () => {
    const cycle = detectCycle([e('A', 'B')], [e('B', 'A')]);
    expect(cycle).toEqual(['A', 'B', 'A']);
  });

  it('三点环：A→B→C 现有链 + 新边 C→A → 完整环路径', () => {
    const cycle = detectCycle([e('A', 'B'), e('B', 'C')], [e('C', 'A')]);
    expect(cycle).toEqual(['A', 'B', 'C', 'A']);
  });

  it('跨 parent 链：依赖边 + 父任务边交叉成环（spec §2.3 矩阵第 4 项）', () => {
    // A 依赖 B（依赖边）+ B 挂在 C 下（父边 child→parent）+ C 依赖 A（依赖边）
    // 合并图：A→B（dep）、B→C（parent）、C→A（dep）= 三点交叉环
    const existing = [e('A', 'B'), e('B', 'C')];
    const cycle = detectCycle(existing, [e('C', 'A')]);
    expect(cycle).toEqual(['A', 'B', 'C', 'A']);
  });

  it('纯父链环：A→B→A（两名任务互为 parent 场景）→ 拒绝', () => {
    const cycle = detectCycle([e('A', 'B')], [e('B', 'A')]);
    expect(cycle).toEqual(['A', 'B', 'A']);
  });

  it('环不经过新边（存量图已含环）→ 同样检出（防御：legacy 脏数据不因新写放行）', () => {
    const cycle = detectCycle([e('X', 'Y'), e('Y', 'X')], [e('A', 'B')]);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain('X');
  });

  it('重复边（同向多条）幂等：不误判为环', () => {
    expect(detectCycle([e('A', 'B')], [e('A', 'B')])).toBeNull();
  });

  it('长链环（5 点）→ 路径完整返回', () => {
    const existing = [e('A', 'B'), e('B', 'C'), e('C', 'D'), e('D', 'E')];
    expect(detectCycle(existing, [e('E', 'A')])).toEqual(['A', 'B', 'C', 'D', 'E', 'A']);
  });
});

describe('unsatisfiedDeps —— 未完成直接依赖判定', () => {
  const edges = [e('T-1', 'T-2'), e('T-1', 'T-3'), e('T-2', 'T-3')];

  it('依赖全部 completed → 空列表（解锁）', () => {
    const statusOf = (id: string): string | undefined =>
      ({ 'T-2': 'completed', 'T-3': 'completed' })[id];
    expect(unsatisfiedDeps('T-1', edges, statusOf)).toEqual([]);
  });

  it('依赖含未完成（draft/in_progress/failed 等八态）→ 全部列出，completed 排除', () => {
    const statusOf = (id: string): string | undefined =>
      ({ 'T-2': 'in_progress', 'T-3': 'completed' })[id];
    expect(unsatisfiedDeps('T-1', edges, statusOf)).toEqual(['T-2']);
  });

  it('failed / cancelled 依赖同样算未完成（仅 completed 解锁）', () => {
    const statusOf = (id: string): string | undefined =>
      ({ 'T-2': 'failed', 'T-3': 'cancelled' })[id];
    expect(unsatisfiedDeps('T-1', edges, statusOf)).toEqual(['T-2', 'T-3']);
  });

  it('悬挂边（依赖行不存在，statusOf → undefined）不阻塞——与 SQL NOT EXISTS 口径一致', () => {
    const statusOf = (id: string): string | undefined =>
      id === 'T-2' ? 'draft' : undefined;
    expect(unsatisfiedDeps('T-1', edges, statusOf)).toEqual(['T-2']);
  });

  it('只算 from === taskId 的直接边；他任务的边不参与', () => {
    const statusOf = (): string | undefined => 'in_progress';
    // T-2 的边（T-2→T-3）不属于 T-1 的直接依赖
    expect(unsatisfiedDeps('T-1', edges, statusOf)).toEqual(['T-2', 'T-3']);
    expect(unsatisfiedDeps('T-2', edges, statusOf)).toEqual(['T-3']);
  });

  it('无依赖边 → 空列表', () => {
    expect(unsatisfiedDeps('T-9', edges, () => 'in_progress')).toEqual([]);
  });
});
