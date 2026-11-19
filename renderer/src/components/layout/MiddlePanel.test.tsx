// renderer/src/components/layout/MiddlePanel.test.tsx
//
// M2.1 D1 回归锁：
//   1. 0-ws 主区引导——!workspace 分支渲染 EmptyState 引导 + 内嵌创建表单
//      （自 App.tsx 首启空态迁入；创建流程 store 断言 = 原 App 级回归锁平移）
//   2. workgroups 视图不依赖工作空间——workspace 守卫之前分发（UC8 新设备
//      0 空间可达工作组，D1 主壳化的前置契约）
// 重型视图组件打桩（本文件聚焦分支分发，子组件行为由各自测试覆盖）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useUiStore } from '../../stores/ui.store';
import { useSessionStore } from '../../stores/session.store';
import { useHubStore } from '../../stores/hub.store';
import { useHumanStore } from '../../stores/human.store';
import { useTaskStore } from '../../stores/task.store';
import type { SessionSummary, TaskRow } from '../../ipc/types';
import type { Workspace } from '../../ipc/types';

vi.mock('../editor/CodeEditor', () => ({ CodeEditor: () => <div data-testid="code-editor-stub" /> }));
vi.mock('../im/MessageList', () => ({ MessageList: () => <div /> }));
vi.mock('../im/MentionInput', () => ({ MentionInput: () => <div data-testid="mention-input-stub" /> }));
vi.mock('../im/MembersPanel', () => ({ MembersPanel: () => <div /> }));
vi.mock('../im/InputToolbar', () => ({ InputToolbar: () => <div /> }));
vi.mock('../im/RoomToolBudgetBadge', () => ({ RoomToolBudgetBadge: () => <div /> }));
vi.mock('../im/ExportChatButton', () => ({ ExportChatButton: () => <div /> }));
vi.mock('../im/TaskProgressButton', () => ({ TaskProgressButton: () => <div /> }));
vi.mock('../im/InFlightPanel', () => ({ InFlightPanel: () => <div /> }));
vi.mock('../im/HumanRequestPanel', () => ({
  HumanRequestPanel: ({ excludeKinds }: { excludeKinds?: readonly string[] }) => (
    <div data-testid="human-request-stub" data-exclude={(excludeKinds ?? []).join(',')} />
  ),
}));
vi.mock('../agent/AgentsView', () => ({ AgentsView: () => <div data-testid="agents-stub" /> }));
vi.mock('../settings/SettingsView', () => ({
  SettingsView: () => <div data-testid="settings-view-stub" />,
}));
vi.mock('../resource-library/ResourceLibraryView', () => ({
  ResourceLibraryView: () => <div />,
}));
vi.mock('../task-board/TaskBoardView', () => ({ TaskBoardView: () => <div /> }));
vi.mock('../workgroup/WorkgroupView', () => ({
  WorkgroupView: () => <div data-testid="workgroup-view-stub" />,
}));
vi.mock('../workspace/BrowserSidebar', () => ({ BrowserSidebar: () => <div /> }));
vi.mock('../plugins/PanelPageView', () => ({ PanelPageView: () => <div /> }));
vi.mock('../hub/RemoteSessionPanel', () => ({
  RemoteSessionPanel: ({ sessionId, footerSlot }: { sessionId: string; footerSlot?: React.ReactNode }) => (
    <div data-testid="remote-session-panel-stub" data-session={sessionId}>{footerSlot}</div>
  ),
}));
vi.mock('../hub/RemoteSteerComposer', () => ({
  RemoteSteerComposer: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="local-steer-stub" data-session={sessionId} />
  ),
}));

import { MiddlePanel } from './MiddlePanel';

function mkWs(id: string): Workspace {
  return {
    id,
    name: `ws-${id}`,
    description: '',
    directoryPath: '/tmp/ws',
    gitInitialized: true,
    createdAt: '2026-01-01',
    ownerId: 'owner',
    iconEmoji: '📁',
    defaultAgentInstanceId: null,
  };
}

const mockApi = {
  workspace: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    // D7 目录探测（Dialog 形态提交必经；exists=true 直创不打确认层）
    probePath: vi.fn().mockResolvedValue({ exists: true, resolvedPath: '/tmp/project', hasGit: false }),
  },
  dialog: {
    pickDirectory: vi.fn().mockResolvedValue('/tmp/picked'),
  },
  // CreateWorkspaceDialog 挂载拉工作目录视图（预填源——2026-10-27）
  hub: {
    getWorkspaceDirSettings: vi.fn().mockResolvedValue({
      rootDir: null, defaultRootDir: '/data/workspaces', effectiveRootDir: '/data/workspaces',
    }),
    getStatus: vi.fn().mockResolvedValue(null),
  },
  task: {
    steer: vi.fn().mockResolvedValue({ ok: true }),
    list: vi.fn().mockResolvedValue([]),
  },
};

beforeEach(() => {
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  mockApi.workspace.list.mockReset().mockResolvedValue([]);
  mockApi.workspace.create.mockReset();
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, closedIds: [] });
  useUiStore.setState({ activeView: 'im' });
});

function ui(): ReactElement {
  return <MiddlePanel />;
}

describe('MiddlePanel 0-ws 主区引导（T2 改造：嵌入表单退役为按钮 + Dialog，spec 2026-11-13 §4.3）', () => {
  it('无 workspace → 引导文案 +「新建工作空间」按钮，初始无表单（不嵌 Dialog）', () => {
    render(ui());
    expect(screen.getByText('创建或选择一个工作空间开始')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /新建工作空间/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '新建工作空间' })).not.toBeInTheDocument();
  });

  it('点按钮 → 打开 Dialog 形态（含取消——对话框有上级界面，取消语义成立）', () => {
    render(ui());
    fireEvent.click(screen.getByRole('button', { name: /新建工作空间/ }));
    expect(screen.getByRole('heading', { name: '新建工作空间' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
  });

  it('创建成功 → store.workspaces 更新（主壳分支翻转到工作空间态的数据前提）', async () => {
    mockApi.workspace.create.mockResolvedValue(mkWs('w-new'));
    render(ui());
    fireEvent.click(screen.getByRole('button', { name: /新建工作空间/ }));

    const inputs = document.querySelectorAll('input');
    fireEvent.change(inputs[0]!, { target: { value: '我的项目' } });
    fireEvent.change(inputs[1]!, { target: { value: '/tmp/project' } });
    fireEvent.click(screen.getByRole('button', { name: /^创建$/ }));

    await waitFor(() => {
      expect(mockApi.workspace.create).toHaveBeenCalledWith({
        name: '我的项目',
        directoryPath: '/tmp/project',
      });
    });
    await waitFor(() => {
      expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);
      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('w-new');
    });
  });

  it('Dialog 表单提交缺项 → 创建按钮禁用不触发 create（空输入守卫）', () => {
    render(ui());
    fireEvent.click(screen.getByRole('button', { name: /新建工作空间/ }));
    const submit = screen.getByRole('button', { name: /^创建$/ });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(mockApi.workspace.create).not.toHaveBeenCalled();
  });
});

describe('MiddlePanel workgroups 视图独立于工作空间（D1 前置契约，UC8）', () => {
  it('无 workspace + workgroups 视图 → WorkgroupView 渲染（不被创建引导拦截）', () => {
    useUiStore.setState({ activeView: 'workgroups' });
    render(ui());
    expect(screen.getByTestId('workgroup-view-stub')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '新建工作空间' })).not.toBeInTheDocument();
  });
});

// M2.2 P2-8 守卫顺序回归锁：设置页不依赖工作空间（全局分类可用）——settings
// 分发必须在 workspace 守卫之前；若守卫顺序回归（settings 落到 EmptyState 拦截），
// 0-ws 设备将无法进入设置（模型服务等全局配置不可达）。
describe('MiddlePanel settings 视图独立于工作空间（M2.2 P2-8）', () => {
  it('无 workspace + settings 视图 → SettingsView 渲染（不被创建引导拦截）', () => {
    useUiStore.setState({ activeView: 'settings' });
    render(ui());
    expect(screen.getByTestId('settings-view-stub')).toBeInTheDocument();
    expect(screen.queryByText(/创建或选择一个工作空间开始/i)).not.toBeInTheDocument();
  });

  it('无 workspace + 其余视图维持引导语义（files 仍落创建引导）', () => {
    useUiStore.setState({ activeView: 'files' });
    render(ui());
    expect(screen.getByText('创建或选择一个工作空间开始')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-view-stub')).not.toBeInTheDocument();
  });
});


// ── spec §12.1：跟踪会话直连 RemoteSessionPanel ─────────────────────────────

function seedImWorkspace(): void {
  const ws = mkWs('w1');
  useWorkspaceStore.setState({ workspaces: [ws], activeWorkspaceId: 'w1' });
  useUiStore.setState({ activeView: 'im', remoteSessionView: undefined } as never);
}

const trackSession = {
  id: 'sess-track', workspaceId: 'w1', title: '#T-009 · → node-b', kind: 'task_execution',
  createdAt: 0, updatedAt: 0, lastMessageAt: null, delegationRole: 'out', taskId: 'T-009',
} as never;

const chatSession = {
  id: 'sess-chat', workspaceId: 'w1', title: '普通会话', kind: 'chat',
  createdAt: 0, updatedAt: 0, lastMessageAt: null, delegationRole: null, taskId: null,
} as never;

describe('MiddlePanel 跟踪会话直连（spec §12.1）', () => {
  it('选中 task_execution 会话 → 面板在场；聊天输入框不渲染；验收卡在面板内（footerSlot）', () => {
    seedImWorkspace();
    useSessionStore.setState({ sessions: [trackSession, chatSession], activeSessionId: 'sess-track' });
    render(ui());
    const panel = screen.getByTestId('remote-session-panel-stub');
    expect(panel.dataset.session).toBe('sess-track');
    expect(screen.queryByTestId('mention-input-stub')).not.toBeInTheDocument();
    expect(panel.contains(screen.getByTestId('human-request-stub'))).toBe(true);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('普通会话 → 原样渲染（无面板；聊天输入框与验收卡照常、验收卡不在面板内）', () => {
    seedImWorkspace();
    useSessionStore.setState({ sessions: [trackSession, chatSession], activeSessionId: 'sess-chat' });
    render(ui());
    expect(screen.queryByTestId('remote-session-panel-stub')).not.toBeInTheDocument();
    expect(screen.getByTestId('mention-input-stub')).toBeInTheDocument();
    expect(screen.getByTestId('human-request-stub')).toBeInTheDocument();
  });

  it('StrictMode 双挂载：卸载重挂同会话 → 面板仍在（close 后可重开）', () => {
    seedImWorkspace();
    useSessionStore.setState({ sessions: [trackSession], activeSessionId: 'sess-track' });
    const { unmount } = render(ui());
    expect(screen.getByTestId('remote-session-panel-stub')).toBeInTheDocument();
    unmount();
    render(ui());
    expect(screen.getByTestId('remote-session-panel-stub')).toBeInTheDocument();
  });
});


// ── 任务会话形态分流（2026-11-19）：执行节点==本节点 → 本地形态 ──────────────
describe('MiddlePanel 任务会话形态分流（2026-11-19）', () => {
  function mkSession(id: string): SessionSummary {
    return {
      id, workspaceId: 'ws-1', title: `任务 ${id}`, kind: 'task_execution',
      createdAt: 1, updatedAt: 1, lastSeq: 0, pinnedAt: null, isLeaderView: false,
    } as unknown as SessionSummary;
  }
  function mkExecTask(id: string, sessionId: string, routing: TaskRow['routing']): TaskRow {
    return {
      id, workspaceId: 'ws-1', title: `任务 ${id}`, description: '', status: 'in_progress',
      sourceSessionId: null, sourceMessageId: null, creatorUserId: 'u', executionSessionId: sessionId,
      assigneeAgentId: null, targetTeamId: null, targetSessionId: null, recurrenceParentId: null,
      recurrenceChainRoot: null, priority: 0, scheduledAt: null, recurrenceRule: null, deadlineAt: null,
      queuePosition: null, runtimeInstanceId: null, estimatedTokens: null, actualTokens: null,
      toolCallsUsed: 0, errorMessage: null, sourceNodeId: null, createdAt: 1, updatedAt: 1,
      startedAt: null, completedAt: null, currentRunId: null, submittedAt: null, acceptedAt: null,
      delegationRole: null, autoAccept: false, groupId: null, pinnedAt: null, archivedAt: null,
      routing, delegationId: null, origin: 'user', parentTaskId: null,
    };
  }

  function setupTaskSession(task: TaskRow): void {
    useWorkspaceStore.setState({ workspaces: [mkWs('ws-1')], activeWorkspaceId: 'ws-1', closedIds: [] });
    useSessionStore.setState({ sessions: [mkSession(task.executionSessionId!)], activeSessionId: task.executionSessionId! });
    // 分流数据源 2026-11-19 改为按 executionSessionId 精确直查（archived:'all'——
    // 循环实例验收即归档，看板 store 不含归档行，不能作依赖）
    mockApi.task.list.mockReset().mockResolvedValue([task]);
    useHubStore.setState({ status: null });
  }

  it('本机任务（routing local）→ 形态①原样：MessageList + 工具条 + 完整输入框，不渲染远端面板', async () => {
    setupTaskSession(mkExecTask('T-901', 'sess-local-1', { mode: 'local' }));
    render(ui());
    // 形态判定落地：MentionInput（完整输入框）在 = 与普通会话同构
    await waitFor(() => {
      expect(screen.getByTestId('mention-input-stub')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('remote-session-panel-stub')).not.toBeInTheDocument();
    // 2026-11-19：本机会话不再渲染 steer 简框（输入面=完整输入框）
    expect(screen.queryByTestId('local-steer-stub')).not.toBeInTheDocument();
    // 本机执行 → 验收卡排除（裁决归看板）
    expect(screen.getByTestId('human-request-stub').getAttribute('data-exclude')).toBe('acceptance');
    // 分流判定需要本节点 id → hub status 兜底拉取被触发；任务行按会话精确直查（含归档）
    expect(mockApi.hub.getStatus).toHaveBeenCalled();
    expect(mockApi.task.list).toHaveBeenCalledWith(
      expect.objectContaining({ executionSessionId: 'sess-local-1', archived: 'all' }),
    );
  });

  it('远端任务（node 目标 ≠ 本节点）→ RemoteSessionPanel + 面板内 steer（输入框不渲染）', async () => {
    mockApi.hub.getStatus.mockResolvedValueOnce({ configured: true, state: 'online', hubUrl: 'http://x', nodeName: '本机', nodeId: 'node-self', lastError: null, lastErrorCode: null });
    setupTaskSession(mkExecTask('T-902', 'sess-remote-1', { mode: 'node', groupId: 'g', targetNodeId: 'node-b' }));
    render(ui());
    await waitFor(() => {
      expect(screen.getByTestId('remote-session-panel-stub')).toBeInTheDocument();
    });
    // 远端跟踪会话：输入面是面板内 steer composer，完整输入框不挂；
    // footerSlot 的验收卡不排除（发起方在会话里裁决）
    expect(screen.queryByTestId('mention-input-stub')).not.toBeInTheDocument();
    const footerPanel = screen.getByTestId('human-request-stub');
    expect(footerPanel.getAttribute('data-exclude')).toBe('');
  });

  it('指定会话模式（执行会话 kind=chat）+ 本机任务 → 验收卡仍排除（判定看任务不看会话 kind）', async () => {
    const task = mkExecTask('T-904', 'sess-chat-1', { mode: 'local' });
    useWorkspaceStore.setState({ workspaces: [mkWs('ws-1')], activeWorkspaceId: 'ws-1', closedIds: [] });
    useSessionStore.setState({
      sessions: [{ ...mkSession('sess-chat-1'), kind: 'chat' } as unknown as SessionSummary],
      activeSessionId: 'sess-chat-1',
    });
    mockApi.task.list.mockReset().mockResolvedValue([task]);
    useHubStore.setState({ status: null });
    render(ui());
    await waitFor(() => {
      expect(mockApi.task.list).toHaveBeenCalled();
    });
    // 本机执行的 acceptance 被排除（面板挂载但 excludeKinds 生效——判定看任务不看会话 kind）
    expect(screen.getByTestId('human-request-stub').getAttribute('data-exclude')).toBe('acceptance');
    // 输入面仍是完整输入框
    expect(screen.getByTestId('mention-input-stub')).toBeInTheDocument();
  });

  it('本机任务待验收 → 轻提示入口显示，点击直达看板选中任务（D1-C/D4-B）', async () => {
    const task = mkExecTask('T-905', 'sess-acc-1', { mode: 'local' });
    useWorkspaceStore.setState({ workspaces: [mkWs('ws-1')], activeWorkspaceId: 'ws-1', closedIds: [] });
    useSessionStore.setState({
      sessions: [{ ...mkSession('sess-acc-1') } as unknown as SessionSummary],
      activeSessionId: 'sess-acc-1',
    });
    mockApi.task.list.mockReset().mockResolvedValue([task]);
    useHubStore.setState({ status: null });
    useHumanStore.setState({
      pendingBySession: new Map([
        ['sess-acc-1', [{ id: 'r1', kind: 'acceptance', status: 'pending' } as never]],
      ]),
    });
    render(ui());
    const notice = await screen.findByTestId('local-acceptance-notice');
    fireEvent.click(within(notice).getByRole('button', { name: /前往看板裁决/ }));
    expect(useUiStore.getState().activeView).toBe('tasks');
    expect(useTaskStore.getState().selectedTaskId).toBe('T-905');
  });

  it('调度落本机（group targetNodeId == 本节点）→ 形态①原样', async () => {
    mockApi.hub.getStatus.mockResolvedValueOnce({ configured: true, state: 'online', hubUrl: 'http://x', nodeName: '本机', nodeId: 'node-self', lastError: null, lastErrorCode: null });
    setupTaskSession(mkExecTask('T-903', 'sess-self-1', { mode: 'group', groupId: 'g', targetNodeId: 'node-self' }));
    render(ui());
    await waitFor(() => {
      expect(screen.getByTestId('mention-input-stub')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('remote-session-panel-stub')).not.toBeInTheDocument();
  });
});
