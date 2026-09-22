// renderer/src/components/agent/EnablePresetDialog.test.tsx
//
// 启用/配置弹窗行为（spec 2026-09-22 §4）：
//   - 启用模式：必填拦截；保存调用 enablePreset（含 joinWorkspaceId/setAsDefault 联动）
//   - 编辑模式：预填 def 模型；保存调用 updateDefinition（仅模型字段）
//   - 默认模型预填（defaultChatModel）
//
// Mock 策略（momo-test-rules，对齐邻近 ProviderModelPicker/DefinitionEditor 测试）：
// mock 收窄到 window.api 进程边界（ipc client 是运行时读 window.api 的 Proxy，
// 不做模块级 vi.mock）；provider store 按邻近模式 setState 注入 + loadProviders
// 桩（供应商选项同步就绪），agent store 走真实实现（members/builtinSuggestions
// 均为初始空态，不经 IPC 改写）。断言引用本地桩（等价于 brief 的
// vi.mocked(ipc.x)，语义不变）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EnablePresetDialog } from './EnablePresetDialog';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useProviderStore } from '../../stores/provider.store';
import type { AgentDefinition } from '../../ipc/types';

const getGlobal = vi.fn();
const providerList = vi.fn();
const listModels = vi.fn();
const enablePreset = vi.fn();
const updateDefinition = vi.fn();
const agentList = vi.fn();
const listMembers = vi.fn();

const DEF: AgentDefinition = {
  id: 'builtin-coder', name: '程序员', slug: 'coder', version: '1.0.0',
  runtime: 'declarative', systemPrompt: 'p', defaultTools: [], source: 'builtin',
  description: '', iconEmoji: '💻', workspaceId: null,
  modelProviderId: 'p1', modelName: 'm-old', thinkingJson: null,
};

/** 选供应商与模型（picker 两个 Select：第 1 个=供应商，第 2 个=模型）。
 *  模型选项经 listModels 异步到达——先等 option 出现再 change（DefinitionEditor.test 同模式）。 */
async function pickModel(providerId: string, modelId: string): Promise<void> {
  const combos = screen.getAllByRole('combobox');
  fireEvent.change(combos[0]!, { target: { value: providerId } });
  await screen.findByRole('option', { name: modelId });
  fireEvent.change(combos[1]!, { target: { value: modelId } });
}

beforeEach(() => {
  vi.clearAllMocks();
  getGlobal.mockResolvedValue({});
  providerList.mockResolvedValue([
    { id: 'p1', name: '供应商1', baseUrl: 'https://a', defaultModel: null, isDefault: false, createdAt: '', platform: 'openai', presetKey: null },
    { id: 'p2', name: '供应商2', baseUrl: 'https://b', defaultModel: null, isDefault: false, createdAt: '', platform: 'anthropic', presetKey: null },
  ]);
  listModels.mockResolvedValue([
    { providerId: 'p1', modelId: 'm-1', enabled: true, addedAt: 1, contextWindow: null, thinkingJson: null, reasoning: { kind: 'none' }, effectiveWindow: null },
  ]);
  agentList.mockResolvedValue([]);
  listMembers.mockResolvedValue([]);
  (globalThis as unknown as { window: { api: unknown } }).window.api = {
    settings: { getGlobal },
    provider: { list: providerList, listModels },
    agent: { enablePreset, updateDefinition, list: agentList, listMembers },
  };
  useProviderStore.setState({
    providers: [
      { id: 'p1', name: '供应商1', baseUrl: 'https://a', defaultModel: null, isDefault: false, createdAt: '', platform: 'openai' as const, presetKey: null },
      { id: 'p2', name: '供应商2', baseUrl: 'https://b', defaultModel: null, isDefault: false, createdAt: '', platform: 'anthropic' as const, presetKey: null },
    ],
    loading: false,
    loadProviders: vi.fn().mockResolvedValue(undefined),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    setDefault: vi.fn(),
    clear: vi.fn(),
  });
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null });
});

describe('EnablePresetDialog — 启用模式', () => {
  it('模型未选：提交显示错误，不调 enablePreset', async () => {
    render(<EnablePresetDialog slug="coder" name="程序员" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /启用$/ }));
    expect(await screen.findByText(/请选择模型供应商与模型/)).toBeInTheDocument();
    expect(enablePreset).not.toHaveBeenCalled();
  });

  it('保存：调用 enablePreset，无 workspace 时不带 join 字段', async () => {
    render(<EnablePresetDialog slug="coder" name="程序员" onClose={() => {}} />);
    await pickModel('p1', 'm-1');
    fireEvent.click(await screen.findByRole('button', { name: /启用$/ }));
    await waitFor(() => expect(enablePreset).toHaveBeenCalledTimes(1));
    expect(enablePreset).toHaveBeenCalledWith({
      slug: 'coder', modelProviderId: 'p1', modelName: 'm-1', thinkingJson: null,
    });
  });

  it('有激活 workspace 且勾选加入：带 joinWorkspaceId', async () => {
    useWorkspaceStore.setState({
      workspaces: [{ id: 'ws-1', name: 'w', description: '', directoryPath: '/tmp/w', gitInitialized: false, createdAt: '', ownerId: 'u', iconEmoji: '📁', defaultAgentInstanceId: null }],
      activeWorkspaceId: 'ws-1',
    });
    render(<EnablePresetDialog slug="coder" name="程序员" onClose={() => {}} />);
    await pickModel('p1', 'm-1');
    // 「加入当前工作空间」默认勾选
    fireEvent.click(await screen.findByRole('button', { name: /启用$/ }));
    await waitFor(() => expect(enablePreset).toHaveBeenCalledTimes(1));
    expect(enablePreset).toHaveBeenCalledWith({
      slug: 'coder', modelProviderId: 'p1', modelName: 'm-1', thinkingJson: null,
      joinWorkspaceId: 'ws-1', setAsDefault: false,
    });
  });

  it('取消勾选加入：不带 join 字段且无「设为默认」checkbox', async () => {
    useWorkspaceStore.setState({
      workspaces: [{ id: 'ws-1', name: 'w', description: '', directoryPath: '/tmp/w', gitInitialized: false, createdAt: '', ownerId: 'u', iconEmoji: '📁', defaultAgentInstanceId: null }],
      activeWorkspaceId: 'ws-1',
    });
    render(<EnablePresetDialog slug="coder" name="程序员" onClose={() => {}} />);
    const joinBox = await screen.findByRole('checkbox', { name: /加入当前工作空间/ });
    fireEvent.click(joinBox); // 取消勾选
    expect(screen.queryByRole('checkbox', { name: /设为默认会话 agent/ })).not.toBeInTheDocument();
    await pickModel('p1', 'm-1');
    fireEvent.click(screen.getByRole('button', { name: /启用$/ }));
    await waitFor(() => expect(enablePreset).toHaveBeenCalledTimes(1));
    expect(enablePreset).toHaveBeenCalledWith({
      slug: 'coder', modelProviderId: 'p1', modelName: 'm-1', thinkingJson: null,
    });
  });
});

describe('EnablePresetDialog — 编辑模式（配置）', () => {
  it('预填 def 模型；保存调用 updateDefinition（仅模型字段）', async () => {
    render(<EnablePresetDialog slug="coder" name="程序员" def={DEF} onClose={() => {}} />);
    // 编辑模式无加入 checkbox
    expect(screen.queryByRole('checkbox', { name: /加入当前工作空间/ })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('combobox')[0]).toHaveValue('p1'));
    await pickModel('p1', 'm-1');
    fireEvent.click(screen.getByRole('button', { name: /保存$/ }));
    await waitFor(() => expect(updateDefinition).toHaveBeenCalledTimes(1));
    expect(updateDefinition).toHaveBeenCalledWith({
      id: 'builtin-coder', modelProviderId: 'p1', modelName: 'm-1', thinkingJson: null,
    });
    expect(enablePreset).not.toHaveBeenCalled();
  });
});

describe('EnablePresetDialog — 默认模型预填', () => {
  it('settings.defaultChatModel 存在 → 预填 provider+model', async () => {
    getGlobal.mockResolvedValue({
      defaultChatModel: { providerId: 'p1', modelId: 'm-1' },
    });
    render(<EnablePresetDialog slug="coder" name="程序员" onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole('combobox')[0]).toHaveValue('p1'));
    await waitFor(() => expect(screen.getAllByRole('combobox')[1]).toHaveValue('m-1'));
  });
});
