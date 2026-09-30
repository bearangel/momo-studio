// renderer/src/components/im/BubbleToolbar.test.tsx
//
// 气泡工具条测试（2026-09-28）：动作簇随流状态切换 + 撤回挂载条件透传。
//   - streaming → 停止按钮（调 abortStream），无复制/撤回
//   - 终态 → 复制按钮（常显——与撤回统一可见）；canUndo=true 时含撤回按钮
//   - canUndo=false（如 aborted）→ 仅复制
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ImMessage } from '../../ipc/types';
import { useSessionStore } from '../../stores/session.store';
import { BubbleToolbar } from './BubbleToolbar';

const abortStreamMock = vi.fn();
const mockApi = {
  agent: { abortStream: abortStreamMock },
  journal: { list: vi.fn(), revert: vi.fn(), scan: vi.fn(), rollbackFileBefore: vi.fn(), preview: vi.fn() },
  session: { getMessages: vi.fn(), deleteMessages: vi.fn() },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

function makeMessage(overrides: Partial<ImMessage> = {}): ImMessage {
  return {
    id: 'a1',
    sessionId: 'ses-1',
    sender: 'agent-x',
    body: '回答内容',
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

function seedLatest(): void {
  useSessionStore.setState({
    activeSessionId: 'ses-1',
    messagesBySession: new Map([
      [
        'ses-1',
        [
          { ...makeMessage(), id: 'u1', sender: 'owner', streamSessionId: null },
          makeMessage(),
        ],
      ],
    ]),
    eventsByMessage: new Map(),
  });
}

describe('BubbleToolbar — 动作簇', () => {
  beforeEach(() => {
    abortStreamMock.mockReset().mockResolvedValue(undefined);
    mockApi.journal.list.mockReset().mockResolvedValue([]);
    seedLatest();
  });

  it('streaming → 停止按钮（调 abortStream），无复制/撤回', () => {
    render(<BubbleToolbar message={makeMessage()} isStreaming canUndo={false} />);
    fireEvent.click(screen.getByRole('button', { name: /停止/ }));
    expect(abortStreamMock).toHaveBeenCalledWith('s-1');
    expect(screen.queryByTestId('turn-undo-button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /复制/ })).not.toBeInTheDocument();
  });

  it('终态 + canUndo → 工具条含撤回（会话最新组）与复制', () => {
    render(<BubbleToolbar message={makeMessage()} isStreaming={false} canUndo />);
    const toolbar = screen.getByTestId('bubble-toolbar');
    expect(toolbar).toContainElement(screen.getByTestId('turn-undo-button'));
    expect(toolbar).toContainElement(screen.getByRole('button', { name: /复制/ }));
  });

  it('终态 + canUndo=false（aborted）→ 仅复制，无撤回', () => {
    render(<BubbleToolbar message={makeMessage()} isStreaming={false} canUndo={false} />);
    expect(screen.getByRole('button', { name: /复制/ })).toBeInTheDocument();
    expect(screen.queryByTestId('turn-undo-button')).not.toBeInTheDocument();
  });

  it('非会话最新消息（撤回自判）→ 工具条仅复制', () => {
    useSessionStore.setState({
      activeSessionId: 'ses-1',
      messagesBySession: new Map([
        [
          'ses-1',
          [
            { ...makeMessage(), id: 'u1', sender: 'owner', streamSessionId: null },
            makeMessage(),
            { ...makeMessage(), id: 'u2', sender: 'owner', streamSessionId: null },
          ],
        ],
      ]),
      eventsByMessage: new Map(),
    });
    render(<BubbleToolbar message={makeMessage()} isStreaming={false} canUndo />);
    expect(screen.getByRole('button', { name: /复制/ })).toBeInTheDocument();
    expect(screen.queryByTestId('turn-undo-button')).not.toBeInTheDocument();
  });
});
