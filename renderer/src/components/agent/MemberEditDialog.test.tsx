// renderer/src/components/agent/MemberEditDialog.test.tsx
//
// 成员统一编辑弹窗测试（移植原能力覆盖弹窗的加载/added/removed/保存全量/
// 重启提示覆盖 + key-dirty 新语义）。三态 checkbox 语义（保存时计算 deltas）：
//   - 工具 T 在 default 中：value 含 T = 无 delta；value 不含 T = removed delta
//   - 工具 T 不在 default 中：value 不含 T = 无 delta；value 含 T = added delta
//
// default = def.defaultTools/Mcps/Skills ∪ workspace allocation（Layer 2 分配）。
// value = (default + deltas.addedX) - deltas.removedX（从已存 deltas 反推）。
// 保存：addedX = value - default；removedX = default - value（真实 capability-helpers）。
//
// key-dirty 语义：key 输入框仅在用户改过（dirty）时才调 updateMemberApiKey——
// 未编辑 = 不调用（防只改能力时误清 override）；输入后清空 = 调 (instanceId, null)。
//
// Mock 策略（momo-test-rules）：mock 收窄到 IPC 边界（window.api 桩）+
// store.setState 注入 mock action；deltas 计算/比较走真实 capability-helpers。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemberEditDialog } from './MemberEditDialog';
import { useAgentStore } from '../../stores/agent.store';
import type { WorkspaceAgentMember, AgentDefinition, AssignmentDeltas, WorkspaceAllocation, Workspace } from '../../ipc/types';

// ---- mock IPC 桩（capability tabs / allocation / workspace.get 直接走 ipc） ----
const allocationGet = vi.fn();
const workspaceGet = vi.fn();
const resourceList = vi.fn();

// store action 桩（组件经 useAgentStore 调用）
const getMemberDeltasMock = vi.fn();
const setMemberDeltasMock = vi.fn();
const updateMemberApiKeyMock = vi.fn();
const stopMemberMock = vi.fn();
const startMemberMock = vi.fn();

const mockApi = {
  allocation: { get: allocationGet },
  workspace: { get: workspaceGet },
  resource: { list: resourceList },
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
  getMemberDeltasMock.mockReset();
  setMemberDeltasMock.mockReset();
  updateMemberApiKeyMock.mockReset();
  stopMemberMock.mockReset();
  startMemberMock.mockReset();

  allocationGet.mockResolvedValue({ workspaceId: 'ws-1', tools: [], mcps: [], skills: [] } satisfies WorkspaceAllocation);
  workspaceGet.mockResolvedValue(null);
  resourceList.mockResolvedValue([]);
  getMemberDeltasMock.mockResolvedValue({ ...EMPTY_DELTAS });
  setMemberDeltasMock.mockResolvedValue(undefined);
  updateMemberApiKeyMock.mockResolvedValue(undefined);
  stopMemberMock.mockResolvedValue(undefined);
  startMemberMock.mockResolvedValue(undefined);

  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

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
    updateMemberApiKey: updateMemberApiKeyMock,
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

  it('取消按钮不触发 setMemberDeltas / updateMemberApiKey，调用 onClose', async () => {
    const onClose = vi.fn();
    render(
      <MemberEditDialog member={buildMember()} def={buildDef()} onClose={onClose} />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('bash')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(setMemberDeltasMock).not.toHaveBeenCalled();
    expect(updateMemberApiKeyMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('MemberEditDialog — key-dirty 语义', () => {
  it('未动 key 只存能力 → updateMemberApiKey 不被调（防误清 override）', async () => {
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
    expect(updateMemberApiKeyMock).not.toHaveBeenCalled();
  });

  it('输入 key 后保存 → updateMemberApiKey(instanceId, key)', async () => {
    render(
      <MemberEditDialog member={buildMember()} def={buildDef()} onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('API Key')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(updateMemberApiKeyMock).toHaveBeenCalledTimes(1);
    });
    expect(updateMemberApiKeyMock).toHaveBeenCalledWith('inst-1', 'sk-new');
  });

  it('输入后清空保存 → updateMemberApiKey(instanceId, null)（清除 override）', async () => {
    render(
      <MemberEditDialog member={buildMember()} def={buildDef()} onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('API Key')).toBeInTheDocument();
    });
    // 输入再清空：dirty 仍为 true，提交 trim 后为空 → null
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-x' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(updateMemberApiKeyMock).toHaveBeenCalledTimes(1);
    });
    expect(updateMemberApiKeyMock).toHaveBeenCalledWith('inst-1', null);
  });

  it('key 输入含首尾空白 → trim 后提交', async () => {
    render(
      <MemberEditDialog member={buildMember()} def={buildDef()} onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('API Key')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: '  sk-trim  ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(updateMemberApiKeyMock).toHaveBeenCalledTimes(1);
    });
    expect(updateMemberApiKeyMock).toHaveBeenCalledWith('inst-1', 'sk-trim');
  });

  it('hasApiKeyOverride 成员显示 override 提示条；普通成员不显示', async () => {
    const { unmount } = render(
      <MemberEditDialog member={buildMember({ hasApiKeyOverride: true })} def={buildDef()} onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/当前使用独立 API key override/)).toBeInTheDocument();
    });
    unmount();

    render(
      <MemberEditDialog member={buildMember({ hasApiKeyOverride: false })} def={buildDef()} onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('API Key')).toBeInTheDocument();
    });
    expect(screen.queryByText(/当前使用独立 API key override/)).not.toBeInTheDocument();
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

  it('agent 运行中 + 仅 key 变化（deltas 无变化）→ 同样显示重启提示', async () => {
    render(
      <MemberEditDialog member={buildMember()} def={buildDef()} onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('API Key')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-only' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(updateMemberApiKeyMock).toHaveBeenCalledTimes(1);
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
