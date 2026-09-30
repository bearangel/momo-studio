// renderer/src/components/task-board/BoardCard.test.tsx
//
// 看板卡片静态渲染测试（看板重构 Task 11；UX 波 2 #1/#7）：
//   - 基础行：[高] 优先级前缀 + #短ID · 标题 + 状态徽标（task-status.ts 单源）
//   - 中间态徽标：session_queued →「排队中」、paused →「已暂停」（spec §5.2，
//     状态徽标天然按底层状态词表渲染，不占列）
//   - 平铺模式 groupChip：组色低透明底+组色文字/边框（fg/bg 由父层解析传入，
//     UX 波 2 #7）；未知/无色 → 中性回退；null / 不传 → 不渲染
//   - 点击回调 + selected 的 aria-pressed 语义
//   - 右键菜单全状态（UX 波 2 #1）：终态出「归档」（spec §5.2，调 task.store.archive
//     成功即本地剔除 / 失败 toast）；可编辑态（draft/pending，isEditableStatus
//     单源）出「编辑」打开内嵌 EditTaskDialog；执行管线中间态无编辑无归档；
//     全状态首位「顶置/取消顶置」（迁移 050，调 task.store.pin 乐观更新）
// mock 边界对齐 TaskCard.test：仅 mock IPC（window.api），store 用真实实现。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BoardCard } from './BoardCard';
import type { ImMessage, TaskRow } from '../../ipc/types';
import type { StreamState } from '../../stores/stream.store';
import { useAgentStore } from '../../stores/agent.store';
import { useSessionStore } from '../../stores/session.store';
import { useStreamStore } from '../../stores/stream.store';
import { useTaskStore } from '../../stores/task.store';
import { Toast, dismissToast } from '../ui/Toast';

const mockApi = {
  agent: { listMembers: vi.fn().mockRejectedValue(new Error('no ipc')) },
  team: { list: vi.fn().mockRejectedValue(new Error('no ipc')) },
  session: { list: vi.fn().mockRejectedValue(new Error('no ipc')) },
  task: { archive: vi.fn(), setPinned: vi.fn() },
};

const base: TaskRow = {
  id: 'T-001', workspaceId: 'ws1', title: '任务A', description: '', status: 'assigned',
  sourceSessionId: null, sourceMessageId: null, creatorUserId: 'owner', executionSessionId: null,
  assigneeAgentId: null, targetTeamId: null, targetSessionId: null, recurrenceParentId: null,
  priority: 0, scheduledAt: null, recurrenceRule: null, deadlineAt: null, queuePosition: null,
  runtimeInstanceId: null, estimatedTokens: null, actualTokens: null, toolCallsUsed: 0,
  errorMessage: null, sourceNodeId: null, createdAt: 0, updatedAt: 0, startedAt: null, completedAt: null,
  groupId: null, pinnedAt: null, archivedAt: null,
};

beforeEach(() => {
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  mockApi.agent.listMembers.mockClear();
  mockApi.task.archive.mockReset().mockResolvedValue(undefined);
  mockApi.task.setPinned.mockReset().mockImplementation(async (_id: string, pinned: boolean) =>
    ({ ...base, pinnedAt: pinned ? 12345 : null }),
  );
  useAgentStore.setState({ members: [], teams: [] });
  useTaskStore.setState({ tasks: [], selectedTaskId: null, loading: false, error: null });
  dismissToast(); // toast 单例复位，防跨用例串扰
});

describe('BoardCard 基础渲染', () => {
  it('渲染 #短ID · 标题 + 状态徽标；点击回调 onClick', () => {
    const onClick = vi.fn();
    render(<BoardCard task={base} selected={false} onClick={onClick} />);
    expect(screen.getByText(/#T-001 · 任务A/)).toBeInTheDocument();
    expect(screen.getByText('排队中')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /任务A/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('优先级 10 → 标题前缀 [高]', () => {
    render(<BoardCard task={{ ...base, priority: 10 }} selected={false} onClick={() => {}} />);
    expect(screen.getByText('[高]')).toBeInTheDocument();
  });

  it('优先级 0 → 无优先级前缀', () => {
    render(<BoardCard task={base} selected={false} onClick={() => {}} />);
    expect(screen.queryByText('[高]')).not.toBeInTheDocument();
    expect(screen.queryByText('[中]')).not.toBeInTheDocument();
    expect(screen.queryByText('[低]')).not.toBeInTheDocument();
  });

  it('selected=true → aria-pressed=true（选中语义）', () => {
    render(<BoardCard task={base} selected={true} onClick={() => {}} />);
    expect(screen.getByRole('button', { name: /任务A/ }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('BoardCard 中间态徽标（spec §5.2：不占列，徽标表达）', () => {
  it('session_queued → 显示「排队中」', () => {
    render(
      <BoardCard task={{ ...base, status: 'session_queued' }} selected={false} onClick={() => {}} />,
    );
    expect(screen.getByText('排队中')).toBeInTheDocument();
  });

  it('paused → 显示「已暂停」', () => {
    render(<BoardCard task={{ ...base, status: 'paused' }} selected={false} onClick={() => {}} />);
    expect(screen.getByText('已暂停')).toBeInTheDocument();
  });
});

describe('BoardCard 平铺模式组 chip', () => {
  it('groupChip 传入（未解析色）→ 中性回退仍显示组名', () => {
    render(
      <BoardCard
        task={base}
        selected={false}
        onClick={() => {}}
        groupChip={{ name: 'v2.1.0 看板重构', color: 'accent', fg: null, bg: null }}
      />,
    );
    expect(screen.getByText('v2.1.0 看板重构')).toBeInTheDocument();
  });

  it('groupChip=null → 不渲染组名（泳道模式省略 chip）', () => {
    render(<BoardCard task={base} selected={false} onClick={() => {}} groupChip={null} />);
    expect(screen.queryByText('v2.1.0 看板重构')).not.toBeInTheDocument();
  });

  it('不传 groupChip → 不渲染', () => {
    render(<BoardCard task={base} selected={false} onClick={() => {}} />);
    // 元信息行不因缺 chip 崩溃，标题行仍在
    expect(screen.getByText(/任务A/)).toBeInTheDocument();
  });

  it('fg/bg 解析传入 → 组色渲染：低透明底 + 组色文字/边框（UX 波 2 #7）', () => {
    render(
      <BoardCard
        task={base}
        selected={false}
        onClick={() => {}}
        groupChip={{
          name: '前端组',
          color: 'accent',
          fg: 'rgb(var(--accent-500))',
          bg: 'color-mix(in srgb, rgb(var(--accent-500)) 14%, transparent)',
        }}
      />,
    );
    const chip = screen.getByText('前端组');
    expect(chip.style.backgroundColor).toBe(
      'color-mix(in srgb, rgb(var(--accent-500)) 14%, transparent)',
    );
    expect(chip.style.color).toBe('rgb(var(--accent-500))');
    expect(chip.style.borderColor).toBe('rgb(var(--accent-500))');
  });

  it('自定义 hex 组色 → 原值前景 + 原值22 底色（UX 波 2 #5/#7）', () => {
    render(
      <BoardCard
        task={base}
        selected={false}
        onClick={() => {}}
        groupChip={{ name: '自定义组', color: '#ff8800', fg: '#ff8800', bg: '#ff880022' }}
      />,
    );
    const chip = screen.getByText('自定义组');
    // jsdom CSSOM 把 #rrggbbaa 规范化为 rgba（0x22/255 ≈ 0.133）
    expect(chip.style.backgroundColor).toBe('rgba(255, 136, 0, 0.133)');
    expect(chip.style.color).toBe('rgb(255, 136, 0)');
    expect(chip.style.borderColor).toBe('rgb(255, 136, 0)');
  });

  it('fg/bg 为 null（未知/无色）→ 中性样式回退（bg-surface-2，无 inline 色）', () => {
    render(
      <BoardCard
        task={base}
        selected={false}
        onClick={() => {}}
        groupChip={{ name: '无色组', color: null, fg: null, bg: null }}
      />,
    );
    const chip = screen.getByText('无色组');
    expect(chip.className).toContain('bg-surface-2');
    expect(chip.style.backgroundColor).toBe('');
  });
});

describe('BoardCard 终态卡右键归档（spec §5.2）', () => {
  it.each(['completed', 'failed', 'cancelled'] as const)('终态 %s 右键 → 出「归档」菜单', (status) => {
    render(<BoardCard task={{ ...base, status }} selected={false} onClick={() => {}} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: /任务A/ }));
    expect(screen.getByRole('button', { name: /归档/ })).toBeInTheDocument();
    // 终态不出编辑项（编辑入口仅非终态）
    expect(screen.queryByRole('button', { name: /^编辑$/ })).not.toBeInTheDocument();
  });

  it('点归档 → 调 ipc.task.archive(id) 且 store 本地剔除该行（卡片消失）', async () => {
    useTaskStore.setState({
      tasks: [base, { ...base, id: 'T-002', title: '任务B' }],
      selectedTaskId: null,
      loading: false,
      error: null,
    });
    const { unmount } = render(
      <BoardCard task={{ ...base, status: 'completed' }} selected={false} onClick={() => {}} />,
    );
    fireEvent.contextMenu(screen.getByRole('button', { name: /任务A/ }));
    fireEvent.click(screen.getByRole('button', { name: /归档/ }));

    await waitFor(() => {
      expect(mockApi.task.archive).toHaveBeenCalledWith('T-001');
    });
    // 真实 store 语义：归档成功即本地剔除（仅剩 T-002）
    await waitFor(() => {
      expect(useTaskStore.getState().tasks.map((t) => t.id)).toEqual(['T-002']);
    });
    unmount();
  });

  it('归档失败（IPC reject）→ toast 显示错误，store 本地不动（错误路径）', async () => {
    mockApi.task.archive.mockRejectedValue(new Error('归档冲突'));
    useTaskStore.setState({
      tasks: [base],
      selectedTaskId: null,
      loading: false,
      error: null,
    });
    render(
      <>
        <BoardCard task={{ ...base, status: 'completed' }} selected={false} onClick={() => {}} />
        <Toast />
      </>,
    );
    fireEvent.contextMenu(screen.getByRole('button', { name: /任务A/ }));
    fireEvent.click(screen.getByRole('button', { name: /归档/ }));

    expect(await screen.findByTestId('ui-toast')).toHaveTextContent('归档失败: 归档冲突');
    // store.archive 失败 rethrow 且本地不动
    expect(useTaskStore.getState().tasks.map((t) => t.id)).toEqual(['T-001']);
  });
});

describe('BoardCard 右键菜单编辑资格（isEditableStatus 单源，2026-09-30 收敛）', () => {
  it('可编辑态（draft）右键 → 出「编辑」菜单（不放行原生菜单）', () => {
    render(<BoardCard task={{ ...base, status: 'draft' }} selected={false} onClick={() => {}} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: /任务A/ }));
    expect(screen.getByRole('button', { name: /^编辑$/ })).toBeInTheDocument();
    // 可编辑态非终态，不出归档项（主进程同样 reject）
    expect(screen.queryByRole('button', { name: /^归档$/ })).not.toBeInTheDocument();
  });

  it.each(['draft', 'pending'] as const)('可编辑态 %s 右键 → 出「编辑」菜单', (status) => {
    render(<BoardCard task={{ ...base, status }} selected={false} onClick={() => {}} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: /任务A/ }));
    expect(screen.getByRole('button', { name: /^编辑$/ })).toBeInTheDocument();
  });

  it.each(['assigned', 'session_queued', 'in_progress', 'paused'] as const)(
    '执行管线 %s 右键 → 无「编辑」（顶置入口保留，归档仍不出）',
    (status) => {
      render(<BoardCard task={{ ...base, status }} selected={false} onClick={() => {}} />);
      fireEvent.contextMenu(screen.getByRole('button', { name: /任务A/ }));
      expect(screen.queryByRole('button', { name: /^编辑$/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^顶置$/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^归档$/ })).not.toBeInTheDocument();
    },
  );

  it('点「编辑」→ 打开 EditTaskDialog（workspaceId 取 task.workspaceId）', async () => {
    // EditTaskDialog 打开即拉三类目标列表——mock 为空列表防未处理 rejection
    mockApi.agent.listMembers.mockResolvedValue([]);
    mockApi.team.list.mockResolvedValue([]);
    mockApi.session.list.mockResolvedValue([]);
    render(<BoardCard task={{ ...base, status: 'draft' }} selected={false} onClick={() => {}} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: /任务A/ }));
    fireEvent.click(screen.getByRole('button', { name: /^编辑$/ }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-label', '编辑任务 #T-001');
    // 菜单点编辑后关闭
    expect(screen.queryByRole('button', { name: /^编辑$/ })).not.toBeInTheDocument();
  });

  it('可编辑卡不挂 EditTaskDialog 于关闭态（open=false 渲染 null，无对话框副作用）', () => {
    render(<BoardCard task={{ ...base, status: 'draft' }} selected={false} onClick={() => {}} />);
    // EditTaskDialog open=false 不渲染（卡片自身的 useTaskEntityNames 兜底拉取不计入）
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

// === 派生徽标「待收尾」（turn reconciliation spec §3.5）===
// 真实 store 语义：session.messagesBySession + stream.streams 联合推导。

const wrapUpMsg = (id: string): ImMessage => ({
  id,
  sessionId: 'sess-exec',
  sender: '@bot:x',
  body: '',
  eventType: 'm.room.message',
  streamSessionId: null,
  parentStreamSessionId: null,
  segmentOf: null,
  segmentIndex: null,
  status: 'streaming',
  source: 'local',
  workspaceId: null,
  taskId: null,
  contextJson: null,
  createdAt: 0,
  updatedAt: 0,
});

const wrapUpStream = (status: StreamState['status']): StreamState => ({
  thinking: '',
  text: '',
  toolCalls: [],
  todos: [],
  dispatches: [],
  status,
  events: [],
  segments: [],
  messageId: 'm-exec',
  startedAt: 0,
});

describe('BoardCard 派生徽标「待收尾」（spec §3.5）', () => {
  beforeEach(() => {
    useSessionStore.setState({ messagesBySession: new Map() });
    useStreamStore.setState({ streams: new Map() });
  });

  it('in_progress + 宿主会话无运行回合 → 与状态徽标并列显示「待收尾」（不替换进行中真相）', () => {
    render(
      <BoardCard
        task={{ ...base, status: 'in_progress', executionSessionId: 'sess-exec' }}
        selected={false}
        onClick={() => {}}
      />,
    );
    expect(screen.getByText('待收尾')).toBeInTheDocument();
    expect(screen.getByText('进行中')).toBeInTheDocument();
  });

  it('会话正在流式输出 → 不显示（运行回合在场）', () => {
    useSessionStore.setState({
      messagesBySession: new Map([['sess-exec', [wrapUpMsg('m-exec')]]]),
    });
    useStreamStore.setState({
      streams: new Map([['m-exec', wrapUpStream('streaming')]]),
    });
    render(
      <BoardCard
        task={{ ...base, status: 'in_progress', executionSessionId: 'sess-exec' }}
        selected={false}
        onClick={() => {}}
      />,
    );
    expect(screen.queryByText('待收尾')).not.toBeInTheDocument();
    expect(screen.getByText('进行中')).toBeInTheDocument();
  });

  it('completed → 不显示（终态）', () => {
    render(
      <BoardCard
        task={{ ...base, status: 'completed', executionSessionId: 'sess-exec' }}
        selected={false}
        onClick={() => {}}
      />,
    );
    expect(screen.queryByText('待收尾')).not.toBeInTheDocument();
  });

  it('无 executionSessionId 的 in_progress → 不显示（语义边界）', () => {
    render(
      <BoardCard task={{ ...base, status: 'in_progress' }} selected={false} onClick={() => {}} />,
    );
    expect(screen.queryByText('待收尾')).not.toBeInTheDocument();
  });
});

// ── 顶置（迁移 050）：图钉标识 + 右键菜单开关 ──────────────────────────────
describe('BoardCard 顶置', () => {
  it('pinnedAt 非 null → 状态徽标左侧渲染图钉（aria-label 已顶置）', () => {
    render(<BoardCard task={{ ...base, pinnedAt: 999 }} selected={false} onClick={() => {}} />);
    expect(screen.getByLabelText('已顶置')).toBeInTheDocument();
  });

  it('pinnedAt null → 无图钉', () => {
    render(<BoardCard task={base} selected={false} onClick={() => {}} />);
    expect(screen.queryByLabelText('已顶置')).not.toBeInTheDocument();
  });

  it('未顶置右键 → 首位「顶置」项，点击调 store.pin(id, true)', async () => {
    useTaskStore.setState({ tasks: [base], selectedTaskId: null, loading: false, error: null });
    render(<BoardCard task={base} selected={false} onClick={() => {}} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: /任务A/ }));
    fireEvent.click(screen.getByRole('button', { name: /^顶置$/ }));

    await waitFor(() => {
      expect(mockApi.task.setPinned).toHaveBeenCalledWith('T-001', true);
    });
    // 真实 store.pin：成功后权威行覆盖（mock 返回 pinnedAt=12345）
    await waitFor(() => {
      expect(useTaskStore.getState().tasks[0]!.pinnedAt).toBe(12345);
    });
  });

  it('已顶置右键 → 「取消顶置」项，点击调 store.pin(id, false)；终态卡同样可用', async () => {
    const done = { ...base, status: 'completed' as const, pinnedAt: 999 };
    useTaskStore.setState({ tasks: [done], selectedTaskId: null, loading: false, error: null });
    render(<BoardCard task={done} selected={false} onClick={() => {}} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: /任务A/ }));
    // 终态卡菜单同时含「取消顶置」与「归档」
    fireEvent.click(screen.getByRole('button', { name: /取消顶置/ }));

    await waitFor(() => {
      expect(mockApi.task.setPinned).toHaveBeenCalledWith('T-001', false);
    });
    await waitFor(() => {
      expect(useTaskStore.getState().tasks[0]!.pinnedAt).toBeNull();
    });
  });

  it('pin 失败（IPC reject）→ toast 显示错误，store 回滚乐观值（错误路径）', async () => {
    mockApi.task.setPinned.mockRejectedValue(new Error('任务不存在'));
    useTaskStore.setState({ tasks: [base], selectedTaskId: null, loading: false, error: null });
    render(
      <>
        <BoardCard task={base} selected={false} onClick={() => {}} />
        <Toast />
      </>,
    );
    fireEvent.contextMenu(screen.getByRole('button', { name: /任务A/ }));
    fireEvent.click(screen.getByRole('button', { name: /^顶置$/ }));

    expect(await screen.findByTestId('ui-toast')).toHaveTextContent('顶置失败: 任务不存在');
    await waitFor(() => {
      expect(useTaskStore.getState().tasks[0]!.pinnedAt).toBeNull();
    });
  });
});
