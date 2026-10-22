// renderer/src/components/im/RoomList.test.tsx
//
// v2.2 bug 修复：会话列表项不再渲染成员身份图标（用户要求移除「各种图标」——
// 成员 emoji / Crown / Bot 兜底 / +N 溢出计数全部下线；成员身份信息在会话面板
// 成员区查看）。悬停操作按钮（重命名/解散）保留。
// 入口已迁 SessionSidebarHeader（双常驻按钮）：列表不再渲染「+ 新建会话」。
//
// 2026-10-22 Task 7（spec §4，预览 A 批准定值）：列表项重新引入「类型图标」
// （Zap/Users/ListTodo——语义与会话双类型绑定，非成员身份）；新增分桶渲染
// （置顶区 → 分组 → 未分组）、组头折叠、色板面板、置顶/移动工具条。既有
// 「无成员图标」断言语义不变——类型图标恰好每行一枚成为新的锁定面。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { SessionGroupRow, SessionMemberInfo, SessionSummary } from '../../ipc/types';

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
    pinnedAt: null,
    groupId: null,
    groupName: null,
    sessionType: null,
    members: [],
    ...overrides,
  };
}

/** 构造分组行 */
function makeGroup(overrides: Partial<SessionGroupRow> & { id: string }): SessionGroupRow {
  return {
    workspaceId: 'ws-1',
    name: '分组',
    position: 1024,
    color: '#5E6AD2',
    createdAt: 0,
    ...overrides,
  };
}

/** 便捷读取当前 window.api 桩（ipc client 是 Proxy 直读 window.api） */
function apiSession(): {
  rename: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  setPinned: ReturnType<typeof vi.fn>;
  moveToGroup: ReturnType<typeof vi.fn>;
} {
  return (window as unknown as { api: { session: never } }).api.session;
}

function apiGroup(): {
  list: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  setColor: ReturnType<typeof vi.fn>;
} {
  return (window as unknown as { api: { sessionGroup: never } }).api.sessionGroup;
}

function resetState(): void {
  sessionState.sessions = [];
  sessionState.activeSessionId = null;
  sessionState.selectSession = vi.fn().mockResolvedValue(undefined);
  sessionState.loadSessions = vi.fn().mockResolvedValue(undefined);
  sessionState.refreshSessionList = vi.fn();
  sessionState.loading = false;
  // 「切换 workspace」用例会改写 activeWorkspaceId 且模块级状态跨用例存活——
  // 显式复位防泄漏到后续 describe（曾致折叠键/建组参数落到 ws-2）
  workspaceState.activeWorkspaceId = 'ws-1';
}

beforeEach(() => {
  resetState();
  // RoomList 的重命名/解散/置顶/归组/分组 CRUD 走 ipc（本文件既有用例不触发
  // sessionGroup 写面，防误炸兜底注入）。合并进 jsdom 现有 window（整体替换
  // 会丢 document 导致 react-dom 崩溃）。
  Object.assign(window, {
    api: {
      session: {
        rename: vi.fn(),
        delete: vi.fn(),
        setPinned: vi.fn().mockResolvedValue(undefined),
        moveToGroup: vi.fn().mockResolvedValue(undefined),
      },
      sessionGroup: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue(makeGroup({ id: 'g-new' })),
        rename: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        setColor: vi.fn().mockResolvedValue(undefined),
      },
    },
  });
  // 折叠持久化键按 workspace 隔离——测试间互不串扰
  localStorage.removeItem('momo.sessionGroups.collapsed.ws-1');
  localStorage.removeItem('momo.sessionGroups.collapsed.ws-2');
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

  it('多成员会话不渲染成员 icon 组（无 Crown svg / 无 +N 溢出计数 / 无 emoji；类型图标恰好一枚）', () => {
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
    // Task 7：行内恰好一枚 svg = 类型图标（协作会话）；成员身份 icon 组（Crown/
    // Bot 兜底/+N 溢出）仍为零——「无成员图标」语义不变，锁定面收紧为计数断言
    expect(rowButton.querySelectorAll('svg')).toHaveLength(1);
    expect(screen.getByLabelText('协作会话')).toBeInTheDocument();
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

describe('RoomList — 解散会话确认（D10：原生 confirm → ConfirmDialog）', () => {
  it('点「解散」→ 弹「解散会话」ConfirmDialog（含成员移除说明），未确认不调 delete', () => {
    sessionState.sessions = [makeSession({ id: 's1', title: '会话A' })];
    render(<RoomList />);
    fireEvent.click(screen.getByLabelText('解散'));

    const dialog = screen.getByRole('dialog', { name: '解散会话' });
    expect(within(dialog).getByText(/确定解散会话「会话A」/)).toBeInTheDocument();
    expect(within(dialog).getByText(/所有成员将被移除/)).toBeInTheDocument();
    expect((window as unknown as { api: { session: { delete: ReturnType<typeof vi.fn> } } }).api.session.delete).not.toHaveBeenCalled();
  });

  it('确认「解散」→ 调 ipc.session.delete + 刷新列表', async () => {
    sessionState.sessions = [makeSession({ id: 's1', title: '会话A' })];
    const del = (window as unknown as { api: { session: { delete: ReturnType<typeof vi.fn> } } }).api.session.delete;
    del.mockResolvedValue(undefined);
    render(<RoomList />);
    fireEvent.click(screen.getByLabelText('解散'));

    fireEvent.click(within(screen.getByRole('dialog', { name: '解散会话' })).getByRole('button', { name: '解散' }));

    await waitFor(() => expect(del).toHaveBeenCalledWith('s1'));
    expect(sessionState.refreshSessionList).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '解散会话' })).not.toBeInTheDocument(),
    );
  });

  it('点「取消」→ 不调 delete 且对话框关闭', () => {
    sessionState.sessions = [makeSession({ id: 's1', title: '会话A' })];
    const del = (window as unknown as { api: { session: { delete: ReturnType<typeof vi.fn> } } }).api.session.delete;
    render(<RoomList />);
    fireEvent.click(screen.getByLabelText('解散'));

    fireEvent.click(within(screen.getByRole('dialog', { name: '解散会话' })).getByRole('button', { name: '取消' }));

    expect(del).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '解散会话' })).not.toBeInTheDocument();
  });

  it('确认后 delete 失败 → alert 错误（错误路径回归锁）', async () => {
    sessionState.sessions = [makeSession({ id: 's1', title: '会话A' })];
    const del = (window as unknown as { api: { session: { delete: ReturnType<typeof vi.fn> } } }).api.session.delete;
    del.mockRejectedValue(new Error('会话不存在'));
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<RoomList />);
    fireEvent.click(screen.getByLabelText('解散'));

    fireEvent.click(within(screen.getByRole('dialog', { name: '解散会话' })).getByRole('button', { name: '解散' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('解散失败：会话不存在'));
    alertSpy.mockRestore();
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

describe('RoomList — 标题搜索过滤', () => {
  it('输入关键词 → 仅渲染标题命中的会话', () => {
    sessionState.sessions = [
      makeSession({ id: 's1', title: '需求分析' }),
      makeSession({ id: 's2', title: '日常闲聊' }),
    ];
    render(<RoomList />);
    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: '需求' } });
    expect(screen.getByText('需求分析')).toBeInTheDocument();
    expect(screen.queryByText('日常闲聊')).not.toBeInTheDocument();
  });

  it('大小写不敏感', () => {
    sessionState.sessions = [makeSession({ id: 's1', title: 'Release Notes' })];
    render(<RoomList />);
    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: 'release' } });
    expect(screen.getByText('Release Notes')).toBeInTheDocument();
  });

  it('无命中 → 「无匹配会话」空态（区别于「暂无会话」）', () => {
    sessionState.sessions = [makeSession({ id: 's1', title: '会话A' })];
    render(<RoomList />);
    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: 'zzz' } });
    expect(screen.getByText('无匹配会话')).toBeInTheDocument();
    expect(screen.queryByText('会话A')).not.toBeInTheDocument();
  });

  it('点击清除按钮 → 恢复全量列表', () => {
    sessionState.sessions = [
      makeSession({ id: 's1', title: '会话A' }),
      makeSession({ id: 's2', title: '会话B' }),
    ];
    render(<RoomList />);
    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: 'A' } });
    expect(screen.queryByText('会话B')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('清除搜索'));
    expect(screen.getByText('会话A')).toBeInTheDocument();
    expect(screen.getByText('会话B')).toBeInTheDocument();
  });

  it('过滤态下列表项点击 / 悬停操作不受影响', () => {
    sessionState.sessions = [
      makeSession({ id: 's1', title: '目标会话', members: [makeMember({ instanceId: 'i1' })] }),
    ];
    render(<RoomList />);
    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: '目标' } });
    fireEvent.click(screen.getByText('目标会话'));
    expect(sessionState.selectSession).toHaveBeenCalledWith('s1');
    expect(screen.getByLabelText('重命名')).toBeInTheDocument();
    expect(screen.getByLabelText('解散')).toBeInTheDocument();
  });

  it('切换 workspace 时清空过滤（spec §6）', () => {
    sessionState.sessions = [
      makeSession({ id: 's1', title: '会话A' }),
      makeSession({ id: 's2', title: '会话B' }),
    ];
    const { rerender } = render(<RoomList />);
    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: 'A' } });
    expect(screen.queryByText('会话B')).not.toBeInTheDocument();
    // 模拟切 workspace：mock store 状态变更 + rerender 触发 selector 重读
    workspaceState.activeWorkspaceId = 'ws-2';
    rerender(<RoomList />);
    expect(screen.getByText('会话A')).toBeInTheDocument();
    expect(screen.getByText('会话B')).toBeInTheDocument();
  });
});

describe('RoomList — 分桶渲染与类型图标（spec 2026-10-22 §4，预览 A 定值）', () => {
  /** 分桶场景：置顶（属 g1）→ g1 两项 → 未分组一项 */
  function setupBuckets(): void {
    sessionState.sessions = [
      makeSession({ id: 'sp', title: '置顶会话', pinnedAt: 100, groupId: 'g1', groupName: '项目 A' }),
      makeSession({ id: 'sa', title: '组内甲', groupId: 'g1', groupName: '项目 A' }),
      makeSession({ id: 'sb', title: '组内乙', groupId: 'g1', groupName: '项目 A' }),
      makeSession({ id: 'su', title: '未分组会话' }),
    ];
    apiGroup().list.mockResolvedValue([makeGroup({ id: 'g1', name: '项目 A' })]);
  }

  /** 文档序比较（组内行比组头多一层包裹 div，不能用兄弟下标） */
  function isBefore(a: Element, b: Element): boolean {
    return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }

  function rowEl(title: string): Element {
    const btn = screen.getByRole('button', { name: new RegExp(title) });
    return btn.parentElement!;
  }

  it('分桶顺序：置顶区（无组头）→ 组头「项目 A (2)」→ 组内项 → 未分组项', async () => {
    setupBuckets();
    render(<RoomList />);
    const header = await screen.findByTestId('session-group-header');
    expect(within(header).getByText('项目 A')).toBeInTheDocument();
    expect(within(header).getByText('(2)')).toBeInTheDocument();

    expect(isBefore(rowEl('置顶会话'), header)).toBe(true);
    expect(isBefore(header, rowEl('组内甲'))).toBe(true);
    expect(isBefore(rowEl('组内甲'), rowEl('组内乙'))).toBe(true);
    expect(isBefore(rowEl('组内乙'), rowEl('未分组会话'))).toBe(true);
  });

  it('空分组也渲染组头（计数 0）', async () => {
    sessionState.sessions = [makeSession({ id: 'su', title: '未分组会话' })];
    apiGroup().list.mockResolvedValue([makeGroup({ id: 'g0', name: '空组' })]);
    render(<RoomList />);
    const header = await screen.findByTestId('session-group-header');
    expect(within(header).getByText('空组')).toBeInTheDocument();
    expect(within(header).getByText('(0)')).toBeInTheDocument();
  });

  it('孤儿 groupId（组已删/不可见）回落未分组渲染（防御路径）', async () => {
    sessionState.sessions = [makeSession({ id: 's1', title: '孤儿会话', groupId: 'gx', groupName: '幽灵组' })];
    apiGroup().list.mockResolvedValue([]);
    render(<RoomList />);
    await waitFor(() => expect(screen.getByText('孤儿会话')).toBeInTheDocument());
    expect(screen.queryByTestId('session-group-header')).not.toBeInTheDocument();
  });

  it('类型图标三态：quick→快速会话 / collab→协作会话 / task_execution→任务执行会话', () => {
    sessionState.sessions = [
      makeSession({ id: 's1', title: '甲', sessionType: 'quick' }),
      makeSession({ id: 's2', title: '乙', sessionType: 'collab' }),
      makeSession({ id: 's3', title: '丙', kind: 'task_execution' }),
    ];
    render(<RoomList />);
    expect(screen.getByLabelText('快速会话')).toBeInTheDocument();
    expect(screen.getByLabelText('协作会话')).toBeInTheDocument();
    expect(screen.getByLabelText('任务执行会话')).toBeInTheDocument();
  });

  it('sessionType NULL 兜底按成员数推断（多成员=协作，单成员=快速）', () => {
    sessionState.sessions = [
      makeSession({ id: 's1', title: '甲', members: [makeMember({ instanceId: 'i1' })] }),
      makeSession({
        id: 's2',
        title: '乙',
        members: [makeMember({ instanceId: 'i2' }), makeMember({ instanceId: 'i3' })],
      }),
    ];
    render(<RoomList />);
    expect(screen.getByLabelText('快速会话')).toBeInTheDocument();
    expect(screen.getByLabelText('协作会话')).toBeInTheDocument();
  });

  it('置顶行渲染 Pin 标记；有组时 title 注明所属组（组身份随行走）', () => {
    sessionState.sessions = [
      makeSession({ id: 'sp', title: '置顶会话', pinnedAt: 1, groupId: 'g1', groupName: '项目 A' }),
    ];
    render(<RoomList />);
    expect(screen.getByLabelText('已置顶')).toBeInTheDocument();
    expect(screen.getByTitle('已置顶（属于 项目 A）')).toBeInTheDocument();
  });

  it('置顶行渲染 6px 组色圆点 + 组名后缀（圆点色 = 组色 light 档）', async () => {
    sessionState.sessions = [
      makeSession({ id: 'sp', title: '置顶会话', pinnedAt: 1, groupId: 'g1', groupName: '项目 A' }),
    ];
    apiGroup().list.mockResolvedValue([makeGroup({ id: 'g1', name: '项目 A', color: '#5E6AD2' })]);
    render(<RoomList />);
    // 圆点依赖 groups 异步加载（组色查表）——等加载完成再断言
    const dot = await screen.findByTestId('group-dot');
    // jsdom 浅主题（theme.store resolved=light）：#5E6AD2 → rgb(94, 106, 210)
    expect(dot).toHaveStyle({ backgroundColor: 'rgb(94, 106, 210)' });
  });

  it('组头整行组色 tint 底色（rgba .13 浅主题）', async () => {
    setupBuckets();
    render(<RoomList />);
    const header = await screen.findByTestId('session-group-header');
    expect(header).toHaveStyle({ backgroundColor: 'rgba(94, 106, 210, 0.13)' });
  });
});

describe('RoomList — 组头折叠与持久化', () => {
  function setupBuckets(): void {
    sessionState.sessions = [
      makeSession({ id: 'sa', title: '组内甲', groupId: 'g1', groupName: '项目 A' }),
      makeSession({ id: 'sb', title: '组内乙', groupId: 'g1', groupName: '项目 A' }),
    ];
    apiGroup().list.mockResolvedValue([makeGroup({ id: 'g1', name: '项目 A' })]);
  }

  it('点组头折叠：组内项消失、组头保留；折叠态写 localStorage', async () => {
    setupBuckets();
    render(<RoomList />);
    await screen.findByTestId('session-group-header');
    fireEvent.click(screen.getByTestId('session-group-header'));
    expect(screen.queryByText('组内甲')).not.toBeInTheDocument();
    expect(screen.queryByText('组内乙')).not.toBeInTheDocument();
    expect(screen.getByTestId('session-group-header')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('momo.sessionGroups.collapsed.ws-1')!)).toEqual(['g1']);
  });

  it('再点组头展开：组内项恢复', async () => {
    setupBuckets();
    render(<RoomList />);
    await screen.findByTestId('session-group-header');
    fireEvent.click(screen.getByTestId('session-group-header'));
    fireEvent.click(screen.getByTestId('session-group-header'));
    expect(screen.getByText('组内甲')).toBeInTheDocument();
    expect(screen.getByText('组内乙')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('momo.sessionGroups.collapsed.ws-1')!)).toEqual([]);
  });

  it('折叠态从 localStorage 恢复（挂载即折叠）', async () => {
    localStorage.setItem('momo.sessionGroups.collapsed.ws-1', JSON.stringify(['g1']));
    setupBuckets();
    render(<RoomList />);
    await screen.findByTestId('session-group-header');
    expect(screen.queryByText('组内甲')).not.toBeInTheDocument();
  });
});

describe('RoomList — 搜索拍平态（spec §4）', () => {
  it('非空搜索：无组头无置顶区结构，匹配行平铺；行保留类型图标 + 组色圆点 + 组名后缀', async () => {
    sessionState.sessions = [
      makeSession({ id: 'sp', title: '置顶会话', pinnedAt: 1, groupId: 'g1', groupName: '项目 A' }),
      makeSession({ id: 'sa', title: '组内甲', groupId: 'g1', groupName: '项目 A' }),
      makeSession({ id: 'su', title: '未分组会话' }),
    ];
    apiGroup().list.mockResolvedValue([makeGroup({ id: 'g1', name: '项目 A' })]);
    render(<RoomList />);
    await screen.findByTestId('session-group-header');
    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: '组内甲' } });

    expect(screen.queryByTestId('session-group-header')).not.toBeInTheDocument();
    expect(screen.getByText('组内甲')).toBeInTheDocument();
    expect(screen.queryByText('置顶会话')).not.toBeInTheDocument();
    // 拍平行保留组身份：圆点 + 组名后缀
    expect(screen.getByText('项目 A')).toBeInTheDocument();
    expect(document.querySelector('[data-testid="group-dot"]')).toBeInTheDocument();
  });

  it('搜索命中置顶行：保留 Pin 标记', () => {
    sessionState.sessions = [
      makeSession({ id: 'sp', title: '置顶会话', pinnedAt: 1 }),
    ];
    render(<RoomList />);
    fireEvent.change(screen.getByLabelText('搜索会话'), { target: { value: '置顶' } });
    expect(screen.getByText('置顶会话')).toBeInTheDocument();
    expect(screen.getByLabelText('已置顶')).toBeInTheDocument();
  });
});

describe('RoomList — 行工具条四钮与置顶（预览 A 定值）', () => {
  it('悬停工具条四钮：置顶 / 移动到分组 / 重命名 / 解散', () => {
    sessionState.sessions = [makeSession({ id: 's1', title: '会话A' })];
    render(<RoomList />);
    expect(screen.getByLabelText('置顶')).toBeInTheDocument();
    expect(screen.getByLabelText('移动到分组')).toBeInTheDocument();
    expect(screen.getByLabelText('重命名')).toBeInTheDocument();
    expect(screen.getByLabelText('解散')).toBeInTheDocument();
  });

  it('点「置顶」→ ipc.session.setPinned(id, true) + refreshSessionList', async () => {
    sessionState.sessions = [makeSession({ id: 's1', title: '会话A' })];
    render(<RoomList />);
    fireEvent.click(screen.getByLabelText('置顶'));
    await waitFor(() => expect(apiSession().setPinned).toHaveBeenCalledWith('s1', true));
    expect(sessionState.refreshSessionList).toHaveBeenCalled();
  });

  it('已置顶会话工具条为「取消置顶」→ setPinned(id, false)', async () => {
    sessionState.sessions = [makeSession({ id: 's1', title: '会话A', pinnedAt: 5 })];
    render(<RoomList />);
    fireEvent.click(screen.getByLabelText('取消置顶'));
    await waitFor(() => expect(apiSession().setPinned).toHaveBeenCalledWith('s1', false));
  });

  it('点「移动到分组」→ 打开 MoveToGroupDialog', async () => {
    sessionState.sessions = [makeSession({ id: 's1', title: '会话A' })];
    render(<RoomList />);
    fireEvent.click(screen.getByLabelText('移动到分组'));
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: '移动「会话A」到分组' })).toBeInTheDocument(),
    );
  });
});

describe('RoomList — 分组 CRUD 与组色面板', () => {
  it('搜索框旁 FolderPlus → PromptDialog 新建分组 → sessionGroup.create + 组列表重拉渲染', async () => {
    sessionState.sessions = [makeSession({ id: 's1', title: '会话A' })];
    apiGroup().list.mockResolvedValueOnce([]).mockResolvedValueOnce([makeGroup({ id: 'g1', name: '新组' })]);
    render(<RoomList />);
    fireEvent.click(screen.getByLabelText('新建分组'));
    const dialog = screen.getByRole('dialog', { name: '新建分组' });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '新组' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '确定' }));

    await waitFor(() => expect(apiGroup().create).toHaveBeenCalledWith('ws-1', '新组'));
    await waitFor(() => expect(screen.getByTestId('session-group-header')).toBeInTheDocument());
    expect(apiGroup().list).toHaveBeenCalledTimes(2);
  });

  it('新建分组失败 → alert 错误（错误路径）', async () => {
    sessionState.sessions = [makeSession({ id: 's1', title: '会话A' })];
    apiGroup().create.mockRejectedValue(new Error('分组名不能为空'));
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<RoomList />);
    fireEvent.click(screen.getByLabelText('新建分组'));
    const dialog = screen.getByRole('dialog', { name: '新建分组' });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '新组' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '确定' }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('新建分组失败：分组名不能为空'));
    alertSpy.mockRestore();
  });

  it('组头「重命名分组」→ PromptDialog 预填旧名 → rename + 组与会话列表双刷新', async () => {
    sessionState.sessions = [makeSession({ id: 'sa', title: '组内甲', groupId: 'g1', groupName: '项目 A' })];
    apiGroup().list.mockResolvedValue([makeGroup({ id: 'g1', name: '项目 A' })]);
    render(<RoomList />);
    await screen.findByTestId('session-group-header');
    fireEvent.click(screen.getByLabelText('重命名分组'));
    const dialog = screen.getByRole('dialog', { name: '重命名分组' });
    expect((within(dialog).getByRole('textbox') as HTMLInputElement).value).toBe('项目 A');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '项目 B' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '确定' }));

    await waitFor(() => expect(apiGroup().rename).toHaveBeenCalledWith('g1', '项目 B'));
    expect(sessionState.refreshSessionList).toHaveBeenCalled();
  });

  it('组头「删除分组」→ ConfirmDialog 文案明示会话回落 → delete + 双刷新', async () => {
    sessionState.sessions = [
      makeSession({ id: 'sa', title: '组内甲', groupId: 'g1', groupName: '项目 A' }),
      makeSession({ id: 'sb', title: '组内乙', groupId: 'g1', groupName: '项目 A' }),
    ];
    apiGroup().list.mockResolvedValue([makeGroup({ id: 'g1', name: '项目 A' })]);
    render(<RoomList />);
    await screen.findByTestId('session-group-header');
    fireEvent.click(screen.getByLabelText('删除分组'));
    const dialog = screen.getByRole('dialog', { name: '删除分组' });
    expect(within(dialog).getByText(/只删除分组，组内 2 个会话将回到未分组/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));

    await waitFor(() => expect(apiGroup().delete).toHaveBeenCalledWith('g1'));
    expect(sessionState.refreshSessionList).toHaveBeenCalled();
  });

  it('删除空分组文案 N=0', async () => {
    sessionState.sessions = [makeSession({ id: 'su', title: '未分组会话' })];
    apiGroup().list.mockResolvedValue([makeGroup({ id: 'g0', name: '空组' })]);
    render(<RoomList />);
    await screen.findByTestId('session-group-header');
    fireEvent.click(screen.getByLabelText('删除分组'));
    expect(screen.getByText(/只删除分组，组内 0 个会话将回到未分组/)).toBeInTheDocument();
  });

  it('色板面板：6 swatch + 恢复默认 + 自定义且零文字；点 swatch → setColor(组, 色板值)', async () => {
    sessionState.sessions = [makeSession({ id: 'sa', title: '组内甲', groupId: 'g1', groupName: '项目 A' })];
    apiGroup().list.mockResolvedValue([makeGroup({ id: 'g1', name: '项目 A' })]);
    render(<RoomList />);
    await screen.findByTestId('session-group-header');
    fireEvent.click(screen.getByLabelText('设置组色'));

    const panel = screen.getByTestId('group-palette');
    // 面板零文字：无可見文本内容
    expect(panel.textContent).toBe('');
    expect(within(panel).getAllByRole('button')).toHaveLength(8); // 6 swatch + 恢复默认 + 自定义

    fireEvent.click(within(panel).getByLabelText('色板 2'));
    await waitFor(() => expect(apiGroup().setColor).toHaveBeenCalledWith('g1', '#23835C'));
  });

  it('恢复默认 = GROUP_COLOR_PALETTE[组序 % 6]（第 0 组 → 首色；第 1 组 → 次色）', async () => {
    sessionState.sessions = [makeSession({ id: 'su', title: '未分组会话' })];
    apiGroup().list.mockResolvedValue([
      makeGroup({ id: 'g0', name: '甲组' }),
      makeGroup({ id: 'g1', name: '乙组' }),
    ]);
    render(<RoomList />);
    await waitFor(() => expect(screen.getAllByTestId('session-group-header')).toHaveLength(2));
    const headers = screen.getAllByTestId('session-group-header');
    fireEvent.click(within(headers[0]!).getByLabelText('设置组色'));
    fireEvent.click(within(screen.getByTestId('group-palette')).getByLabelText('恢复默认色'));
    await waitFor(() => expect(apiGroup().setColor).toHaveBeenCalledWith('g0', '#5E6AD2'));

    fireEvent.click(within(headers[1]!).getByLabelText('设置组色'));
    fireEvent.click(within(screen.getByTestId('group-palette')).getByLabelText('恢复默认色'));
    await waitFor(() => expect(apiGroup().setColor).toHaveBeenCalledWith('g1', '#23835C'));
  });

  it('自定义颜色：hex trim 后 setColor；非法值不发送', async () => {
    sessionState.sessions = [makeSession({ id: 'sa', title: '组内甲', groupId: 'g1', groupName: '项目 A' })];
    apiGroup().list.mockResolvedValue([makeGroup({ id: 'g1', name: '项目 A' })]);
    render(<RoomList />);
    await screen.findByTestId('session-group-header');
    fireEvent.click(screen.getByLabelText('设置组色'));
    fireEvent.click(within(screen.getByTestId('group-palette')).getByLabelText('自定义颜色'));

    const input = screen.getByLabelText('自定义颜色');
    // 首尾空白 + 合法 hex → trim 后发送（regex $ 尾换行洞由 renderer 堵）
    fireEvent.change(input, { target: { value: '  #A1B2C3  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(apiGroup().setColor).toHaveBeenCalledWith('g1', '#A1B2C3'));

    // 非法值 → 不发送
    fireEvent.click(within(screen.getByTestId('group-palette')).getByLabelText('自定义颜色'));
    const input2 = screen.getByLabelText('自定义颜色');
    fireEvent.change(input2, { target: { value: 'zzz' } });
    fireEvent.keyDown(input2, { key: 'Enter' });
    expect(apiGroup().setColor).toHaveBeenCalledTimes(1);
  });

  it('sessionGroup.list 失败 → 降级为无分组平铺，列表照常渲染（错误路径）', async () => {
    sessionState.sessions = [makeSession({ id: 's1', title: '会话A', groupId: 'g1', groupName: '项目 A' })];
    apiGroup().list.mockRejectedValue(new Error('db locked'));
    render(<RoomList />);
    await waitFor(() => expect(screen.getByText('会话A')).toBeInTheDocument());
    expect(screen.queryByTestId('session-group-header')).not.toBeInTheDocument();
  });
});
