// renderer/src/components/agent/AssignmentCapabilitiesDialog.test.tsx
//
// v1.6 Task 10：Layer 3 per-assignment 能力 override 弹窗测试。
// 三态 checkbox 语义（保存时计算 deltas）：
//   - 工具 T 在 default 中：value 含 T = 无 delta；value 不含 T = removed delta
//   - 工具 T 不在 default 中：value 不含 T = 无 delta；value 含 T = added delta
//
// default = def.defaultTools/Mcps/Skills ∪ workspace allocation（Layer 2 分配）。
// value = (default + deltas.addedX) - deltas.removedX（从已存 deltas 反推）。
// 保存：addedX = value - default；removedX = default - value。
//
// Mock 策略：与 DefinitionEditor.test.tsx 一致——window.api 桩 + store.setState 注入 mock action。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AssignmentCapabilitiesDialog } from './AssignmentCapabilitiesDialog';
import { useAgentStore } from '../../stores/agent.store';
import type { AgentAssignment, AgentDefinition, AssignmentDeltas, WorkspaceAllocation, Workspace } from '../../ipc/types';

// ---- mock IPC 桩（capability tabs / allocation / workspace.get 直接走 ipc） ----
const allocationGet = vi.fn();
const workspaceGet = vi.fn();
const resourceList = vi.fn();

// store action 桩（组件经 useAgentStore 调用）
const getAssignmentDeltasMock = vi.fn();
const setAssignmentDeltasMock = vi.fn();
const stopAgentMock = vi.fn();
const startAgentMock = vi.fn();

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
  getAssignmentDeltasMock.mockReset();
  setAssignmentDeltasMock.mockReset();
  stopAgentMock.mockReset();
  startAgentMock.mockReset();

  allocationGet.mockResolvedValue({ workspaceId: 'ws-1', tools: [], mcps: [], skills: [] } satisfies WorkspaceAllocation);
  workspaceGet.mockResolvedValue(null);
  resourceList.mockResolvedValue([]);
  getAssignmentDeltasMock.mockResolvedValue({ ...EMPTY_DELTAS });
  setAssignmentDeltasMock.mockResolvedValue(undefined);
  stopAgentMock.mockResolvedValue(undefined);
  startAgentMock.mockResolvedValue(undefined);

  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

  useAgentStore.setState({
    definitions: [],
    assignments: [],
    builtinSuggestions: {},
    loading: false,
    error: null,
    loadDefinitions: vi.fn(),
    loadAssignments: vi.fn(),
    loadBuiltinSuggestions: vi.fn(),
    addAgent: vi.fn(),
    assignMainAgent: vi.fn(),
    deleteDefinition: vi.fn(),
    updateAssignmentRole: vi.fn(),
    updateAssignmentApiKey: vi.fn(),
    getAssignmentDeltas: getAssignmentDeltasMock,
    setAssignmentDeltas: setAssignmentDeltasMock,
    stopAgent: stopAgentMock,
    startAgent: startAgentMock,
    reset: vi.fn(),
  });
});

function buildAssignment(overrides: Partial<AgentAssignment> = {}): AgentAssignment {
  return {
    instanceId: 'inst-1',
    workspaceId: 'ws-1',
    agentDefinitionId: 'def-1',
    agentUserId: '@bot:server',
    enabled: true,
    createdAt: '',
    role: 'standalone',
    parentInstanceId: null,
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

describe('AssignmentCapabilitiesDialog — 加载', () => {
  it('无 deltas 时 value = default（def + ws allocation 合集）', async () => {
    // def.defaultTools=[read_file], allocation.tools=[grep] → default=[read_file, grep]
    allocationGet.mockResolvedValueOnce({
      workspaceId: 'ws-1',
      tools: ['grep'],
      mcps: [],
      skills: [],
    } satisfies WorkspaceAllocation);
    getAssignmentDeltasMock.mockResolvedValueOnce({ ...EMPTY_DELTAS });
    render(
      <AssignmentCapabilitiesDialog
        assignment={buildAssignment()}
        def={buildDef()}
        onClose={() => {}}
      />,
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
    getAssignmentDeltasMock.mockResolvedValueOnce({
      ...EMPTY_DELTAS,
      addedTools: ['bash'],
      removedTools: ['read_file'],
    });
    render(
      <AssignmentCapabilitiesDialog
        assignment={buildAssignment()}
        def={buildDef()}
        onClose={() => {}}
      />,
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
      <AssignmentCapabilitiesDialog
        assignment={buildAssignment()}
        def={buildDef()}
        onClose={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/默认（def \+ workspace）/)).toBeInTheDocument();
    });
  });
});

describe('AssignmentCapabilitiesDialog — 改 added', () => {
  it('勾选非默认工具 → 保存 → setAssignmentDeltas 收到 addedTools 含该工具', async () => {
    // default=[read_file], 勾 bash → value=[read_file, bash]
    // addedTools=[bash], removedTools=[]
    render(
      <AssignmentCapabilitiesDialog
        assignment={buildAssignment()}
        def={buildDef()}
        onClose={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('bash')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('bash'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(setAssignmentDeltasMock).toHaveBeenCalledTimes(1);
    });
    const [instanceId, deltas] = setAssignmentDeltasMock.mock.calls[0]!;
    expect(instanceId).toBe('inst-1');
    expect(deltas.addedTools).toEqual(['bash']);
    expect(deltas.removedTools).toEqual([]);
  });
});

describe('AssignmentCapabilitiesDialog — 改 removed', () => {
  it('取消默认工具 → 保存 → setAssignmentDeltas 收到 removedTools 含该工具', async () => {
    // default=[read_file], 取消 read_file → value=[]
    // addedTools=[], removedTools=[read_file]
    render(
      <AssignmentCapabilitiesDialog
        assignment={buildAssignment()}
        def={buildDef()}
        onClose={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('read_file')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('read_file'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(setAssignmentDeltasMock).toHaveBeenCalledTimes(1);
    });
    const [, deltas] = setAssignmentDeltasMock.mock.calls[0]!;
    expect(deltas.addedTools).toEqual([]);
    expect(deltas.removedTools).toEqual(['read_file']);
  });
});

describe('AssignmentCapabilitiesDialog — 保存全量', () => {
  it('同时 added + removed → deltas 同时含 addedTools 和 removedTools', async () => {
    // default=[read_file], 勾 bash + 取消 read_file → value=[bash]
    render(
      <AssignmentCapabilitiesDialog
        assignment={buildAssignment()}
        def={buildDef()}
        onClose={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('bash')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('bash'));
    fireEvent.click(screen.getByLabelText('read_file'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(setAssignmentDeltasMock).toHaveBeenCalledTimes(1);
    });
    const [, deltas] = setAssignmentDeltasMock.mock.calls[0]!;
    expect(deltas.addedTools).toEqual(['bash']);
    expect(deltas.removedTools).toEqual(['read_file']);
  });

  it('取消按钮不触发 setAssignmentDeltas，调用 onClose', async () => {
    const onClose = vi.fn();
    render(
      <AssignmentCapabilitiesDialog
        assignment={buildAssignment()}
        def={buildDef()}
        onClose={onClose}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('bash')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(setAssignmentDeltasMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('AssignmentCapabilitiesDialog — 重启提示', () => {
  it('agent 运行中 + delta 变化 → 保存后显示重启提示', async () => {
    render(
      <AssignmentCapabilitiesDialog
        assignment={buildAssignment()}
        def={buildDef()}
        onClose={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('bash')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('bash'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(setAssignmentDeltasMock).toHaveBeenCalledTimes(1);
    });
    // 弹出重启提示
    expect(screen.getByText(/需重启/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '立即重启' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '稍后' })).toBeInTheDocument();
  });

  it('点击 [立即重启] → stopAgent + startAgent + onClose', async () => {
    workspaceGet.mockResolvedValueOnce({
      id: 'ws-1',
      name: 'WS',
      description: '',
      directoryPath: '/tmp',
      teamSessionId: '!team:server',
      gitInitialized: true,
      createdAt: '',
      ownerId: 'u',
      iconEmoji: '📁',
      coordinatorInstanceId: null,
    } satisfies Workspace);
    const onClose = vi.fn();
    render(
      <AssignmentCapabilitiesDialog
        assignment={buildAssignment()}
        def={buildDef()}
        onClose={onClose}
      />,
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
      expect(stopAgentMock).toHaveBeenCalledWith('inst-1');
    });
    await waitFor(() => {
      expect(startAgentMock).toHaveBeenCalledTimes(1);
    });
    // startAgent 收到 assignment + wsId + teamRoomId
    const startArgs = startAgentMock.mock.calls[0]!;
    expect(startArgs[0]?.instanceId).toBe('inst-1');
    expect(startArgs[1]).toBe('ws-1');
    expect(startArgs[2]).toBe('!team:server');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('agent 未运行 → 保存后直接关闭（不弹重启提示）', async () => {
    const onClose = vi.fn();
    render(
      <AssignmentCapabilitiesDialog
        assignment={buildAssignment({ lastRunning: false })}
        def={buildDef()}
        onClose={onClose}
      />,
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
    expect(stopAgentMock).not.toHaveBeenCalled();
  });

  it('点击 [稍后] → 关闭弹窗（不重启）', async () => {
    const onClose = vi.fn();
    render(
      <AssignmentCapabilitiesDialog
        assignment={buildAssignment()}
        def={buildDef()}
        onClose={onClose}
      />,
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
    expect(stopAgentMock).not.toHaveBeenCalled();
  });
});
