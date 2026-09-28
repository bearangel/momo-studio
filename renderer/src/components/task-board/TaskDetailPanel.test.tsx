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
// useTaskEntityNames 以 hook 形式订阅 sessions，跳转按钮以 getState 调 selectSession，
// 派生「待收尾」hook 以 selector 读 messagesBySession。
// stream.store 不 mock——真实实现（zustand），用例按需 setState 流聚合。
const { sessionState, uiState } = vi.hoisted(() => ({
  sessionState: {
    sessions: [],
    selectSession: vi.fn(),
    messagesBySession: new Map(),
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
import type { ImMessage, TaskRow } from '../../ipc/types';
import type { StreamState } from '../../stores/stream.store';
import { useStreamStore } from '../../stores/stream.store';
import { TURN_RECONCILE_NOTICE_PREFIX } from '../../lib/turn-reconcile';
import { Toast, dismissToast } from '../ui/Toast';

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
    send: vi.fn(),
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
    groupId: null,
    boardPosition: null,
    archivedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  sessionState.selectSession = vi.fn().mockResolvedValue(undefined);
  sessionState.messagesBySession = new Map();
  uiState.setActiveView = vi.fn();
  mockApi.task.get.mockReset();
  mockApi.task.start.mockReset().mockResolvedValue(undefined);
  mockApi.task.cancel.mockReset().mockResolvedValue(undefined);
  mockApi.task.transition.mockReset().mockResolvedValue(makeTask({}));
  mockApi.task.resume.mockReset().mockResolvedValue(makeTask({ status: 'in_progress' }));
  mockApi.task.update.mockReset().mockResolvedValue(undefined);
  mockApi.session.send.mockReset().mockResolvedValue({ readOnly: false });
  useStreamStore.setState({ streams: new Map() });
  dismissToast(); // toast 单例复位，防跨用例串扰
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

// === 派生徽标「待收尾」+ 一键催（turn reconciliation spec §3.5/§3.6）===
// session.store 为 mock（messagesBySession 可控）；stream.store 为真实实现。

const hostMsg = (id: string): ImMessage => ({
  id,
  sessionId: 'sess-exec',
  sender: '@bot:x',
  body: '',
  eventType: 'm.room.message',
  streamSessionId: null,
  parentStreamSessionId: null,
  segmentOf: null,
  segmentIndex: null,
  status: 'done',
  source: 'local',
  workspaceId: null,
  taskId: null,
  contextJson: null,
  createdAt: 0,
  updatedAt: 0,
});

const hostStream = (overrides: Partial<StreamState>): StreamState => ({
  thinking: '',
  text: '',
  toolCalls: [],
  todos: [],
  dispatches: [],
  status: 'done',
  events: [],
  segments: [],
  messageId: 'm-exec',
  startedAt: 0,
  ...overrides,
});

describe('TaskDetailPanel 待收尾徽标与催收尾按钮（spec §3.5/§3.6）', () => {
  it('in_progress + 宿主会话无运行回合 → 徽标与「催收尾」按钮并列出现', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'in_progress' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    expect(await screen.findByText('待收尾')).toBeInTheDocument();
    expect(screen.getByText('进行中')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '催收尾' })).toBeInTheDocument();
  });

  it('会话正在流式输出 → 徽标与按钮均不显示', async () => {
    sessionState.messagesBySession = new Map([['sess-exec', [hostMsg('m-exec')]]]);
    useStreamStore.setState({
      streams: new Map([['m-exec', hostStream({ status: 'streaming' })]]),
    });
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'in_progress' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    await screen.findByText('进行中');
    expect(screen.queryByText('待收尾')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '催收尾' })).not.toBeInTheDocument();
  });

  it('completed（终态）→ 徽标与按钮均不显示', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'completed' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    await screen.findByText('已完成');
    expect(screen.queryByText('待收尾')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '催收尾' })).not.toBeInTheDocument();
  });

  it('无 executionSessionId 的 in_progress → 徽标与按钮均不显示', async () => {
    mockApi.task.get.mockResolvedValue(
      makeTask({ status: 'in_progress', executionSessionId: null }),
    );
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    await screen.findByText('进行中');
    expect(screen.queryByText('待收尾')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '催收尾' })).not.toBeInTheDocument();
  });

  it('点击催收尾 → session.send 发送含任务 id 与模板前缀的镜像文本（todo 源可见时含未清项）', async () => {
    sessionState.messagesBySession = new Map([
      ['sess-exec', [hostMsg('m-old'), hostMsg('m-exec')]],
    ]);
    useStreamStore.setState({
      streams: new Map([
        [
          'm-exec',
          hostStream({
            todos: [
              { id: 't1', subject: '修复登录', status: 'in_progress' },
              { id: 't2', subject: '已做完的', status: 'completed' },
            ],
          }),
        ],
      ]),
    });
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'in_progress' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '催收尾' }));
    await waitFor(() => expect(mockApi.session.send).toHaveBeenCalledTimes(1));
    const [sessionId, body] = mockApi.session.send.mock.calls[0]!;
    expect(sessionId).toBe('sess-exec');
    expect(body.startsWith(`${TURN_RECONCILE_NOTICE_PREFIX}（非新任务请求）：任务 task-1 `)).toBe(
      true,
    );
    expect(body).toContain('  - 修复登录（进行中）');
    expect(body).not.toContain('已做完的');
    expect(body).toContain('本提醒一次性，不会再触发。');
  });

  it('拿不到待办数据 → 退化为不含列表项的占位版本（错误路径）', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'in_progress' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '催收尾' }));
    await waitFor(() => expect(mockApi.session.send).toHaveBeenCalledTimes(1));
    const [, body] = mockApi.session.send.mock.calls[0]!;
    expect(body).toContain('（无未清待办——但任务尚未调用 complete_task / fail_task 关闭）');
  });

  it('发送失败 → toast 显示错误（不静默吞异常）', async () => {
    mockApi.session.send.mockRejectedValue(new Error('会话已只读'));
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'in_progress' }));
    render(
      <>
        <TaskDetailPanel taskId="task-1" onClose={() => {}} />
        <Toast />
      </>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '催收尾' }));
    expect(await screen.findByTestId('ui-toast')).toHaveTextContent('催收尾发送失败: 会话已只读');
  });
});
