// renderer/src/stores/agent.store.test.ts
// v1.3 schema：AgentDefinition 无 type/parent/model；AgentAssignment 含 role/parent/hasApiKeyOverride
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
  botMatrixUserId: '@bot.x.alice:localhost',
  enabled: true,
  createdAt: '2026-01-01T00:00:00Z',
  role: 'standalone',
  parentInstanceId: null,
  hasApiKeyOverride: false,
  lastRunning: true,
};

const MOCK_MAIN_ASSIGNMENT: AgentAssignment = {
  instanceId: 'main-i',
  workspaceId: 'ws-1',
  agentDefinitionId: 'main-d',
  botMatrixUserId: '@main:localhost',
  enabled: true,
  createdAt: '2026-01-01T00:00:00Z',
  role: 'main',
  parentInstanceId: null,
  hasApiKeyOverride: false,
  lastRunning: true,
};

const MOCK_SUB_ASSIGNMENT: AgentAssignment = {
  instanceId: 'sub-i',
  workspaceId: 'ws-1',
  agentDefinitionId: 'sub-d',
  botMatrixUserId: '@sub:localhost',
  enabled: true,
  createdAt: '2026-01-01T00:00:00Z',
  role: 'sub',
  parentInstanceId: 'main-i',
  hasApiKeyOverride: false,
  lastRunning: false,
};

const mockApi = {
  agent: {
    list: vi.fn().mockResolvedValue(MOCK_DEFS),
    listAssignments: vi.fn().mockResolvedValue([MOCK_ASSIGNMENT]),
    addToWorkspace: vi.fn().mockResolvedValue(MOCK_ASSIGNMENT),
    stop: vi.fn().mockResolvedValue({ ok: true }),
    isRunning: vi.fn().mockResolvedValue(true),
    assignMain: vi.fn().mockResolvedValue([MOCK_MAIN_ASSIGNMENT, MOCK_SUB_ASSIGNMENT]),
    deleteDefinition: vi.fn().mockResolvedValue({ stoppedInstanceIds: [] }),
    updateAssignmentRole: vi.fn().mockResolvedValue({ stoppedInstanceIds: [] }),
    updateAssignmentApiKey: vi.fn().mockResolvedValue({ ok: true }),
    getBuiltinSuggestions: vi.fn().mockResolvedValue({
      'def-1': { role: 'standalone', suggestedPlatform: 'anthropic' },
    }),
  },
};

beforeEach(() => {
  (globalThis as unknown as { window: { api: typeof mockApi } }).window = { api: mockApi };
  useAgentStore.getState().reset();
  mockApi.agent.list.mockResolvedValue(MOCK_DEFS);
  mockApi.agent.listAssignments.mockResolvedValue([MOCK_ASSIGNMENT]);
  mockApi.agent.addToWorkspace.mockResolvedValue(MOCK_ASSIGNMENT);
  mockApi.agent.isRunning.mockResolvedValue(true);
  mockApi.agent.assignMain.mockResolvedValue([MOCK_MAIN_ASSIGNMENT, MOCK_SUB_ASSIGNMENT]);
  mockApi.agent.stop.mockClear();
  mockApi.agent.assignMain.mockClear();
  mockApi.agent.deleteDefinition.mockClear();
  mockApi.agent.updateAssignmentRole.mockClear();
  mockApi.agent.updateAssignmentApiKey.mockClear();
});

describe('agent.store — v1.3', () => {
  it('loadDefinitions(wsId) 透传 workspaceId 到 IPC', async () => {
    await useAgentStore.getState().loadDefinitions('ws-1');
    expect(mockApi.agent.list).toHaveBeenCalledWith('ws-1');
    expect(useAgentStore.getState().definitions).toHaveLength(1);
  });

  it('loadAssignments 填充 assignments 并同步运行状态', async () => {
    await useAgentStore.getState().loadAssignments('ws-1');
    expect(mockApi.agent.listAssignments).toHaveBeenCalledWith('ws-1');
    expect(useAgentStore.getState().assignments).toHaveLength(1);
    expect(useAgentStore.getState().running['inst-1']).toBe(true);
  });

  it('addAgent 透传 role + parentInstanceId + apiKeyOverride', async () => {
    await useAgentStore.getState().addAgent('ws-1', 'def-1', 'main');
    expect(mockApi.agent.addToWorkspace).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      agentDefinitionId: 'def-1',
      role: 'main',
      parentInstanceId: undefined,
      apiKeyOverride: undefined,
    });
    expect(useAgentStore.getState().assignments).toContainEqual(MOCK_ASSIGNMENT);
    expect(useAgentStore.getState().running['inst-1']).toBe(true);
  });

  it('addAgent 失败时抛错并写入 error', async () => {
    mockApi.agent.addToWorkspace.mockRejectedValue(new Error('bot 注册失败'));
    await expect(
      useAgentStore.getState().addAgent('ws-1', 'def-1', 'standalone'),
    ).rejects.toThrow('bot 注册失败');
    expect(useAgentStore.getState().error).toBe('bot 注册失败');
  });

  it('addAgent 返回新创建的 AgentAssignment（供调用方捕获 instanceId 写 Layer 3 deltas）', async () => {
    const result = await useAgentStore.getState().addAgent('ws-1', 'def-1', 'standalone');
    expect(result).toEqual(MOCK_ASSIGNMENT);
    expect(result.instanceId).toBe('inst-1');
  });

  it('stopAgent 调用 stop 并标记为未运行', async () => {
    await useAgentStore.getState().addAgent('ws-1', 'def-1', 'standalone');
    expect(useAgentStore.getState().running['inst-1']).toBe(true);

    await useAgentStore.getState().stopAgent('inst-1');
    expect(mockApi.agent.stop).toHaveBeenCalledWith('inst-1');
    expect(useAgentStore.getState().running['inst-1']).toBe(false);
  });

  it('deleteDefinition 调用 IPC + 刷新 definitions', async () => {
    await useAgentStore.getState().loadDefinitions('ws-1');
    expect(useAgentStore.getState().definitions).toHaveLength(1);

    await useAgentStore.getState().deleteDefinition('def-1');
    expect(mockApi.agent.deleteDefinition).toHaveBeenCalledWith('def-1');
    expect(useAgentStore.getState().definitions).toHaveLength(0);
  });

  it('updateAssignmentRole 调用 IPC + 刷新 assignments', async () => {
    await useAgentStore.getState().loadAssignments('ws-1');

    await useAgentStore.getState().updateAssignmentRole('inst-1', 'main');
    expect(mockApi.agent.updateAssignmentRole).toHaveBeenCalledWith('inst-1', 'main', undefined);
  });

  it('updateAssignmentApiKey(null) 调用 IPC 清除 override', async () => {
    await useAgentStore.getState().loadAssignments('ws-1');

    await useAgentStore.getState().updateAssignmentApiKey('inst-1', null);
    expect(mockApi.agent.updateAssignmentApiKey).toHaveBeenCalledWith('inst-1', null);
  });

  it('loadBuiltinSuggestions 填充 state', async () => {
    await useAgentStore.getState().loadBuiltinSuggestions();
    expect(mockApi.agent.getBuiltinSuggestions).toHaveBeenCalled();
    expect(useAgentStore.getState().builtinSuggestions['def-1']).toBeDefined();
    expect(useAgentStore.getState().builtinSuggestions['def-1']!.suggestedPlatform).toBe('anthropic');
  });
});

describe('assignMainAgent — v1.3', () => {
  it('调 IPC 后追加 assignments 并标记运行中', async () => {
    await useAgentStore.getState().assignMainAgent('ws-1', 'main-d');
    const { assignments, running } = useAgentStore.getState();
    expect(assignments).toHaveLength(2);
    expect(running['main-i']).toBe(true);
    expect(running['sub-i']).toBe(true);
  });

  it('apiKeyOverride + selectedSubDefIds 透传', async () => {
    await useAgentStore.getState().assignMainAgent('ws-1', 'main-d', 'sk-override', ['sub-d']);
    expect(mockApi.agent.assignMain).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      mainDefId: 'main-d',
      apiKeyOverride: 'sk-override',
      selectedSubDefIds: ['sub-d'],
    });
  });
});
