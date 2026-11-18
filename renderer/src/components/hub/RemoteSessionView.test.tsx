// RemoteSessionView 全宽组件测试（spec 2026-11-17 §7.2）——store 直植状态：
// 1. 帧渲染：text 气泡（streaming 光标类）/ tool → ToolCallChip（名称+结果）/
//    steer → user 气泡 + 「指令」徽标 / user 帧 → 右对齐 user 气泡
// 2. miss → 人话占位 + 重试按钮；error → 人话错误行
// 3. 降级（wire2=false）→ legacy 消息旧样式渲染（工具文本行「调用工具 X」）
// 4. 加载更早按钮 → store.loadEarlier
// 5. 会话头：节点名 · run 号 · 实时/已断开徽标
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { RemoteSessionView } from './RemoteSessionView';
import { useRemoteSessionStore } from '../../stores/remote-session.view';
import { useUiStore } from '../../stores/ui.store';
import type { HubViewFrame, HubViewMessage } from '../../ipc/types';

const frame = (over: Partial<HubViewFrame> & Pick<HubViewFrame, 'frameId' | 'seq'>): HubViewFrame => ({
  at: 1, role: 'assistant', kind: 'text', ...over,
});

function seedReady(over: Partial<ReturnType<typeof useRemoteSessionStore.getState>> = {}): void {
  useRemoteSessionStore.setState({
    phase: 'ready',
    errorText: null,
    target: { targetNodeId: 'node-b', workspaceName: 'ws-b', groupId: 'g-1', runNo: 2, nodeName: '节点B', sessionId: 'sx' },
    wire2: true,
    frames: [],
    legacy: [],
    hasMore: false,
    loadingEarlier: false,
    live: true,
    hubOnline: true,
    liveError: null,
    pendingSteers: [],
    ...over,
  });
}

const openMock = vi.fn().mockResolvedValue(undefined);
const closeMock = vi.fn();
const loadEarlierMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  useRemoteSessionStore.setState({
    phase: 'resolving', errorText: null, task: null, target: null, wire2: false,
    frames: [], legacy: [], hasMore: false, loadingEarlier: false,
    live: false, hubOnline: true, liveError: null, pendingSteers: [],
    open: openMock, close: closeMock, loadEarlier: loadEarlierMock,
    sendSteer: vi.fn().mockResolvedValue(undefined), retrySteer: vi.fn().mockResolvedValue(undefined), dropSteer: vi.fn(),
  });
});

describe('帧渲染', () => {
  it('text 气泡（streaming 帧带光标）+ tool chip + steer/user 气泡', () => {
    seedReady({
      frames: [
        frame({ frameId: 'u1', seq: 1, kind: 'user', role: 'user', content: '任务书' }),
        frame({ frameId: 'a1', seq: 2, kind: 'text', content: '回答正文' }),
        frame({ frameId: 'a2', seq: 3, kind: 'text', content: '流式中', streaming: true }),
        frame({ frameId: 't1', seq: 4, kind: 'tool', tool: { name: 'bash', argsExcerpt: 'ls', result: 'file', success: true } }),
        frame({ frameId: 's1', seq: 5, kind: 'steer', role: 'user', content: '先写测试' }),
      ],
    });
    render(<RemoteSessionView />);
    expect(screen.getByText('任务书')).toBeInTheDocument();
    expect(screen.getByText('回答正文')).toBeInTheDocument();
    expect(screen.getByText('流式中')).toBeInTheDocument();
    expect(screen.getByText('生成中…')).toBeInTheDocument();
    expect(screen.getByText('bash')).toBeInTheDocument();
    expect(screen.getByText('先写测试')).toBeInTheDocument();
    expect(screen.getByText('指令')).toBeInTheDocument();
  });

  it('pendingSteers 乐观气泡 + 送达徽标渲染在帧尾', () => {
    seedReady({
      pendingSteers: [{ id: 'p1', text: '刚发出的指令', state: 'sent' }],
    });
    render(<RemoteSessionView />);
    expect(screen.getByText('刚发出的指令')).toBeInTheDocument();
    expect(screen.getByText(/送达/)).toBeInTheDocument();
  });
});

describe('miss / error 态', () => {
  it('miss → 人话占位 + 重试按钮（重试 = close+open）', () => {
    useRemoteSessionStore.setState({ phase: 'miss' });
    render(<RemoteSessionView />);
    expect(screen.getByText(/未找到执行会话/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    expect(closeMock).toHaveBeenCalled();
  });

  it('error → 人话错误行', () => {
    useRemoteSessionStore.setState({ phase: 'error', errorText: '目标节点不在线——连接恢复后可重试' });
    render(<RemoteSessionView />);
    expect(screen.getByText(/目标节点不在线/)).toBeInTheDocument();
  });
});

describe('降级渲染', () => {
  it('wire2=false → legacy 消息旧样式（工具文本行「调用工具 X」）', () => {
    const legacy: HubViewMessage[] = [
      { seq: 1, at: 1, role: 'assistant', content: '调用工具 bash' },
      { seq: 2, at: 2, role: 'user', content: '用户行' },
      { seq: 3, at: 3, role: 'assistant', content: '正文行' },
    ];
    seedReady({ wire2: false, legacy, frames: [] });
    render(<RemoteSessionView />);
    expect(screen.getByText('bash')).toBeInTheDocument();
    expect(screen.getByText('用户行')).toBeInTheDocument();
    expect(screen.getByText('正文行')).toBeInTheDocument();
    expect(screen.getByText(/简版回放/)).toBeInTheDocument();
  });
});

describe('分页与会话头', () => {
  it('hasMore → 加载更早按钮触发 loadEarlier', () => {
    seedReady({ hasMore: true });
    render(<RemoteSessionView />);
    fireEvent.click(screen.getByRole('button', { name: /加载更早/ }));
    expect(loadEarlierMock).toHaveBeenCalled();
  });

  it('会话头：节点名 · run 号 · 实时徽标；断开降文案', () => {
    seedReady();
    const { rerender } = render(<RemoteSessionView />);
    expect(screen.getAllByText(/节点B/).length).toBeGreaterThan(0);
    expect(screen.getByText(/run #2/)).toBeInTheDocument();
    expect(screen.getByText('实时')).toBeInTheDocument();
    useRemoteSessionStore.setState({ live: false, hubOnline: false });
    rerender(<RemoteSessionView />);
    expect(screen.getByText(/已断开/)).toBeInTheDocument();
  });
});

// ── 终审 C1/C6：入口接线与切换关闭 ───────────────────────────────────────────

describe('入口接线与切换关闭（终审修复）', () => {
  it('挂载即触发 open(task)（ui.remoteSessionView.task → store.open）', async () => {
    const task = { id: 'T-1' } as never;
    useUiStore.setState({ remoteSessionView: { task }, activeView: 'im' });
    render(<RemoteSessionView />);
    await waitFor(() => expect(openMock).toHaveBeenCalledWith(task));
  });

  it('同任务重挂载不重复 open；换任务才重新 open', async () => {
    const t1 = { id: 'T-1' } as never;
    const t2 = { id: 'T-2' } as never;
    useUiStore.setState({ remoteSessionView: { task: t1 }, activeView: 'im' });
    const { rerender } = render(<RemoteSessionView />);
    await waitFor(() => expect(openMock).toHaveBeenCalledTimes(1));
    rerender(<RemoteSessionView />);
    expect(openMock).toHaveBeenCalledTimes(1);
    useUiStore.setState({ remoteSessionView: { task: t2 } });
    rerender(<RemoteSessionView />);
    await waitFor(() => expect(openMock).toHaveBeenCalledWith(t2));
  });

  it('remoteSessionView 置空（切视图/切会话收口）→ store.close + 清 ui 态', async () => {
    useUiStore.setState({ remoteSessionView: { task: { id: 'T-1' } as never }, activeView: 'im' });
    render(<RemoteSessionView />);
    await waitFor(() => expect(openMock).toHaveBeenCalled());
    useUiStore.getState().closeRemoteSession();
    await waitFor(() => expect(closeMock).toHaveBeenCalled());
  });
});

// ── 终审修复补丁：StrictMode 双挂载不死 ─────────────────────────────────────

describe('StrictMode 双挂载', () => {
  it('卸载→重挂载（同 ui 态）→ 视图仍工作：卸载清理不得清 remoteSessionView', async () => {
    const task = { id: 'T-9' } as never;
    useUiStore.setState({ remoteSessionView: { task }, activeView: 'im' });
    const { unmount } = render(<RemoteSessionView />);
    await waitFor(() => expect(openMock).toHaveBeenCalledWith(task));
    unmount();
    // StrictMode 第二次挂载：ui 态未变（remoteSessionView 仍在）
    expect(useUiStore.getState().remoteSessionView).not.toBeNull();
    render(<RemoteSessionView />);
    await waitFor(() => {
      expect(screen.getByTestId('remote-session-view')).toBeInTheDocument();
    });
  });
});
