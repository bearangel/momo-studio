// renderer/src/components/agent/TeamsPanel.test.tsx
//
// v25 Task 12：AgentsView Tab 2「团队」面板测试（spec §6.1）。
// 团队卡片 = icon + 名称 + 👑leader 标记 + 成员 chips + 编辑/删除；
// 「+ 新建团队」入口占位（创建/编辑弹窗 TeamDialog 归 Task 13）。
//
// Mock 策略（momo-test-rules）：
//   - store 为真实 zustand 实例，setState 注入状态与 action 桩；
//   - 断言生产消费的字段（teamId / leaderInstanceId 对应关系）。
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AgentDefinition, Team, Workspace, WorkspaceAgentMember } from '../../ipc/types';

const { TeamsPanel } = await import('./TeamsPanel');
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
  defaultTools: [{ kind: 'builtin', ref: 'read_file' }],
  source: 'custom',
  description: '',
  iconEmoji: '🤖',
  defaultMcps: [],
  defaultSkills: [],
  workspaceId: null,
  modelProviderId: 'p1',
  modelName: 'gpt-4o',
};

const DEF_2: AgentDefinition = {
  ...DEF_1,
  id: 'def-2',
  name: '评审员',
  slug: 'reviewer',
  iconEmoji: '🔍',
};

const MEMBER_LEADER: WorkspaceAgentMember = {
  instanceId: 'inst-1',
  workspaceId: 'ws-1',
  agentDefinitionId: 'def-1',
  agentUserId: '@coder:local',
  hasApiKeyOverride: false,
  lastRunning: true,
  createdAt: '',
};

const MEMBER_MEMBER: WorkspaceAgentMember = {
  ...MEMBER_LEADER,
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
  members: [MEMBER_LEADER, MEMBER_MEMBER],
  createdAt: '',
};

const loadTeamsMock = vi.fn();
const deleteTeamMock = vi.fn();

let confirmSpy: MockInstance<Parameters<typeof window.confirm>, ReturnType<typeof window.confirm>>;

beforeEach(() => {
  loadTeamsMock.mockReset().mockResolvedValue(undefined);
  deleteTeamMock.mockReset().mockResolvedValue(undefined);

  useWorkspaceStore.setState({
    workspaces: [WS],
    activeWorkspaceId: 'ws-1',
    loading: false,
    error: null,
  });

  useAgentStore.setState({
    definitions: [DEF_1, DEF_2],
    members: [MEMBER_LEADER, MEMBER_MEMBER],
    teams: [TEAM],
    builtinSuggestions: {},
    loading: false,
    error: null,
    loadDefinitions: vi.fn(),
    loadMembers: vi.fn(),
    loadBuiltinSuggestions: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
    deleteDefinition: vi.fn(),
    updateMemberApiKey: vi.fn(),
    getMemberDeltas: vi.fn(),
    setMemberDeltas: vi.fn(),
    stopMember: vi.fn(),
    startMember: vi.fn(),
    loadTeams: loadTeamsMock,
    createTeam: vi.fn(),
    renameTeam: vi.fn(),
    deleteTeam: deleteTeamMock,
    setLeader: vi.fn(),
    addTeamMember: vi.fn(),
    removeTeamMember: vi.fn(),
    reset: vi.fn(),
  });

  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  confirmSpy.mockRestore();
});

describe('TeamsPanel — 团队卡片渲染', () => {
  it('挂载时按当前 workspace 加载团队列表', async () => {
    render(<TeamsPanel />);
    await waitFor(() => {
      expect(loadTeamsMock).toHaveBeenCalledWith('ws-1');
    });
  });

  it('团队卡片渲染 icon、名称、👑leader 标记与成员 chips', async () => {
    render(<TeamsPanel />);
    await waitFor(() => {
      expect(loadTeamsMock).toHaveBeenCalledWith('ws-1');
    });
    expect(screen.getByText('攻坚组')).toBeInTheDocument();
    expect(screen.getByText('🛠️')).toBeInTheDocument();
    // leader chip（inst-1=编码助手）带 👑 前缀
    expect(screen.getByText('👑编码助手')).toBeInTheDocument();
    // 普通成员 chip 无 👑
    expect(screen.getByText('评审员')).toBeInTheDocument();
    expect(screen.queryByText('👑评审员')).not.toBeInTheDocument();
  });

  it('头部提供「+ 新建团队」入口（Task 13 弹窗接线占位）', async () => {
    render(<TeamsPanel />);
    await waitFor(() => {
      expect(loadTeamsMock).toHaveBeenCalledWith('ws-1');
    });
    expect(screen.getByRole('button', { name: '+ 新建团队' })).toBeInTheDocument();
  });

  it('空态：无团队时显示空态提示', async () => {
    useAgentStore.setState({ teams: [] });
    render(<TeamsPanel />);
    await waitFor(() => {
      expect(loadTeamsMock).toHaveBeenCalledWith('ws-1');
    });
    expect(screen.getByText('暂无团队')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ 新建团队' })).toBeInTheDocument();
  });
});

describe('TeamsPanel — 团队删除', () => {
  it('确认后调用 deleteTeam(teamId)', async () => {
    render(<TeamsPanel />);
    await waitFor(() => {
      expect(loadTeamsMock).toHaveBeenCalledWith('ws-1');
    });
    fireEvent.click(screen.getByText('删除'));
    await waitFor(() => {
      expect(deleteTeamMock).toHaveBeenCalledWith('team-1');
    });
    expect(confirmSpy).toHaveBeenCalled();
  });

  it('confirm 取消 → 不调用 deleteTeam', async () => {
    confirmSpy.mockReturnValue(false);
    render(<TeamsPanel />);
    await waitFor(() => {
      expect(loadTeamsMock).toHaveBeenCalledWith('ws-1');
    });
    fireEvent.click(screen.getByText('删除'));
    expect(deleteTeamMock).not.toHaveBeenCalled();
  });
});
