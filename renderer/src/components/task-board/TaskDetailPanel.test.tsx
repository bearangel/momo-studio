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
import type { ImMessage, SessionSummary, TaskRow } from '../../ipc/types';
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
    groupId: null,
    pinnedAt: null,
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
  mockApi.session.list.mockReset().mockRejectedValue(new Error('no ipc in test'));
  mockApi.journal.list.mockReset().mockResolvedValue([]);
  useStreamStore.setState({ streams: new Map() });
  locateMessageMock.mockClear();
  locateTaskExecutionMock.mockClear();
  dismissToast(); // toast 单例复位，防跨用例串扰
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
