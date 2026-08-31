// renderer/src/stores/agent.store.test.ts
// v25 schema：WorkspaceAgentMember 无 role/parent/enabled；通道面 member 命名
// （listMembers/addMember/setMemberApiKeyOverride）；assignMain/updateAssignmentRole
// 随 role 概念退役删除（用例同步移除）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAgentStore } from './agent.store';
import type { AgentAssignment, AgentDefinition } from '../ipc/types';

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

const MOCK_ASSIGNMENT: AgentAssignment = {
  instanceId: 'inst-1',
  workspaceId: 'ws-1',
  agentDefinitionId: 'def-1',
  agentUserId: '@bot.x.alice:localhost',
  createdAt: '2026-01-01T00:00:00Z',
  hasApiKeyOverride: false,
  lastRunning: true,
};

const mockApi = {
  agent: {
    list: vi.fn().mockResolvedValue(MOCK_DEFS),
    listMembers: vi.fn().mockResolvedValue([MOCK_ASSIGNMENT]),
    addMember: vi.fn().mockResolvedValue(MOCK_ASSIGNMENT),
    stop: vi.fn().mockResolvedValue({ ok: true }),
    isRunning: vi.fn().mockResolvedValue(true),
    deleteDefinition: vi.fn().mockResolvedValue({ stoppedInstanceIds: [] }),
    setMemberApiKeyOverride: vi.fn().mockResolvedValue({ ok: true }),
    getBuiltinSuggestions: vi.fn().mockResolvedValue({
      'def-1': { suggestedPlatform: 'anthropic' },
    }),
  },
};

beforeEach(() => {
  (globalThis as unknown as { window: { api: typeof mockApi } }).window = { api: mockApi };
  useAgentStore.getState().reset();
  mockApi.agent.list.mockResolvedValue(MOCK_DEFS);
  mockApi.agent.listMembers.mockResolvedValue([MOCK_ASSIGNMENT]);
  mockApi.agent.addMember.mockResolvedValue(MOCK_ASSIGNMENT);
  mockApi.agent.isRunning.mockResolvedValue(true);
  mockApi.agent.stop.mockClear();
  mockApi.agent.deleteDefinition.mockClear();
  mockApi.agent.setMemberApiKeyOverride.mockClear();
});

describe('agent.store — v25', () => {
  it('loadDefinitions(wsId) 透传 workspaceId 到 IPC', async () => {
    await useAgentStore.getState().loadDefinitions('ws-1');
    expect(mockApi.agent.list).toHaveBeenCalledWith('ws-1');
    expect(useAgentStore.getState().definitions).toHaveLength(1);
  });

  it('loadAssignments 填充 assignments', async () => {
    await useAgentStore.getState().loadAssignments('ws-1');
    expect(mockApi.agent.listMembers).toHaveBeenCalledWith('ws-1');
    expect(useAgentStore.getState().assignments).toHaveLength(1);
    expect(useAgentStore.getState().assignments[0]?.lastRunning).toBe(true);
  });

  it('addAgent 透传 workspaceId + defId + apiKeyOverride', async () => {
    await useAgentStore.getState().addAgent('ws-1', 'def-1', 'sk-x');
    expect(mockApi.agent.addMember).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      agentDefinitionId: 'def-1',
      apiKeyOverride: 'sk-x',
    });
    expect(useAgentStore.getState().assignments).toContainEqual(MOCK_ASSIGNMENT);
  });

  it('addAgent 失败时抛错并写入 error', async () => {
    mockApi.agent.addMember.mockRejectedValue(new Error('加入失败'));
    await expect(
      useAgentStore.getState().addAgent('ws-1', 'def-1'),
    ).rejects.toThrow('加入失败');
    expect(useAgentStore.getState().error).toBe('加入失败');
  });

  it('addAgent 返回新创建的成员（供调用方捕获 instanceId 写 Layer 3 deltas）', async () => {
    const result = await useAgentStore.getState().addAgent('ws-1', 'def-1');
    expect(result).toEqual(MOCK_ASSIGNMENT);
    expect(result.instanceId).toBe('inst-1');
  });

  it('stopAgent 调用 stop 并重新加载 assignments（反映 lastRunning）', async () => {
    await useAgentStore.getState().addAgent('ws-1', 'def-1');
    expect(useAgentStore.getState().assignments).toContainEqual(MOCK_ASSIGNMENT);

    // stop 后 listMembers 返回 lastRunning=false 的成员
    const stoppedAssignment = { ...MOCK_ASSIGNMENT, lastRunning: false };
    mockApi.agent.listMembers.mockResolvedValueOnce([stoppedAssignment]);

    await useAgentStore.getState().stopAgent('inst-1');
    expect(mockApi.agent.stop).toHaveBeenCalledWith('inst-1');
    expect(useAgentStore.getState().assignments[0]?.lastRunning).toBe(false);
  });

  it('deleteDefinition 调用 IPC + 刷新 definitions', async () => {
    await useAgentStore.getState().loadDefinitions('ws-1');
    expect(useAgentStore.getState().definitions).toHaveLength(1);

    await useAgentStore.getState().deleteDefinition('def-1');
    expect(mockApi.agent.deleteDefinition).toHaveBeenCalledWith('def-1');
    expect(useAgentStore.getState().definitions).toHaveLength(0);
  });

  it('updateAssignmentApiKey(null) 调用 setMemberApiKeyOverride 清除 override', async () => {
    await useAgentStore.getState().loadAssignments('ws-1');

    await useAgentStore.getState().updateAssignmentApiKey('inst-1', null);
    expect(mockApi.agent.setMemberApiKeyOverride).toHaveBeenCalledWith('inst-1', null);
  });

  it('loadBuiltinSuggestions 填充 state', async () => {
    await useAgentStore.getState().loadBuiltinSuggestions();
    expect(mockApi.agent.getBuiltinSuggestions).toHaveBeenCalled();
    expect(useAgentStore.getState().builtinSuggestions['def-1']).toBeDefined();
    expect(useAgentStore.getState().builtinSuggestions['def-1']!.suggestedPlatform).toBe('anthropic');
  });
});
