// renderer/src/components/im/ChangesChip.test.tsx
//
// ChangesChip 纯查看模式测试（2026-09-28 回滚重构）：展开看 diff，
// 不再提供任何撤回动作（撤回统一走 TurnUndoButton）。
//   - 空账 / workspaceId null / 查询失败 → 不渲染（错误路径）
//   - 头部「N 处变更 · M 个文件」；展开文件行（rename → 箭头）+ diff
//   - 回归锁：界面无「撤回」「全部撤回」按钮（纯查看契约）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ImMessage, JournalEntryView } from '../../ipc/types';
import { ChangesChip } from './ChangesChip';

const listMock = vi.fn();

const mockApi = {
  journal: {
    list: listMock,
    revert: vi.fn(),
    scan: vi.fn(),
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
    taskId: null,
    sessionId: 'ses-1',
    streamSessionId: 's-1',
    toolName: 'write_file',
    path: 'src/app.ts',
    op: 'modify',
    beforeHash: 'hb',
    afterHash: 'ha',
    oldPath: null,
    createdAt: 1757000001000,
    beforeText: 'old-line',
    afterText: 'new-line',
    ...overrides,
  };
}

describe('ChangesChip — 纯查看模式', () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue([]);
  });

  it('空账 → 不渲染', async () => {
    const { container } = render(<ChangesChip message={makeMessage()} />);
    await waitForEmpty();
    expect(container.firstChild).toBeNull();
  });

  it('workspaceId null（旧数据）→ 不查询不渲染', async () => {
    const { container } = render(<ChangesChip message={makeMessage({ workspaceId: null })} />);
    expect(listMock).not.toHaveBeenCalled();
    expect(container.firstChild).toBeNull();
  });

  it('查询失败（reject）→ 降级不渲染不抛错（错误路径）', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listMock.mockRejectedValue(new Error('store 未注入'));
    const { container } = render(<ChangesChip message={makeMessage()} />);
    await waitForEmpty();
    expect(container.firstChild).toBeNull();
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it('2 条 2 文件 → 头部「2 处变更 · 2 个文件」；展开文件行（rename 箭头）+ diff', async () => {
    listMock.mockResolvedValue([
      makeEntry(),
      makeEntry({
        id: 'je-2',
        path: 'docs/new.md',
        op: 'rename',
        oldPath: 'docs/old.md',
        beforeText: 'same',
        afterText: 'same',
      }),
    ]);
    render(<ChangesChip message={makeMessage()} />);
    const chip = await screen.findByTestId('changes-chip');
    expect(chip).toHaveTextContent('2 处变更 · 2 个文件');

    fireEvent.click(chip.querySelector('button')!);
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    expect(screen.getByText('docs/old.md → docs/new.md')).toBeInTheDocument();

    fireEvent.click(screen.getByText('src/app.ts'));
    const diff = await screen.findByTestId('changes-diff');
    expect(diff).toHaveTextContent('old-line');
    expect(diff).toHaveTextContent('new-line');
  });

  it('回归锁：纯查看——界面无任何撤回按钮', async () => {
    listMock.mockResolvedValue([makeEntry()]);
    render(<ChangesChip message={makeMessage()} />);
    const chip = await screen.findByTestId('changes-chip');
    fireEvent.click(chip.querySelector('button')!);
    expect(screen.queryByRole('button', { name: /撤回/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /全部撤回/ })).not.toBeInTheDocument();
    expect(mockApi.journal.revert).not.toHaveBeenCalled();
  });
});

function waitForEmpty(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
