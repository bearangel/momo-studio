// renderer/src/components/task-board/BoardColumn.test.tsx
//
// 看板列静态渲染测试（看板重构 Task 11）：
//   - 列头：label + 卡片计数 + hint 灰字（与 BOARD_COLUMNS 契约一致）
//   - 列内排序：sortColumn（boardPosition 升序、NULL 垫底）在组件内部生效
//   - 空态「暂无」；点击卡片回调 onSelect(id)；selectedId 高亮语义
// mock 边界对齐 TaskCard.test：仅 mock IPC（window.api），store 用真实实现。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BoardColumn } from './BoardColumn';
import { BOARD_COLUMNS, type BoardColumnDef } from '../../ipc/board-columns';
import type { TaskRow } from '../../ipc/types';
import { useAgentStore } from '../../stores/agent.store';

const backlog: BoardColumnDef = BOARD_COLUMNS[0]!;

const mockApi = {
  agent: { listMembers: vi.fn().mockRejectedValue(new Error('no ipc')) },
  team: { list: vi.fn().mockRejectedValue(new Error('no ipc')) },
  session: { list: vi.fn().mockRejectedValue(new Error('no ipc')) },
};

function mkTask(partial: Partial<TaskRow> & Pick<TaskRow, 'id' | 'title'>): TaskRow {
  return {
    workspaceId: 'ws1',
    description: '',
    status: 'draft',
    sourceSessionId: null,
    sourceMessageId: null,
    creatorUserId: 'owner',
    executionSessionId: null,
    assigneeAgentId: null,
    targetTeamId: null,
    targetSessionId: null,
    recurrenceParentId: null,
    priority: 0,
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
    ...partial,
  };
}

beforeEach(() => {
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  mockApi.agent.listMembers.mockClear();
  useAgentStore.setState({ members: [], teams: [] });
});

describe('BoardColumn 列头与卡片', () => {
  it('渲染列名/计数/卡片，点击卡片回调 onSelect(id)', () => {
    const onSelect = vi.fn();
    render(
      <BoardColumn
        column={backlog}
        tasks={[mkTask({ id: 'T-001', title: '看板联调' })]}
        selectedId={null}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText('待办')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText(/看板联调/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /看板联调/ }));
    expect(onSelect).toHaveBeenCalledWith('T-001');
  });

  it('渲染列头 hint 灰字（合并的底层状态标注）', () => {
    render(
      <BoardColumn column={backlog} tasks={[]} selectedId={null} onSelect={() => {}} />,
    );
    expect(screen.getByText('draft+pending')).toBeInTheDocument();
  });

  it('空列 → 显示「暂无」空态', () => {
    render(
      <BoardColumn column={backlog} tasks={[]} selectedId={null} onSelect={() => {}} />,
    );
    expect(screen.getByText('暂无')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('selectedId 命中 → 对应卡片 aria-pressed=true，其余为 false', () => {
    render(
      <BoardColumn
        column={backlog}
        tasks={[mkTask({ id: 'T-001', title: '甲' }), mkTask({ id: 'T-002', title: '乙' })]}
        selectedId="T-002"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /甲/ }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: /乙/ }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('BoardColumn 列内排序（sortColumn 内部生效）', () => {
  it('boardPosition 升序渲染；NULL 垫底（createdAt 兜底）', () => {
    render(
      <BoardColumn
        column={backlog}
        tasks={[
          mkTask({ id: 'T-null-new', title: '无位新卡', boardPosition: null, createdAt: 2000 }),
          mkTask({ id: 'T-2048', title: '乙位', boardPosition: 2048 }),
          mkTask({ id: 'T-1024', title: '甲位', boardPosition: 1024 }),
          mkTask({ id: 'T-null-old', title: '无位老卡', boardPosition: null, createdAt: 1000 }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    const cards = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') !== null);
    expect(cards.map((b) => b.textContent)).toEqual([
      expect.stringContaining('甲位'),
      expect.stringContaining('乙位'),
      expect.stringContaining('无位老卡'),
      expect.stringContaining('无位新卡'),
    ]);
  });
});
