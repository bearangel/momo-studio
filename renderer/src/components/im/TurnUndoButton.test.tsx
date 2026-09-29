// renderer/src/components/im/TurnUndoButton.test.tsx
//
// 逐层撤回测试（rollback UI 重设计 2026-09-28）：TurnUndoButton 挂载条件 +
// TurnUndoDialog 两种形态 + 确认链（revert → deleteMessages → reload）+ 失败路径。
// mock 形态照抄 ChangesChip.test（window.api 桩）；session store 用真实 store
// 直接 setState（消息列表与会话激活态）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ImMessage, JournalEntryView } from '../../ipc/types';
import { useSessionStore } from '../../stores/session.store';
import { TurnUndoButton } from './TurnUndoButton';

const journalListMock = vi.fn();
const previewMock = vi.fn();
const revertMock = vi.fn();
const deleteMessagesMock = vi.fn();
const getMessagesMock = vi.fn();

const mockApi = {
  journal: {
    list: journalListMock,
    revert: revertMock,
    scan: vi.fn(),
    rollbackFileBefore: vi.fn(),
    preview: previewMock,
  },
  session: {
    getMessages: getMessagesMock,
    deleteMessages: deleteMessagesMock,
  },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

function msg(overrides: Partial<ImMessage> & Pick<ImMessage, 'id' | 'sender'>): ImMessage {
  return {
    sessionId: 'ses-1',
    body: '',
    eventType: 'm.room.message',
    streamSessionId: null,
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
    path: '123.txt',
    op: 'create',
    beforeHash: null,
    afterHash: 'ha',
    oldPath: null,
    createdAt: 1757000001000,
    beforeText: null,
    afterText: '123test',
    ...overrides,
  };
}

/** 一组对话的典型消息序列：owner 提问 + agent 回复（流 s-1） */
function turnMessages(): ImMessage[] {
  return [
    msg({ id: 'u1', sender: 'owner', createdAt: 1 }),
    msg({ id: 'a1', sender: 'agent-x', streamSessionId: 's-1', createdAt: 2 }),
  ];
}

function seedSession(messages: ImMessage[]): void {
  useSessionStore.setState({
    activeSessionId: 'ses-1',
    messagesBySession: new Map([['ses-1', messages]]),
    eventsByMessage: new Map(),
  });
}

describe('TurnUndoButton — 挂载条件', () => {
  beforeEach(() => {
    journalListMock.mockReset().mockResolvedValue([]);
    previewMock.mockReset().mockResolvedValue([]);
    revertMock.mockReset().mockResolvedValue([]);
    deleteMessagesMock.mockReset().mockResolvedValue({ deletedIds: [] });
    getMessagesMock.mockReset().mockResolvedValue({ messages: [], eventsByMessage: {} });
  });

  it('非会话最后一条消息 → 不渲染', () => {
    seedSession([
      msg({ id: 'u1', sender: 'owner', createdAt: 1 }),
      msg({ id: 'a1', sender: 'agent-x', streamSessionId: 's-1', createdAt: 2 }),
      msg({ id: 'u2', sender: 'owner', createdAt: 3 }),
    ]);
    const { container } = render(<TurnUndoButton message={msg({ id: 'a1', sender: 'agent-x', streamSessionId: 's-1' })} />);
    expect(container.firstChild).toBeNull();
  });

  it('workspaceId null → 不渲染', () => {
    seedSession(turnMessages());
    const { container } = render(
      <TurnUndoButton message={msg({ id: 'a1', sender: 'agent-x', streamSessionId: 's-1', workspaceId: null })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('会话最后一条 agent 消息 → 「撤回」按钮渲染', () => {
    seedSession(turnMessages());
    render(<TurnUndoButton message={msg({ id: 'a1', sender: 'agent-x', streamSessionId: 's-1' })} />);
    expect(screen.getByTestId('turn-undo-button')).toBeInTheDocument();
  });
});

describe('TurnUndoDialog — 有变更组（弹窗 A）', () => {
  beforeEach(() => {
    journalListMock.mockReset();
    previewMock.mockReset();
    revertMock.mockReset().mockResolvedValue([]);
    deleteMessagesMock.mockReset().mockResolvedValue({ deletedIds: ['u1', 'a1'] });
    getMessagesMock.mockReset().mockResolvedValue({ messages: [], eventsByMessage: {} });
    seedSession(turnMessages());
  });

  it('打开 → 匹配组条目 + 预检 → 警告文案与文件清单 → 确认 → revert + deleteMessages + reload', async () => {
    journalListMock.mockResolvedValue([
      makeEntry(),
      makeEntry({ id: 'je-other', streamSessionId: 's-older', path: 'older.txt' }),
    ]);
    previewMock.mockResolvedValue([{ id: 'je-1', path: '123.txt', result: 'reverted' }]);
    revertMock.mockResolvedValue([{ id: 'je-1', path: '123.txt', result: 'reverted' }]);

    render(<TurnUndoButton message={msg({ id: 'a1', sender: 'agent-x', streamSessionId: 's-1' })} />);
    fireEvent.click(screen.getByTestId('turn-undo-button'));

    const dialog = await screen.findByRole('dialog');
    // 只匹配本组流（s-1）的条目——older.txt（s-older 流）不混入
    expect(await within(dialog).findByText(/删除这组对话（提问 \+ 回复），并整体还原它修改的 1 个文件/)).toBeInTheDocument();
    expect(within(dialog).getByText('将还原 / 删除（1 处）：')).toBeInTheDocument();
    expect(within(dialog).getByText('123.txt')).toBeInTheDocument();
    expect(within(dialog).queryByText('older.txt')).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByTestId('turn-undo-confirm-btn'));
    await waitFor(() =>
      expect(revertMock).toHaveBeenCalledWith('ws-1', ['je-1'], undefined),
    );
    await waitFor(() =>
      expect(deleteMessagesMock).toHaveBeenCalledWith('ses-1', ['u1', 'a1']),
    );
    // reloadMessages 走 getMessages 重拉
    await waitFor(() => expect(getMessagesMock).toHaveBeenCalledWith('ses-1'));
  });

  it('漂移预检 → 黄标 + 强制勾选；勾选后确认 → revert(…, { force: true })', async () => {
    journalListMock.mockResolvedValue([makeEntry()]);
    previewMock.mockResolvedValue([{ id: 'je-1', path: '123.txt', result: 'skipped-diverged' }]);
    revertMock.mockResolvedValue([{ id: 'je-1', path: '123.txt', result: 'skipped-diverged' }]);

    render(<TurnUndoButton message={msg({ id: 'a1', sender: 'agent-x', streamSessionId: 's-1' })} />);
    fireEvent.click(screen.getByTestId('turn-undo-button'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('将跳过 1 处（文件在记账后被修改）：')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByTestId('turn-undo-force-override'));
    fireEvent.click(within(dialog).getByTestId('turn-undo-confirm-btn'));
    await waitFor(() => expect(revertMock).toHaveBeenCalledWith('ws-1', ['je-1'], { force: true }));
    await waitFor(() => expect(deleteMessagesMock).toHaveBeenCalled());
  });
});

describe('TurnUndoDialog — 纯聊天组（弹窗 B）', () => {
  beforeEach(() => {
    journalListMock.mockReset().mockResolvedValue([]);
    previewMock.mockReset();
    revertMock.mockReset().mockResolvedValue([]);
    deleteMessagesMock.mockReset().mockResolvedValue({ deletedIds: ['u1', 'a1'] });
    getMessagesMock.mockReset().mockResolvedValue({ messages: [], eventsByMessage: {} });
    seedSession(turnMessages());
  });

  it('无条目 → 「没有修改任何文件」→ 确认删除 → 只 deleteMessages 不 revert', async () => {
    render(<TurnUndoButton message={msg({ id: 'a1', sender: 'agent-x', streamSessionId: 's-1' })} />);
    fireEvent.click(screen.getByTestId('turn-undo-button'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/这组对话没有修改任何文件/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '确认删除' })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));
    await waitFor(() =>
      expect(deleteMessagesMock).toHaveBeenCalledWith('ses-1', ['u1', 'a1']),
    );
    expect(revertMock).not.toHaveBeenCalled();
  });
});

describe('TurnUndoDialog — 失败路径', () => {
  beforeEach(() => {
    journalListMock.mockReset();
    previewMock.mockReset();
    revertMock.mockReset();
    deleteMessagesMock.mockReset();
    getMessagesMock.mockReset().mockResolvedValue({ messages: [], eventsByMessage: {} });
    seedSession(turnMessages());
  });

  it('revert 出 failed → 停在错误态不删气泡（错误不静默）', async () => {
    journalListMock.mockResolvedValue([makeEntry()]);
    previewMock.mockResolvedValue([{ id: 'je-1', path: '123.txt', result: 'reverted' }]);
    revertMock.mockResolvedValue([
      { id: 'je-1', path: '123.txt', result: 'failed', detail: 'before 内容 blob 缺失' },
    ]);

    render(<TurnUndoButton message={msg({ id: 'a1', sender: 'agent-x', streamSessionId: 's-1' })} />);
    fireEvent.click(screen.getByTestId('turn-undo-button'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByTestId('turn-undo-confirm-btn'));

    const error = await within(dialog).findByTestId('turn-undo-error');
    expect(within(error).getByText(/1 处还原失败：123.txt/)).toBeInTheDocument();
    expect(deleteMessagesMock).not.toHaveBeenCalled();
  });

  it('journal.list 抛错 → 错误态呈现（不静默）', async () => {
    journalListMock.mockRejectedValue(new Error('journal store 未注入'));
    render(<TurnUndoButton message={msg({ id: 'a1', sender: 'agent-x', streamSessionId: 's-1' })} />);
    fireEvent.click(screen.getByTestId('turn-undo-button'));
    const dialog = await screen.findByRole('dialog');
    const error = await within(dialog).findByTestId('turn-undo-error');
    expect(within(error).getByText(/journal store 未注入/)).toBeInTheDocument();
  });

  it('无 owner 锚点（纯 agent 会话）→ 错误态「未找到可撤回的对话组」', async () => {
    seedSession([msg({ id: 'a1', sender: 'agent-x', streamSessionId: 's-1' })]);
    journalListMock.mockResolvedValue([]);
    render(<TurnUndoButton message={msg({ id: 'a1', sender: 'agent-x', streamSessionId: 's-1' })} />);
    fireEvent.click(screen.getByTestId('turn-undo-button'));
    const dialog = await screen.findByRole('dialog');
    const error = await within(dialog).findByTestId('turn-undo-error');
    expect(within(error).getByText('未找到可撤回的对话组')).toBeInTheDocument();
  });
});
