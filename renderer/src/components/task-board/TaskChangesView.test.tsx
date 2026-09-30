// renderer/src/components/task-board/TaskChangesView.test.tsx
//
// 任务详情·变更查看测试（2026-09-30 预览确认后新增）：
//   - 数据面：按 { workspaceId, taskId } scope 查询；空账 / 查询失败 → 不渲染
//   - 视觉面：头行「N 处变更 · M 个文件」；展开文件行（rename → 箭头）+ diff
//   - 纯查看契约：无「撤回」「回滚」任何动作按钮
//   - 一致性锁：与气泡 ChangesChip 同 render 输出比对——容器与头行 className
//     逐字相等（预览承诺「效果与气泡一致」的机械保障，样式改动须两侧同步）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ImMessage, JournalEntryView } from '../../ipc/types';
import { ChangesChip } from '../im/ChangesChip';
import { TaskChangesView } from './TaskChangesView';

const listMock = vi.fn();

const mockApi = {
  journal: {
    list: listMock,
    revert: vi.fn(),
    rollbackFileBefore: vi.fn(),
    preview: vi.fn(),
  },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

function makeMessage(overrides: Partial<ImMessage> = {}): ImMessage {
  return {
    id: 'm-1',
    sessionId: 'ses-1',
    sender: 'agent-x',
    body: 'done',
    eventType: 'm.room.message',
    streamSessionId: 's-1',
    parentStreamSessionId: null,
    segmentOf: null,
    segmentIndex: null,
    status: 'done',
    source: 'local',
    workspaceId: 'ws-1',
    taskId: null,
    contextJson: null,
    createdAt: 1757000000000,
    updatedAt: 1757000000000,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<JournalEntryView> = {}): JournalEntryView {
  return {
    id: 'je-1',
    workspaceId: 'ws-1',
    taskId: 'task-1',
    sessionId: 'ses-1',
    streamSessionId: 's-1',
    toolName: 'write_file',
    path: 'src/app.ts',
    op: 'modify',
    beforeHash: 'hb',
    afterHash: 'ha',
    oldPath: null,
    createdAt: 1_757_000_001_000,
    beforeText: 'a\nb',
    afterText: 'a\nb\nc',
    ...overrides,
  };
}

beforeEach(() => {
  listMock.mockReset();
});

describe('TaskChangesView（任务详情·变更查看）', () => {
  it('空账 → 不渲染（不占位）', async () => {
    listMock.mockResolvedValue([]);
    const { container } = render(<TaskChangesView workspaceId="ws-1" taskId="task-1" />);
    await screen.findByTestId('task-changes-view').catch(() => null);
    expect(container.querySelector('[data-testid="task-changes-view"]')).toBeNull();
  });

  it('查询失败 → 不渲染（错误路径，warn 不弹错）', async () => {
    listMock.mockRejectedValue(new Error('ipc down'));
    const { container } = render(<TaskChangesView workspaceId="ws-1" taskId="task-1" />);
    // 微任务排空后仍不渲染
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('[data-testid="task-changes-view"]')).toBeNull();
  });

  it('有账 → 按 taskId scope 查询 + 头部「N 处变更 · M 个文件」（同 path 归一文件数）', async () => {
    listMock.mockResolvedValue([
      makeEntry({ id: 'je-1', path: 'src/app.ts' }),
      makeEntry({ id: 'je-2', path: 'src/app.ts', op: 'create' }),
      makeEntry({ id: 'je-3', path: 'docs/guide.md' }),
    ]);
    render(<TaskChangesView workspaceId="ws-1" taskId="task-1" />);
    expect(await screen.findByTestId('task-changes-view')).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith({ workspaceId: 'ws-1', taskId: 'task-1' });
    expect(screen.getByText('3 处变更 · 2 个文件')).toBeInTheDocument();
  });

  it('展开：文件行（rename → 箭头）+ 就地 diff + 行尾条数', async () => {
    listMock.mockResolvedValue([
      makeEntry({ id: 'je-1', path: 'src/app.ts', beforeText: 'a\nb', afterText: 'a\nb\nc' }),
      makeEntry({
        id: 'je-2',
        path: 'docs/dev/auth-notes.md',
        op: 'rename',
        oldPath: 'docs/auth-notes.md',
      }),
    ]);
    render(<TaskChangesView workspaceId="ws-1" taskId="task-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /2 处变更 · 2 个文件/ }));

    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    expect(screen.getByText('docs/auth-notes.md → docs/dev/auth-notes.md')).toBeInTheDocument();

    fireEvent.click(screen.getByText('src/app.ts'));
    expect(screen.getByTestId('changes-diff')).toBeInTheDocument();
    expect(screen.getByTestId('changes-diff')).toHaveTextContent('+c');
  });

  it('纯查看契约：无「撤回」「回滚」动作按钮（回归锁）', async () => {
    listMock.mockResolvedValue([makeEntry()]);
    render(<TaskChangesView workspaceId="ws-1" taskId="task-1" />);
    await screen.findByTestId('task-changes-view');
    expect(screen.queryByRole('button', { name: /撤回|回滚/ })).toBeNull();
  });

  it('一致性锁：容器与头行 className 与气泡 ChangesChip 逐字相等（宿主 margin 除外）', async () => {
    listMock.mockImplementation(async (scope: { streamSessionId?: string; taskId?: string }) =>
      scope.taskId === 'task-1' ? [makeEntry()] : [makeEntry({ taskId: null })],
    );
    render(
      <div>
        <ChangesChip message={makeMessage()} />
        <TaskChangesView workspaceId="ws-1" taskId="task-1" />
      </div>,
    );
    const chip = await screen.findByTestId('changes-chip');
    const view = await screen.findByTestId('task-changes-view');
    // 容器唯一允许差异：宿主侧 margin（chip 在气泡体内带 mt-1；任务面板由
    // space-y-3 统一间距）——边框/底色/圆角/排版类必须逐字一致
    const stripHostMargin = (cls: string): string => cls.replace(/(^|\s)mt-\S+/g, '').trim();
    expect(stripHostMargin(view.className)).toBe(stripHostMargin(chip.className));
    expect(view.querySelector('button')?.className).toBe(chip.querySelector('button')?.className);
  });
});
