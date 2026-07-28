// renderer/src/stores/agent.store.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAgentStore } from './agent.store';
import type { AgentAssignment, AgentDefinition } from '../ipc/types';

const MOCK_DEFS: AgentDefinition[] = [
  {
    id: 'def-1',
    name: '需求讨论师',
    slug: 'requirement-analyst',
    version: '1.0.0',
    type: 'standalone',
    runtime: 'declarative',
    systemPrompt: '你是需求分析师',
    model: { provider: 'anthropic', model: 'claude-3-5-sonnet' },
    defaultTools: [{ kind: 'builtin', ref: 'read_file' }],
    source: 'builtin',
    description: '梳理需求',
    iconEmoji: '📝',
  },
];

const MOCK_ASSIGNMENT: AgentAssignment = {
  instanceId: 'inst-1',
  workspaceId: 'ws-1',
  agentDefinitionId: 'def-1',
  botMatrixUserId: '@bot.x.alice:localhost',
  enabled: true,
  createdAt: '2026-01-01T00:00:00Z',
};

const mockApi = {
  agent: {
    list: vi.fn().mockResolvedValue(MOCK_DEFS),
    listAssignments: vi.fn().mockResolvedValue([MOCK_ASSIGNMENT]),
    addToWorkspace: vi.fn().mockResolvedValue(MOCK_ASSIGNMENT),
    stop: vi.fn().mockResolvedValue({ ok: true }),
    isRunning: vi.fn().mockResolvedValue(true),
  },
};

beforeEach(() => {
  Object.assign(globalThis, { window: { api: mockApi } });
  useAgentStore.getState().reset();
  mockApi.agent.list.mockResolvedValue(MOCK_DEFS);
  mockApi.agent.listAssignments.mockResolvedValue([MOCK_ASSIGNMENT]);
  mockApi.agent.addToWorkspace.mockResolvedValue(MOCK_ASSIGNMENT);
  mockApi.agent.isRunning.mockResolvedValue(true);
  mockApi.agent.stop.mockClear();
});

describe('agent.store', () => {
  it('loadDefinitions 填充 definitions', async () => {
    await useAgentStore.getState().loadDefinitions();
    expect(useAgentStore.getState().definitions).toHaveLength(1);
    expect(useAgentStore.getState().definitions[0]!.slug).toBe('requirement-analyst');
  });

  it('loadAssignments 填充 assignments 并同步运行状态', async () => {
    await useAgentStore.getState().loadAssignments('ws-1');
    expect(mockApi.agent.listAssignments).toHaveBeenCalledWith('ws-1');
    expect(useAgentStore.getState().assignments).toHaveLength(1);
    expect(useAgentStore.getState().running['inst-1']).toBe(true);
  });

  it('addAgent 调用 addToWorkspace 并追加 assignment + 标记运行中', async () => {
    await useAgentStore.getState().addAgent('ws-1', 'def-1', 'sk-test');
    expect(mockApi.agent.addToWorkspace).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      agentDefinitionId: 'def-1',
      llmApiKey: 'sk-test',
    });
    expect(useAgentStore.getState().assignments).toContainEqual(MOCK_ASSIGNMENT);
    expect(useAgentStore.getState().running['inst-1']).toBe(true);
  });

  it('addAgent 失败时抛错并写入 error', async () => {
    mockApi.agent.addToWorkspace.mockRejectedValue(new Error('bot 注册失败'));
    await expect(
      useAgentStore.getState().addAgent('ws-1', 'def-1', 'sk-test'),
    ).rejects.toThrow('bot 注册失败');
    expect(useAgentStore.getState().error).toBe('bot 注册失败');
  });

  it('stopAgent 调用 stop 并标记为未运行', async () => {
    await useAgentStore.getState().addAgent('ws-1', 'def-1', 'sk-test');
    expect(useAgentStore.getState().running['inst-1']).toBe(true);

    await useAgentStore.getState().stopAgent('inst-1');
    expect(mockApi.agent.stop).toHaveBeenCalledWith('inst-1');
    expect(useAgentStore.getState().running['inst-1']).toBe(false);
  });
});
