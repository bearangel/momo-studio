// electron/tests/agent/ipc-handlers.test.ts
//
// agent: / team: 命名空间 IPC handler 契约测试（v25 Task 6，spec §5）。
//
// 锁三件事：
//   1. 新通道注册齐全 + 退役通道零注册（agent:addToWorkspace / assignMain /
//      updateAssignmentRole / listAssignments / removeAssignment /
//      updateAssignmentApiKey / getAssignmentDeltas / setAssignmentDeltas）
//   2. handler 显式映射委托到 crud / team 服务（参数逐字段透传，杜绝整传 input）
//   3. 编排副作用契约：removeMember blocked 零副作用（不停 runtime）；
//      addMember 成功后启动 runtime；team 服务错误原样传播
//
// 保真度（momo-test-rules）：mock 只覆盖 DB/keychain/runtime 进程边界；
// mock 产出的 instanceId / agentUserId 用自增序号保证唯一（消费方去重语义不误杀）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted：vi.mock 工厂提升到 import 之前，可变桩需在此声明
const {
  ipcHandlers,
  crudMocks,
  teamMocks,
  workspaceCrudMocks,
  keychainMocks,
  runtimeRegistryMocks,
  runtimeStatusMocks,
  spawnMocks,
  builtinMocks,
  resourceShareMocks,
  capsMocks,
} = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
  // 自增序号：mock 产出的 ID 必须真实唯一（randomUUID 语义的最小仿真）
  let idSeq = 0;
  const nextId = (prefix: string): string => {
    idSeq += 1;
    return `${prefix}-${idSeq}`;
  };
  return {
    ipcHandlers,
    crudMocks: {
      saveAgentDefinition: vi.fn(),
      listAgentDefinitions: vi.fn(() => []),
      getAgentDefinition: vi.fn((): null => null),
      addMember: vi.fn(async () => ({
        instanceId: nextId('inst'),
        workspaceId: 'ws-1',
        agentDefinitionId: 'def-1',
        agentUserId: `@bot-${idSeq}:local`,
        hasApiKeyOverride: false,
        lastRunning: true,
        createdAt: '2026-09-01T00:00:00.000Z',
      })),
      generateAgentUserId: vi.fn((slug: string) => `@${slug}-${nextId('u')}:local`),
      listMembers: vi.fn(() => []),
      removeMember: vi.fn(() => ({ ok: true })),
      updateAssignmentApiKey: vi.fn(async () => undefined),
      deleteDefinition: vi.fn(async () => ({ stoppedInstanceIds: [] })),
      updateAgentDefinition: vi.fn(() => ({})),
      createCustomDef: vi.fn(() => ({})),
      stopRunningInstancesByDefinition: vi.fn(async () => []),
    },
    teamMocks: {
      listTeams: vi.fn(() => []),
      createTeam: vi.fn(() => ({
        id: 'team-1',
        workspaceId: 'ws-1',
        name: '攻坚组',
        iconEmoji: '👥',
        leaderInstanceId: 'inst-leader',
        members: [],
        createdAt: '2026-09-01T00:00:00.000Z',
      })),
      renameTeam: vi.fn(),
      setLeader: vi.fn(),
      addTeamMember: vi.fn(),
      removeTeamMember: vi.fn(),
      deleteTeam: vi.fn(),
    },
    workspaceCrudMocks: {
      getWorkspace: vi.fn((): null => null),
    },
    keychainMocks: {
      deleteSecret: vi.fn(async () => undefined),
      setSecret: vi.fn(async () => undefined),
    },
    runtimeRegistryMocks: {
      startAgentRuntime: vi.fn(async () => undefined),
      stopAgentRuntime: vi.fn(async () => undefined),
    },
    runtimeStatusMocks: {
      isAgentRunning: vi.fn(() => false),
    },
    spawnMocks: {
      buildSpawnOpts: vi.fn(() => ({ instanceId: 'spawn-opts-stub' })),
      resolveApiKey: vi.fn(async () => 'sk-test'),
    },
    builtinMocks: {
      getBuiltinSuggestionsMap: vi.fn(() => ({})),
    },
    resourceShareMocks: {
      broadcastLocalResourceCatalog: vi.fn(async () => undefined),
    },
    capsMocks: {
      getAssignmentDeltas: vi.fn(() => ({
        addedTools: [], removedTools: [], addedMcps: [],
        removedMcps: [], addedSkills: [], removedSkills: [],
      })),
      setAssignmentDeltas: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
}));

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/main/agent/crud', () => crudMocks);
vi.mock('../../src/main/agent/team', () => teamMocks);
vi.mock('../../src/main/workspace/crud', () => workspaceCrudMocks);
vi.mock('../../src/main/storage/keychain', () => keychainMocks);
vi.mock('../../src/main/agent/runtime-registry', () => runtimeRegistryMocks);
vi.mock('../../src/main/agent/runtime-status', () => runtimeStatusMocks);
vi.mock('../../src/main/agent/spawn-helpers', () => spawnMocks);
vi.mock('../../src/main/agent/builtin', () => builtinMocks);
vi.mock('../../src/main/p2p/resource-share', () => resourceShareMocks);
vi.mock('../../src/main/agent/assignment-capabilities', () => capsMocks);
vi.mock('../../src/main/agent/manifest-parser', () => ({
  parseAgentManifest: vi.fn(),
}));

import { registerAgentHandlers } from '../../src/main/agent/ipc.handlers';

/** 最小可用 def fixture（modelProviderId 已配置） */
const DEF = {
  id: 'def-1',
  name: '小助手',
  slug: 'helper',
  modelProviderId: 'prov-1',
} as const;

const WORKSPACE = {
  id: 'ws-1',
  directoryPath: '/tmp/ws-1',
  defaultAgentInstanceId: null,
} as const;

beforeEach(() => {
  ipcHandlers.clear();
  Object.values(crudMocks).forEach((m) => m.mockClear());
  Object.values(teamMocks).forEach((m) => m.mockClear());
  Object.values(workspaceCrudMocks).forEach((m) => m.mockClear());
  Object.values(keychainMocks).forEach((m) => m.mockClear());
  Object.values(runtimeRegistryMocks).forEach((m) => m.mockClear());
  Object.values(runtimeStatusMocks).forEach((m) => m.mockClear());
  Object.values(spawnMocks).forEach((m) => m.mockClear());
  Object.values(builtinMocks).forEach((m) => m.mockClear());
  Object.values(resourceShareMocks).forEach((m) => m.mockClear());
  Object.values(capsMocks).forEach((m) => m.mockClear());
  registerAgentHandlers();
});

describe('通道注册面（spec §5）', () => {
  it('注册全部 agent: 存留通道 + team: 新通道', () => {
    const expected = [
      'agent:addMember',
      'agent:createFromYaml',
      'agent:createCustom',
      'agent:updateDefinition',
      'agent:deleteDefinition',
      'agent:list',
      'agent:assign',
      'agent:listMembers',
      'agent:stop',
      'agent:removeMember',
      'agent:isRunning',
      'agent:setMemberApiKeyOverride',
      'agent:getBuiltinSuggestions',
      'agent:getMemberDeltas',
      'agent:setMemberDeltas',
      'agent:start',
      'team:list',
      'team:create',
      'team:rename',
      'team:delete',
      'team:setLeader',
      'team:addMember',
      'team:removeMember',
    ];
    for (const ch of expected) expect(ipcHandlers.has(ch), ch).toBe(true);
  });

  it('退役通道零注册（零残留锁）', () => {
    const retired = [
      'agent:addToWorkspace',
      'agent:assignMain',
      'agent:updateAssignmentRole',
      'agent:listAssignments',
      'agent:removeAssignment',
      'agent:updateAssignmentApiKey',
      'agent:getAssignmentDeltas',
      'agent:setAssignmentDeltas',
    ];
    for (const ch of retired) expect(ipcHandlers.has(ch), ch).toBe(false);
  });
});

describe('agent:addMember handler', () => {
  it('显式映射入参 → addMember → resolveApiKey → 启动 runtime → 返回成员', async () => {
    crudMocks.getAgentDefinition.mockReturnValueOnce({ ...DEF });
    workspaceCrudMocks.getWorkspace.mockReturnValueOnce({ ...WORKSPACE });

    const res = await ipcHandlers.get('agent:addMember')!({} as never, {
      workspaceId: 'ws-1',
      agentDefinitionId: 'def-1',
      apiKeyOverride: 'sk-override',
    });

    // def / workspace 守卫
    expect(crudMocks.getAgentDefinition).toHaveBeenCalledWith('def-1');
    expect(workspaceCrudMocks.getWorkspace).toHaveBeenCalledWith('ws-1');
    // 本地身份生成 + apiKeyOverride 透传（显式映射，不整传 input）
    expect(crudMocks.addMember).toHaveBeenCalledWith(
      'ws-1', 'def-1', expect.any(String), 'sk-override',
    );
    expect(spawnMocks.resolveApiKey).toHaveBeenCalled();
    expect(runtimeRegistryMocks.startAgentRuntime).toHaveBeenCalledTimes(1);
    // 返回带真实唯一 instanceId 的成员
    expect(res).toMatchObject({ workspaceId: 'ws-1', agentDefinitionId: 'def-1' });
    expect((res as { instanceId: string }).instanceId).toMatch(/^inst-\d+$/);
  });

  it('def 未配置 modelProviderId → 拒绝且零写入', async () => {
    crudMocks.getAgentDefinition.mockReturnValueOnce({ ...DEF, modelProviderId: null });
    await expect(
      ipcHandlers.get('agent:addMember')!({} as never, {
        workspaceId: 'ws-1',
        agentDefinitionId: 'def-1',
      }),
    ).rejects.toThrow('modelProviderId');
    expect(crudMocks.addMember).not.toHaveBeenCalled();
  });

  it('workspace 不存在 → 拒绝', async () => {
    crudMocks.getAgentDefinition.mockReturnValueOnce({ ...DEF });
    workspaceCrudMocks.getWorkspace.mockReturnValueOnce(null);
    await expect(
      ipcHandlers.get('agent:addMember')!({} as never, {
        workspaceId: 'ws-404',
        agentDefinitionId: 'def-1',
      }),
    ).rejects.toThrow('workspace');
  });
});

describe('agent:removeMember handler', () => {
  it('成功：事务删除 + 销毁 runtime + 清 keychain override', async () => {
    crudMocks.removeMember.mockReturnValueOnce({ ok: true });
    const res = await ipcHandlers.get('agent:removeMember')!({} as never, 'inst-9');
    expect(res).toEqual({ ok: true });
    expect(runtimeRegistryMocks.stopAgentRuntime).toHaveBeenCalledWith('inst-9');
    expect(keychainMocks.deleteSecret).toHaveBeenCalledWith('agent.inst-9.api_key_override');
  });

  it('leader 守卫 blocked：返回 blockedTeams，零副作用（不停 runtime / 不清 keychain）', async () => {
    crudMocks.removeMember.mockReturnValueOnce({ ok: false, blockedTeams: ['攻坚组', '值班组'] });
    const res = await ipcHandlers.get('agent:removeMember')!({} as never, 'inst-leader');
    expect(res).toEqual({ ok: false, blockedTeams: ['攻坚组', '值班组'] });
    expect(runtimeRegistryMocks.stopAgentRuntime).not.toHaveBeenCalled();
    expect(keychainMocks.deleteSecret).not.toHaveBeenCalled();
  });
});

describe('agent 成员读写平移通道', () => {
  it('agent:listMembers 委托 listMembers(workspaceId)', async () => {
    crudMocks.listMembers.mockReturnValueOnce([{ instanceId: 'inst-1' }]);
    const res = await ipcHandlers.get('agent:listMembers')!({} as never, 'ws-1');
    expect(crudMocks.listMembers).toHaveBeenCalledWith('ws-1');
    expect(res).toEqual([{ instanceId: 'inst-1' }]);
  });

  it('agent:setMemberApiKeyOverride 委托 updateAssignmentApiKey(instanceId, apiKey)', async () => {
    const res = await ipcHandlers.get('agent:setMemberApiKeyOverride')!({} as never, 'inst-1', 'sk-new');
    expect(crudMocks.updateAssignmentApiKey).toHaveBeenCalledWith('inst-1', 'sk-new');
    expect(res).toEqual({ ok: true });
  });

  it('agent:setMemberApiKeyOverride(null) 清除语义透传', async () => {
    await ipcHandlers.get('agent:setMemberApiKeyOverride')!({} as never, 'inst-1', null);
    expect(crudMocks.updateAssignmentApiKey).toHaveBeenCalledWith('inst-1', null);
  });

  it('agent:getMemberDeltas 委托 getAssignmentDeltas(instanceId)', async () => {
    const res = await ipcHandlers.get('agent:getMemberDeltas')!({} as never, 'inst-1');
    expect(capsMocks.getAssignmentDeltas).toHaveBeenCalledWith('inst-1');
    expect(res).toMatchObject({
      addedTools: [], removedTools: [], addedMcps: [],
      removedMcps: [], addedSkills: [], removedSkills: [],
    });
  });

  it('agent:setMemberDeltas 委托 setAssignmentDeltas(instanceId, deltas)', async () => {
    const deltas = {
      addedTools: ['bash'], removedTools: [], addedMcps: [],
      removedMcps: [], addedSkills: [], removedSkills: [],
    };
    await ipcHandlers.get('agent:setMemberDeltas')!({} as never, 'inst-1', deltas);
    expect(capsMocks.setAssignmentDeltas).toHaveBeenCalledWith('inst-1', deltas);
  });
});

describe('team: 通道（spec §4.2 委托）', () => {
  it('team:list 委托 listTeams(workspaceId)', async () => {
    teamMocks.listTeams.mockReturnValueOnce([{ id: 'team-1' }]);
    const res = await ipcHandlers.get('team:list')!({} as never, 'ws-1');
    expect(teamMocks.listTeams).toHaveBeenCalledWith('ws-1');
    expect(res).toEqual([{ id: 'team-1' }]);
  });

  it('team:create 显式映射入参委托 createTeam（iconEmoji 缺省 👥）', async () => {
    const res = await ipcHandlers.get('team:create')!({} as never, 'ws-1', {
      name: '攻坚组',
      memberInstanceIds: ['inst-leader', 'inst-a'],
      leaderInstanceId: 'inst-leader',
    });
    expect(teamMocks.createTeam).toHaveBeenCalledWith(
      'ws-1', '攻坚组', '👥', ['inst-leader', 'inst-a'], 'inst-leader',
    );
    expect(res).toMatchObject({ id: 'team-1', name: '攻坚组' });
  });

  it('team:create 成员数不足时 createTeam 错误原样传播', async () => {
    teamMocks.createTeam.mockImplementationOnce(() => {
      throw new Error('团队成员数至少 2（leader + 至少 1 名成员），去重后为 1');
    });
    await expect(
      ipcHandlers.get('team:create')!({} as never, 'ws-1', {
        name: '独行侠',
        memberInstanceIds: ['inst-solo'],
        leaderInstanceId: 'inst-solo',
      }),
    ).rejects.toThrow('团队成员数至少 2');
  });

  it('team:rename 委托 renameTeam(teamId, name, iconEmoji?)', async () => {
    await ipcHandlers.get('team:rename')!({} as never, 'team-1', '新名字', '🚀');
    expect(teamMocks.renameTeam).toHaveBeenCalledWith('team-1', '新名字', '🚀');
  });

  it('team:setLeader 委托 setLeader(teamId, leaderInstanceId)', async () => {
    await ipcHandlers.get('team:setLeader')!({} as never, 'team-1', 'inst-b');
    expect(teamMocks.setLeader).toHaveBeenCalledWith('team-1', 'inst-b');
  });

  it('team:setLeader 新 leader 不在团队内时错误传播', async () => {
    teamMocks.setLeader.mockImplementationOnce(() => {
      throw new Error('新 leader 必须是团队成员: inst-x');
    });
    await expect(
      ipcHandlers.get('team:setLeader')!({} as never, 'team-1', 'inst-x'),
    ).rejects.toThrow('新 leader 必须是团队成员');
  });

  it('team:addMember 委托 addTeamMember(teamId, instanceId)', async () => {
    await ipcHandlers.get('team:addMember')!({} as never, 'team-1', 'inst-c');
    expect(teamMocks.addTeamMember).toHaveBeenCalledWith('team-1', 'inst-c');
  });

  it('team:removeMember 委托 removeTeamMember；leader 守卫错误传播', async () => {
    await ipcHandlers.get('team:removeMember')!({} as never, 'team-1', 'inst-b');
    expect(teamMocks.removeTeamMember).toHaveBeenCalledWith('team-1', 'inst-b');

    teamMocks.removeTeamMember.mockImplementationOnce(() => {
      throw new Error('不能移除团队 leader，请先转移 leader 或解散团队');
    });
    await expect(
      ipcHandlers.get('team:removeMember')!({} as never, 'team-1', 'inst-leader'),
    ).rejects.toThrow('不能移除团队 leader');
  });

  it('team:delete 委托 deleteTeam(teamId) 并回传 { ok: true }', async () => {
    const res = await ipcHandlers.get('team:delete')!({} as never, 'team-1');
    expect(teamMocks.deleteTeam).toHaveBeenCalledWith('team-1');
    expect(res).toEqual({ ok: true });
  });
});
