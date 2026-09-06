// renderer/src/components/agent/DefinitionEditor.test.tsx
//
// v1.6 Task 9：DefinitionEditor 整合 CapabilityTabs 后的行为测试。
// - create 模式：能力区显示，默认勾选安全最小集；提交时 IPC 收到 defaultTools/Mcps/Skills
// - edit 模式：从 def.defaultTools/Mcps/Skills 加载初始勾选
// - configure（builtin）模式：CapabilityTabs readonly，提交按钮不传 default*
//
// Mock 策略：与 CreateWorkspaceDialog 测试一致——通过 (globalThis).window.api 注入桩。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DefinitionEditor } from './DefinitionEditor';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useProviderStore } from '../../stores/provider.store';
import { useAgentStore } from '../../stores/agent.store';
import { SAFE_MINIMUM_TOOLS } from '../../lib/tool-catalog';
import type { AgentDefinition } from '../../ipc/types';

const createCustom = vi.fn();
const updateDefinition = vi.fn();
const resourceList = vi.fn();
const listModels = vi.fn();

const mockApi = {
  agent: {
    createCustom,
    updateDefinition,
    list: vi.fn().mockResolvedValue([]),
  },
  resource: { list: resourceList },
  provider: { listModels },
};

beforeEach(() => {
  createCustom.mockReset();
  updateDefinition.mockReset();
  createCustom.mockResolvedValue({});
  updateDefinition.mockResolvedValue({ definition: {}, stoppedInstanceIds: [] });
  resourceList.mockResolvedValue([]);
  listModels.mockReset().mockResolvedValue([
    { providerId: 'prov-1', modelId: 'gpt-4o', enabled: true, addedAt: 0 },
  ]);
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

  useWorkspaceStore.setState({
    workspaces: [],
    activeWorkspaceId: 'ws-active',
    loading: false,
    error: null,
    load: vi.fn(),
    create: vi.fn(),
    select: vi.fn(),
    getActive: () => null,
  });

  useProviderStore.setState({
    providers: [
      { id: 'prov-1', name: 'P1', baseUrl: 'https://a', defaultModel: 'gpt-4o', isDefault: true, createdAt: '', platform: 'openai' as const },
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
    builtinSuggestions: {},
    loading: false,
    error: null,
    loadDefinitions: vi.fn().mockResolvedValue(undefined),
    loadMembers: vi.fn(),
    loadBuiltinSuggestions: vi.fn(),
    addMember: vi.fn(),
    deleteDefinition: vi.fn(),
    updateMemberApiKey: vi.fn(),
    getMemberDeltas: vi.fn(),
    setMemberDeltas: vi.fn(),
    stopMember: vi.fn(),
    startMember: vi.fn(),
    reset: vi.fn(),
  });
});

/** 构造一个完整 AgentDefinition fixture（用于 edit / configure 模式） */
function buildDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'def-1',
    name: '原 agent',
    slug: 'orig',
    version: '1.0.0',
    runtime: 'declarative',
    systemPrompt: '原 prompt',
    defaultTools: [{ kind: 'builtin', ref: 'read_file' }],
    source: 'custom',
    description: 'd',
    iconEmoji: '🤖',
    defaultMcps: [],
    defaultSkills: [],
    workspaceId: null,
    modelProviderId: 'prov-1',
    modelName: 'gpt-4o',
    ...overrides,
  };
}

describe('DefinitionEditor — create 模式能力配置区', () => {
  it('渲染「能力配置」标题', async () => {
    render(<DefinitionEditor mode="create" onClose={() => {}} />);
    expect(screen.getByText('能力配置')).toBeInTheDocument();
  });

  it('create 模式默认勾选安全最小集（read_file 已勾，bash 未勾）', async () => {
    render(<DefinitionEditor mode="create" onClose={() => {}} />);
    expect((screen.getByLabelText('read_file') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('bash') as HTMLInputElement).checked).toBe(false);
  });

  it('create 模式 checkbox 可交互（非 readonly）', async () => {
    render(<DefinitionEditor mode="create" onClose={() => {}} />);
    expect(screen.getByLabelText('bash')).not.toBeDisabled();
  });

  it('模型字段为 ProviderModelPicker 下拉（非手填 Input）', async () => {
    render(<DefinitionEditor mode="create" onClose={() => {}} />);
    expect(screen.getByLabelText('模型名').tagName).toBe('SELECT');
  });

  it('提交时 IPC.createCustom 收到 defaultTools = 安全最小集', async () => {
    render(<DefinitionEditor mode="create" onClose={() => {}} />);
    // 填必填字段
    fireEvent.change(screen.getByPlaceholderText('如：代码审查员'), { target: { value: '测试 agent' } });
    fireEvent.change(screen.getByPlaceholderText('如：code-reviewer'), { target: { value: 'test-agent' } });
    fireEvent.change(screen.getByPlaceholderText('你是一名资深审查员...'), {
      target: { value: '系统提示词' },
    });
    // 选模型供应商 + 等模型加载 + 选模型
    fireEvent.change(screen.getByLabelText('模型供应商*'), { target: { value: 'prov-1' } });
    await screen.findByRole('option', { name: 'gpt-4o' });
    fireEvent.change(screen.getByLabelText('模型名'), { target: { value: 'gpt-4o' } });

    fireEvent.click(screen.getByText('创建'));

    await waitFor(() => {
      expect(createCustom).toHaveBeenCalledTimes(1);
    });
    const arg = createCustom.mock.calls[0][0];
    expect(arg.defaultTools).toEqual(
      SAFE_MINIMUM_TOOLS.map((ref) => ({ kind: 'builtin', ref })),
    );
    expect(arg.defaultMcps).toEqual([]);
    expect(arg.defaultSkills).toEqual([]);
  });

  it('勾选 bash 后提交，IPC.createCustom.defaultTools 含 bash', async () => {
    render(<DefinitionEditor mode="create" onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('如：代码审查员'), { target: { value: 'A' } });
    fireEvent.change(screen.getByPlaceholderText('如：code-reviewer'), { target: { value: 'a' } });
    fireEvent.change(screen.getByPlaceholderText('你是一名资深审查员...'), {
      target: { value: 'p' },
    });
    fireEvent.change(screen.getByLabelText('模型供应商*'), { target: { value: 'prov-1' } });
    await screen.findByRole('option', { name: 'gpt-4o' });
    fireEvent.change(screen.getByLabelText('模型名'), { target: { value: 'gpt-4o' } });
    // 勾 bash
    fireEvent.click(screen.getByLabelText('bash'));

    fireEvent.click(screen.getByText('创建'));

    await waitFor(() => {
      expect(createCustom).toHaveBeenCalledTimes(1);
    });
    const arg = createCustom.mock.calls[0][0];
    expect(arg.defaultTools).toEqual(
      expect.arrayContaining([
        ...SAFE_MINIMUM_TOOLS.map((ref) => ({ kind: 'builtin', ref })),
        { kind: 'builtin', ref: 'bash' },
      ]),
    );
  });
});

describe('DefinitionEditor — edit 模式加载现有 def 能力', () => {
  it('edit 模式从 def.defaultTools 初始化 checkbox（bash 已选）', async () => {
    const def = buildDef({
      defaultTools: [{ kind: 'builtin', ref: 'bash' }],
    });
    render(<DefinitionEditor mode="edit" def={def} onClose={() => {}} />);
    expect((screen.getByLabelText('bash') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('read_file') as HTMLInputElement).checked).toBe(false);
  });

  it('edit 模式 checkbox 可交互', async () => {
    const def = buildDef();
    render(<DefinitionEditor mode="edit" def={def} onClose={() => {}} />);
    expect(screen.getByLabelText('bash')).not.toBeDisabled();
  });

  it('edit 模式提交时 IPC.updateDefinition 收到 defaultTools（含修改后值）', async () => {
    const def = buildDef({ defaultTools: [{ kind: 'builtin', ref: 'read_file' }] });
    render(<DefinitionEditor mode="edit" def={def} onClose={() => {}} />);
    // 勾上 bash
    fireEvent.click(screen.getByLabelText('bash'));
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => {
      expect(updateDefinition).toHaveBeenCalledTimes(1);
    });
    const arg = updateDefinition.mock.calls[0][0];
    expect(arg.defaultTools).toEqual(
      expect.arrayContaining([
        { kind: 'builtin', ref: 'read_file' },
        { kind: 'builtin', ref: 'bash' },
      ]),
    );
  });
});

describe('DefinitionEditor — configure（builtin）模式只读', () => {
  it('configure 模式显示 builtin 提示文案', async () => {
    const def = buildDef({ source: 'builtin' });
    render(<DefinitionEditor mode="configure" def={def} onClose={() => {}} />);
    expect(screen.getByText(/builtin 默认能力不可改/)).toBeInTheDocument();
  });

  it('configure 模式 CapabilityTabs checkbox disabled', async () => {
    const def = buildDef({ source: 'builtin', defaultTools: [{ kind: 'builtin', ref: 'read_file' }] });
    render(<DefinitionEditor mode="configure" def={def} onClose={() => {}} />);
    expect(screen.getByLabelText('read_file')).toBeDisabled();
    expect(screen.getByLabelText('bash')).toBeDisabled();
  });
});
