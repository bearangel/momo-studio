// renderer/src/components/agent/MemberEditDialog.test.tsx
//
// 成员统一编辑弹窗测试（移植原能力覆盖弹窗的加载/added/removed/保存全量/
// 重启提示覆盖 + 模型区新语义）。三态 checkbox 语义（保存时计算 deltas）：
//   - 工具 T 在 default 中：value 含 T = 无 delta；value 不含 T = removed delta
//   - 工具 T 不在 default 中：value 不含 T = 无 delta；value 含 T = added delta
//
// default = def.defaultTools/Mcps/Skills ∪ workspace allocation（Layer 2 分配）。
// value = (default + deltas.addedX) - deltas.removedX（从已存 deltas 反推）。
// 保存：addedX = value - default；removedX = default - value（真实 capability-helpers）。
//
// 模型区（v2.2 P4 fix）：key 区已移除；模型为全局定义属性（写入 agent_definitions），
// ProviderModelPicker 受控 + 数据自理，保存链 updateDefinition 先于 setMemberDeltas。
// pendingRestart 条件 = (modelChanged || deltasChanged) && member.lastRunning。
//
// Mock 策略（momo-test-rules）：mock 收窄到 IPC 边界（window.api 桩）+
// store.setState 注入 mock action；deltas 计算/比较走真实 capability-helpers。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemberEditDialog } from './MemberEditDialog';
import { useAgentStore } from '../../stores/agent.store';
import { useProviderStore } from '../../stores/provider.store';
import type { WorkspaceAgentMember, AgentDefinition, AssignmentDeltas, WorkspaceAllocation, Workspace } from '../../ipc/types';

// ---- mock IPC 桩（capability tabs / allocation / workspace.get / provider / agent 直接走 ipc） ----
const allocationGet = vi.fn();
const workspaceGet = vi.fn();
const resourceList = vi.fn();
const providerListModels = vi.fn();
const updateDefinition = vi.fn();

// store action 桩（组件经 useAgentStore / useProviderStore 调用）
const getMemberDeltasMock = vi.fn();
const setMemberDeltasMock = vi.fn();
const stopMemberMock = vi.fn();
const startMemberMock = vi.fn();

const mockApi = {
  allocation: { get: allocationGet },
  workspace: { get: workspaceGet },
  resource: { list: resourceList },
  provider: { listModels: providerListModels },
  agent: { updateDefinition },
};

const EMPTY_DELTAS: AssignmentDeltas = {
  addedTools: [],
  removedTools: [],
  addedMcps: [],
  removedMcps: [],
  addedSkills: [],
  removedSkills: [],
};

beforeEach(() => {
  allocationGet.mockReset();
  workspaceGet.mockReset();
  resourceList.mockReset();
  providerListModels.mockReset();
  updateDefinition.mockReset();
  getMemberDeltasMock.mockReset();
  setMemberDeltasMock.mockReset();
  stopMemberMock.mockReset();
  startMemberMock.mockReset();

  allocationGet.mockResolvedValue({ workspaceId: 'ws-1', tools: [], mcps: [], skills: [] } satisfies WorkspaceAllocation);
  workspaceGet.mockResolvedValue(null);
  resourceList.mockResolvedValue([]);
  // 默认返回 p1 的两个已启用模型（与 buildDef.modelProviderId='p1' / modelName='m' 对齐）
  providerListModels.mockResolvedValue([
    { providerId: 'p1', modelId: 'm', enabled: true, addedAt: 0 },
    { providerId: 'p1', modelId: 'm2', enabled: true, addedAt: 1 },
  ]);
  updateDefinition.mockResolvedValue(undefined);
  getMemberDeltasMock.mockResolvedValue({ ...EMPTY_DELTAS });
  setMemberDeltasMock.mockResolvedValue(undefined);
  stopMemberMock.mockResolvedValue(undefined);
  startMemberMock.mockResolvedValue(undefined);

  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

  useProviderStore.setState({
    providers: [
      { id: 'p1', name: 'P1', baseUrl: 'https://a', defaultModel: null, isDefault: true, createdAt: '', platform: 'openai' as const },
      { id: 'p2', name: 'P2', baseUrl: 'https://b', defaultModel: null, isDefault: false, createdAt: '', platform: 'openai' as const },
    ],
    loading: false,
    loadProviders: vi.fn().mockResolvedValue(undefined),
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
    loadDefinitions: vi.fn(),
    loadMembers: vi.fn(),
    loadBuiltinSuggestions: vi.fn(),
    addMember: vi.fn(),
    deleteDefinition: vi.fn(),
    getMemberDeltas: getMemberDeltasMock,
    setMemberDeltas: setMemberDeltasMock,
    stopMember: stopMemberMock,
    startMember: startMemberMock,
    reset: vi.fn(),
  });
});

function buildMember(overrides: Partial<WorkspaceAgentMember> = {}): WorkspaceAgentMember {
  return {
    instanceId: 'inst-1',
    workspaceId: 'ws-1',
    agentDefinitionId: 'def-1',
    agentUserId: '@bot:server',
    agentName: '测试 agent',
    iconEmoji: '',
    createdAt: '',
    hasApiKeyOverride: false,
    lastRunning: true,
    ...overrides,
  };
}

function buildDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'def-1',
    name: '测试 agent',
    slug: 'test',
    version: '1.0.0',
    runtime: 'declarative',
    systemPrompt: '',
    defaultTools: [{ kind: 'builtin', ref: 'read_file' }],
    source: 'custom',
    description: '',
    iconEmoji: '🤖',
    defaultMcps: [],
    defaultSkills: [],
    workspaceId: null,
    modelProviderId: 'p1',
    modelName: 'm',
    ...overrides,
  };
}

describe('MemberEditDialog — 加载', () => {
  it('无 deltas 时 value = default（def + ws allocation 合集）', async () => {
    // def.defaultTools=[read_file], allocation.tools=[grep] → default=[read_file, grep]
    allocationGet.mockResolvedValueOnce({
      workspaceId: 'ws-1',
      tools: ['grep'],
      mcps: [],
      skills: [],
    } satisfies WorkspaceAllocation);
    getMemberDeltasMock.mockResolvedValueOnce({ ...EMPTY_DELTAS });
    render(
      <MemberEditDialog member={buildMember()} def={buildDef()} onClose={() => {}} />,
    );
    // 等待加载完成（checkbox 出现）
    await waitFor(() => {
      expect(screen.getByLabelText('read_file')).toBeInTheDocument();
    });
    expect((screen.getByLabelText('read_file') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('grep') as HTMLInputElement).checked).toBe(true);
    // bash 既不在 def 也不在 allocation → 未勾
    expect((screen.getByLabelText('bash') as HTMLInputElement).checked).toBe(false);
  });

  it('应用已存 deltas 反推 value（addedTools + removedTools）', async () => {
    // default=[read_file], deltas: added=[bash], removed=[read_file] → value=[bash]
    getMemberDeltasMock.mockResolvedValueOnce({
      ...EMPTY_DELTAS,
      addedTools: ['bash'],
      removedTools: ['read_file'],
    });
    render(
      <MemberEditDialog member={buildMember()} def={buildDef()} onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('bash')).toBeInTheDocument();
    });
    expect((screen.getByLabelText('bash') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('read_file') as HTMLInputElement).checked).toBe(false);
  });

  it('override 模式显示默认值提示（让用户知道 def+ws 默认是什么）', async () => {
    allocationGet.mockResolvedValueOnce({
      workspaceId: 'ws-1',
      tools: ['grep'],
      mcps: [],
      skills: [],
    } satisfies WorkspaceAllocation);
    render(
      <MemberEditDialog member={buildMember()} def={buildDef()} onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/默认（def \+ workspace）/)).toBeInTheDocument();
    });
  });
});

describe('MemberEditDialog — 改 added', () => {
  it('勾选非默认工具 → 保存 → setMemberDeltas 收到 addedTools 含该工具', async () => {
    // default=[read_file], 勾 bash → value=[read_file, bash]
    // addedTools=[bash], removedTools=[]
    render(
      <MemberEditDialog member={buildMember()} def={buildDef()} onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('bash')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('bash'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(setMemberDeltasMock).toHaveBeenCalledTimes(1);
    });
    const [instanceId, deltas] = setMemberDeltasMock.mock.calls[0]!;
    expect(instanceId).toBe('inst-1');
    expect(deltas.addedTools).toEqual(['bash']);
    expect(deltas.removedTools).toEqual([]);
  });
});

describe('MemberEditDialog — 改 removed', () => {
  it('取消默认工具 → 保存 → setMemberDeltas 收到 removedTools 含该工具', async () => {
    // default=[read_file], 取消 read_file → value=[]
    // addedTools=[], removedTools=[read_file]
    render(
      <MemberEditDialog member={buildMember()} def={buildDef()} onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('read_file')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('read_file'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(setMemberDeltasMock).toHaveBeenCalledTimes(1);
    });
    const [, deltas] = setMemberDeltasMock.mock.calls[0]!;
    expect(deltas.addedTools).toEqual([]);
    expect(deltas.removedTools).toEqual(['read_file']);
  });
});

describe('MemberEditDialog — 保存全量', () => {
  it('同时 added + removed → deltas 同时含 addedTools 和 removedTools', async () => {
    // default=[read_file], 勾 bash + 取消 read_file → value=[bash]
    render(
      <MemberEditDialog member={buildMember()} def={buildDef()} onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('bash')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('bash'));
    fireEvent.click(screen.getByLabelText('read_file'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(setMemberDeltasMock).toHaveBeenCalledTimes(1);
    });
    const [, deltas] = setMemberDeltasMock.mock.calls[0]!;
    expect(deltas.addedTools).toEqual(['bash']);
    expect(deltas.removedTools).toEqual(['read_file']);
  });

  it('取消按钮不触发 updateDefinition / setMemberDeltas，调用 onClose', async () => {
    const onClose = vi.fn();
    render(
      <MemberEditDialog member={buildMember()} def={buildDef()} onClose={onClose} />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('bash')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(setMemberDeltasMock).not.toHaveBeenCalled();
    expect(updateDefinition).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('MemberEditDialog — 重启提示', () => {
  it('agent 运行中 + delta 变化 → 保存后显示重启提示', async () => {
    render(
      <MemberEditDialog member={buildMember()} def={buildDef()} onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('bash')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('bash'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(setMemberDeltasMock).toHaveBeenCalledTimes(1);
    });
    // 弹出重启提示
    expect(screen.getByText(/需重启/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '立即重启' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '稍后' })).toBeInTheDocument();
  });

  it('agent 运行中 + 仅模型变化（deltas 无变化）→ 同样显示重启提示', async () => {
    render(<MemberEditDialog member={buildMember()} def={buildDef()} onClose={() => {}} />);
    // 等模型下拉加载完成
    await screen.findByRole('option', { name: 'm2' });
    fireEvent.change(screen.getByLabelText('模型名'), { target: { value: 'm2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(updateDefinition).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText(/需重启/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '立即重启' })).toBeInTheDocument();
  });

  it('点击 [立即重启] → stopMember + startMember + onClose', async () => {
    workspaceGet.mockResolvedValueOnce({
      id: 'ws-1',
      name: 'WS',
      description: '',
      directoryPath: '/tmp',
      gitInitialized: true,
      createdAt: '',
      ownerId: 'u',
      iconEmoji: '📁',
      defaultAgentInstanceId: null,
    } satisfies Workspace);
    const onClose = vi.fn();
    render(
      <MemberEditDialog member={buildMember()} def={buildDef()} onClose={onClose} />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('bash')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('bash'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '立即重启' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '立即重启' }));

    await waitFor(() => {
      expect(stopMemberMock).toHaveBeenCalledWith('inst-1');
    });
    await waitFor(() => {
      expect(startMemberMock).toHaveBeenCalledTimes(1);
    });
    // startMember 收到 member + wsId
    const startArgs = startMemberMock.mock.calls[0]!;
    expect(startArgs[0]?.instanceId).toBe('inst-1');
    expect(startArgs[1]).toBe('ws-1');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('agent 未运行 → 保存后直接关闭（不弹重启提示）', async () => {
    const onClose = vi.fn();
    render(
      <MemberEditDialog member={buildMember({ lastRunning: false })} def={buildDef()} onClose={onClose} />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('bash')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('bash'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    // 无重启提示
    expect(screen.queryByText(/需重启/)).not.toBeInTheDocument();
    expect(stopMemberMock).not.toHaveBeenCalled();
  });

  it('点击 [稍后] → 关闭弹窗（不重启）', async () => {
    const onClose = vi.fn();
    render(
      <MemberEditDialog member={buildMember()} def={buildDef()} onClose={onClose} />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('bash')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('bash'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '稍后' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '稍后' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(stopMemberMock).not.toHaveBeenCalled();
  });
});

describe('MemberEditDialog — 模型区（全局定义）', () => {
  it('显示全局影响提示文案与初始模型（def 的 provider/model）', async () => {
    render(<MemberEditDialog member={buildMember()} def={buildDef()} onClose={() => {}} />);
    expect(screen.getByText(/定义全局共享，模型修改对所有工作空间的同名 agent 生效/)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText('模型名')).toHaveValue('m');
    });
  });

  it('模型未变化保存 → updateDefinition 不被调用', async () => {
    render(<MemberEditDialog member={buildMember()} def={buildDef()} onClose={() => {}} />);
    await screen.findByLabelText('bash');
    fireEvent.click(screen.getByLabelText('bash')); // 只改能力
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(setMemberDeltasMock).toHaveBeenCalledTimes(1);
    });
    expect(updateDefinition).not.toHaveBeenCalled();
  });

  it('换模型保存 → updateDefinition(def.id, 新 provider/model) 先于 setMemberDeltas', async () => {
    render(<MemberEditDialog member={buildMember()} def={buildDef()} onClose={() => {}} />);
    await screen.findByRole('option', { name: 'm2' });
    fireEvent.change(screen.getByLabelText('模型供应商*'), { target: { value: 'p2' } });
    // 切 p2 触发 picker 联动重置（模型清空）；再切回 p1 走缓存路径，覆盖重置→重选链
    fireEvent.change(screen.getByLabelText('模型供应商*'), { target: { value: 'p1' } });
    await screen.findByRole('option', { name: 'm2' });
    fireEvent.change(screen.getByLabelText('模型名'), { target: { value: 'm2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(updateDefinition).toHaveBeenCalledWith({
        id: 'def-1',
        modelProviderId: 'p1',
        modelName: 'm2',
      });
    });
    // 保存链同时落能力 deltas（顺序保证由实现中 await updateDefinition 先于
    // setMemberDeltasAction 承担——momo-test-rules：断言调用与字段，不做时序细节断言）
    expect(setMemberDeltasMock).toHaveBeenCalled();
  });

  it('API Key 区已移除（无 key 输入框）', async () => {
    render(<MemberEditDialog member={buildMember()} def={buildDef()} onClose={() => {}} />);
    await screen.findByLabelText('bash');
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument();
    expect(screen.queryByText(/当前使用独立 API key override/)).not.toBeInTheDocument();
  });

  it('updateDefinition 失败 → error 展示且弹窗不关闭', async () => {
    updateDefinition.mockRejectedValue(new Error('Agent 定义不存在: def-1'));
    const onClose = vi.fn();
    render(<MemberEditDialog member={buildMember()} def={buildDef()} onClose={onClose} />);
    await screen.findByRole('option', { name: 'm2' });
    fireEvent.change(screen.getByLabelText('模型名'), { target: { value: 'm2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('Agent 定义不存在: def-1')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('换供应商后模型被清空即保存 → 拦截报错且不调 updateDefinition / 不关窗', async () => {
    const onClose = vi.fn();
    render(<MemberEditDialog member={buildMember()} def={buildDef()} onClose={onClose} />);
    // 等初始模型加载完成
    await waitFor(() => {
      expect(screen.getByLabelText('模型名')).toHaveValue('m');
    });
    // 切供应商 → picker 联动清空模型（onModelChange('')）
    fireEvent.change(screen.getByLabelText('模型供应商*'), { target: { value: 'p2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('请选择模型供应商与模型')).toBeInTheDocument();
    expect(updateDefinition).not.toHaveBeenCalled();
    expect(setMemberDeltasMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
