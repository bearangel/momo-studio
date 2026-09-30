// renderer/src/components/agent/CreateAgentDialog.test.tsx
//
// v25 Task 13：创建 Agent 弹窗测试（spec §6.3）。
// 表单：名称*/图标/模型服务(provider→model 二级联动 ProviderModelPicker)/
// 提示词/默认工具集三档（标准/全部/自定义）/
// 「设为默认会话 agent」勾选（已有默认提示替换）。
// source='agentView' 创建成功自动 addMember 入当前 ws（+勾选默认则 setDefaultAgent）；
// source='library' 仅建定义。
//
// Mock 策略（momo-test-rules）：
//   - store 为真实 zustand 实例，setState 注入状态与 action 桩；
//   - ipc 经 window.api 桩注入（进程边界）：agent.createCustom +
//     provider.listModels + tools.getCatalog + resource.list；
//   - 断言生产消费的字段（defId / instanceId / defaultTools / defaultMcps /
//     defaultSkills / modelName）。
// v2.1 P3：弹窗收敛 Dialog 后供应商选择走 Select 原子件——必填标记并入 label
// 文案（CreateTaskDialog「标题*」同款），accessible name 由「模型供应商」变为
// 「模型供应商*」，断言同步；其余语义不变。
// v2.2 fix：模型名由手填 Input 改为 ProviderModelPicker 联动下拉（Bug 1）——
// defaultModel 快填退役，picker 自身管模型列表；测试 fillRequired 需等模型
// options 异步加载。
// v2.x 工具能力重构（Task 6）：preset 语义换档（safe→standard），「自定义」档
// 内嵌 CapabilityTabs（工具/MCP/Skill 三 tab），提交三字段（defaultTools/
// defaultMcps/defaultSkills）；preset 断言不再 import tool-catalog 常量副本，
// 一律用 mock 目录（tools.getCatalog）派生集合。目录未就绪守卫用例走
// vi.resetModules + 动态 import（useToolCatalog 模块级 cache=null 才能真实
// 触发「加载中」路径，同 CapabilityTabs.test.tsx 的 importFresh 模式）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AgentDefinition, ResourceItem, ToolCatalogEntry, Workspace, WorkspaceAgentMember } from '../../ipc/types';

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

/** 供应商桩行（主 beforeEach 与 fresh-module 注入共用） */
const PROVIDER_ROW = {
  id: 'prov-1',
  name: 'P1',
  baseUrl: 'https://a',
  defaultModel: 'gpt-4o',
  isDefault: true,
  createdAt: '',
  platform: 'openai' as const,
  presetKey: null,
};

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

/** 模拟 IPC 工具目录：1 个 defaultOn + 1 个 defaultOn=false（Tier 1 = read_file） */
const MOCK_CATALOG: ToolCatalogEntry[] = [
  { name: 'read_file', description: '读文件', category: '文件', categoryEmoji: '📁', defaultOn: true },
  { name: 'bash', description: '执行命令', category: 'Shell', categoryEmoji: '💻', defaultOn: false },
];
/** mock 目录派生：安全最小集（defaultOn 集）与全集——preset 断言一律用这两份 */
const MOCK_SAFE_MINIMUM = ['read_file'];
const MOCK_ALL_TOOLS = ['read_file', 'bash'];

/** ResourceItem 形状最小桩：已安装 MCP / Skill 各一（CapabilityTabs 动态 tab 用） */
const MCP_ITEM: ResourceItem = {
  id: 'custom-mcp-filesystem',
  type: 'mcp',
  source: 'custom',
  slug: 'filesystem',
  name: 'filesystem',
  description: '',
  installed: true,
  installable: false,
  removable: true,
};
const SKILL_ITEM: ResourceItem = {
  id: 'builtin-skill-code-review',
  type: 'skill',
  source: 'builtin',
  slug: 'code-review',
  name: '代码审查',
  description: '',
  installed: true,
  installable: false,
  removable: false,
};

const createCustom = vi.fn();
const providerListModels = vi.fn();
const addMember = vi.fn();
const loadDefinitions = vi.fn();
const setDefaultAgent = vi.fn();
// v2.x：工具目录 + 资源列表与既有通道共用 window.api 桩（拦截生产路径 ipc Proxy）
const getCatalog = vi.fn();
const resourceList = vi.fn();

beforeEach(() => {
  createCustom.mockReset().mockResolvedValue(CREATED_DEF);
  providerListModels.mockReset().mockResolvedValue([
    { providerId: 'prov-1', modelId: 'gpt-4o', enabled: true, addedAt: 0 },
  ]);
  addMember.mockReset().mockResolvedValue(CREATED_MEMBER);
  loadDefinitions.mockReset().mockResolvedValue(undefined);
  setDefaultAgent.mockReset().mockResolvedValue(undefined);
  // 默认目录就绪 + 资源为空（守卫用例在测试体内改写 getCatalog 为 pending）
  getCatalog.mockReset().mockResolvedValue(MOCK_CATALOG);
  resourceList.mockReset().mockResolvedValue([]);

  (globalThis as unknown as { window: { api: unknown } }).window.api = {
    agent: { createCustom },
    provider: { listModels: providerListModels },
    tools: { getCatalog },
    resource: { list: resourceList },
  };

  useWorkspaceStore.setState({
    workspaces: [WS],
    activeWorkspaceId: 'ws-1',
    loading: false,
    error: null,
    setDefaultAgent,
  });

  useProviderStore.setState({
    providers: [PROVIDER_ROW],
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

/**
 * 目录未就绪用例专用：vi.resetModules 后动态 import，拿全新组件与全新
 * useToolCatalog 模块实例（模块级 cache=null，「加载中」路径才能真实触发）。
 * 全新 store 实例的真实 action 会调 window.api 桩外的通道（provider.list /
 * agent.list）而崩，故先注入与主 beforeEach 同款的状态与 action 桩。
 */
async function importFreshDialog(): Promise<typeof CreateAgentDialog> {
  vi.resetModules();
  const { useProviderStore: freshProviderStore } = await import('../../stores/provider.store');
  const { useAgentStore: freshAgentStore } = await import('../../stores/agent.store');
  freshProviderStore.setState({
    providers: [PROVIDER_ROW],
    loading: false,
    loadProviders: vi.fn(),
  });
  freshAgentStore.setState({ loadDefinitions });
  const mod = await import('./CreateAgentDialog');
  return mod.CreateAgentDialog;
}

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
  it('默认档=标准（推荐），提交 defaultTools=目录 defaultOn 集 + 空 mcps/skills', async () => {
    render(<CreateAgentDialog source="agentView" onClose={() => {}} />);
    await fillRequired();
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(createCustom).toHaveBeenCalled());
    expect(createCustom).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultTools: MOCK_SAFE_MINIMUM.map((ref) => ({ kind: 'builtin', ref })),
        defaultMcps: [],
        defaultSkills: [],
      }),
    );
  });

  it('切「全部工具」档 → defaultTools=目录全集', async () => {
    render(<CreateAgentDialog source="agentView" onClose={() => {}} />);
    await fillRequired();
    fireEvent.click(screen.getByLabelText('全部工具'));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(createCustom).toHaveBeenCalled());
    expect(createCustom).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultTools: MOCK_ALL_TOOLS.map((ref) => ({ kind: 'builtin', ref })),
      }),
    );
  });

  it('「自定义」档展开 CapabilityTabs 工具勾选，勾选 bash 后提交含 bash（初始=目录 Tier 1）', async () => {
    render(<CreateAgentDialog source="agentView" onClose={() => {}} />);
    await fillRequired();
    fireEvent.click(screen.getByLabelText('自定义'));
    // 目录驱动渲染（异步就绪，find 等待）；初始勾选 = 目录 defaultOn 集
    const bash = await screen.findByLabelText('bash');
    expect((bash as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('read_file') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(bash);
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(createCustom).toHaveBeenCalled());
    const tools = createCustom.mock.calls[0]![0]!.defaultTools as Array<{ ref: string }>;
    expect(tools.map((t) => t.ref)).toEqual([...MOCK_SAFE_MINIMUM, 'bash']);
  });

  it('自定义档：三 tab 可用，提交携带 defaultMcps/defaultSkills', async () => {
    resourceList.mockImplementation(async (filter?: { type?: string }) => {
      if (filter?.type === 'mcp') return [MCP_ITEM];
      if (filter?.type === 'skill') return [SKILL_ITEM];
      return [];
    });
    render(<CreateAgentDialog source="library" onClose={vi.fn()} />);
    await fillRequired('多面手');
    fireEvent.click(screen.getByLabelText('自定义'));
    await screen.findByLabelText('read_file'); // 目录就绪（工具 tab 默认激活）
    // 切 MCP tab 勾选一个；再切 Skill tab 勾选一个
    fireEvent.click(screen.getByRole('button', { name: 'MCP' }));
    fireEvent.click(await screen.findByLabelText('filesystem'));
    fireEvent.click(screen.getByRole('button', { name: 'Skill' }));
    fireEvent.click(await screen.findByLabelText('code-review'));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(createCustom).toHaveBeenCalled());
    const input = createCustom.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.defaultTools).toEqual([{ kind: 'builtin', ref: 'read_file' }]);
    expect(input.defaultMcps).toEqual([{ kind: 'mcp', ref: 'filesystem' }]);
    expect(input.defaultSkills).toEqual([{ kind: 'skill', ref: 'code-review' }]);
  });
});

describe('CreateAgentDialog — 目录未就绪提交守卫', () => {
  it('标准档 + 目录未就绪 → 提示「工具目录加载中」且不提交', async () => {
    getCatalog.mockReturnValue(new Promise(() => {})); // 永不 resolve
    const Fresh = await importFreshDialog();
    render(<Fresh source="library" onClose={() => {}} />);
    await fillRequired();
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('工具目录加载中，请稍候再提交')).toBeInTheDocument();
    expect(createCustom).not.toHaveBeenCalled();
  });

  it('全部档 + 目录未就绪 → 同样拦截', async () => {
    getCatalog.mockReturnValue(new Promise(() => {}));
    const Fresh = await importFreshDialog();
    render(<Fresh source="library" onClose={() => {}} />);
    await fillRequired();
    fireEvent.click(screen.getByLabelText('全部工具'));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('工具目录加载中，请稍候再提交')).toBeInTheDocument();
    expect(createCustom).not.toHaveBeenCalled();
  });

  it('自定义档不依赖目录 → 目录未就绪仍可提交（工具空集，三字段齐全）', async () => {
    getCatalog.mockReturnValue(new Promise(() => {}));
    const Fresh = await importFreshDialog();
    render(<Fresh source="library" onClose={vi.fn()} />);
    await fillRequired();
    fireEvent.click(screen.getByLabelText('自定义'));
    // CapabilityTabs 工具区显示加载提示（目录未就绪），MCP/Skill 不受影响
    expect(await screen.findByText('工具目录加载中…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(createCustom).toHaveBeenCalled());
    const input = createCustom.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.defaultTools).toEqual([]);
    expect(input.defaultMcps).toEqual([]);
    expect(input.defaultSkills).toEqual([]);
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
