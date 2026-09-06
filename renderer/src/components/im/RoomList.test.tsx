// renderer/src/components/im/RoomList.test.tsx
//
// v2.2 bug 修复：会话列表项不再渲染任何图标（用户要求移除「各种图标」——
// 成员 emoji / Crown / Bot 兜底 / MessageSquare / +N 溢出计数全部下线；
// 成员身份信息在会话面板成员区查看）。悬停操作按钮（重命名/解散）保留。
// 入口已迁 SessionSidebarHeader（双常驻按钮）：列表不再渲染「+ 新建会话」。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SessionMemberInfo, SessionSummary } from '../../ipc/types';

// vi.hoisted：mock store 状态在 vi.mock 工厂注册前完成初始化
const { sessionState, workspaceState } = vi.hoisted(() => ({
  sessionState: {
    sessions: [] as SessionSummary[],
    activeSessionId: null as string | null,
    selectSession: vi.fn(),
    loadSessions: vi.fn(),
    refreshSessionList: vi.fn(),
    loading: false,
  },
  workspaceState: {
    activeWorkspaceId: 'ws-1',
  },
}));

vi.mock('../../stores/session.store', () => ({
  useSessionStore: (selector: (s: typeof sessionState) => unknown) => selector(sessionState),
}));
vi.mock('../../stores/workspace.store', () => ({
  useWorkspaceStore: (selector: (s: typeof workspaceState) => unknown) => selector(workspaceState),
}));

import { RoomList } from './RoomList';

/** 构造会话成员（默认非 leader） */
function makeMember(overrides: Partial<SessionMemberInfo>): SessionMemberInfo {
  return {
    instanceId: 'inst-1',
    agentName: 'Agent',
    iconEmoji: '🤖',
    lastRunning: true,
    isLeader: false,
    ...overrides,
  };
}

/** 构造会话列表项 */
function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    workspaceId: 'ws-1',
    title: '会话',
    titleAuto: false,
    kind: 'chat',
    lastMessageAt: null,
    members: [],
    ...overrides,
  };
}

function resetState(): void {
  sessionState.sessions = [];
  sessionState.activeSessionId = null;
  sessionState.selectSession = vi.fn().mockResolvedValue(undefined);
  sessionState.loadSessions = vi.fn().mockResolvedValue(undefined);
  sessionState.refreshSessionList = vi.fn();
  sessionState.loading = false;
}

beforeEach(() => {
  resetState();
  // RoomList 的重命名/解散走 ipc（本文件不触发，防误炸兜底注入）。
  // 合并进 jsdom 现有 window（整体替换会丢 document 导致 react-dom 崩溃）
  Object.assign(window, { api: { session: { rename: vi.fn(), delete: vi.fn() } } });
});

describe('RoomList — 列表项不渲染图标（v2.2 移除）', () => {
  it('单成员会话不渲染成员 emoji', () => {
    sessionState.sessions = [
      makeSession({
        id: 's1',
        title: '快速会话',
        members: [makeMember({ instanceId: 'i1', iconEmoji: '🦊', isLeader: true })],
      }),
    ];
    render(<RoomList />);
    expect(screen.queryByText('🦊')).not.toBeInTheDocument();
    expect(screen.getByText('快速会话')).toBeInTheDocument();
  });

  it('多成员会话不渲染 icon 组（无 Crown svg / 无 +N 溢出计数 / 无 emoji）', () => {
    sessionState.sessions = [
      makeSession({
        id: 's1',
        title: '协作会话',
        members: [
          makeMember({ instanceId: 'i1', agentName: '普通成员', iconEmoji: '🤖' }),
          makeMember({ instanceId: 'i2', agentName: '队长', iconEmoji: '🦊', isLeader: true }),
          makeMember({ instanceId: 'i3', agentName: '队员', iconEmoji: '🐳' }),
          makeMember({ instanceId: 'i4', agentName: '队员2', iconEmoji: '🐲' }),
        ],
      }),
    ];
    render(<RoomList />);
    const rowButton = screen.getByRole('button', { name: /协作会话/ });
    expect(rowButton.querySelector('svg')).not.toBeInTheDocument();
    expect(screen.queryByText('🦊')).not.toBeInTheDocument();
    expect(screen.queryByText('🤖')).not.toBeInTheDocument();
    expect(screen.queryByText('🐳')).not.toBeInTheDocument();
    expect(screen.queryByText('+1')).not.toBeInTheDocument();
    expect(screen.queryByTitle('队长（leader）')).not.toBeInTheDocument();
  });

  it('成员全失效（空数组）不渲染兜底会话图标', () => {
    sessionState.sessions = [makeSession({ id: 's1', title: '只读会话', members: [] })];
    render(<RoomList />);
    expect(screen.queryByLabelText('会话图标')).not.toBeInTheDocument();
    expect(screen.getByText('只读会话')).toBeInTheDocument();
  });

  it('悬停操作按钮保留（重命名 / 解散）', () => {
    sessionState.sessions = [
      makeSession({ id: 's1', title: '会话A', members: [makeMember({ instanceId: 'i1' })] }),
    ];
    render(<RoomList />);
    expect(screen.getByLabelText('重命名')).toBeInTheDocument();
    expect(screen.getByLabelText('解散')).toBeInTheDocument();
  });

  it('点击列表项 → selectSession(会话 id)', () => {
    sessionState.sessions = [
      makeSession({
        id: 's1',
        title: '目标会话',
        members: [makeMember({ instanceId: 'i1', iconEmoji: '🦊' })],
      }),
    ];
    render(<RoomList />);
    fireEvent.click(screen.getByText('目标会话'));
    expect(sessionState.selectSession).toHaveBeenCalledWith('s1');
  });
});

describe('RoomList — 入口迁移与空态', () => {
  it('不再渲染「+ 新建会话」入口（已迁 SessionSidebarHeader 双按钮）', () => {
    sessionState.sessions = [makeSession({ id: 's1', title: '会话A' })];
    render(<RoomList />);
    expect(screen.queryByText('+ 新建会话')).not.toBeInTheDocument();
  });

  it('空会话列表引导使用上方入口按钮', () => {
    render(<RoomList />);
    // 空态接 EmptyState 后用按钮名称（非 emoji）描述引导路径
    expect(screen.getByText(/暂无会话/)).toBeInTheDocument();
    expect(screen.getByText(/快速会话/)).toBeInTheDocument();
    expect(screen.getByText(/协作会话/)).toBeInTheDocument();
  });
});
