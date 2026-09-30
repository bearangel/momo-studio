// renderer/src/components/agent/DefinitionEditor.test.tsx
//
// v1.6 Task 9：DefinitionEditor 整合 CapabilityTabs 后的行为测试。
// - create 模式：能力区显示，默认勾选安全最小集；提交时 IPC 收到 defaultTools/Mcps/Skills
// - edit 模式：从 def.defaultTools/Mcps/Skills 加载初始勾选
// - configure（builtin）模式：CapabilityTabs readonly，提交按钮不传 default*
//
// Mock 策略：与 CreateWorkspaceDialog 测试一致——通过 (globalThis).window.api 注入桩
// （ipc client 是读 window.api 的 Proxy，等价于 mock '../../ipc/client' 生产路径）。
// v2.x 切源：tools.getCatalog 提供小目录（read_file/write_file defaultOn + bash 关），
// create 模式默认工具断言改用该 mock 目录的 defaultOn 集。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DefinitionEditor } from './DefinitionEditor';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useProviderStore } from '../../stores/provider.store';
import { useAgentStore } from '../../stores/agent.store';
import type { AgentDefinition, ToolCatalogEntry } from '../../ipc/types';

const createCustom = vi.fn();
const updateDefinition = vi.fn();
const resourceList = vi.fn();
const listModels = vi.fn();
const getCatalog = vi.fn();

/** mock 工具目录：2 个 defaultOn + 1 个 defaultOn=false（与 CapabilityTabs 测试同规格） */
const MOCK_CATALOG: ToolCatalogEntry[] = [
  { name: 'read_file', description: '读文件', category: '文件', categoryEmoji: '📁', defaultOn: true },
  { name: 'write_file', description: '写文件', category: '文件', categoryEmoji: '📁', defaultOn: true },
  { name: 'bash', description: '执行命令', category: 'Shell', categoryEmoji: '💻', defaultOn: false },
];
/** mock 目录 defaultOn 集——create 模式默认勾选的 Tier 1 */
const MOCK_DEFAULT_ON = ['read_file', 'write_file'];

const mockApi = {
  agent: {
    createCustom,
    updateDefinition,
    list: vi.fn().mockResolvedValue([]),
  },
  resource: { list: resourceList },
  provider: { listModels },
  tools: { getCatalog },
};

beforeEach(() => {
  createCustom.mockReset();
  updateDefinition.mockReset();
  createCustom.mockResolvedValue({});
  updateDefinition.mockResolvedValue({ definition: {}, stoppedInstanceIds: [] });
  resourceList.mockResolvedValue([]);
  getCatalog.mockReset().mockResolvedValue(MOCK_CATALOG);
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
      { id: 'prov-1', name: 'P1', baseUrl: 'https://a', defaultModel: 'gpt-4o', isDefault: true, createdAt: '', platform: 'openai' as const, presetKey: null },
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

  it('create 模式目录就绪后默认勾选 defaultOn 集（read_file 已勾，bash 未勾）', async () => {
    render(<DefinitionEditor mode="create" onClose={() => {}} />);
    expect((await screen.findByLabelText('read_file') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('bash') as HTMLInputElement).checked).toBe(false);
  });

  it('create 模式 checkbox 可交互（非 readonly）', async () => {
    render(<DefinitionEditor mode="create" onClose={() => {}} />);
    expect(await screen.findByLabelText('bash')).not.toBeDisabled();
  });

  it('模型字段为 ProviderModelPicker 下拉（非手填 Input）', async () => {
    render(<DefinitionEditor mode="create" onClose={() => {}} />);
    expect(screen.getByLabelText('模型名').tagName).toBe('SELECT');
  });

  it('提交时 IPC.createCustom 收到 defaultTools = 目录 defaultOn 集', async () => {
    render(<DefinitionEditor mode="create" onClose={() => {}} />);
    // 等 Tier 1 回填完成（目录就绪 → capabilities 回填 → read_file 勾选）
    await screen.findByLabelText('read_file');
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
      MOCK_DEFAULT_ON.map((ref) => ({ kind: 'builtin', ref })),
    );
    expect(arg.defaultMcps).toEqual([]);
    expect(arg.defaultSkills).toEqual([]);
  });

  it('勾选 bash 后提交，IPC.createCustom.defaultTools 含 bash', async () => {
    render(<DefinitionEditor mode="create" onClose={() => {}} />);
    // 等 Tier 1 回填完成再操作（否则空集起勾会覆盖回填语义）
    await screen.findByLabelText('read_file');
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
        ...MOCK_DEFAULT_ON.map((ref) => ({ kind: 'builtin', ref })),
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
    expect((await screen.findByLabelText('bash') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('read_file') as HTMLInputElement).checked).toBe(false);
  });

  it('edit 模式 checkbox 可交互', async () => {
    const def = buildDef();
    render(<DefinitionEditor mode="edit" def={def} onClose={() => {}} />);
    expect(await screen.findByLabelText('bash')).not.toBeDisabled();
  });

  it('edit 模式提交时 IPC.updateDefinition 收到 defaultTools（含修改后值）', async () => {
    const def = buildDef({ defaultTools: [{ kind: 'builtin', ref: 'read_file' }] });
    render(<DefinitionEditor mode="edit" def={def} onClose={() => {}} />);
    // 勾上 bash（等目录渲染出 checkbox）
    fireEvent.click(await screen.findByLabelText('bash'));
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
    expect(await screen.findByLabelText('read_file')).toBeDisabled();
    expect(screen.getByLabelText('bash')).toBeDisabled();
  });
});

describe('DefinitionEditor — brief 数据丢失回归锁：def.thinkingJson 经列表加载后必须存活', () => {
  // 任务上下文 Important：实现者在 brief 真缺陷修复后（onModelInfo 依赖陷阱 →
  // onModelChange 事件挂点）没补保留性测试。brief 原写法会把 setThinkingJson(null)
  // 放在 onModelInfo 内联箭头里，而 ProviderModelPicker 走 useEffect 异步回传
  // （models / modelId 依赖），列表加载完即触发 → 编辑模式 def.thinkingJson
  // 初值被首次 onModelInfo(null) 抹掉 → 用户不动 picker 直接保存 = 覆盖被清零。
  // 本测试断言：(1) 列表加载后控件回显原值；(2) 不动 picker 直接保存，
  // updateDefinition 入参 thinkingJson 与 def.thinkingJson 逐字相等。
  // 若有人把 setThinkingJson(null) 重新挂回 onModelInfo，本测试必红。
  it('edit 模式：def 带非空 thinkingJson，列表加载后控件值与提交对象保持原样', async () => {
    const persistedThinking = { mode: 'on' as const, effort: 'high' as const };
    // listModels 异步返回——首次 effect 期间 models=[] 触发 onModelInfo(null)，
    // 列表解析后 onModelInfo(model) 二次触发；brief 原写法把 setThinkingJson(null)
    // 挂在 onModelInfo 内联箭头里，即此路径抹回 null
    listModels.mockReset().mockResolvedValue([
      {
        providerId: 'prov-1',
        modelId: 'glm-5.3',
        enabled: true,
        addedAt: 1,
        contextWindow: 1000000,
        thinkingJson: null,
        reasoning: { kind: 'effort', values: ['low', 'high', 'max'], default: 'max' },
        effectiveWindow: 1000000,
      },
    ]);
    const def = buildDef({
      modelProviderId: 'prov-1',
      modelName: 'glm-5.3',
      thinkingJson: persistedThinking,
    });
    render(<DefinitionEditor mode="edit" def={def} onClose={() => {}} />);
    await screen.findByRole('option', { name: 'glm-5.3' });

    expect((screen.getByLabelText('思维模式') as HTMLSelectElement).value).toBe('on');
    expect((screen.getByLabelText('思维档位') as HTMLSelectElement).value).toBe('high');

    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => {
      expect(updateDefinition).toHaveBeenCalledTimes(1);
    });
    const arg = updateDefinition.mock.calls[0][0];
    expect(arg.thinkingJson).toEqual(persistedThinking);
  });
});
