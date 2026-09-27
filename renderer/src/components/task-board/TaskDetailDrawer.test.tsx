// renderer/src/components/task-board/TaskDetailDrawer.test.tsx
//
// 任务详情抽屉测试(看板重构 Task 12):
//   - 渲染:内部复用 TaskDetailPanel(props 不变)——taskId 内容出现
//   - 关闭三通道:ESC 键 / 点遮罩 / 面板内 X 按钮 → onClose 回调
// mock 边界对齐 TaskDetailPanel.test:session/ui store mock 为可调用 hook +
// getState 双形态;IPC 走 window.api mock;task.store 用真实实现。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { sessionState, uiState } = vi.hoisted(() => ({
  sessionState: {
    sessions: [],
    selectSession: vi.fn(),
  },
  uiState: {
    setActiveView: vi.fn(),
  },
}));

vi.mock('../../stores/session.store', () => ({
  useSessionStore: Object.assign(
    (sel: (s: typeof sessionState) => unknown) => sel(sessionState),
    { getState: () => sessionState },
  ),
}));
vi.mock('../../stores/ui.store', () => ({
  useUiStore: Object.assign(
    (sel: (s: typeof uiState) => unknown) => sel(uiState),
    { getState: () => uiState },
  ),
}));

import { TaskDetailDrawer } from './TaskDetailDrawer';
import type { TaskRow } from '../../ipc/types';

const mockApi = {
  task: {
    get: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
    transition: vi.fn(),
    resume: vi.fn(),
    update: vi.fn(),
  },
  agent: { listMembers: vi.fn().mockRejectedValue(new Error('no ipc in test')) },
  team: { list: vi.fn().mockRejectedValue(new Error('no ipc in test')) },
  session: { list: vi.fn().mockRejectedValue(new Error('no ipc in test')) },
};

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'task-1',
    workspaceId: 'ws-1',
    title: '抽屉示例任务',
    description: '',
    status: 'pending',
    priority: 5,
    sourceSessionId: null,
    sourceMessageId: null,
    creatorUserId: 'user-1',
    executionSessionId: null,
    assigneeAgentId: null,
    targetTeamId: null,
    targetSessionId: null,
    recurrenceParentId: null,
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
    boardPosition: null,
    archivedAt: null,
    ...overrides,
  };
}

describe('TaskDetailDrawer 详情抽屉', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    mockApi.task.get.mockReset().mockResolvedValue(makeTask());
  });

  it('渲染 taskId 对应内容(内部复用 TaskDetailPanel)', async () => {
    render(<TaskDetailDrawer taskId="task-1" onClose={() => {}} />);
    // TaskDetailPanel 异步拉取 task.get 后渲染标题
    expect(await screen.findByText('抽屉示例任务')).toBeInTheDocument();
    expect(mockApi.task.get).toHaveBeenCalledWith('task-1');
  });

  it('ESC 键 → onClose 回调', async () => {
    const onClose = vi.fn();
    render(<TaskDetailDrawer taskId="task-1" onClose={onClose} />);
    await screen.findByText('抽屉示例任务');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点击遮罩 → onClose 回调', async () => {
    const onClose = vi.fn();
    render(<TaskDetailDrawer taskId="task-1" onClose={onClose} />);
    await screen.findByText('抽屉示例任务');
    // 遮罩:role=dialog 之前的 fixed 全屏层(aria-hidden)
    fireEvent.click(screen.getByTestId('drawer-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('面板内 X 按钮 → onClose 回调(TaskDetailPanel 既有通道透传)', async () => {
    const onClose = vi.fn();
    render(<TaskDetailDrawer taskId="task-1" onClose={onClose} />);
    await screen.findByText('抽屉示例任务');
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
