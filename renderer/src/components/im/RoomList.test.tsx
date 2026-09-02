// renderer/src/components/im/RoomList.test.tsx
//
// v25 Task 14：会话列表项图标语义派生测试（spec §6.2/§7）。
// 图标从 members（有效成员，三表 JOIN 产物）派生、不持久化创建方式：
//   - 单成员会话 → 该 agent 的 emoji（缺失时 Bot 图标兜底，v2.1 终审 lucide 化）
//   - 多成员会话 → 成员 icon 组（leader Crown 前缀置首），最多 3 个 + 溢出 +N 计数
//   - 成员全失效（空数组）→ MessageSquare 兜底（会话只读的可见信号）
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

describe('RoomList — 列表项图标语义派生', () => {
  it('单成员会话显示该 agent 的 emoji（不加 leader Crown）', () => {
    sessionState.sessions = [
      makeSession({
        id: 's1',
        title: '快速会话',
        members: [makeMember({ instanceId: 'i1', iconEmoji: '🦊', isLeader: true })],
      }),
    ];
    render(<RoomList />);
    expect(screen.getByText('🦊')).toBeInTheDocument();
    // 单成员路径不渲染任何 svg（无 Crown 标记、无 Bot 兜底——emoji 已存在）
    expect(screen.getByLabelText('会话图标').querySelector('svg')).not.toBeInTheDocument();
  });

  it('多成员会话显示 icon 组：leader Crown 前缀 + 其余成员 emoji', () => {
    sessionState.sessions = [
      makeSession({
        id: 's1',
        title: '协作会话',
        members: [
          makeMember({ instanceId: 'i1', agentName: '普通成员', iconEmoji: '🤖' }),
          makeMember({ instanceId: 'i2', agentName: '队长', iconEmoji: '🦊', isLeader: true }),
          makeMember({ instanceId: 'i3', agentName: '队员', iconEmoji: '🐳' }),
        ],
      }),
    ];
    render(<RoomList />);
    // leader chip 带 Crown svg 标记（title 含 leader 后缀）；非 leader chip 无 svg
    expect(screen.getByTitle('队长（leader）').querySelector('svg')).toBeInTheDocument();
    expect(screen.getByTitle('普通成员').querySelector('svg')).not.toBeInTheDocument();
    expect(screen.getByText('🦊')).toBeInTheDocument();
    expect(screen.getByText('🤖')).toBeInTheDocument();
    expect(screen.getByText('🐳')).toBeInTheDocument();
  });

  it('成员超过 3 个：只展示前 3 个 + 溢出计数 +N，第 4 个不渲染', () => {
    sessionState.sessions = [
      makeSession({
        id: 's1',
        title: '大队会话',
        members: [
          makeMember({ instanceId: 'i1', iconEmoji: '🦊', isLeader: true }),
          makeMember({ instanceId: 'i2', iconEmoji: '🤖' }),
          makeMember({ instanceId: 'i3', iconEmoji: '🐳' }),
          makeMember({ instanceId: 'i4', iconEmoji: '🐲' }),
        ],
      }),
    ];
    render(<RoomList />);
    // leader（i1，默认 agentName 'Agent'）带 Crown 置首
    expect(screen.getByTitle('Agent（leader）').querySelector('svg')).toBeInTheDocument();
    expect(screen.getByText('🦊')).toBeInTheDocument();
    expect(screen.getByText('🤖')).toBeInTheDocument();
    expect(screen.getByText('🐳')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.queryByText('🐲')).not.toBeInTheDocument();
  });

  it('成员无 iconEmoji → Bot 图标兜底（不落 🤖 字符）', () => {
    sessionState.sessions = [
      makeSession({
        id: 's1',
        title: '会话',
        members: [makeMember({ instanceId: 'i1', iconEmoji: undefined })],
      }),
    ];
    render(<RoomList />);
    expect(screen.getByLabelText('会话图标').querySelector('svg')).toBeInTheDocument();
    expect(screen.queryByText('🤖')).not.toBeInTheDocument();
  });

  it('成员全失效（空数组）→ 兜底图标（aria-label="会话图标"）', () => {
    sessionState.sessions = [makeSession({ id: 's1', title: '只读会话', members: [] })];
    render(<RoomList />);
    expect(screen.getAllByLabelText('会话图标').length).toBeGreaterThan(0);
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
