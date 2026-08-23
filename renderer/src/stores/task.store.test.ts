// renderer/src/stores/task.store.test.ts
//
// task.store selectedTaskId 用例（P2 Task 3）：选中态从 TaskBoardView 本地 state
// 提升到 store——侧边栏（TaskSidebarPanel）写、主区（TaskBoardView）读。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTaskStore } from './task.store';

const mockApi = {
  task: {
    list: vi.fn().mockResolvedValue([]),
  },
};

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
