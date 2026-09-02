// renderer/src/components/im/CollabSessionDialog.test.tsx
//
// v25 Task 13：创建协作会话弹窗测试（spec §6.5）。
// 名称输入（可空=动态命名提示文案）+「单个 agent / 团队」页签 + 目标单选列表
// （成员行显示在线态 / 团队行显示 Crown leader + 成员数）；提交走 session.store createCollabSession。
// v2.1 P2 Task 15：👑 → lucide-react Crown；断言改 getByTitle('leader：…') + 内含 svg。
//
// Mock 策略（momo-test-rules）：
//   - store 为真实 zustand 实例，setState 注入状态与 action 桩；
//   - createCollabSession 桩仿真真实语义（失败写 store error 并返回 false）；
//   - 断言生产消费的字段（CollabTarget / title undefined 语义）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AgentDefinition, Team, Workspace, WorkspaceAgentMember } from '../../ipc/types';

const { CollabSessionDialog } = await import('./CollabSessionDialog');
const { useSessionStore } = await import('../../stores/session.store');
const { useAgentStore } = await import('../../stores/agent.store');
const { useWorkspaceStore } = await import('../../stores/workspace.store');

const WS: Workspace = {
  id: 'ws-1',
  name: '测试工作空间',
  description: '',
  directoryPath: '/tmp/ws',
  gitInitialized: true,
  createdAt: '',
  ownerId: 'u',
  iconEmoji: '📁',
  defaultAgentInstanceId: null,
};

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

const DEF_2: AgentDefinition = { ...DEF_1, id: 'def-2', name: '评审员', slug: 'reviewer' };

const MEMBER_1: WorkspaceAgentMember = {
  instanceId: 'inst-1',
  workspaceId: 'ws-1',
  agentDefinitionId: 'def-1',
  agentUserId: '@coder:local',
  hasApiKeyOverride: false,
  lastRunning: true,
  createdAt: '',
};

const MEMBER_2: WorkspaceAgentMember = {
  ...MEMBER_1,
  instanceId: 'inst-2',
  agentDefinitionId: 'def-2',
  agentUserId: '@reviewer:local',
  lastRunning: false,
};

const TEAM: Team = {
  id: 'team-1',
  workspaceId: 'ws-1',
  name: '攻坚组',
  iconEmoji: '🛠️',
  leaderInstanceId: 'inst-1',
  members: [MEMBER_1, MEMBER_2],
  createdAt: '',
};

const loadMembers = vi.fn();
const loadTeams = vi.fn();
const createCollabSession = vi.fn();

beforeEach(() => {
  loadMembers.mockReset().mockResolvedValue(undefined);
  loadTeams.mockReset().mockResolvedValue(undefined);
  createCollabSession.mockReset().mockResolvedValue(true);

  useWorkspaceStore.setState({
    workspaces: [WS],
    activeWorkspaceId: 'ws-1',
    loading: false,
    error: null,
  });

  useAgentStore.setState({
    definitions: [DEF_1, DEF_2],
    members: [MEMBER_1, MEMBER_2],
    teams: [TEAM],
    builtinSuggestions: {},
    loading: false,
    error: null,
    loadDefinitions: vi.fn(),
    loadMembers,
    loadBuiltinSuggestions: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
    deleteDefinition: vi.fn(),
    updateMemberApiKey: vi.fn(),
    getMemberDeltas: vi.fn(),
    setMemberDeltas: vi.fn(),
    stopMember: vi.fn(),
    startMember: vi.fn(),
    loadTeams,
    createTeam: vi.fn(),
    renameTeam: vi.fn(),
    deleteTeam: vi.fn(),
    setLeader: vi.fn(),
    addTeamMember: vi.fn(),
    removeTeamMember: vi.fn(),
    reset: vi.fn(),
  });

  useSessionStore.setState({ error: null, createCollabSession });
});

describe('CollabSessionDialog — 渲染与数据加载', () => {
  it('挂载时加载当前 ws 成员与团队', async () => {
    render(<CollabSessionDialog onClose={() => {}} />);
    await waitFor(() => {
      expect(loadMembers).toHaveBeenCalledWith('ws-1');
      expect(loadTeams).toHaveBeenCalledWith('ws-1');
    });
  });

  it('默认「单个 agent」页签，成员行显示名称与在线/离线态', async () => {
    render(<CollabSessionDialog onClose={() => {}} />);
    expect(screen.getByRole('button', { name: '单个 agent' })).toBeInTheDocument();
    expect(screen.getByText('编码助手')).toBeInTheDocument();
    expect(screen.getByText('在线')).toBeInTheDocument();
    expect(screen.getByText('离线')).toBeInTheDocument();
  });

  it('名称输入框带动态命名提示文案', () => {
    render(<CollabSessionDialog onClose={() => {}} />);
    expect(screen.getByLabelText('会话名称')).toHaveAttribute(
      'placeholder',
      expect.stringContaining('动态命名'),
    );
  });
});

describe('CollabSessionDialog — 校验', () => {
  it('未选目标提交 → 提示选择会话目标', async () => {
    render(<CollabSessionDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('请选择会话目标')).toBeInTheDocument();
    expect(createCollabSession).not.toHaveBeenCalled();
  });
});

describe('CollabSessionDialog — 单个 agent 提交', () => {
  it('名称留空 → title=undefined（动态命名），目标为所选成员', async () => {
    const onClose = vi.fn();
    render(<CollabSessionDialog onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('编码助手'));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(createCollabSession).toHaveBeenCalledWith('ws-1', undefined, {
      type: 'agent',
      instanceId: 'inst-1',
    });
  });

  it('填写名称 → title=该名称', async () => {
    const onClose = vi.fn();
    render(<CollabSessionDialog onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('会话名称'), { target: { value: '评审会' } });
    fireEvent.click(screen.getByLabelText('评审员'));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(createCollabSession).toHaveBeenCalledWith('ws-1', '评审会', {
      type: 'agent',
      instanceId: 'inst-2',
    });
  });
});

describe('CollabSessionDialog — 团队页签', () => {
  it('团队行显示 Crown leader 标记与成员数；选择团队提交 → team 目标', async () => {
    const onClose = vi.fn();
    render(<CollabSessionDialog onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '团队' }));
    // v2.1 P2 Task 15：👑 emoji → lucide-react Crown；断言改 getByTitle + 内含 svg
    const leader = screen.getByTitle('leader：编码助手');
    expect(leader).toBeInTheDocument();
    expect(leader.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('2 成员')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('攻坚组'));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(createCollabSession).toHaveBeenCalledWith('ws-1', undefined, {
      type: 'team',
      teamId: 'team-1',
    });
  });

  it('团队页签下不显示成员单选列表', () => {
    render(<CollabSessionDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '团队' }));
    expect(screen.queryByLabelText('编码助手')).not.toBeInTheDocument();
  });
});

describe('CollabSessionDialog — 失败路径', () => {
  it('createCollabSession 返回 false → 显示 store 错误，不 onClose', async () => {
    // 仿真真实 action 语义：失败时写 store error 并返回 false
    createCollabSession.mockImplementation(async () => {
      useSessionStore.setState({ error: '目标成员不存在' });
      return false;
    });
    const onClose = vi.fn();
    render(<CollabSessionDialog onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('编码助手'));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('目标成员不存在')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
