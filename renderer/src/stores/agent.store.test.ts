// renderer/src/stores/agent.store.test.ts
// v25 Task 11：assignments→members 命名彻底化 + 团队 action（spec §5）。
// 通道面：listMembers/addMember/removeMember/setMemberApiKeyOverride/
// getMemberDeltas/setMemberDeltas + team:list/create/rename/delete/setLeader/
// addMember/removeMember。setDefaultAgent 在 workspace.store（Task 6 已实现，
// 单一入口防漂移，此处不重复暴露）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAgentStore } from './agent.store';
import type { AgentDefinition, Team, WorkspaceAgentMember } from '../ipc/types';

const MOCK_DEFS: AgentDefinition[] = [
  {
    id: 'def-1',
    name: '需求讨论师',
    slug: 'requirement-analyst',
    version: '1.0.0',
    runtime: 'declarative',
    systemPrompt: '你是需求分析师',
    defaultTools: [{ kind: 'builtin', ref: 'read_file' }],
    source: 'builtin',
    description: '梳理需求',
    iconEmoji: '📝',
    defaultMcps: [],
    defaultSkills: [],
    workspaceId: null,
    modelProviderId: 'prov-1',
    modelName: 'claude-3-5-sonnet',
  },
];

const MOCK_MEMBER: WorkspaceAgentMember = {
  instanceId: 'inst-1',
  workspaceId: 'ws-1',
  agentDefinitionId: 'def-1',
  agentUserId: '@bot.x.alice:localhost',
  agentName: '编码助手',
  iconEmoji: '🤖',
  createdAt: '2026-01-01T00:00:00Z',
  hasApiKeyOverride: false,
  lastRunning: true,
};

const MOCK_MEMBER_2: WorkspaceAgentMember = {
  ...MOCK_MEMBER,
  instanceId: 'inst-2',
  agentUserId: '@bot.x.bob:localhost',
};

function mkTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 'team-1',
    workspaceId: 'ws-1',
    name: '研发小组',
    iconEmoji: '🛠️',
    leaderInstanceId: 'inst-1',
    members: [MOCK_MEMBER, MOCK_MEMBER_2],
    createdAt: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

const MOCK_TEAM = mkTeam();

const mockApi = {
  agent: {
    list: vi.fn().mockResolvedValue(MOCK_DEFS),
    listMembers: vi.fn().mockResolvedValue([MOCK_MEMBER]),
    addMember: vi.fn().mockResolvedValue(MOCK_MEMBER),
    removeMember: vi.fn().mockResolvedValue({ ok: true as const }),
    stop: vi.fn().mockResolvedValue({ ok: true }),
    isRunning: vi.fn().mockResolvedValue(true),
    deleteDefinition: vi.fn().mockResolvedValue({ stoppedInstanceIds: [] }),
    setMemberApiKeyOverride: vi.fn().mockResolvedValue({ ok: true }),
    getMemberDeltas: vi.fn().mockResolvedValue({
      addedTools: [],
      removedTools: [],
      addedMcps: [],
      removedMcps: [],
      addedSkills: [],
      removedSkills: [],
    }),
    setMemberDeltas: vi.fn().mockResolvedValue(undefined),
    getBuiltinSuggestions: vi.fn().mockResolvedValue({
      'def-1': { suggestedPlatform: 'anthropic' },
    }),
  },
  team: {
    list: vi.fn().mockResolvedValue([MOCK_TEAM]),
    create: vi.fn().mockResolvedValue(MOCK_TEAM),
    rename: vi.fn().mockResolvedValue({ ok: true as const }),
    delete: vi.fn().mockResolvedValue({ ok: true as const }),
    setLeader: vi.fn().mockResolvedValue({ ok: true as const }),
    addMember: vi.fn().mockResolvedValue({ ok: true as const }),
    removeMember: vi.fn().mockResolvedValue({ ok: true as const }),
  },
};

beforeEach(() => {
  (globalThis as unknown as { window: { api: typeof mockApi } }).window = { api: mockApi };
  useAgentStore.getState().reset();
  mockApi.agent.list.mockReset();
  mockApi.agent.list.mockResolvedValue(MOCK_DEFS);
  mockApi.agent.listMembers.mockReset();
  mockApi.agent.listMembers.mockResolvedValue([MOCK_MEMBER]);
  mockApi.agent.addMember.mockReset();
  mockApi.agent.addMember.mockResolvedValue(MOCK_MEMBER);
  mockApi.agent.removeMember.mockResolvedValue({ ok: true as const });
  mockApi.agent.isRunning.mockResolvedValue(true);
  mockApi.agent.stop.mockClear();
  mockApi.agent.deleteDefinition.mockClear();
  mockApi.agent.setMemberApiKeyOverride.mockClear();
  mockApi.agent.getMemberDeltas.mockClear();
  mockApi.agent.setMemberDeltas.mockClear();
  mockApi.team.list.mockClear();
  mockApi.team.list.mockResolvedValue([MOCK_TEAM]);
  mockApi.team.create.mockClear();
  mockApi.team.create.mockResolvedValue(MOCK_TEAM);
  mockApi.team.rename.mockClear();
  mockApi.team.rename.mockResolvedValue({ ok: true as const });
  mockApi.team.delete.mockClear();
  mockApi.team.delete.mockResolvedValue({ ok: true as const });
  mockApi.team.setLeader.mockClear();
  mockApi.team.setLeader.mockResolvedValue({ ok: true as const });
  mockApi.team.addMember.mockClear();
  mockApi.team.addMember.mockResolvedValue({ ok: true as const });
  mockApi.team.removeMember.mockClear();
  mockApi.team.removeMember.mockResolvedValue({ ok: true as const });
});

describe('agent.store — v25 members（spec §5）', () => {
  it('loadDefinitions(wsId) 透传 workspaceId 到 IPC', async () => {
    await useAgentStore.getState().loadDefinitions('ws-1');
    expect(mockApi.agent.list).toHaveBeenCalledWith('ws-1');
    expect(useAgentStore.getState().definitions).toHaveLength(1);
  });

  it('loadMembers 填充 members（断言生产消费字段 instanceId/lastRunning）', async () => {
    await useAgentStore.getState().loadMembers('ws-1');
    expect(mockApi.agent.listMembers).toHaveBeenCalledWith('ws-1');
    const { members } = useAgentStore.getState();
    expect(members).toHaveLength(1);
    expect(members[0]?.instanceId).toBe('inst-1');
    expect(members[0]?.lastRunning).toBe(true);
  });

  it('loadMembers IPC 失败时写入 error 且 members 不变', async () => {
    mockApi.agent.listMembers.mockRejectedValue(new Error('数据库占用'));
    await useAgentStore.getState().loadMembers('ws-1');
    expect(useAgentStore.getState().error).toBe('数据库占用');
    expect(useAgentStore.getState().members).toHaveLength(0);
  });

  it('addMember 透传 workspaceId + defId + apiKeyOverride 并追加 members', async () => {
    const result = await useAgentStore.getState().addMember('ws-1', 'def-1', 'sk-x');
    expect(mockApi.agent.addMember).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      agentDefinitionId: 'def-1',
      apiKeyOverride: 'sk-x',
    });
    expect(useAgentStore.getState().members).toContainEqual(MOCK_MEMBER);
    // 返回新成员（供调用方捕获 instanceId 写 Layer 3 deltas）
    expect(result.instanceId).toBe('inst-1');
  });

  it('addMember 失败时抛错并写入 error，members 不追加', async () => {
    mockApi.agent.addMember.mockRejectedValue(new Error('该 agent 定义已加入 workspace，不可重复添加'));
    await expect(
      useAgentStore.getState().addMember('ws-1', 'def-1'),
    ).rejects.toThrow('不可重复添加');
    expect(useAgentStore.getState().error).toContain('不可重复添加');
    expect(useAgentStore.getState().members).toHaveLength(0);
  });

  it('removeMember 成功（ok:true）后刷新 members', async () => {
    await useAgentStore.getState().loadMembers('ws-1');
    mockApi.agent.listMembers.mockResolvedValue([]);

    await useAgentStore.getState().removeMember('inst-1');
    expect(mockApi.agent.removeMember).toHaveBeenCalledWith('inst-1');
    expect(useAgentStore.getState().members).toHaveLength(0);
  });

  it('removeMember leader 守卫命中（ok:false）透传 blockedTeams 且不误报成功', async () => {
    await useAgentStore.getState().loadMembers('ws-1');
    // leader 守卫：返回团队名列表（生产消费字段——UI 据此提示先转移/解散）
    mockApi.agent.removeMember.mockResolvedValue({ ok: false, blockedTeams: ['研发小组'] });

    const result = await useAgentStore.getState().removeMember('inst-1');
    expect(result).toEqual({ ok: false, blockedTeams: ['研发小组'] });
    // blocked 时不应刷新（成员并未被移除）
    expect(mockApi.agent.listMembers).toHaveBeenCalledTimes(1);
  });

  it('removeMember IPC 抛错时写入 error 并向上抛', async () => {
    mockApi.agent.removeMember.mockRejectedValue(new Error('member not found'));
    await expect(useAgentStore.getState().removeMember('inst-1')).rejects.toThrow('member not found');
    expect(useAgentStore.getState().error).toBe('member not found');
  });

  it('stopMember 调用 stop 并重新加载 members（反映 lastRunning）', async () => {
    await useAgentStore.getState().addMember('ws-1', 'def-1');
    expect(useAgentStore.getState().members).toContainEqual(MOCK_MEMBER);

    // stop 后 listMembers 返回 lastRunning=false 的成员
    mockApi.agent.listMembers.mockResolvedValueOnce([{ ...MOCK_MEMBER, lastRunning: false }]);

    await useAgentStore.getState().stopMember('inst-1');
    expect(mockApi.agent.stop).toHaveBeenCalledWith('inst-1');
    expect(useAgentStore.getState().members[0]?.lastRunning).toBe(false);
  });

  it('deleteDefinition 调用 IPC + 刷新 definitions', async () => {
    await useAgentStore.getState().loadDefinitions('ws-1');
    expect(useAgentStore.getState().definitions).toHaveLength(1);

    await useAgentStore.getState().deleteDefinition('def-1');
    expect(mockApi.agent.deleteDefinition).toHaveBeenCalledWith('def-1');
    expect(useAgentStore.getState().definitions).toHaveLength(0);
  });

  it('updateMemberApiKey(null) 调用 setMemberApiKeyOverride 清除 override 并刷新', async () => {
    await useAgentStore.getState().loadMembers('ws-1');

    await useAgentStore.getState().updateMemberApiKey('inst-1', null);
    expect(mockApi.agent.setMemberApiKeyOverride).toHaveBeenCalledWith('inst-1', null);
    expect(mockApi.agent.listMembers).toHaveBeenCalledTimes(2);
  });

  it('getMemberDeltas / setMemberDeltas 透传 instanceId', async () => {
    const deltas = {
      addedTools: ['grep'],
      removedTools: [],
      addedMcps: [],
      removedMcps: [],
      addedSkills: [],
      removedSkills: [],
    };
    await useAgentStore.getState().setMemberDeltas('inst-1', deltas);
    expect(mockApi.agent.setMemberDeltas).toHaveBeenCalledWith('inst-1', deltas);

    await useAgentStore.getState().getMemberDeltas('inst-1');
    expect(mockApi.agent.getMemberDeltas).toHaveBeenCalledWith('inst-1');
  });

  it('loadBuiltinSuggestions 填充 state', async () => {
    await useAgentStore.getState().loadBuiltinSuggestions();
    expect(mockApi.agent.getBuiltinSuggestions).toHaveBeenCalled();
    expect(useAgentStore.getState().builtinSuggestions['def-1']).toBeDefined();
    expect(useAgentStore.getState().builtinSuggestions['def-1']!.suggestedPlatform).toBe('anthropic');
  });
});

describe('agent.store — 团队 action（spec §4.2/§5）', () => {
  it('loadTeams 填充 teams 并记住 workspaceId（后续变更用它自动刷新）', async () => {
    await useAgentStore.getState().loadTeams('ws-1');
    expect(mockApi.team.list).toHaveBeenCalledWith('ws-1');
    expect(useAgentStore.getState().teams).toEqual([MOCK_TEAM]);
    expect(useAgentStore.getState().teams[0]?.leaderInstanceId).toBe('inst-1');
  });

  it('loadTeams IPC 失败时写入 error', async () => {
    mockApi.team.list.mockRejectedValue(new Error('team:list down'));
    await useAgentStore.getState().loadTeams('ws-1');
    expect(useAgentStore.getState().error).toBe('team:list down');
  });

  it('createTeam 透传入参并刷新 teams', async () => {
    await useAgentStore.getState().loadTeams('ws-1');
    const newTeam = mkTeam({ id: 'team-2', name: '评审小组' });
    mockApi.team.create.mockResolvedValue(newTeam);
    mockApi.team.list.mockResolvedValue([MOCK_TEAM, newTeam]);

    const created = await useAgentStore.getState().createTeam('ws-1', {
      name: '评审小组',
      iconEmoji: '🔍',
      memberInstanceIds: ['inst-1', 'inst-2'],
      leaderInstanceId: 'inst-1',
    });
    expect(mockApi.team.create).toHaveBeenCalledWith('ws-1', {
      name: '评审小组',
      iconEmoji: '🔍',
      memberInstanceIds: ['inst-1', 'inst-2'],
      leaderInstanceId: 'inst-1',
    });
    expect(created.id).toBe('team-2');
    // 变更后自动 reload（单一真相源 = DB）
    expect(mockApi.team.list).toHaveBeenCalledTimes(2);
    expect(useAgentStore.getState().teams).toHaveLength(2);
  });

  it('createTeam IPC 失败时抛错并写入 error（leader 不在成员集等校验）', async () => {
    await useAgentStore.getState().loadTeams('ws-1');
    mockApi.team.create.mockRejectedValue(new Error('leader 必须在成员集内'));

    await expect(
      useAgentStore.getState().createTeam('ws-1', {
        name: '坏团队',
        memberInstanceIds: ['inst-1'],
        leaderInstanceId: 'inst-2',
      }),
    ).rejects.toThrow('leader 必须在成员集内');
    expect(useAgentStore.getState().error).toContain('leader');
  });

  it('renameTeam 透传 teamId/name/iconEmoji 并刷新 teams', async () => {
    await useAgentStore.getState().loadTeams('ws-1');
    const renamed = mkTeam({ name: '改名小组' });
    mockApi.team.list.mockResolvedValue([renamed]);

    await useAgentStore.getState().renameTeam('team-1', '改名小组', '🚀');
    expect(mockApi.team.rename).toHaveBeenCalledWith('team-1', '改名小组', '🚀');
    expect(useAgentStore.getState().teams[0]?.name).toBe('改名小组');
  });

  it('deleteTeam 后该团队从 teams 消失', async () => {
    await useAgentStore.getState().loadTeams('ws-1');
    mockApi.team.list.mockResolvedValue([]);

    await useAgentStore.getState().deleteTeam('team-1');
    expect(mockApi.team.delete).toHaveBeenCalledWith('team-1');
    expect(useAgentStore.getState().teams).toHaveLength(0);
  });

  it('setLeader 透传并刷新 teams（新 leader 必须是团队成员由主进程校验）', async () => {
    await useAgentStore.getState().loadTeams('ws-1');
    const swapped = mkTeam({ leaderInstanceId: 'inst-2' });
    mockApi.team.list.mockResolvedValue([swapped]);

    await useAgentStore.getState().setLeader('team-1', 'inst-2');
    expect(mockApi.team.setLeader).toHaveBeenCalledWith('team-1', 'inst-2');
    expect(useAgentStore.getState().teams[0]?.leaderInstanceId).toBe('inst-2');
  });

  it('setLeader IPC 失败（新 leader 不在团队内）抛错并写入 error', async () => {
    await useAgentStore.getState().loadTeams('ws-1');
    mockApi.team.setLeader.mockRejectedValue(new Error('新 leader 不是团队成员'));

    await expect(
      useAgentStore.getState().setLeader('team-1', 'inst-x'),
    ).rejects.toThrow('新 leader 不是团队成员');
    expect(useAgentStore.getState().error).toContain('团队成员');
  });

  it('addTeamMember / removeTeamMember 透传并刷新 teams', async () => {
    await useAgentStore.getState().loadTeams('ws-1');
    mockApi.team.list.mockClear();

    await useAgentStore.getState().addTeamMember('team-1', 'inst-2');
    expect(mockApi.team.addMember).toHaveBeenCalledWith('team-1', 'inst-2');
    expect(mockApi.team.list).toHaveBeenCalledTimes(1);

    mockApi.team.list.mockClear();
    await useAgentStore.getState().removeTeamMember('team-1', 'inst-2');
    expect(mockApi.team.removeMember).toHaveBeenCalledWith('team-1', 'inst-2');
    expect(mockApi.team.list).toHaveBeenCalledTimes(1);
  });

  it('reset 清空 teams 与 teamsWorkspaceId', async () => {
    await useAgentStore.getState().loadTeams('ws-1');
    expect(useAgentStore.getState().teams).toHaveLength(1);
    useAgentStore.getState().reset();
    expect(useAgentStore.getState().teams).toHaveLength(0);
    expect(useAgentStore.getState().definitions).toHaveLength(0);
    expect(useAgentStore.getState().members).toHaveLength(0);
  });
});
