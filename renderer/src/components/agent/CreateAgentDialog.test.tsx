// renderer/src/components/agent/CreateAgentDialog.test.tsx
//
// v25 Task 13：创建 Agent 弹窗测试（spec §6.3）。
// 表单：名称*/图标/模型服务(provider→model 二级联动 ProviderModelPicker)/
// 提示词/默认工具集三档（安全最小集/全部/自选）/
// 「设为默认会话 agent」勾选（已有默认提示替换）。
// source='agentView' 创建成功自动 addMember 入当前 ws（+勾选默认则 setDefaultAgent）；
// source='library' 仅建定义。
//
// Mock 策略（momo-test-rules）：
//   - store 为真实 zustand 实例，setState 注入状态与 action 桩；
//   - ipc.agent.createCustom 经 window.api 桩注入（进程边界）；
//   - ipc.provider.listModels 经 window.api.provider 桩注入（picker 拉模型列表用）；
//   - 断言生产消费的字段（defId / instanceId / defaultTools / modelName）。
// v2.1 P3：弹窗收敛 Dialog 后供应商选择走 Select 原子件——必填标记并入 label
// 文案（CreateTaskDialog「标题*」同款），accessible name 由「模型供应商」变为
// 「模型供应商*」，断言同步；其余语义不变。
// v2.2 fix：模型名由手填 Input 改为 ProviderModelPicker 联动下拉（Bug 1）——
// defaultModel 快填退役，picker 自身管模型列表；测试 fillRequired 需等模型
// options 异步加载。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AgentDefinition, Workspace, WorkspaceAgentMember } from '../../ipc/types';
import { ALL_BUILTIN_TOOLS, SAFE_MINIMUM_TOOLS } from '../../lib/tool-catalog';

const { CreateAgentDialog } = await import('./CreateAgentDialog');
const { useWorkspaceStore } = await import('../../stores/workspace.store');
const { useProviderStore } = await import('../../stores/provider.store');
const { useAgentStore } = await import('../../stores/agent.store');

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

const WS_WITH_DEFAULT: Workspace = { ...WS, defaultAgentInstanceId: 'inst-old' };

const CREATED_DEF: AgentDefinition = {
  id: 'def-9',
  name: '新助手',
  slug: '新助手',
  version: '1.0.0',
  runtime: 'declarative',
  systemPrompt: 'p',
  defaultTools: [],
  source: 'custom',
  description: '',
  iconEmoji: '🤖',
  defaultMcps: [],
  defaultSkills: [],
  workspaceId: null,
  modelProviderId: 'prov-1',
  modelName: 'gpt-4o',
};

const CREATED_MEMBER: WorkspaceAgentMember = {
  instanceId: 'inst-9',
  workspaceId: 'ws-1',
  agentDefinitionId: 'def-9',
  agentUserId: '@new:local',
  agentName: '新助手',
  iconEmoji: '',
  hasApiKeyOverride: false,
  lastRunning: false,
  createdAt: '',
};

const createCustom = vi.fn();
const providerListModels = vi.fn();
const addMember = vi.fn();
const loadDefinitions = vi.fn();
const setDefaultAgent = vi.fn();

beforeEach(() => {
  createCustom.mockReset().mockResolvedValue(CREATED_DEF);
  providerListModels.mockReset().mockResolvedValue([
    { providerId: 'prov-1', modelId: 'gpt-4o', enabled: true, addedAt: 0 },
  ]);
  addMember.mockReset().mockResolvedValue(CREATED_MEMBER);
  loadDefinitions.mockReset().mockResolvedValue(undefined);
  setDefaultAgent.mockReset().mockResolvedValue(undefined);

  (globalThis as unknown as { window: { api: unknown } }).window.api = {
    agent: { createCustom },
    provider: { listModels: providerListModels },
  };

  useWorkspaceStore.setState({
    workspaces: [WS],
    activeWorkspaceId: 'ws-1',
    loading: false,
    error: null,
    setDefaultAgent,
  });

  useProviderStore.setState({
    providers: [
      {
        id: 'prov-1',
        name: 'P1',
        baseUrl: 'https://a',
        defaultModel: 'gpt-4o',
        isDefault: true,
        createdAt: '',
        platform: 'openai' as const,
      },
    ],
    loading: false,
    loadProviders: vi.fn(),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    setDefault: vi.fn(),
    clear: vi.fn(),
  });

  useAgentStore.setState({
    definitions: [],
    members: [],
    teams: [],
    builtinSuggestions: {},
    loading: false,
    error: null,
    loadDefinitions,
    loadMembers: vi.fn(),
    loadBuiltinSuggestions: vi.fn(),
    addMember,
    removeMember: vi.fn(),
    deleteDefinition: vi.fn(),
    updateMemberApiKey: vi.fn(),
    getMemberDeltas: vi.fn(),
    setMemberDeltas: vi.fn(),
    stopMember: vi.fn(),
    startMember: vi.fn(),
    loadTeams: vi.fn(),
    createTeam: vi.fn(),
    renameTeam: vi.fn(),
    deleteTeam: vi.fn(),
    setLeader: vi.fn(),
    addTeamMember: vi.fn(),
    removeTeamMember: vi.fn(),
    reset: vi.fn(),
  });
});

/** 填写必填字段：名称 + 供应商 + 模型（模型 options 异步加载，需 await） */
async function fillRequired(name = '新助手'): Promise<void> {
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('模型供应商*'), { target: { value: 'prov-1' } });
  await screen.findByRole('option', { name: 'gpt-4o' });
  fireEvent.change(screen.getByLabelText('模型名'), { target: { value: 'gpt-4o' } });
}

describe('CreateAgentDialog — 校验', () => {
  it('名称为空提交 → 显示错误且不调 createCustom', async () => {
    render(<CreateAgentDialog source="agentView" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('模型供应商*'), { target: { value: 'prov-1' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('名称不能为空')).toBeInTheDocument();
    expect(createCustom).not.toHaveBeenCalled();
  });

  it('未选模型服务提交 → 显示错误且不调 createCustom', async () => {
    render(<CreateAgentDialog source="agentView" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新助手' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('请选择模型供应商与模型')).toBeInTheDocument();
    expect(createCustom).not.toHaveBeenCalled();
  });

  it('选择供应商后模型下拉列出其已启用模型；模型名不再是手填输入框', async () => {
    render(<CreateAgentDialog source="agentView" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('模型供应商*'), { target: { value: 'prov-1' } });
    await screen.findByRole('option', { name: 'gpt-4o' });
    // 模型名是 select（下拉）而非 input（手填）
    expect(screen.getByLabelText('模型名').tagName).toBe('SELECT');
  });
});

describe('CreateAgentDialog — 默认工具集三档', () => {
  it('默认档=安全最小集，提交 defaultTools=SAFE_MINIMUM_TOOLS', async () => {
    render(<CreateAgentDialog source="agentView" onClose={() => {}} />);
    await fillRequired();
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(createCustom).toHaveBeenCalled());
    expect(createCustom).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultTools: SAFE_MINIMUM_TOOLS.map((ref) => ({ kind: 'builtin', ref })),
      }),
    );
  });

  it('切「全部」档 → defaultTools=ALL_BUILTIN_TOOLS', async () => {
    render(<CreateAgentDialog source="agentView" onClose={() => {}} />);
    await fillRequired();
    fireEvent.click(screen.getByLabelText('全部工具'));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(createCustom).toHaveBeenCalled());
    expect(createCustom).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultTools: ALL_BUILTIN_TOOLS.map((ref) => ({ kind: 'builtin', ref })),
      }),
    );
  });

  it('「自选」档展开工具勾选，勾选 bash 后提交含 bash', async () => {
    render(<CreateAgentDialog source="agentView" onClose={() => {}} />);
    await fillRequired();
    // 自选档初始勾选 = 安全最小集
    fireEvent.click(screen.getByLabelText('自选'));
    expect((screen.getByLabelText('bash') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText('bash'));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(createCustom).toHaveBeenCalled());
    const tools = createCustom.mock.calls[0]![0]!.defaultTools as Array<{ ref: string }>;
    expect(tools.map((t) => t.ref)).toEqual([...SAFE_MINIMUM_TOOLS, 'bash']);
  });
});

describe('CreateAgentDialog — source=agentView 提交路径', () => {
  it('创建成功 → createCustom + addMember 入当前 ws + onClose', async () => {
    const onClose = vi.fn();
    render(<CreateAgentDialog source="agentView" onClose={onClose} />);
    await fillRequired();
    fireEvent.change(screen.getByLabelText('系统提示词'), { target: { value: '你是助手' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(createCustom).toHaveBeenCalledWith(
      expect.objectContaining({ name: '新助手', modelProviderId: 'prov-1', modelName: 'gpt-4o' }),
    );
    expect(addMember).toHaveBeenCalledWith('ws-1', 'def-9');
    expect(loadDefinitions).toHaveBeenCalled();
  });

  it('勾选「设为默认会话 agent」→ setDefaultAgent(ws, 新成员 instanceId)', async () => {
    const onClose = vi.fn();
    render(<CreateAgentDialog source="agentView" onClose={onClose} />);
    await fillRequired();
    fireEvent.click(screen.getByLabelText('设为默认会话 agent'));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(setDefaultAgent).toHaveBeenCalledWith('ws-1', 'inst-9');
  });

  it('工作空间已有默认 agent 时，勾选框旁显示「将替换现有默认」副文案', () => {
    useWorkspaceStore.setState({ workspaces: [WS_WITH_DEFAULT] });
    render(<CreateAgentDialog source="agentView" onClose={() => {}} />);
    expect(screen.getByText('将替换现有默认')).toBeInTheDocument();
  });

  it('createCustom 失败 → 显示错误，不 addMember 不 onClose', async () => {
    createCustom.mockRejectedValue(new Error('slug 已存在'));
    const onClose = vi.fn();
    render(<CreateAgentDialog source="agentView" onClose={onClose} />);
    await fillRequired();
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('slug 已存在')).toBeInTheDocument();
    expect(addMember).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('CreateAgentDialog — source=library 提交路径', () => {
  it('仅建定义：不显示默认勾选、不调 addMember/setDefaultAgent', async () => {
    const onClose = vi.fn();
    render(<CreateAgentDialog source="library" onClose={onClose} />);
    expect(screen.queryByLabelText('设为默认会话 agent')).not.toBeInTheDocument();
    await fillRequired();
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(createCustom).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'global' }),
    );
    expect(addMember).not.toHaveBeenCalled();
    expect(setDefaultAgent).not.toHaveBeenCalled();
  });
});
