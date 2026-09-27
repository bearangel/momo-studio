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

// ── 拖拽视觉反馈(看板重构 Task 13:禁投变暗 / 合法虚线 / 插入指示线)──────────
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
    const section = screen.getByRole('region', { name: '已分配' });
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

  it('指示线:dropIndicatorBeforeTaskId → 该卡上方 2px accent 线,其余卡无', () => {
    render(
      <BoardColumn
        column={backlog}
        tasks={[mkTask({ id: 'T-001', title: '甲', boardPosition: 1024 }), mkTask({ id: 'T-002', title: '乙', boardPosition: 2048 })]}
        dropIndicatorBeforeTaskId="T-002"
      />,
    );
    const lines = screen.getAllByTestId('drop-indicator');
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.className).toContain('bg-focus');
    // 线紧贴 T-002 之前(其后继文本含乙卡)
    expect(line.nextElementSibling?.textContent).toContain('乙');
  });

  it('指示线:dropIndicatorAfterTaskId → 该卡下方 2px accent 线', () => {
    render(
      <BoardColumn
        column={backlog}
        tasks={[mkTask({ id: 'T-001', title: '甲', boardPosition: 1024 }), mkTask({ id: 'T-002', title: '乙', boardPosition: 2048 })]}
        dropIndicatorAfterTaskId="T-001"
      />,
    );
    const lines = screen.getAllByTestId('drop-indicator');
    expect(lines).toHaveLength(1);
    // 线在 T-001 之后(其前驱文本含甲卡)
    expect(lines[0]!.previousElementSibling?.textContent).toContain('甲');
  });

  it('指示线:空列尾线(showTailDropIndicator)→ 列表尾部 2px accent 线', () => {
    render(
      <BoardColumn
        column={backlog}
        tasks={[mkTask({ id: 'T-001', title: '甲', boardPosition: 1024 })]}
        showTailDropIndicator
      />,
    );
    const lines = screen.getAllByTestId('drop-indicator');
    expect(lines).toHaveLength(1);
    // 尾线是列内最后一个元素(其前驱含甲卡、无后继)
    expect(lines[0]!.previousElementSibling?.textContent).toContain('甲');
    expect(lines[0]!.nextElementSibling).toBeNull();
  });
});
