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
//     成功即本地剔除 / 失败 toast）；非终态出「编辑」打开内嵌 EditTaskDialog
// mock 边界对齐 TaskCard.test：仅 mock IPC（window.api），store 用真实实现。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BoardCard } from './BoardCard';
import type { TaskRow } from '../../ipc/types';
import { useAgentStore } from '../../stores/agent.store';
import { useTaskStore } from '../../stores/task.store';
import { Toast, dismissToast } from '../ui/Toast';

const mockApi = {
  agent: { listMembers: vi.fn().mockRejectedValue(new Error('no ipc')) },
  team: { list: vi.fn().mockRejectedValue(new Error('no ipc')) },
  session: { list: vi.fn().mockRejectedValue(new Error('no ipc')) },
  task: { archive: vi.fn() },
};

const base: TaskRow = {
  id: 'T-001', workspaceId: 'ws1', title: '任务A', description: '', status: 'assigned',
  sourceSessionId: null, sourceMessageId: null, creatorUserId: 'owner', executionSessionId: null,
  assigneeAgentId: null, targetTeamId: null, targetSessionId: null, recurrenceParentId: null,
  priority: 0, scheduledAt: null, recurrenceRule: null, deadlineAt: null, queuePosition: null,
  runtimeInstanceId: null, estimatedTokens: null, actualTokens: null, toolCallsUsed: 0,
  errorMessage: null, sourceNodeId: null, createdAt: 0, updatedAt: 0, startedAt: null, completedAt: null,
  groupId: null, boardPosition: null, archivedAt: null,
};

beforeEach(() => {
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  mockApi.agent.listMembers.mockClear();
  mockApi.task.archive.mockReset().mockResolvedValue(undefined);
  useAgentStore.setState({ members: [], teams: [] });
  useTaskStore.setState({ tasks: [], selectedTaskId: null, loading: false, error: null });
  dismissToast(); // toast 单例复位，防跨用例串扰
});

describe('BoardCard 基础渲染', () => {
  it('渲染 #短ID · 标题 + 状态徽标；点击回调 onClick', () => {
    const onClick = vi.fn();
    render(<BoardCard task={base} selected={false} onClick={onClick} />);
    expect(screen.getByText(/#T-001 · 任务A/)).toBeInTheDocument();
    expect(screen.getByText('已分配')).toBeInTheDocument();
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

describe('BoardCard 非终态卡右键编辑（UX 波 2 #1：入口可达性）', () => {
  it('非终态（assigned）右键 → 出「编辑」菜单（不再放行原生菜单）', () => {
    render(<BoardCard task={base} selected={false} onClick={() => {}} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: /任务A/ }));
    expect(screen.getByRole('button', { name: /^编辑$/ })).toBeInTheDocument();
    // 非终态不出归档项（主进程同样 reject）
    expect(screen.queryByRole('button', { name: /^归档$/ })).not.toBeInTheDocument();
  });

  it.each(['draft', 'pending', 'session_queued', 'in_progress', 'paused'] as const)(
    '非终态 %s 右键 → 出「编辑」菜单',
    (status) => {
      render(<BoardCard task={{ ...base, status }} selected={false} onClick={() => {}} />);
      fireEvent.contextMenu(screen.getByRole('button', { name: /任务A/ }));
      expect(screen.getByRole('button', { name: /^编辑$/ })).toBeInTheDocument();
    },
  );

  it('点「编辑」→ 打开 EditTaskDialog（workspaceId 取 task.workspaceId）', async () => {
    // EditTaskDialog 打开即拉三类目标列表——mock 为空列表防未处理 rejection
    mockApi.agent.listMembers.mockResolvedValue([]);
    mockApi.team.list.mockResolvedValue([]);
    mockApi.session.list.mockResolvedValue([]);
    render(<BoardCard task={base} selected={false} onClick={() => {}} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: /任务A/ }));
    fireEvent.click(screen.getByRole('button', { name: /^编辑$/ }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-label', '编辑任务 #T-001');
    // 菜单点编辑后关闭
    expect(screen.queryByRole('button', { name: /^编辑$/ })).not.toBeInTheDocument();
  });

  it('非终态卡不挂 EditTaskDialog 于关闭态（open=false 渲染 null，无对话框副作用）', () => {
    render(<BoardCard task={base} selected={false} onClick={() => {}} />);
    // EditTaskDialog open=false 不渲染（卡片自身的 useTaskEntityNames 兜底拉取不计入）
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
