// renderer/src/components/im/SessionSidebarHeader.test.tsx
//
// v25 Task 14：会话区头部双常驻按钮测试（spec §6.2/§7）。
//   ⚡ 有默认 agent → 免弹窗直达 createQuickSession（IPC 收到 createQuick）；
//   ⚡ 无默认 → 弹 DefaultAgentPickerDialog；选成员提交 → setDefaultAgent +
//     createQuick 契约链闭合（T13 移交：onContinue 消费方自 catch）；
//   ⚡ ws 无成员 → Picker 呈引导文案（去 Agent 管理添加）；
//   store needsDefaultAgent（NO_DEFAULT_AGENT 错误态）→ 自动弹 Picker；
//   👥 → CollabSessionDialog 挂载。
//
// Mock 策略（momo-test-rules 契约测试）：session/workspace/agent store 均为真实
// zustand 实例，弹窗组件为真实实现——只在 window.api（IPC 进程边界）mock，
// 断言生产者真实产出被消费者原样消费（ws id / instanceId 透传）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type {
  AgentDefinition,
  SessionMemberInfo,
  SessionSummary,
  Workspace,
  WorkspaceAgentMember,
} from '../../ipc/types';

const { SessionSidebarHeader } = await import('./SessionSidebarHeader');
const { useSessionStore } = await import('../../stores/session.store');
const { useWorkspaceStore } = await import('../../stores/workspace.store');
const { useAgentStore } = await import('../../stores/agent.store');

const WS_NO_DEFAULT: Workspace = {
  id: 'ws-1',
  name: '测试空间',
  description: '',
  directoryPath: '/tmp/ws',
  gitInitialized: true,
  createdAt: '',
  ownerId: 'owner',
  iconEmoji: '🗂',
  defaultAgentInstanceId: null,
};

const WS_WITH_DEFAULT: Workspace = { ...WS_NO_DEFAULT, defaultAgentInstanceId: 'inst-1' };

const DEF_1: AgentDefinition = {
  id: 'def-1',
  name: '编码助手',
  slug: 'coder',
  version: '1.0.0',
  runtime: 'declarative',
  systemPrompt: '',
  defaultTools: [],
  source: 'custom',
  description: '',
  iconEmoji: '🤖',
  defaultMcps: [],
  defaultSkills: [],
  workspaceId: null,
  modelProviderId: 'p1',
  modelName: 'gpt-4o',
};

const MEMBER_1: WorkspaceAgentMember = {
  instanceId: 'inst-1',
  workspaceId: 'ws-1',
  agentDefinitionId: 'def-1',
  agentUserId: '@coder:local',
  hasApiKeyOverride: false,
  lastRunning: true,
  createdAt: '',
};

const DEF_2: AgentDefinition = { ...DEF_1, id: 'def-2', name: '评审员', slug: 'reviewer' };

const MEMBER_2: WorkspaceAgentMember = {
  ...MEMBER_1,
  instanceId: 'inst-2',
  agentDefinitionId: 'def-2',
  agentUserId: '@reviewer:local',
  lastRunning: false,
};

const QUICK_SESSION_MEMBER: SessionMemberInfo = {
  instanceId: 'inst-1',
  agentName: '编码助手',
  iconEmoji: '🤖',
  lastRunning: true,
  isLeader: true,
};

const MOCK_QUICK_SESSION: SessionSummary = {
  id: 'sess-quick',
  workspaceId: 'ws-1',
  title: '新会话',
  titleAuto: true,
  kind: 'chat',
  lastMessageAt: null,
  members: [QUICK_SESSION_MEMBER],
};

const mockApi = {
  session: {
    list: vi.fn(),
    get: vi.fn(),
    createQuick: vi.fn(),
    createCollab: vi.fn(),
    getMessages: vi.fn(),
    send: vi.fn(),
  },
  workspace: {
    setDefaultAgent: vi.fn(),
    list: vi.fn(),
  },
  agent: {
    listMembers: vi.fn(),
  },
  team: {
    list: vi.fn(),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  // 合并进 jsdom 现有 window（整体替换会丢 document 导致 react-dom 崩溃）
  Object.assign(window, { api: mockApi });

  mockApi.session.list.mockResolvedValue([]);
  mockApi.session.get.mockResolvedValue({ session: {}, members: [QUICK_SESSION_MEMBER] });
  mockApi.session.getMessages.mockResolvedValue({ messages: [], eventsByMessage: {} });
  mockApi.session.createQuick.mockResolvedValue(MOCK_QUICK_SESSION);
  mockApi.session.createCollab.mockResolvedValue(MOCK_QUICK_SESSION);
  mockApi.workspace.setDefaultAgent.mockResolvedValue(undefined);
  mockApi.workspace.list.mockResolvedValue([WS_WITH_DEFAULT]);
  mockApi.agent.listMembers.mockResolvedValue([MEMBER_1, MEMBER_2]);
  mockApi.team.list.mockResolvedValue([]);

  useSessionStore.getState().reset();
  useAgentStore.getState().reset();
  // Picker 标签解析走 definitions 映射（生产中由 Agent 管理加载）——注入后
  // memberLabel 才能显示 agent 名称而非回退 agentUserId
  useAgentStore.setState({ definitions: [DEF_1, DEF_2] });
  useWorkspaceStore.setState({
    workspaces: [],
    activeWorkspaceId: null,
    loading: false,
    error: null,
  });
});

function activateWorkspace(ws: Workspace): void {
  useWorkspaceStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id });
}

describe('SessionSidebarHeader — ⚡ 快速会话入口', () => {
  it('ws 已设默认 agent：免弹窗直达 createQuickSession，不渲染 Picker，聚焦信号 +1', async () => {
    activateWorkspace(WS_WITH_DEFAULT);
    render(<SessionSidebarHeader />);

    fireEvent.click(screen.getByLabelText('快速会话'));

    await waitFor(() => expect(mockApi.session.createQuick).toHaveBeenCalledWith('ws-1'));
    // 免弹窗：一次性选择弹窗不出现
    expect(screen.queryByText('选择默认会话 agent')).not.toBeInTheDocument();
    // 建会成功 → 输入框聚焦请求信号递增（MentionInput 订阅）
    await waitFor(() => expect(useSessionStore.getState().inputFocusTick).toBe(1));
  });

  it('ws 未设默认 agent：弹一次性选择弹窗，不直接建会', async () => {
    activateWorkspace(WS_NO_DEFAULT);
    render(<SessionSidebarHeader />);

    fireEvent.click(screen.getByLabelText('快速会话'));

    // 真实 DefaultAgentPickerDialog 渲染 + 拉取成员
    await waitFor(() => expect(screen.getByText('选择默认会话 agent')).toBeInTheDocument());
    expect(mockApi.session.createQuick).not.toHaveBeenCalled();
  });

  it('无默认 → Picker 选成员提交：setDefaultAgent + createQuick 契约链闭合，弹窗关闭', async () => {
    activateWorkspace(WS_NO_DEFAULT);
    render(<SessionSidebarHeader />);

    fireEvent.click(screen.getByLabelText('快速会话'));
    await waitFor(() => expect(screen.getByText('选择默认会话 agent')).toBeInTheDocument());

    // 单选成员并提交（真实 Picker 交互）
    fireEvent.click(screen.getByLabelText('编码助手'));
    fireEvent.click(screen.getByText('设为默认并继续'));

    // 契约链：Picker setDefaultAgent(wsId, instanceId) → onContinue → 消费方 createQuickSession(wsId)
    await waitFor(() =>
      expect(mockApi.workspace.setDefaultAgent).toHaveBeenCalledWith('ws-1', 'inst-1'),
    );
    await waitFor(() => expect(mockApi.session.createQuick).toHaveBeenCalledWith('ws-1'));
    await waitFor(() =>
      expect(screen.queryByText('选择默认会话 agent')).not.toBeInTheDocument(),
    );
  });

  it('ws 无任何成员：Picker 呈引导文案（去 Agent 管理添加），无选择列表', async () => {
    activateWorkspace(WS_NO_DEFAULT);
    mockApi.agent.listMembers.mockResolvedValue([]);
    render(<SessionSidebarHeader />);

    fireEvent.click(screen.getByLabelText('快速会话'));

    await waitFor(() =>
      expect(screen.getByText(/请先到 Agent 管理添加 agent 成员/)).toBeInTheDocument(),
    );
    // 无成员不渲染选择列表与提交按钮
    expect(screen.queryByText('设为默认并继续')).not.toBeInTheDocument();
    expect(mockApi.session.createQuick).not.toHaveBeenCalled();
  });

  it('store needsDefaultAgent（NO_DEFAULT_AGENT 错误态）自动触发 Picker', async () => {
    activateWorkspace(WS_WITH_DEFAULT);
    useSessionStore.setState({ needsDefaultAgent: true });
    render(<SessionSidebarHeader />);

    await waitFor(() => expect(screen.getByText('选择默认会话 agent')).toBeInTheDocument());
  });

  it('onContinue 消费方自 catch：createQuickSession 抛错不产生未处理 rejection，弹窗已关闭', async () => {
    // T13 移交约定：Picker 不 await onContinue——消费方必须自行兜底自己的错误
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rejectingCreateQuick = vi.fn().mockRejectedValue(new Error('boom'));
    useSessionStore.setState({ createQuickSession: rejectingCreateQuick });
    activateWorkspace(WS_NO_DEFAULT);
    render(<SessionSidebarHeader />);

    fireEvent.click(screen.getByLabelText('快速会话'));
    await waitFor(() => expect(screen.getByText('选择默认会话 agent')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('编码助手'));
    fireEvent.click(screen.getByText('设为默认并继续'));

    await waitFor(() => expect(rejectingCreateQuick).toHaveBeenCalledWith('ws-1'));
    // 消费方先关弹窗再建会：Picker 不因消费方错误滞留/误显
    await waitFor(() =>
      expect(screen.queryByText('选择默认会话 agent')).not.toBeInTheDocument(),
    );
    consoleSpy.mockRestore();
  });
});

describe('SessionSidebarHeader — 👥 协作会话入口', () => {
  it('点击 👥 挂载 CollabSessionDialog（真实组件），取消后关闭', async () => {
    activateWorkspace(WS_WITH_DEFAULT);
    render(<SessionSidebarHeader />);

    fireEvent.click(screen.getByLabelText('协作会话'));

    await waitFor(() => expect(screen.getByText('创建协作会话')).toBeInTheDocument());
    // 取消关闭
    fireEvent.click(screen.getByText('取消'));
    await waitFor(() =>
      expect(screen.queryByText('创建协作会话')).not.toBeInTheDocument(),
    );
  });
});
