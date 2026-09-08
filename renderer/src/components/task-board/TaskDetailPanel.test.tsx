// renderer/src/components/task-board/TaskDetailPanel.test.tsx
//
// P3 Task 4：进入执行会话接线（selectSession → setActiveView 顺序 + 失败不切视图）
// K4/K6 重写回归锁：
//   - 状态徽标中文（不裸显 draft/in_progress 枚举）+ 优先级中文
//   - 指派 agent 显示名称（useTaskEntityNames 解析，非 ID 片段）
//   - failed 任务展示 errorMessage
//   - 操作矩阵：draft 无目标无启动按钮+引导文案；draft 有目标可启动；
//     paused 可恢复（transition in_progress）；终态无任何操作按钮
//   - 启动失败显示错误条（不再静默吞 unhandled rejection）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// vi.hoisted：mock store 状态在 vi.mock 工厂注册前完成初始化。
// session.store / ui.store mock 为「可调用 hook（selector）+ getState」双形态——
// useTaskEntityNames 以 hook 形式订阅 sessions，跳转按钮以 getState 调 selectSession。
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

import { TaskDetailPanel } from './TaskDetailPanel';
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
  agent: {
    listMembers: vi.fn().mockRejectedValue(new Error('no ipc in test')),
  },
  team: {
    list: vi.fn().mockRejectedValue(new Error('no ipc in test')),
  },
  session: {
    list: vi.fn().mockRejectedValue(new Error('no ipc in test')),
  },
};

function makeTask(overrides: Partial<TaskRow>): TaskRow {
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
  mockApi.task.transition.mockReset().mockResolvedValue(makeTask({}));
  mockApi.task.resume.mockReset().mockResolvedValue(makeTask({ status: 'in_progress' }));
  mockApi.task.update.mockReset().mockResolvedValue(undefined);
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
    expect(await screen.findByText('#task-1')).toBeInTheDocument();
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
    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(uiState.setActiveView).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('TaskDetailPanel 人性化展示（K4）', () => {
  it('状态显示中文徽标，不裸显英文枚举', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'in_progress' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    expect(await screen.findByText('进行中')).toBeInTheDocument();
    expect(screen.queryByText('in_progress')).not.toBeInTheDocument();
  });

  it('优先级显示中文（5 → 中）', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ priority: 5 }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    expect(await screen.findByText('中')).toBeInTheDocument();
  });

  it('failed 任务展示 errorMessage', async () => {
    mockApi.task.get.mockResolvedValue(
      makeTask({ status: 'failed', errorMessage: '指派 agent 已不在工作空间' }),
    );
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    expect(await screen.findByText(/指派 agent 已不在工作空间/)).toBeInTheDocument();
  });

  it('assigned 状态显示等待调度提示', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'assigned', executionSessionId: null }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    expect(await screen.findByText('已分配')).toBeInTheDocument();
    expect(screen.getByText('等待调度放行')).toBeInTheDocument();
  });
});

describe('TaskDetailPanel 操作矩阵（K6）', () => {
  it('draft 无目标 → 无启动按钮 + 引导指派提示 + 有编辑/取消', async () => {
    mockApi.task.get.mockResolvedValue(
      makeTask({ status: 'draft', assigneeAgentId: null, executionSessionId: null }),
    );
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    expect(await screen.findByText('草稿')).toBeInTheDocument();
    expect(screen.getByText(/尚未指派委派目标/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '启动' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑任务' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消任务' })).toBeInTheDocument();
  });

  it('draft 有目标 → 显示启动按钮，点击调 task.start', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'draft' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '启动' }));
    await waitFor(() => expect(mockApi.task.start).toHaveBeenCalledWith('task-1', {}));
  });

  it('paused → 恢复按钮调 task:resume（K7-5：转 in_progress + kickoff 重注入）', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'paused' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '恢复' }));
    await waitFor(() => expect(mockApi.task.resume).toHaveBeenCalledWith('task-1'));
    expect(mockApi.task.transition).not.toHaveBeenCalled();
  });

  it('in_progress → 暂停按钮调 transition(paused)（K7-4：后端联动中断 agent 流）', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'in_progress' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '暂停' }));
    await waitFor(() => expect(mockApi.task.transition).toHaveBeenCalledWith('task-1', 'paused'));
  });

  it('in_progress → 无启动/恢复，有取消', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'in_progress' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    await screen.findByText('进行中');
    expect(screen.queryByRole('button', { name: '启动' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '恢复' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消任务' })).toBeInTheDocument();
  });

  it('终态（completed）→ 无取消/编辑按钮', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'completed' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    await screen.findByText('已完成');
    expect(screen.queryByRole('button', { name: '取消任务' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑任务' })).not.toBeInTheDocument();
  });

  it('启动失败 → 显示错误条（不静默吞异常）', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'assigned', executionSessionId: null }));
    mockApi.task.start.mockRejectedValue(new Error('任务已被并发调度'));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '启动' }));
    expect(await screen.findByText(/任务已被并发调度/)).toBeInTheDocument();
  });

  it('点击取消 → task.cancel + onClose', async () => {
    const onClose = vi.fn();
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'assigned', executionSessionId: null }));
    render(<TaskDetailPanel taskId="task-1" onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: '取消任务' }));
    await waitFor(() => expect(mockApi.task.cancel).toHaveBeenCalledWith('task-1'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
