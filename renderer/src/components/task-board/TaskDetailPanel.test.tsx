// renderer/src/components/task-board/TaskDetailPanel.test.tsx
//
// P3 Task 4：进入执行会话接线
//   - 缺 executionSessionId 时不渲染跳转按钮
//   - 点击按钮 → session.store.selectSession(executionSessionId) +
//     ui.store.setActiveView('im')（顺序：先选会话再切视图）
//   - selectSession 失败时仅控制台报错（不切视图，保持简单）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// vi.hoisted：mock store 状态在 vi.mock 工厂注册前完成初始化
const { sessionState, uiState } = vi.hoisted(() => ({
  sessionState: {
    selectSession: vi.fn(),
  },
  uiState: {
    setActiveView: vi.fn(),
  },
}));

vi.mock('../../stores/session.store', () => ({
  useSessionStore: {
    getState: () => sessionState,
  },
}));
vi.mock('../../stores/ui.store', () => ({
  useUiStore: {
    getState: () => uiState,
  },
}));

import { TaskDetailPanel } from './TaskDetailPanel';

const mockApi = {
  task: {
    get: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
  },
};

function makeTask(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'task-1',
    workspaceId: 'ws-1',
    title: '示例任务',
    description: '',
    status: 'in_progress',
    priority: 5,
    sourceSessionId: null,
    sourceMessageId: null,
    creatorUserId: 'user-1',
    executionSessionId: 'sess-exec',
    assigneeAgentId: 'inst-pm',
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
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  sessionState.selectSession = vi.fn().mockResolvedValue(undefined);
  uiState.setActiveView = vi.fn();
  mockApi.task.get.mockReset();
  mockApi.task.start.mockReset().mockResolvedValue(undefined);
  mockApi.task.cancel.mockReset().mockResolvedValue(undefined);
});

describe('TaskDetailPanel 进入执行会话', () => {
  it('executionSessionId 存在时渲染跳转按钮', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({}));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    expect(await screen.findByText('进入执行会话 →')).toBeInTheDocument();
  });

  it('executionSessionId 缺失时不渲染跳转按钮', async () => {
    mockApi.task.get.mockResolvedValue(
      makeTask({ status: 'pending', executionSessionId: null }),
    );
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    // 等待详情面板渲染（标题行 #xxxx）
    expect(await screen.findByText('#task-1'.slice(0, 8))).toBeInTheDocument();
    expect(screen.queryByText('进入执行会话 →')).not.toBeInTheDocument();
  });

  it('点击按钮 → selectSession(executionSessionId) 然后 setActiveView("im")', async () => {
    const order: string[] = [];
    sessionState.selectSession = vi.fn().mockImplementation(async () => {
      order.push('selectSession');
    });
    uiState.setActiveView = vi.fn().mockImplementation(() => {
      order.push('setActiveView');
    });
    mockApi.task.get.mockResolvedValue(makeTask({ executionSessionId: 'sess-abc' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByText('进入执行会话 →'));
    await waitFor(() => expect(sessionState.selectSession).toHaveBeenCalledWith('sess-abc'));
    await waitFor(() => expect(uiState.setActiveView).toHaveBeenCalledWith('im'));
    expect(order).toEqual(['selectSession', 'setActiveView']);
  });

  it('selectSession 失败时控制台报错且不切视图', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    sessionState.selectSession = vi.fn().mockRejectedValue(new Error('会话不存在'));
    mockApi.task.get.mockResolvedValue(makeTask({ executionSessionId: 'sess-bad' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByText('进入执行会话 →'));
    await waitFor(() => expect(sessionState.selectSession).toHaveBeenCalledWith('sess-bad'));
    // 等待 catch 回调执行
    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(uiState.setActiveView).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
