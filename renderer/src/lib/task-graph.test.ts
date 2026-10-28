// renderer/src/lib/task-graph.test.ts
//
// task-graph 分层拓扑单测（M3.3 §2.2 DAG 视图）：
//   - 空图 / 孤立点 / 链式分层 / 菱形汇聚（层号=拓扑深度）
//   - 层内输入序保持
//   - 环回退平铺（两点环 / 带孤立点的部分环——整图平铺而非只平铺环成员）
//   - 依赖指向不可见任务（被过滤）→ 边忽略进第 1 层
//   - blockedBy 未填充（旧行）→ 按无依赖处理
import { describe, it, expect } from 'vitest';
import { layerTasks } from './task-graph';
import type { TaskRow } from '../ipc/types';

function mkTask(partial: Partial<TaskRow> & Pick<TaskRow, 'id' | 'title' | 'status'>): TaskRow {
  return {
    workspaceId: 'ws1',
    description: '',
    sourceSessionId: null,
    sourceMessageId: null,
    creatorUserId: 'user-1',
    executionSessionId: null,
    assigneeAgentId: null,
    targetTeamId: null,
    targetSessionId: null,
    recurrenceParentId: null,
    priority: 0,
    scheduledAt: null,
    recurrenceRule: null,
    deadlineAt: null,
    queuePosition: null,
    runtimeInstanceId: null,
    estimatedTokens: null,
    actualTokens: null,
    toolCallsUsed: 0,
    errorMessage: null,
    sourceNodeId: null,
    createdAt: 1000,
    updatedAt: 1000,
    startedAt: null,
    completedAt: null,
    groupId: null,
    pinnedAt: null,
    archivedAt: null,
    routing: { mode: 'local' },
    delegationId: null,
    parentTaskId: null,
    ...partial,
  };
}

const ids = (rows: TaskRow[]): string[] => rows.map((t) => t.id);

describe('layerTasks 分层拓扑', () => {
  it('空图 → 空层数组，无环', () => {
    expect(layerTasks([])).toEqual({ layers: [], hasCycle: false });
  });

  it('孤立点（全部无依赖）→ 单层，保持输入序', () => {
    const tasks = [
      mkTask({ id: 'T-1', title: '甲', status: 'draft' }),
      mkTask({ id: 'T-2', title: '乙', status: 'draft' }),
    ];
    const { layers, hasCycle } = layerTasks(tasks);
    expect(hasCycle).toBe(false);
    expect(layers.map(ids)).toEqual([['T-1', 'T-2']]);
  });

  it('blockedBy 未填充（旧行/未阻塞）→ 按无依赖处理', () => {
    const tasks = [
      mkTask({ id: 'T-1', title: '甲', status: 'draft' }), // 无 blockedBy 字段
      mkTask({ id: 'T-2', title: '乙', status: 'draft', blockedBy: [] }),
    ];
    const { layers, hasCycle } = layerTasks(tasks);
    expect(hasCycle).toBe(false);
    expect(layers.map(ids)).toEqual([['T-1', 'T-2']]);
  });

  it('链 A→B→C（B 依赖 A，C 依赖 B）→ 三层左→右', () => {
    const tasks = [
      mkTask({ id: 'T-A', title: 'A', status: 'completed' }),
      mkTask({ id: 'T-B', title: 'B', status: 'draft', blockedBy: ['T-A'] }),
      mkTask({ id: 'T-C', title: 'C', status: 'draft', blockedBy: ['T-B'] }),
    ];
    const { layers, hasCycle } = layerTasks(tasks);
    expect(hasCycle).toBe(false);
    expect(layers.map(ids)).toEqual([['T-A'], ['T-B'], ['T-C']]);
  });

  it('菱形 A；B/C 依赖 A；D 依赖 B+C → 层号=拓扑深度（B/C 同层）', () => {
    const tasks = [
      mkTask({ id: 'T-A', title: 'A', status: 'in_progress' }),
      mkTask({ id: 'T-B', title: 'B', status: 'draft', blockedBy: ['T-A'] }),
      mkTask({ id: 'T-C', title: 'C', status: 'draft', blockedBy: ['T-A'] }),
      mkTask({ id: 'T-D', title: 'D', status: 'draft', blockedBy: ['T-B', 'T-C'] }),
    ];
    const { layers, hasCycle } = layerTasks(tasks);
    expect(hasCycle).toBe(false);
    expect(layers.map(ids)).toEqual([['T-A'], ['T-B', 'T-C'], ['T-D']]);
  });

  it('层内保持输入序（同层任务不因邻接遍历顺序重排）', () => {
    const tasks = [
      mkTask({ id: 'T-A', title: 'A', status: 'in_progress' }),
      mkTask({ id: 'T-C', title: 'C', status: 'draft', blockedBy: ['T-A'] }),
      mkTask({ id: 'T-B', title: 'B', status: 'draft', blockedBy: ['T-A'] }),
    ];
    const { layers } = layerTasks(tasks);
    // 第 2 层输入序是 C 在前 B 在后（非 id 字典序）
    expect(layers.map(ids)).toEqual([['T-A'], ['T-C', 'T-B']]);
  });

  it('依赖指向不可见任务（被过滤/归档）→ 边忽略，任务进第 1 层', () => {
    const tasks = [
      mkTask({ id: 'T-1', title: '甲', status: 'draft' }),
      mkTask({ id: 'T-2', title: '乙', status: 'draft', blockedBy: ['T-gone'] }), // T-gone 不在列表
    ];
    const { layers, hasCycle } = layerTasks(tasks);
    expect(hasCycle).toBe(false);
    expect(layers.map(ids)).toEqual([['T-1', 'T-2']]);
  });

  it('可见边与不可见边并存 → 只计可见边入度', () => {
    const tasks = [
      mkTask({ id: 'T-A', title: 'A', status: 'in_progress' }),
      mkTask({ id: 'T-B', title: 'B', status: 'draft', blockedBy: ['T-A', 'T-gone'] }),
    ];
    const { layers } = layerTasks(tasks);
    expect(layers.map(ids)).toEqual([['T-A'], ['T-B']]);
  });
});

describe('layerTasks 环回退平铺', () => {
  it('两点环（A↔B）→ hasCycle=true 整图平铺单层（保输入序）', () => {
    const tasks = [
      mkTask({ id: 'T-A', title: 'A', status: 'draft', blockedBy: ['T-B'] }),
      mkTask({ id: 'T-B', title: 'B', status: 'draft', blockedBy: ['T-A'] }),
    ];
    const { layers, hasCycle } = layerTasks(tasks);
    expect(hasCycle).toBe(true);
    expect(layers.map(ids)).toEqual([['T-A', 'T-B']]);
  });

  it('部分环（A↔B + 孤立 C）→ 同样整图平铺（环成员与孤立点同层，视图不丢卡）', () => {
    const tasks = [
      mkTask({ id: 'T-A', title: 'A', status: 'draft', blockedBy: ['T-B'] }),
      mkTask({ id: 'T-B', title: 'B', status: 'draft', blockedBy: ['T-A'] }),
      mkTask({ id: 'T-C', title: 'C', status: 'draft' }),
    ];
    const { layers, hasCycle } = layerTasks(tasks);
    expect(hasCycle).toBe(true);
    expect(layers.map(ids)).toEqual([['T-A', 'T-B', 'T-C']]);
  });

  it('自环（数据异常，写路径 CHECK 理论已拦）→ 环回退兜底不炸', () => {
    const tasks = [mkTask({ id: 'T-A', title: 'A', status: 'draft', blockedBy: ['T-A'] })];
    const { layers, hasCycle } = layerTasks(tasks);
    expect(hasCycle).toBe(true);
    expect(layers.map(ids)).toEqual([['T-A']]);
  });
});
