// renderer/src/components/agent/AddToWorkspaceDialog.test.tsx
//
// v1.6 Task 11：AddToWorkspaceDialog Layer 3 折叠区测试。
// 在现有「添加 agent」流程最后一步（API key 之后）追加一个可选的「能力调整」折叠区，
// 用户可在添加 agent 时同时设置 per-assignment 能力 override（Layer 3 deltas）。
//
// 行为约定：
//   - 折叠区默认收起（大多数情况不需要 override）。
//   - 展开后显示 CapabilityTabs mode="override"，defaultValue = def + ws allocation 合集。
//   - 提交时：先 addAgent 拿到新 instanceId，再 computeDeltas；deltas 全空则跳过 setAssignmentDeltas。
//
// Mock 策略：window.api 桩（allocation/mcp/skill）+ useAgentStore/useWorkspaceStore.setState 注入。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddToWorkspaceDialog } from './AddToWorkspaceDialog';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type {
  AgentAssignment,
  AgentDefinition,
  Workspace,
  WorkspaceAllocation,
} from '../../ipc/types';

// ---- mock IPC 桩（CapabilityTabs 直接走 ipc 拉 MCP/Skill；折叠区加载走 allocation.get） ----
const allocationGet = vi.fn();
const listRegistered = vi.fn();
const listInstalled = vi.fn();
const workspaceGet = vi.fn();

const mockApi = {
  allocation: { get: allocationGet },
  mcp: { listRegistered },
  skill: { listInstalled },
  workspace: { get: workspaceGet },
};

const addAgentMock = vi.fn();
const setAssignmentDeltasMock = vi.fn();
const stopAgentMock = vi.fn();
const startAgentMock = vi.fn();

const WS: Workspace = {
  id: 'ws-1',
  name: '测试工作空间',
  description: '',
  directoryPath: '/tmp/ws',
  matrixSpaceId: '!space:server',
  teamRoomId: '!team:server',
  gitInitialized: true,
  createdAt: '',
  ownerId: 'u',
  iconEmoji: '📁',
  coordinatorInstanceId: null,
};

const NEW_ASSIGNMENT: AgentAssignment = {
  instanceId: 'inst-new',
  workspaceId: 'ws-1',
  agentDefinitionId: 'def-1',
  botMatrixUserId: '@bot:server',
  enabled: true,
  createdAt: '',
  role: 'standalone',
  parentInstanceId: null,
  hasApiKeyOverride: false,
};

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

const DEF = buildDef();

function mockEmptyAllocation(): WorkspaceAllocation {
  return { workspaceId: 'ws-1', tools: [], mcps: [], skills: [] };
}

beforeEach(() => {
  allocationGet.mockReset();
  listRegistered.mockReset();
  listInstalled.mockReset();
  addAgentMock.mockReset();
  setAssignmentDeltasMock.mockReset();
  workspaceGet.mockReset();
  stopAgentMock.mockReset();
  startAgentMock.mockReset();

  allocationGet.mockResolvedValue(mockEmptyAllocation());
  listRegistered.mockResolvedValue([]);
  listInstalled.mockResolvedValue([]);
  addAgentMock.mockResolvedValue(NEW_ASSIGNMENT);
  setAssignmentDeltasMock.mockResolvedValue(undefined);
  workspaceGet.mockResolvedValue(WS);
  stopAgentMock.mockResolvedValue(undefined);
  startAgentMock.mockResolvedValue(undefined);

  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

  useWorkspaceStore.setState({
    workspaces: [WS],
    activeWorkspaceId: 'ws-1',
    loading: false,
    error: null,
  });

  useAgentStore.setState({
    definitions: [DEF],
    assignments: [],
    running: {},
    builtinSuggestions: {},
    loading: false,
    error: null,
    loadDefinitions: vi.fn(),
    loadAssignments: vi.fn(),
    loadBuiltinSuggestions: vi.fn(),
    syncRunningStates: vi.fn(),
    addAgent: addAgentMock,
    assignMainAgent: vi.fn(),
    deleteDefinition: vi.fn(),
    updateAssignmentRole: vi.fn(),
    updateAssignmentApiKey: vi.fn(),
    getAssignmentDeltas: vi.fn(),
    setAssignmentDeltas: setAssignmentDeltasMock,
    stopAgent: stopAgentMock,
    startAgent: startAgentMock,
    reset: vi.fn(),
  });
});

describe('AddToWorkspaceDialog — Layer 3 折叠区', () => {
  it('默认收起：summary 在，但 CapabilityTabs 的 checkbox 不在', () => {
    render(<AddToWorkspaceDialog preselectedDef={DEF} onClose={() => {}} />);
    expect(screen.getByText(/能力调整（可选）/)).toBeInTheDocument();
    // 工具 checkbox 尚未渲染（折叠区未展开）
    expect(screen.queryByLabelText('read_file')).not.toBeInTheDocument();
  });

  it('点击 summary 展开 → CapabilityTabs 工具 checkbox 出现', async () => {
    render(<AddToWorkspaceDialog preselectedDef={DEF} onClose={() => {}} />);
    fireEvent.click(screen.getByText(/能力调整（可选）/));
    await waitFor(() => {
      expect(screen.getByLabelText('read_file')).toBeInTheDocument();
    });
  });

  it('展开后显示 override 模式默认值提示（def + workspace 合集）', async () => {
    // def.defaultTools=[read_file], allocation.tools=[grep] → 默认合集含两者
    allocationGet.mockResolvedValueOnce({
      workspaceId: 'ws-1',
      tools: ['grep'],
      mcps: [],
      skills: [],
    } satisfies WorkspaceAllocation);
    render(<AddToWorkspaceDialog preselectedDef={DEF} onClose={() => {}} />);
    fireEvent.click(screen.getByText(/能力调整（可选）/));
    // allocation 异步加载后 defaultCaps 含 grep，overrideValue 同步 → grep 勾选
    await waitFor(() => {
      expect((screen.getByLabelText('grep') as HTMLInputElement).checked).toBe(true);
    });
    expect((screen.getByLabelText('read_file') as HTMLInputElement).checked).toBe(true);
    // override 模式的默认值提示文案
    expect(screen.getByText(/默认（def \+ workspace）/)).toBeInTheDocument();
  });

  it('改工具后保存 → setAssignmentDeltas 收到正确 instanceId + addedTools', async () => {
    render(<AddToWorkspaceDialog preselectedDef={DEF} onClose={() => {}} />);
    // 展开折叠区
    fireEvent.click(screen.getByText(/能力调整（可选）/));
    await waitFor(() => {
      expect(screen.getByLabelText('bash')).toBeInTheDocument();
    });
    // 勾选 bash（非默认工具）→ 产生 addedTools=[bash]
    fireEvent.click(screen.getByLabelText('bash'));
    // 提交
    fireEvent.click(screen.getByRole('button', { name: '添加并启动' }));

    await waitFor(() => {
      expect(addAgentMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(setAssignmentDeltasMock).toHaveBeenCalledTimes(1);
    });
    // setAssignmentDeltas 必须用新 instanceId
    const [instanceId, deltas] = setAssignmentDeltasMock.mock.calls[0]!;
    expect(instanceId).toBe('inst-new');
    expect(deltas.addedTools).toEqual(['bash']);
    expect(deltas.removedTools).toEqual([]);
  });

  it('不展开直接保存 → deltas 全空，setAssignmentDeltas 不被调用', async () => {
    const onClose = vi.fn();
    render(<AddToWorkspaceDialog preselectedDef={DEF} onClose={onClose} />);
    // 直接提交（折叠区没展开，value=defaultCaps → deltas 全空）
    fireEvent.click(screen.getByRole('button', { name: '添加并启动' }));

    await waitFor(() => {
      expect(addAgentMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(setAssignmentDeltasMock).not.toHaveBeenCalled();
  });

  it('填了 deltas 后提交 → setAssignmentDeltas 后自动 stop+start 重启（顺序正确）', async () => {
    render(<AddToWorkspaceDialog preselectedDef={DEF} onClose={() => {}} />);
    fireEvent.click(screen.getByText(/能力调整（可选）/));
    await waitFor(() => {
      expect(screen.getByLabelText('bash')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('bash'));
    fireEvent.click(screen.getByRole('button', { name: '添加并启动' }));

    await waitFor(() => {
      expect(addAgentMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(setAssignmentDeltasMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(stopAgentMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(startAgentMock).toHaveBeenCalledTimes(1);
    });

    expect(stopAgentMock).toHaveBeenCalledWith('inst-new');

    const [assignmentArg, wsIdArg, teamRoomIdArg] = startAgentMock.mock.calls[0]!;
    expect(assignmentArg).toBe(NEW_ASSIGNMENT);
    expect(wsIdArg).toBe('ws-1');
    expect(teamRoomIdArg).toBe('!team:server');

    expect(workspaceGet).toHaveBeenCalledWith('ws-1');

    const addAgentOrder = addAgentMock.mock.invocationCallOrder[0]!;
    const setDeltasOrder = setAssignmentDeltasMock.mock.invocationCallOrder[0]!;
    const stopOrder = stopAgentMock.mock.invocationCallOrder[0]!;
    const startOrder = startAgentMock.mock.invocationCallOrder[0]!;
    expect(addAgentOrder).toBeLessThan(setDeltasOrder);
    expect(setDeltasOrder).toBeLessThan(stopOrder);
    expect(stopOrder).toBeLessThan(startOrder);
  });

  it('填了 deltas 且 workspace 已删除 → 只 stop 不 start', async () => {
    workspaceGet.mockResolvedValueOnce(null);
    render(<AddToWorkspaceDialog preselectedDef={DEF} onClose={() => {}} />);
    fireEvent.click(screen.getByText(/能力调整（可选）/));
    await waitFor(() => {
      expect(screen.getByLabelText('bash')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('bash'));
    fireEvent.click(screen.getByRole('button', { name: '添加并启动' }));

    await waitFor(() => {
      expect(stopAgentMock).toHaveBeenCalledTimes(1);
    });
    expect(startAgentMock).not.toHaveBeenCalled();
  });
});
