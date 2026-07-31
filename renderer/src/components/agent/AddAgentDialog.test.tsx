// renderer/src/components/agent/AddAgentDialog.test.tsx
// AddAgentDialog 角色选择 + main 定义子 agent 勾选的渲染行为测试。
//
// IPC 约定：通过 globalThis.window.api 提供桩（与 Onboarding/MainLayout 测试一致），
// 不直接 vi.mock('../../ipc/client')。stores 用 vi.mock 做组件级隔离。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { AgentDefinition } from '../../ipc/types';

// 测试用 agent 定义：1 个 main（PM）+ 1 个 sub（Coder，挂在 PM 下）+ 1 个 standalone
const mockDefinitions: AgentDefinition[] = [
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

// 组件级隔离三个 store：返回受控数据，避免真实异步链触发 act 警告
vi.mock('../../stores/agent.store', () => ({
  useAgentStore: vi.fn(() => ({
    definitions: mockDefinitions,
    loadDefinitions: vi.fn(),
    addAgent: vi.fn(async () => {}),
    assignMainAgent: vi.fn(async () => {}),
  })),
}));
vi.mock('../../stores/provider.store', () => ({
  useProviderStore: vi.fn(() => ({ providers: [], loadProviders: vi.fn() })),
}));
vi.mock('../../stores/workspace.store', () => ({
  useWorkspaceStore: vi.fn((selector?: (s: unknown) => unknown) => {
    const state = {
      getActive: () => ({ id: 'w', name: 'w', directoryPath: '/tmp', teamRoomId: '!t:h' }),
      setCoordinator: vi.fn(),
    };
    return selector ? selector(state) : state;
  }),
}));

// IPC 桩：proxy 读取 globalThis.window.api，故只需提供 api 对象
const mockApi = {
  agent: { createCustom: vi.fn(), updateDefinition: vi.fn() },
  provider: { getApiKey: vi.fn().mockResolvedValue(null) },
};

// 动态导入，确保 vi.mock 在组件加载前生效
const { AddAgentDialog } = await import('./AddAgentDialog');

beforeEach(() => {
  vi.clearAllMocks();
  // 沿用 Onboarding/MainLayout 测试约定：只设置 api，不替换整个 window
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
});

describe('AddAgentDialog — 选择 main 定义', () => {
  it('选中 main 定义时展示子 agent 勾选区', () => {
    render(<AddAgentDialog onClose={() => {}} />);
    // 选 PM（main 定义）—— 默认已选中 definitions[0]=m1，再次 change 保证 selectedDefId 更新
    const select = screen.getByDisplayValue(/PM/);
    fireEvent.change(select, { target: { value: 'm1' } });
    // 子 agent 勾选区出现：标题 + Coder 对应的勾选框（区别于下拉里的同名选项）
    expect(screen.getByText(/子 Agent/)).toBeDefined();
    expect(screen.getByRole('checkbox', { name: /Coder/ })).toBeDefined();
    // 默认全部勾选
    expect((screen.getByRole('checkbox', { name: /Coder/ }) as HTMLInputElement).checked).toBe(true);
  });
});

describe('AddAgentDialog — 创建自定义角色选择', () => {
  it('切换到创建模式有角色下拉', () => {
    render(<AddAgentDialog onClose={() => {}} />);
    fireEvent.click(screen.getByText('+ 创建自定义 agent'));
    // 角色下拉存在
    expect(screen.getByText('角色')).toBeDefined();
  });
});
