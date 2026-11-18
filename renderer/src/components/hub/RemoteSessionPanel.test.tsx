// RemoteSessionPanel 测试（spec §12.1/§12.2/§12.3）——store 直植：
// 1. 穿插时间线：远端帧 + 本地镜像里程碑按时间戳穿插（同毫秒镜像先行）
// 2. 降级矩阵四态：miss 占位 / 旧 worker 简版 + 镜像穿插 / 断开徽标保留已到帧
// 3. composer 在场 + 加载更早
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { RemoteSessionPanel } from './RemoteSessionPanel';
import { useRemoteSessionStore } from '../../stores/remote-session.view';
import type { HubViewFrame, HubViewMessage, ImMessage } from '../../ipc/types';

const frame = (over: Partial<HubViewFrame> & Pick<HubViewFrame, 'frameId' | 'seq'>): HubViewFrame => ({
  at: 1_700_000_000_000, role: 'assistant', kind: 'text', ...over,
});

const mirror = (over: Partial<ImMessage> & Pick<ImMessage, 'id'>): ImMessage => ({
  sessionId: 'sx', sender: 'system', body: '里程碑行', eventType: 'delegation_milestone',
  streamSessionId: null, parentStreamSessionId: null, segmentOf: null, segmentIndex: null,
  status: 'done', source: 'hub', workspaceId: 'ws1', taskId: 'T-9',
  contextJson: null, createdAt: 1_700_000_000_000, updatedAt: 0, ...over,
});

function seedReady(over: Partial<ReturnType<typeof useRemoteSessionStore.getState>> = {}): void {
  useRemoteSessionStore.setState({
    phase: 'ready', errorText: null,
    task: { id: 'T-9', status: 'in_progress', executionSessionId: 'sx' } as never,
    target: { targetNodeId: 'node-b', workspaceName: 'ws-b', groupId: 'g', runNo: 1, nodeName: '节点B', sessionId: 'sx' },
    wire2: true, frames: [], legacy: [], mirrorRows: [], hasMore: false, loadingEarlier: false,
    live: true, hubOnline: true, liveError: null, pendingSteers: [],
    ...over,
  } as Partial<ReturnType<typeof useRemoteSessionStore.getState>>);
}

const loadEarlier = vi.fn();
const open = vi.fn().mockResolvedValue(undefined);
const close = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  useRemoteSessionStore.setState({
    phase: 'resolving', errorText: null, task: null, target: null, wire2: false,
    frames: [], legacy: [], mirrorRows: [], hasMore: false, loadingEarlier: false,
    live: false, hubOnline: true, liveError: null, pendingSteers: [],
    open, close, loadEarlier,
    sendSteer: vi.fn().mockResolvedValue(undefined), retrySteer: vi.fn().mockResolvedValue(undefined), dropSteer: vi.fn(),
  } as Partial<ReturnType<typeof useRemoteSessionStore.getState>>);
});

describe('穿插时间线（spec §12.2）', () => {
  it('镜像里程碑在帧之前（createdAt 早于帧 at）→ DOM 序：细行在前气泡在后', () => {
    seedReady({
      frames: [frame({ frameId: 'f1', seq: 5, at: 1_700_000_002_000, content: '远端正文' })],
      mirrorRows: [mirror({ id: 'm1', createdAt: 1_700_000_001_000, body: '已提交待验收' })],
    });
    const { container } = render(<RemoteSessionPanel sessionId="sx" workspaceId="ws1" />);
    const panel = screen.getByTestId('remote-session-panel');
    const texts = [...panel.querySelectorAll('[data-testid=remote-session-flow] *')].filter((e) => e.children.length === 0).map((e) => e.textContent);
    const mi = texts.findIndex((t) => t.includes('已提交待验收'));
    const fi = texts.findIndex((t) => t.includes('远端正文'));
    expect(mi).toBeGreaterThanOrEqual(0);
    expect(fi).toBeGreaterThanOrEqual(0);
    expect(mi).toBeLessThan(fi);
    expect(panel.textContent).toContain('已提交待验收');
    expect(panel.textContent).toContain('远端正文');
    void container;
  });

  it('同毫秒 tie-break：镜像行在前（稳定序防抖动）', () => {
    seedReady({
      frames: [frame({ frameId: 'f1', seq: 5, at: 1_700_000_001_000, content: '同刻帧' })],
      mirrorRows: [mirror({ id: 'm1', createdAt: 1_700_000_001_000, body: '同刻里程碑' })],
    });
    render(<RemoteSessionPanel sessionId="sx" workspaceId="ws1" />);
    const panel = screen.getByTestId('remote-session-panel');
    expect(panel.textContent!.indexOf('同刻里程碑')).toBeLessThan(panel.textContent!.indexOf('同刻帧'));
  });

  it('镜像细行带时间（HHmm）与截断正文', () => {
    seedReady({
      frames: [],
      mirrorRows: [mirror({ id: 'm1', createdAt: new Date('2026-11-18T14:05:00').getTime(), body: '打回：理由'.repeat(20) })],
    });
    render(<RemoteSessionPanel sessionId="sx" workspaceId="ws1" />);
    expect(screen.getByText(/14:05/)).toBeInTheDocument();
    expect(screen.getByTestId('remote-session-panel').textContent!.length).toBeLessThan(('打回：理由'.repeat(20)).length + 200);
  });
});

describe('降级矩阵（spec §12.3）', () => {
  it('未开始 / miss → 人话占位 + 重试钮', () => {
    useRemoteSessionStore.setState({ phase: 'miss' });
    render(<RemoteSessionPanel sessionId="sx" workspaceId="ws1" />);
    expect(screen.getByText(/未找到执行会话/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    expect(close).toHaveBeenCalled();
  });

  it('旧 worker（wire2=false）→ legacy 行 + 镜像穿插 + 简版徽标', () => {
    seedReady({
      wire2: false,
      frames: [],
      legacy: [{ seq: 2, at: 1_700_000_003_000, role: 'assistant', content: '旧投影正文行' } as HubViewMessage],
      mirrorRows: [mirror({ id: 'm1', createdAt: 1_700_000_002_000, body: '验收里程碑' })],
    });
    render(<RemoteSessionPanel sessionId="sx" workspaceId="ws1" />);
    const txt = screen.getByTestId('remote-session-panel').textContent!;
    expect(txt).toContain('旧投影正文行');
    expect(txt).toContain('验收里程碑');
    expect(txt).toContain('简版回放');
    expect(txt.indexOf('验收里程碑')).toBeLessThan(txt.indexOf('旧投影正文行'));
  });

  it('断开 → 徽标在场 + 已到帧保留', () => {
    seedReady({ live: false, hubOnline: false, frames: [frame({ frameId: 'f1', seq: 1, content: '断前帧' })] });
    render(<RemoteSessionPanel sessionId="sx" workspaceId="ws1" />);
    const txt = screen.getByTestId('remote-session-panel').textContent!;
    expect(txt).toContain('已断开');
    expect(txt).toContain('断前帧');
  });

  it('error 态 → 人话错误行', () => {
    useRemoteSessionStore.setState({ phase: 'error', errorText: '目标节点不在线——连接恢复后可重试' });
    render(<RemoteSessionPanel sessionId="sx" workspaceId="ws1" />);
    expect(screen.getByText(/目标节点不在线/)).toBeInTheDocument();
  });
});

describe('面板附属件', () => {
  it('composer 在场（RemoteSteerComposer 渲染）+ 加载更早触发 loadEarlier', () => {
    seedReady({ hasMore: true });
    render(<RemoteSessionPanel sessionId="sx" workspaceId="ws1" />);
    expect(screen.getByTestId('remote-steer-composer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /加载更早/ }));
    expect(loadEarlier).toHaveBeenCalled();
  });

  it('头部状态条：节点名 + run 号 + 实时徽标', () => {
    seedReady();
    render(<RemoteSessionPanel sessionId="sx" workspaceId="ws1" />);
    const txt = screen.getByTestId('remote-session-panel').textContent!;
    expect(txt).toContain('节点B');
    expect(txt).toContain('run #1');
    expect(txt).toContain('实时');
  });
});


// ── 终审 Important 2：任务解析失败（孤儿跟踪会话）不得永久 spinner ────────────

describe('resolve-null 死端（终审 Important 2）', () => {
  it('resolveTrackingTask 返回 null → miss 样占位 + 重试钮（非永久定位中）', async () => {
    (globalThis as unknown as { window: { api: unknown } }).window.api = {
      task: { get: vi.fn().mockResolvedValue(null), list: vi.fn().mockResolvedValue([]) },
    };
    render(<RemoteSessionPanel sessionId="orphan" workspaceId="ws1" />);
    await waitFor(() => {
      expect(screen.getByText(/未找到关联的委派任务/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument();
  });
});
