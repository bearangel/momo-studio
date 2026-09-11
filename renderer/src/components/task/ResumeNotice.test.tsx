// renderer/src/components/task/ResumeNotice.test.tsx
//
// ResumeNotice 启动恢复卡测试（v2.6.0 Task 6，spec §6）：
//   - boot 现查 listInterrupted；空列表 / 拉取失败 → 不渲染（瞬态卡，无 kv）
//   - 逐任务行：标题 + agent 名 + 「半程变更 M 处」（journalCount=0 → 「无文件变更」）
//   - [恢复] → task.resume(taskId) → 该行消散（其余行保留）
//   - [放弃] → 展开内联二选一（直接放弃 / 撤回变更后放弃）
//   - [直接放弃] → task.transition(id, 'cancelled') → 行消散
//   - [撤回变更后放弃] → task.get 取 workspaceId → journal.list({workspaceId, taskId})
//     取全部条目 ids → journal.revert(workspaceId, ids, {}) → 行内撤回结果摘要
//     （撤回 x 处 / 跳过 y 处）→ transition('cancelled') → 行消散
//   - 账本为空（list 返回 []）→ 跳过 revert 直接 transition（空输入分支）
//   - 全部决策完 → 卡片消散
//   - 错误路径：resume reject → 行保留 + 错误提示可见
// mock 形态照抄 SandboxNotice.test.tsx（window.api 桩 + ipc Proxy 透传）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ResumeNotice } from './ResumeNotice';
import type {
  InterruptedTaskInfo,
  JournalEntryView,
  RevertOutcome,
  TaskRow,
} from '../../ipc/types';

const listInterruptedMock = vi.fn();
const resumeMock = vi.fn();
const transitionMock = vi.fn();
const getTaskMock = vi.fn();
const journalListMock = vi.fn();
const journalRevertMock = vi.fn();

// 桩 window.api（task + journal 命名空间；组件经 ipc Proxy 透传消费）
const mockApi = {
  task: {
    listInterrupted: listInterruptedMock,
    resume: resumeMock,
    transition: transitionMock,
    get: getTaskMock,
  },
  journal: {
    list: journalListMock,
    revert: journalRevertMock,
  },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

const WS_ID = '9d8e7f6a-2222-4ccc-b0aa-deadbeef0001';
const TASK_A = '3a1b0c2d-aa11-4e5f-9c3d-0123456789ab';
const TASK_B = '7c4d5e6f-bb22-4a7c-8d9e-fedcba987654';

// 构造完整 InterruptedTaskInfo（真实形状——types.d.ts 契约，不用简化占位）
function makeInterrupted(overrides?: Partial<InterruptedTaskInfo>): InterruptedTaskInfo {
  return {
    taskId: TASK_A,
    title: '重构登录模块',
    status: 'in_progress',
    agentName: 'coder',
    journalCount: 3,
    streamSessionId: 'ss-bp-0001',
    ...overrides,
  };
}

// 构造完整 TaskRow（撤回链经 task.get 取 workspaceId——被消费字段用真实值）
function makeTaskRow(overrides?: Partial<TaskRow>): TaskRow {
  return {
    id: TASK_A,
    workspaceId: WS_ID,
    title: '重构登录模块',
    description: '',
    status: 'in_progress',
    sourceSessionId: null,
    sourceMessageId: null,
    creatorUserId: 'user-local',
    executionSessionId: 'sess-exec-0001',
    assigneeAgentId: 'inst-coder-01',
    targetTeamId: null,
    targetSessionId: null,
    recurrenceParentId: null,
    priority: 2,
    scheduledAt: null,
    recurrenceRule: null,
    deadlineAt: null,
    queuePosition: null,
    runtimeInstanceId: null,
    estimatedTokens: null,
    actualTokens: null,
    toolCallsUsed: 3,
    errorMessage: null,
    sourceNodeId: null,
    createdAt: 1757500000000,
    updatedAt: 1757500100000,
    startedAt: 1757500005000,
    completedAt: null,
    ...overrides,
  };
}

// 构造账本视图条目（真实唯一 id——撤回链消费 ids 列表）
function makeEntry(id: string): JournalEntryView {
  return {
    id,
    workspaceId: WS_ID,
    taskId: TASK_A,
    sessionId: null,
    streamSessionId: 'ss-bp-0001',
    toolName: 'write_file',
    path: `src/mod-${id}.ts`,
    op: 'modify',
    beforeHash: 'h-before',
    afterHash: 'h-after',
    oldPath: null,
    createdAt: 1757500050000,
    beforeText: null,
    afterText: null,
  };
}

function makeOutcome(id: string, result: RevertOutcome['result']): RevertOutcome {
  return { id, path: `src/mod-${id}.ts`, result };
}

beforeEach(() => {
  listInterruptedMock.mockReset();
  resumeMock.mockReset();
  transitionMock.mockReset();
  getTaskMock.mockReset();
  journalListMock.mockReset();
  journalRevertMock.mockReset();
});

describe('ResumeNotice（v2.6.0 Task 6）', () => {
  it('挂载时调 ipc.task.listInterrupted', async () => {
    listInterruptedMock.mockResolvedValue([makeInterrupted()]);
    render(<ResumeNotice />);
    await waitFor(() => expect(listInterruptedMock).toHaveBeenCalledTimes(1));
  });

  it('空列表 → 不渲染', async () => {
    listInterruptedMock.mockResolvedValue([]);
    const { container } = render(<ResumeNotice />);
    await waitFor(() => expect(listInterruptedMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it('boot 拉取失败 → 不渲染（恢复卡是增强路径，不阻塞启动）', async () => {
    listInterruptedMock.mockRejectedValue(new Error('db busy'));
    const { container } = render(<ResumeNotice />);
    await waitFor(() => expect(listInterruptedMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it('逐任务行：标题 + agent 名 + 「半程变更 M 处」', async () => {
    listInterruptedMock.mockResolvedValue([
      makeInterrupted(),
      makeInterrupted({
        taskId: TASK_B,
        title: '编写单元测试',
        agentName: 'pm-agent',
        journalCount: 7,
      }),
    ]);
    render(<ResumeNotice />);
    await waitFor(() => expect(screen.getByTestId('resume-notice')).toBeInTheDocument());
    expect(screen.getByText('重构登录模块')).toBeInTheDocument();
    expect(screen.getByText('coder')).toBeInTheDocument();
    expect(screen.getByText('半程变更 3 处')).toBeInTheDocument();
    expect(screen.getByText('编写单元测试')).toBeInTheDocument();
    expect(screen.getByText('pm-agent')).toBeInTheDocument();
    expect(screen.getByText('半程变更 7 处')).toBeInTheDocument();
  });

  it('journalCount=0 → 文案「无文件变更」', async () => {
    listInterruptedMock.mockResolvedValue([makeInterrupted({ journalCount: 0 })]);
    render(<ResumeNotice />);
    await waitFor(() => expect(screen.getByTestId('resume-notice')).toBeInTheDocument());
    expect(screen.getByText('无文件变更')).toBeInTheDocument();
  });

  it('[恢复] → task.resume(taskId) → 该行消散（其余行保留）', async () => {
    listInterruptedMock.mockResolvedValue([
      makeInterrupted(),
      makeInterrupted({ taskId: TASK_B, title: '编写单元测试' }),
    ]);
    render(<ResumeNotice />);
    await waitFor(() => expect(screen.getByTestId('resume-notice')).toBeInTheDocument());

    resumeMock.mockResolvedValue(makeTaskRow());
    fireEvent.click(screen.getAllByRole('button', { name: /恢复/ })[0]!);

    await waitFor(() => expect(resumeMock).toHaveBeenCalledWith(TASK_A));
    await waitFor(() => {
      expect(screen.queryByText('重构登录模块')).toBeNull();
    });
    expect(screen.getByText('编写单元测试')).toBeInTheDocument();
  });

  it('[放弃] → 展开内联二选一（直接放弃 / 撤回变更后放弃）', async () => {
    listInterruptedMock.mockResolvedValue([makeInterrupted()]);
    render(<ResumeNotice />);
    await waitFor(() => expect(screen.getByTestId('resume-notice')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '放弃' }));

    expect(screen.getByRole('button', { name: '直接放弃' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '撤回变更后放弃' })).toBeInTheDocument();
  });

  it('[直接放弃] → transition(id, "cancelled") → 行消散', async () => {
    listInterruptedMock.mockResolvedValue([makeInterrupted()]);
    render(<ResumeNotice />);
    await waitFor(() => expect(screen.getByTestId('resume-notice')).toBeInTheDocument());

    transitionMock.mockResolvedValue(makeTaskRow({ status: 'cancelled' }));
    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    fireEvent.click(screen.getByRole('button', { name: '直接放弃' }));

    await waitFor(() => expect(transitionMock).toHaveBeenCalledWith(TASK_A, 'cancelled'));
    await waitFor(() => {
      expect(screen.queryByTestId('resume-notice')).toBeNull();
    });
  });

  it('[撤回变更后放弃] → get → journal.list → revert(全部 ids) → 摘要呈现 → transition → 行消散', async () => {
    listInterruptedMock.mockResolvedValue([makeInterrupted()]);
    render(<ResumeNotice />);
    await waitFor(() => expect(screen.getByTestId('resume-notice')).toBeInTheDocument());

    getTaskMock.mockResolvedValue(makeTaskRow());
    journalListMock.mockResolvedValue([makeEntry('e1'), makeEntry('e2'), makeEntry('e3')]);
    journalRevertMock.mockResolvedValue([
      makeOutcome('e1', 'reverted'),
      makeOutcome('e2', 'skipped-diverged'),
      makeOutcome('e3', 'reverted'),
    ]);
    // transition 挂起——先断言撤回结果摘要呈现，再放行验证行消散
    let resolveTransition: (v: TaskRow) => void = () => {};
    transitionMock.mockReturnValue(
      new Promise<TaskRow>((res) => {
        resolveTransition = res;
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    fireEvent.click(screen.getByRole('button', { name: '撤回变更后放弃' }));

    await waitFor(() => expect(journalRevertMock).toHaveBeenCalledTimes(1));
    expect(getTaskMock).toHaveBeenCalledWith(TASK_A);
    expect(journalListMock).toHaveBeenCalledWith({ workspaceId: WS_ID, taskId: TASK_A });
    expect(journalRevertMock).toHaveBeenCalledWith(WS_ID, ['e1', 'e2', 'e3'], {});
    // 链路顺序：list 先于 revert 先于 transition
    expect(journalListMock.mock.invocationCallOrder[0]!).toBeLessThan(
      journalRevertMock.mock.invocationCallOrder[0]!,
    );
    expect(journalRevertMock.mock.invocationCallOrder[0]!).toBeLessThan(
      transitionMock.mock.invocationCallOrder[0]!,
    );
    // 摘要行内呈现（transition 未放行前可见）
    expect(screen.getByText('撤回 2 处 · 跳过 1 处')).toBeInTheDocument();

    await act(async () => {
      resolveTransition(makeTaskRow({ status: 'cancelled' }));
    });
    await waitFor(() => {
      expect(screen.queryByTestId('resume-notice')).toBeNull();
    });
  });

  it('[撤回变更后放弃] 账本为空 → 跳过 revert 直接 transition（空输入分支）', async () => {
    listInterruptedMock.mockResolvedValue([makeInterrupted({ journalCount: 0 })]);
    render(<ResumeNotice />);
    await waitFor(() => expect(screen.getByTestId('resume-notice')).toBeInTheDocument());

    getTaskMock.mockResolvedValue(makeTaskRow());
    journalListMock.mockResolvedValue([]);
    transitionMock.mockResolvedValue(makeTaskRow({ status: 'cancelled' }));

    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    fireEvent.click(screen.getByRole('button', { name: '撤回变更后放弃' }));

    await waitFor(() => expect(transitionMock).toHaveBeenCalledWith(TASK_A, 'cancelled'));
    expect(journalRevertMock).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByTestId('resume-notice')).toBeNull();
    });
  });

  it('全部决策完（一恢复一放弃）→ 卡片消散', async () => {
    listInterruptedMock.mockResolvedValue([
      makeInterrupted(),
      makeInterrupted({ taskId: TASK_B, title: '编写单元测试' }),
    ]);
    render(<ResumeNotice />);
    await waitFor(() => expect(screen.getByTestId('resume-notice')).toBeInTheDocument());

    resumeMock.mockResolvedValue(makeTaskRow());
    transitionMock.mockResolvedValue(makeTaskRow({ status: 'cancelled' }));
    fireEvent.click(screen.getAllByRole('button', { name: '恢复' })[0]!);
    await waitFor(() => expect(screen.queryByText('重构登录模块')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    fireEvent.click(screen.getByRole('button', { name: '直接放弃' }));

    await waitFor(() => {
      expect(screen.queryByTestId('resume-notice')).toBeNull();
    });
  });

  it('恢复失败（resume reject）→ 行保留 + 错误提示可见（错误路径）', async () => {
    listInterruptedMock.mockResolvedValue([makeInterrupted()]);
    render(<ResumeNotice />);
    await waitFor(() => expect(screen.getByTestId('resume-notice')).toBeInTheDocument());

    resumeMock.mockRejectedValue(new Error('任务状态已变化'));
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));

    await waitFor(() => {
      expect(screen.getByText(/恢复失败：任务状态已变化/)).toBeInTheDocument();
    });
    expect(screen.getByText('重构登录模块')).toBeInTheDocument();
    expect(screen.getByTestId('resume-notice')).toBeInTheDocument();
  });
});
