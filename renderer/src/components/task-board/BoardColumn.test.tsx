// renderer/src/components/task-board/BoardColumn.test.tsx
//
// 看板列静态渲染测试（看板重构 Task 11）：
//   - 列头：label + 卡片计数 + hint 灰字（与 BOARD_COLUMNS 契约一致）
//   - 列内排序：sortColumn（boardPosition 升序、NULL 垫底）在组件内部生效
//   - 空态「暂无」；点击卡片回调 onSelect(id)；selectedId 高亮语义
// 拖拽视觉反馈（看板重构 Task 13，spec §4 列级投影）：
//   - 禁投列：变暗 +「不可投放」标注（data-drop-state=forbidden）
//   - 拖拽中合法列：accent 虚线边框（data-drop-state=ok）
//   - 插入指示线：卡前/卡后/空列尾 2px accent 线（drop-indicator）
// isOver 拖悬升级态（data-drop-state=over）依赖 dnd-kit 碰撞检测实时驱动，
// jsdom 矩形全零不可信（Task 12 裁定），由 e2e/手工冒烟承接。
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
    pinnedAt: null,
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
    expect(screen.getByText('草稿')).toBeInTheDocument();
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
  it('顶置组在前（pin 时间倒序）→ 未顶置（createdAt 倒序）；两组间渲染「顶置以上」分隔线', () => {
    render(
      <BoardColumn
        column={backlog}
        tasks={[
          mkTask({ id: 'T-pin-old', title: '早置卡', pinnedAt: 1000 }),
          mkTask({ id: 'T-new', title: '新卡', pinnedAt: null, createdAt: 2000 }),
          mkTask({ id: 'T-pin-new', title: '晚置卡', pinnedAt: 3000 }),
          mkTask({ id: 'T-old', title: '老卡', pinnedAt: null, createdAt: 1000 }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    const cards = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') !== null);
    expect(cards.map((b) => b.textContent)).toEqual([
      expect.stringContaining('晚置卡'),
      expect.stringContaining('早置卡'),
      expect.stringContaining('新卡'),
      expect.stringContaining('老卡'),
    ]);
    // 分隔线一条，位于未顶置首卡（新卡）之前
    const dividers = screen.getAllByTestId('pinned-divider');
    expect(dividers).toHaveLength(1);
    expect(dividers[0]!.nextElementSibling?.textContent).toContain('新卡');
  });

  it('全列未顶置 / 全列顶置 → 无分隔线（边界）', () => {
    const { unmount } = render(
      <BoardColumn column={backlog} tasks={[mkTask({ id: 'T-a', title: '甲', pinnedAt: null })]} />,
    );
    expect(screen.queryByTestId('pinned-divider')).toBeNull();
    unmount();
    render(
      <BoardColumn column={backlog} tasks={[mkTask({ id: 'T-b', title: '乙', pinnedAt: 1 })]} />,
    );
    expect(screen.queryByTestId('pinned-divider')).toBeNull();
  });
});

// ── 拖拽视觉反馈(看板重构 Task 13:禁投变暗 / 合法虚线 / 目标列高亮)──────────
describe('BoardColumn 拖拽视觉反馈', () => {
  const assigned: BoardColumnDef = BOARD_COLUMNS[1]!;

  it('禁投列(dropFromStatus 状态机不允许)→ 变暗 + 「不可投放」标注', () => {
    // in_progress → backlog 只出不进,禁投
    render(<BoardColumn column={backlog} tasks={[]} dropFromStatus="in_progress" />);
    const section = screen.getByRole('region', { name: '待办' });
    expect(section).toHaveAttribute('data-drop-state', 'forbidden');
    expect(section.className).toContain('opacity-50');
    expect(screen.getByText('不可投放')).toBeInTheDocument();
  });

  it('拖拽中合法列 → accent 虚线边框,无禁投标注', () => {
    // draft → assigned 合法
    render(<BoardColumn column={assigned} tasks={[]} dropFromStatus="draft" />);
    const section = screen.getByRole('region', { name: '排队中' });
    expect(section).toHaveAttribute('data-drop-state', 'ok');
    expect(section.className).toContain('border-dashed');
    expect(section.className).toContain('border-focus');
    expect(screen.queryByText('不可投放')).not.toBeInTheDocument();
  });

  it('无拖拽 → idle 常规边框(无虚线/无变暗)', () => {
    render(<BoardColumn column={backlog} tasks={[]} />);
    const section = screen.getByRole('region', { name: '待办' });
    expect(section).toHaveAttribute('data-drop-state', 'idle');
    expect(section.className).not.toContain('opacity-50');
    expect(section.className).not.toContain('border-dashed');
  });

  it('dropTargetActive=true → data-drop-state=over（拖悬目标列高亮，悬卡片时列容器 isOver 不触发的补位）', () => {
    render(
      <BoardColumn
        column={assigned}
        tasks={[mkTask({ id: 'T-001', title: '甲', status: 'assigned' })]}
        dropFromStatus="assigned"
        dropTargetActive
      />,
    );
    const section = screen.getByRole('region');
    expect(section.getAttribute('data-drop-state')).toBe('over');
    expect(section.className).toContain('bg-surface-2');
  });

  it('dropTargetActive=false → 维持可投 idle/ok 态（不高亮）', () => {
    render(
      <BoardColumn
        column={assigned}
        tasks={[mkTask({ id: 'T-001', title: '甲', status: 'assigned' })]}
        dropFromStatus="assigned"
        dropTargetActive={false}
      />,
    );
    const section = screen.getByRole('region');
    expect(section.getAttribute('data-drop-state')).toBe('ok');
    expect(section.className).not.toContain('bg-surface-2');
  });
});
