// renderer/src/stores/task.store.test.ts
//
// task.store 用例：
//   - selectedTaskId（P2 Task 3）：选中态从 TaskBoardView 本地 state
//     提升到 store——侧边栏（TaskSidebarPanel）写、主区（TaskBoardView）读
//   - load（v2.3 P0 修复）：全生命周期拉取——不按状态过滤 + orderBy created_at
//     + limit 500 截断终态历史（「启动即消失」bug 家族的数据层根因：
//     旧 load 只拉 draft/pending/assigned，in_progress/paused 任务进不了看板）
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTaskStore } from './task.store';
import type { TaskRow } from '../ipc/types';

const mockApi = {
  task: {
    list: vi.fn().mockResolvedValue([]),
  },
};

/** 构造完整 TaskRow fixture（momo-test-rules：断言生产消费的字段，不用占位符） */
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
    ...partial,
  };
}

describe('task.store selectedTaskId（P2 Task 3）', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    useTaskStore.setState({
      tasks: [],
      selectedTaskId: null,
      loading: false,
      error: null,
    });
    mockApi.task.list.mockClear().mockResolvedValue([]);
  });

  it('setSelectedTaskId 设置选中任务', () => {
    useTaskStore.getState().setSelectedTaskId('t-1');
    expect(useTaskStore.getState().selectedTaskId).toBe('t-1');
  });

  it('setSelectedTaskId(null) 清除选中', () => {
    useTaskStore.getState().setSelectedTaskId('t-1');
    useTaskStore.getState().setSelectedTaskId(null);
    expect(useTaskStore.getState().selectedTaskId).toBeNull();
  });

  it('reset 清空任务列表同时清除选中态', () => {
    useTaskStore.getState().setSelectedTaskId('t-1');
    useTaskStore.getState().reset();
    expect(useTaskStore.getState().selectedTaskId).toBeNull();
    expect(useTaskStore.getState().tasks).toEqual([]);
  });
});

describe('task.store load（v2.3 全生命周期拉取）', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    useTaskStore.setState({
      tasks: [],
      selectedTaskId: null,
      loading: false,
      error: null,
    });
    mockApi.task.list.mockClear().mockResolvedValue([]);
  });

  it('load 拉全生命周期任务（不按状态过滤，created_at_desc + limit 500 保留最新 500 条）', async () => {
    await useTaskStore.getState().load('ws1');
    expect(mockApi.task.list).toHaveBeenCalledWith({ workspaceId: 'ws1', orderBy: 'created_at_desc', limit: 500 });
  });

  it('load 成功后任务写入 store 且 loading 复位（含 in_progress/paused/终态）', async () => {
    const rows = [
      mkTask({ id: 'T-1', title: '执行中', status: 'in_progress' }),
      mkTask({ id: 'T-2', title: '已暂停', status: 'paused' }),
      mkTask({ id: 'T-3', title: '已完成', status: 'completed' }),
    ];
    mockApi.task.list.mockResolvedValue(rows);
    await useTaskStore.getState().load('ws1');
    expect(useTaskStore.getState().tasks).toEqual(rows);
    expect(useTaskStore.getState().loading).toBe(false);
    expect(useTaskStore.getState().error).toBeNull();
  });

  it('load 失败 → error 记录且 loading 复位（错误路径专项）', async () => {
    mockApi.task.list.mockRejectedValue(new Error('IPC 异常'));
    await useTaskStore.getState().load('ws1');
    expect(useTaskStore.getState().error).toBe('IPC 异常');
    expect(useTaskStore.getState().loading).toBe(false);
    expect(useTaskStore.getState().tasks).toEqual([]);
  });
});
