// renderer/src/components/task-board/TaskDetailPanel.test.tsx
//
// 会话任务联动 G2：双锚点入口接线（来源消息定位 + 执行会话全状态回看）。
// 定位链路语义（selectSession 顺序 / 翻页 / 降级）已移入 locate-message.test，
// 此处只锁「UI 入口 → lib 调用」接线。
// K4/K6 重写回归锁：
//   - 状态徽标中文（不裸显 draft/in_progress 枚举）+ 优先级中文
//   - 指派 agent 显示名称（useTaskEntityNames 解析，非 ID 片段）
//   - failed 任务展示 errorMessage
//   - 操作矩阵：draft 无目标无启动按钮+引导文案；draft 有目标可启动；
//     paused 可恢复（transition in_progress）；终态无任何操作按钮
//   - 启动失败显示错误条（不再静默吞 unhandled rejection）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

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

const { locateMessageMock, locateTaskExecutionMock } = vi.hoisted(() => ({
  locateMessageMock: vi.fn().mockResolvedValue('located'),
  locateTaskExecutionMock: vi.fn().mockResolvedValue('located'),
}));
vi.mock('../../lib/locate-message', () => ({
  locateMessage: locateMessageMock,
  locateTaskExecution: locateTaskExecutionMock,
}));

import { TaskDetailPanel } from './TaskDetailPanel';
import { useTaskStore } from '../../stores/task.store';
import type { HumanRequestRow, ImMessage, SessionSummary, TaskRow, TaskRunRow } from '../../ipc/types';
import type { StreamState } from '../../stores/stream.store';
import { useStreamStore } from '../../stores/stream.store';
import { TURN_RECONCILE_NOTICE_PREFIX } from '../../lib/turn-reconcile';
import { Toast, dismissToast } from '../ui/Toast';

const mockApi = {
  task: {
    get: vi.fn(),
    start: vi.fn(),
    move: vi.fn(),
    cancel: vi.fn(),
    transition: vi.fn(),
    resume: vi.fn(),
    update: vi.fn(),
    // Task 24：run 时间线 / 验收打回 / runChanged 订阅
    listRuns: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
    onTaskRunChanged: vi.fn().mockReturnValue(() => {}),
  },
  human: {
    // Task 24：未决请求聚合（list 缺省 pending）+ 变更推送
    list: vi.fn(),
    onChanged: vi.fn().mockReturnValue(() => {}),
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
  journal: {
    list: vi.fn().mockResolvedValue([]),
    revert: vi.fn(),
    rollbackFileBefore: vi.fn(),
    preview: vi.fn(),
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
    currentRunId: null,
    submittedAt: null,
    acceptedAt: null,
    delegationRole: null,
    autoAccept: false,
    groupId: null,
    pinnedAt: null,
    archivedAt: null,
    routing: { mode: 'local' }, delegationId: null, origin: 'user', parentTaskId: null,
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
  mockApi.task.move.mockReset().mockResolvedValue(makeTask({ status: 'assigned' }));
  mockApi.task.cancel.mockReset().mockResolvedValue(undefined);
  mockApi.task.transition.mockReset().mockResolvedValue(makeTask({}));
  mockApi.task.resume.mockReset().mockResolvedValue(makeTask({ status: 'in_progress' }));
  mockApi.task.update.mockReset().mockResolvedValue(undefined);
  mockApi.task.listRuns.mockReset().mockResolvedValue([]);
  mockApi.task.accept.mockReset().mockResolvedValue(undefined);
  mockApi.task.reject.mockReset().mockResolvedValue(undefined);
  mockApi.task.onTaskRunChanged.mockClear();
  mockApi.human.list.mockReset().mockResolvedValue([]);
  mockApi.human.onChanged.mockClear();
  mockApi.session.send.mockReset().mockResolvedValue({ readOnly: false });
  mockApi.session.list.mockReset().mockRejectedValue(new Error('no ipc in test'));
  mockApi.journal.list.mockReset().mockResolvedValue([]);
  useStreamStore.setState({ streams: new Map() });
  locateMessageMock.mockClear();
  locateTaskExecutionMock.mockClear();
  dismissToast(); // toast 单例复位，防跨用例串扰
});

describe('TaskDetailPanel D4 编排行只读（Oracle MUST FIX 2 UI 面）', () => {
  it('dispatch 行 in_progress/paused：暂停/恢复/取消任务按钮全部不渲染（主进程守卫防挫败层）', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'in_progress', origin: 'dispatch' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    await screen.findByText('#task-1');
    expect(screen.queryByText('暂停')).not.toBeInTheDocument();
    expect(screen.queryByText('取消任务')).not.toBeInTheDocument();
  });

  it('dispatch 行 paused：恢复按钮不渲染；用户行 paused 对照渲染恢复', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'paused', origin: 'dispatch' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    await screen.findByText('#task-1');
    expect(screen.queryByText('恢复')).not.toBeInTheDocument();
    expect(screen.queryByText('取消任务')).not.toBeInTheDocument();
  });
});

describe('TaskDetailPanel 进入执行会话（全状态 + 定位接线）', () => {
  it('executionSessionId 存在时渲染跳转按钮（含终态 completed）', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'completed' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    expect(await screen.findByText('进入执行会话 →')).toBeInTheDocument();
  });

  it('executionSessionId 缺失时不渲染跳转按钮', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'pending', executionSessionId: null }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    expect(await screen.findByText('#task-1')).toBeInTheDocument();
    expect(screen.queryByText('进入执行会话 →')).not.toBeInTheDocument();
  });

  it('点击按钮 → locateTaskExecution(taskId, executionSessionId)', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ executionSessionId: 'sess-abc' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByText('进入执行会话 →'));
    await waitFor(() =>
      expect(locateTaskExecutionMock).toHaveBeenCalledWith('task-1', 'sess-abc'),
    );
  });
});

// === 执行会话删除态（useTaskEntityNames.sessionExists 判定）===

function makeSessionSummary(id: string): SessionSummary {
  return {
    id,
    workspaceId: 'ws-1',
    title: `会话 ${id}`,
    titleAuto: false,
    kind: 'chat',
    lastMessageAt: null,
    pinnedAt: null,
    groupId: null,
    groupName: null,
    sessionType: null,
    delegationRole: null,
    readOnly: false,
    taskId: null,
    members: [],
  };
}

describe('TaskDetailPanel 执行会话已删除态', () => {
  it('会话列表不含 executionSessionId → 按钮置灰「执行会话已删除」且不触发定位', async () => {
    mockApi.session.list.mockResolvedValue([makeSessionSummary('ses-other')]);
    mockApi.task.get.mockResolvedValue(makeTask({ executionSessionId: 'sess-exec' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    const btn = await screen.findByRole('button', { name: '执行会话已删除' });
    expect(btn).toBeDisabled();
    expect(screen.queryByText('进入执行会话 →')).not.toBeInTheDocument();
    fireEvent.click(btn);
    expect(locateTaskExecutionMock).not.toHaveBeenCalled();
  });

  it('会话列表含 executionSessionId → 按钮可点并定位', async () => {
    mockApi.session.list.mockResolvedValue([makeSessionSummary('sess-exec')]);
    mockApi.task.get.mockResolvedValue(makeTask({ executionSessionId: 'sess-exec' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByText('进入执行会话 →'));
    await waitFor(() =>
      expect(locateTaskExecutionMock).toHaveBeenCalledWith('task-1', 'sess-exec'),
    );
  });
});

describe('TaskDetailPanel 变更查看分区（TaskChangesView 挂载）', () => {
  it('面板挂载即按 taskId 查账本，有账显示「N 处变更 · M 个文件」', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'in_progress' }));
    mockApi.journal.list.mockResolvedValue([
      {
        id: 'je-1',
        workspaceId: 'ws-1',
        taskId: 'task-1',
        sessionId: 'ses-1',
        streamSessionId: 'ss-1',
        toolName: 'write_file',
        path: 'src/app.ts',
        op: 'modify',
        beforeHash: 'hb',
        afterHash: 'ha',
        oldPath: null,
        createdAt: 1757000001000,
        beforeText: 'a',
        afterText: 'a\nb',
      },
    ]);
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    expect(await screen.findByTestId('task-changes-view')).toBeInTheDocument();
    expect(mockApi.journal.list).toHaveBeenCalledWith({ workspaceId: 'ws-1', taskId: 'task-1' });
    expect(screen.getByText('1 处变更 · 1 个文件')).toBeInTheDocument();
  });

  it('空账 → 分区不渲染（面板其余部分正常）', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'in_progress' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    await screen.findByText('进行中');
    expect(screen.queryByTestId('task-changes-view')).not.toBeInTheDocument();
  });
});

describe('TaskDetailPanel 来源消息入口', () => {
  it('sourceSessionId 存在 → 信息网格渲染「来源消息」行；点击 → locateMessage(来源会话, 消息 id)', async () => {
    mockApi.task.get.mockResolvedValue(
      makeTask({ sourceSessionId: 'ses-src', sourceMessageId: 'm-origin' }),
    );
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByText('来源消息定位'));
    await waitFor(() => expect(locateMessageMock).toHaveBeenCalledWith('ses-src', 'm-origin'));
  });

  it('sourceSessionId null（手建任务）→ 不渲染来源行', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ sourceSessionId: null }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    await screen.findByText('#task-1');
    expect(screen.queryByText('来源消息定位')).not.toBeInTheDocument();
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
    expect(await screen.findByText('排队中')).toBeInTheDocument();
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

  it('draft 有目标 → 启动按钮改道 move 入队（spec §4.2：不再直调 start）', async () => {
    mockApi.task.get.mockResolvedValue(
      makeTask({ status: 'draft', groupId: 'G-009', assigneeAgentId: 'inst-pm' }),
    );
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '启动' }));
    await waitFor(() =>
      expect(mockApi.task.move).toHaveBeenCalledWith('task-1', { column: 'assigned', groupId: 'G-009' }),
    );
    expect(mockApi.task.start).not.toHaveBeenCalled();
  });

  it('assigned 已在队列 → 无启动按钮（放行由 executor 管，spec §4.2）', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'assigned', assigneeAgentId: 'inst-pm' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    await screen.findByText('排队中');
    expect(screen.queryByRole('button', { name: '启动' })).not.toBeInTheDocument();
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
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'draft', executionSessionId: null }));
    mockApi.task.move.mockRejectedValue(new Error('任务已被并发调度'));
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
    expect(body).toContain('（无未清待办——但任务尚未调用 submit_task / fail_task / request_human 收尾）');
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

  describe('归档任务只读（archivedAt 非 null → 操作栏/编辑入口整体隐藏）', () => {
    it('归档的 in_progress 任务：无启动/暂停/编辑/取消按钮，显示只读标识与归档时间', async () => {
      // 归档+非终态（数据异常形态）：只读不受状态机按钮资格影响，一律隐藏
      mockApi.task.get.mockResolvedValue(
        makeTask({ status: 'in_progress', archivedAt: 1700000000000 }),
      );
      render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
      await screen.findByText('示例任务');

      expect(screen.getByText('已归档 · 只读')).toBeInTheDocument();
      expect(screen.getByText('归档时间')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '暂停' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '编辑任务' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '取消任务' })).not.toBeInTheDocument();
    });

    it('非归档任务不受影响：in_progress 仍有暂停/取消，但编辑已锁定（执行管线）', async () => {
      mockApi.task.get.mockResolvedValue(makeTask({ status: 'in_progress', archivedAt: null }));
      render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
      await screen.findByText('进行中');

      expect(screen.getByRole('button', { name: '暂停' })).toBeInTheDocument();
      // 编辑资格收敛（2026-09-30）：in_progress 进入执行管线，编辑入口隐藏
      expect(screen.queryByRole('button', { name: '编辑任务' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '取消任务' })).toBeInTheDocument();
      expect(screen.queryByText('已归档 · 只读')).not.toBeInTheDocument();
    });
  });

  describe('首帧初值：task.store 命中行防空白（2026-09-30 切视图回看板修复）', () => {
    afterEach(() => {
      // 真实 store（本文件不 mock task.store）——用例喂入的行必须清空，防串扰
      useTaskStore.setState({ tasks: [] });
    });

    it('store 已有该行 → fetch 未返回前首帧即渲染行内容（不出现「加载中...」）', () => {
      useTaskStore.setState({ tasks: [makeTask({ status: 'in_progress' })] });
      // get 永不 resolve：证明首帧内容完全来自 store 命中行，而非 IPC 返回
      mockApi.task.get.mockReturnValue(new Promise(() => {}) as ReturnType<typeof mockApi.task.get>);
      render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
      expect(screen.getByText('示例任务')).toBeInTheDocument();
      expect(screen.queryByText('加载中...')).not.toBeInTheDocument();
    });

    it('store 无该行（冷启动直开）→ 「加载中...」，fetch 返回后渲染（回退路径）', async () => {
      let resolveGet!: (t: TaskRow) => void;
      mockApi.task.get.mockReturnValue(
        new Promise<TaskRow>((res) => {
          resolveGet = res;
        }),
      );
      render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
      expect(screen.getByText('加载中...')).toBeInTheDocument();
      resolveGet(makeTask({ status: 'draft' }));
      expect(await screen.findByText('示例任务')).toBeInTheDocument();
    });
  });
});

// === 任务生命周期 v2 Task 24：run 时间线 / 未决请求聚合 / 验收操作区 ===

/** 构造 run 行（默认 run#1 initial running） */
function makeRun(overrides: Partial<TaskRunRow> & { runNo: number }): TaskRunRow {
  const now = Date.now();
  return {
    id: `run-${overrides.runNo}`,
    taskId: 'task-1',
    status: 'running',
    executionSessionId: 'sess-exec',
    trigger: 'initial',
    startedAt: now - 60_000,
    endedAt: null,
    deliverableJson: null,
    rejectReason: null,
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
    ...overrides,
  };
}

/** 构造未决请求行（默认 question pending，2 分钟前创建） */
function makeHumanRequest(overrides: Partial<HumanRequestRow> = {}): HumanRequestRow {
  const now = Date.now();
  return {
    id: 'req-1',
    taskId: 'task-1',
    runId: null,
    sessionId: 'sess-exec',
    delegationId: null,
    originNodeId: null,
    remoteId: null,
    kind: 'question',
    status: 'pending',
    title: '旧版 token 是否继续兼容？',
    prompt: '旧版 token 是否继续兼容？',
    payloadJson: null,
    optionsJson: null,
    assigneeNodeId: null,
    authorityJson: null,
    deadlineAt: null,
    timeoutPolicy: 'keep_waiting',
    lastRemindedAt: null,
    answerJson: null,
    answeredByNodeId: null,
    answeredAt: null,
    createdAt: now - 2 * 60_000,
    updatedAt: now - 2 * 60_000,
    ...overrides,
  };
}

describe('TaskDetailPanel run 时间线（Task 24，预览 #19）', () => {
  it('多 run 渲染：状态词 / 触发徽标 / rejected 显打回理由 / accepted 显交付摘要', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'in_progress' }));
    mockApi.task.listRuns.mockResolvedValue([
      makeRun({ runNo: 1, status: 'rejected', trigger: 'rework', endedAt: 2000, rejectReason: '迁移脚本缺回滚语句，补上再提交' }),
      makeRun({ runNo: 2, status: 'running', trigger: 'initial' }),
      makeRun({
        runNo: 3,
        status: 'accepted',
        endedAt: 3000,
        deliverableJson: JSON.stringify({
          summary: '评估报告 1 份 · 准确率 91.2%',
          files: ['report.md'],
          artifacts: [],
        }),
      }),
    ]);
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    expect(await screen.findByTestId('task-run-timeline')).toBeInTheDocument();
    expect(mockApi.task.listRuns).toHaveBeenCalledWith('task-1');
    // run #1 rejected：状态词 + rework 触发徽标 + 理由引用
    expect(screen.getByTestId('task-run-row-1')).toHaveTextContent('run #1 被打回');
    expect(screen.getByTestId('task-run-row-1')).toHaveTextContent('返工');
    expect(screen.getByTestId('task-run-row-1')).toHaveTextContent('迁移脚本缺回滚语句，补上再提交');
    // run #2 running：状态词 + 结束占位「至今」
    expect(screen.getByTestId('task-run-row-2')).toHaveTextContent('run #2 执行中');
    expect(screen.getByTestId('task-run-row-2')).toHaveTextContent('至今');
    // run #3 accepted：交付摘要一行（含文件数）
    expect(screen.getByTestId('task-run-row-3')).toHaveTextContent('交付：评估报告 1 份 · 准确率 91.2% · 1 文件');
  });

  it('无 run → 时间线整节不渲染', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'draft' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    await screen.findByText('#task-1');
    expect(screen.queryByTestId('task-run-timeline')).not.toBeInTheDocument();
  });

  it('runChanged 推送（本任务）→ 重拉 runs / 未决请求 / 任务行', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'in_progress' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    await screen.findByText('#task-1');
    expect(mockApi.task.listRuns).toHaveBeenCalledTimes(1);
    const cb = mockApi.task.onTaskRunChanged.mock.calls[0]![0] as (e: {
      taskId: string;
      runId: string;
      status: string;
    }) => void;
    cb({ taskId: 'task-1', runId: 'run-1', status: 'waiting_human' });
    await waitFor(() => expect(mockApi.task.listRuns).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockApi.human.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockApi.task.get).toHaveBeenCalledTimes(2));
  });

  it('runChanged 推送（他任务）→ 不刷新', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'in_progress' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    await screen.findByText('#task-1');
    const cb = mockApi.task.onTaskRunChanged.mock.calls[0]![0] as (e: {
      taskId: string;
      runId: string;
      status: string;
    }) => void;
    cb({ taskId: 'task-other', runId: 'run-x', status: 'running' });
    // 轮询间隔外无第二次拉取（get 首载 1 次 + listRuns/human 各 1 次保持不变）
    expect(mockApi.task.listRuns).toHaveBeenCalledTimes(1);
    expect(mockApi.human.list).toHaveBeenCalledTimes(1);
  });
});

describe('TaskDetailPanel 未决请求聚合（Task 24，预览 #20）', () => {
  it('pending 行渲染：计数标题 + kind 徽标 + 标题截断行 + 「到会话处理」按钮；点击跳会话', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'waiting_human' }));
    mockApi.human.list.mockResolvedValue([
      makeHumanRequest({ id: 'req-1', kind: 'tool_gate', title: '写授权：psql -f migrations/0042.sql' }),
      makeHumanRequest({ id: 'req-2', kind: 'question' }),
    ]);
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    expect(await screen.findByTestId('task-pending-requests')).toBeInTheDocument();
    expect(mockApi.human.list).toHaveBeenCalledWith({ taskId: 'task-1' });
    expect(screen.getByText('未决请求（2）')).toBeInTheDocument();
    expect(screen.getByTestId('task-pending-row-req-1')).toHaveTextContent('工具门');
    expect(screen.getByTestId('task-pending-row-req-1')).toHaveTextContent('写授权：psql -f migrations/0042.sql');
    expect(screen.getByTestId('task-pending-row-req-2')).toHaveTextContent('提问');
    // 跳转：selectSession + 切 im 视图
    fireEvent.click(within(screen.getByTestId('task-pending-row-req-2')).getByRole('button', { name: '到会话处理' }));
    await waitFor(() => expect(sessionState.selectSession).toHaveBeenCalledWith('sess-exec'));
    expect(uiState.setActiveView).toHaveBeenCalledWith('im');
  });

  it('最早超时预警：有 deadline 的行显示剩余分钟提示', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'waiting_human' }));
    mockApi.human.list.mockResolvedValue([
      makeHumanRequest({ id: 'req-d', deadlineAt: Date.now() + 3 * 60_000 }),
    ]);
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    await screen.findByTestId('task-pending-requests');
    expect(screen.getByText(/1 项等待 · 最早 3 分钟后超时预警/)).toBeInTheDocument();
  });

  it('无未决请求 → 聚合区不渲染', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'in_progress' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    await screen.findByText('#task-1');
    expect(screen.queryByTestId('task-pending-requests')).not.toBeInTheDocument();
  });
});

describe('TaskDetailPanel 验收操作区（Task 24，预览 #21）', () => {
  it('submitted → 显示验收操作区；「验收通过」→ task.accept', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'submitted' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '验收通过' }));
    await waitFor(() => expect(mockApi.task.accept).toHaveBeenCalledWith('task-1'));
  });

  it('打回流：弹 RejectReasonDialog → 空理由禁用确认 → 填理由确认 → task.reject(taskId, reason)', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'submitted' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '打回返工' }));
    // 复用 #17 弹框：空理由禁用（弹框自身契约，此处锁集成路径）
    const reason = screen.getByRole('textbox', { name: '打回理由' });
    const confirm = screen.getByRole('button', { name: '确认打回' });
    expect(confirm).toBeDisabled();
    fireEvent.change(reason, { target: { value: '未覆盖待支付库存锁定场景' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(mockApi.task.reject).toHaveBeenCalledWith('task-1', '未覆盖待支付库存锁定场景'));
    expect(screen.queryByRole('dialog', { name: '打回返工' })).not.toBeInTheDocument();
  });

  it('非 submitted（in_progress / waiting_human）→ 验收操作区不渲染', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'in_progress' }));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    await screen.findByText('进行中');
    expect(screen.queryByTestId('task-acceptance')).not.toBeInTheDocument();
  });

  it('验收失败 → 错误条可见（不静默吞）', async () => {
    mockApi.task.get.mockResolvedValue(makeTask({ status: 'submitted' }));
    mockApi.task.accept.mockRejectedValue(new Error('任务已被并发打回'));
    render(<TaskDetailPanel taskId="task-1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '验收通过' }));
    expect(await screen.findByText(/任务已被并发打回/)).toBeInTheDocument();
  });
});
