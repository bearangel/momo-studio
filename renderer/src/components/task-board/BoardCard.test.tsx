// renderer/src/components/task-board/BoardCard.test.tsx
//
// 看板卡片静态渲染测试（看板重构 Task 11）：
//   - 基础行：[高] 优先级前缀 + #短ID · 标题 + 状态徽标（task-status.ts 单源）
//   - 中间态徽标：session_queued →「排队中」、paused →「已暂停」（spec §5.2，
//     状态徽标天然按底层状态词表渲染，不占列）
//   - 平铺模式 groupChip：色点 + 组名；null / 不传 → 不渲染
//   - 点击回调 + selected 的 aria-pressed 语义
// mock 边界对齐 TaskCard.test：仅 mock IPC（window.api），store 用真实实现。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BoardCard } from './BoardCard';
import type { TaskRow } from '../../ipc/types';
import { useAgentStore } from '../../stores/agent.store';

const mockApi = {
  agent: { listMembers: vi.fn().mockRejectedValue(new Error('no ipc')) },
  team: { list: vi.fn().mockRejectedValue(new Error('no ipc')) },
  session: { list: vi.fn().mockRejectedValue(new Error('no ipc')) },
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
  useAgentStore.setState({ members: [], teams: [] });
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
  it('groupChip 传入 → 显示组名（色点为纯样式装饰）', () => {
    render(
      <BoardCard
        task={base}
        selected={false}
        onClick={() => {}}
        groupChip={{ name: 'v2.1.0 看板重构', color: 'accent' }}
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
});
