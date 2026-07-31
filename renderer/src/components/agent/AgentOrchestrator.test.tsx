// renderer/src/components/agent/AgentOrchestrator.test.tsx
// AgentOrchestrator 编排视图渲染行为测试：树形展示 main→sub 关系，
// main 节点带 [main] 标签，standalone 节点带"设为主 agent"按钮。
//
// IPC 约定：通过 globalThis.window.api 提供桩（与 Onboarding/AddAgentDialog 测试一致），
// 不直接 vi.mock('../../ipc/client')。stores 用 vi.mock 做组件级隔离。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AgentDefinition, AgentAssignment } from '../../ipc/types';

// 测试用 agent 定义：1 个 main（PM）+ 1 个 sub（Coder，挂在 PM 下）+ 1 个 standalone（Helper）
const mockDefs: AgentDefinition[] = [
  { id: 'm1', name: 'PM', slug: 'pm', version: '1', type: 'main', runtime: 'declarative',
    systemPrompt: '', model: { provider: 'openai', model: 'gpt-4o' }, defaultTools: [],
    source: 'builtin', description: 'PM', iconEmoji: '📋', defaultMcps: [], defaultSkills: [] },
  { id: 's1', name: 'Coder', slug: 'coder', version: '1', type: 'sub', runtime: 'declarative',
    systemPrompt: '', model: { provider: 'openai', model: 'gpt-4o' }, defaultTools: [],
    source: 'builtin', description: '写代码', iconEmoji: '🔗', parentAgentId: 'm1',
    defaultMcps: [], defaultSkills: [] },
  { id: 'sa1', name: 'Helper', slug: 'helper', version: '1', type: 'standalone', runtime: 'declarative',
    systemPrompt: '', model: { provider: 'openai', model: 'gpt-4o' }, defaultTools: [],
    source: 'builtin', description: '助手', iconEmoji: '🤖', defaultMcps: [], defaultSkills: [] },
];
const mockAssignments: AgentAssignment[] = [
  { instanceId: 'a-m1', workspaceId: 'w', agentDefinitionId: 'm1', botMatrixUserId: '@m1:h', enabled: true, createdAt: '' },
  { instanceId: 'a-s1', workspaceId: 'w', agentDefinitionId: 's1', botMatrixUserId: '@s1:h', enabled: true, createdAt: '' },
  { instanceId: 'a-sa1', workspaceId: 'w', agentDefinitionId: 'sa1', botMatrixUserId: '@sa1:h', enabled: true, createdAt: '' },
];

// 组件级隔离 agent store：组件以 useAgentStore()（无 selector）解构整 state，直接返回 state
vi.mock('../../stores/agent.store', () => ({
  useAgentStore: vi.fn(() => ({
    assignments: mockAssignments,
    definitions: mockDefs,
    running: { 'a-m1': true, 'a-s1': true, 'a-sa1': false },
    loadDefinitions: vi.fn(),
    loadAssignments: vi.fn(),
  })),
}));
// 组件级隔离 workspace store：组件以 useWorkspaceStore((s) => s.getActive()) 带 selector 调用，
// 故 mock 需 selector-aware（与 AddAgentDialog.test.tsx 一致）
vi.mock('../../stores/workspace.store', () => ({
  useWorkspaceStore: vi.fn((selector?: (s: unknown) => unknown) => {
    const state = {
      getActive: () => ({ id: 'w', name: 'w', directoryPath: '/tmp', teamRoomId: '!t:h' }),
    };
    return selector ? selector(state) : state;
  }),
}));

// IPC 桩：ipc/client 的 Proxy 在调用时读取 globalThis.window.api，故只需提供 api 对象
const mockApi = {
  agent: { updateDefinition: vi.fn(async () => ({ definition: {}, stoppedInstanceIds: [] })) },
};

// 动态导入，确保 vi.mock 在组件加载前生效
const { AgentOrchestrator } = await import('./AgentOrchestrator');

beforeEach(() => {
  vi.clearAllMocks();
  // 沿用 Onboarding/AddAgentDialog 测试约定：只设置 api，不替换整个 window
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
});

describe('AgentOrchestrator', () => {
  it('渲染 main 节点及其子节点', () => {
    render(<AgentOrchestrator />);
    expect(screen.getByText('PM')).toBeDefined();
    expect(screen.getByText('Coder')).toBeDefined();
    expect(screen.getByText('Helper')).toBeDefined();
    // main 节点有 [main] 标签
    expect(screen.getByText('[main]')).toBeDefined();
    // standalone 有 [设为主 agent] 按钮
    expect(screen.getByText('设为主 agent')).toBeDefined();
  });
});
