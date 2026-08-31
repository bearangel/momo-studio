// renderer/src/components/agent/AgentsView.test.tsx
//
// v2.0 P3 Task 5：L2 工作空间能力编辑面板挂载测试。
// AgentsView workspace tab 内除 WorkspaceAgentsPanel 外，应新增一个可折叠的
// 「工作空间共享能力（L2）」区，挂载 <CapabilityConfig />（无选中 agent，
// 只渲染 Layer 2）。section 默认展开。
//
// 约束：
//   - 仅 activeWorkspaceId 非空时挂载 CapabilityConfig（避免无 ws 时注入 load）；
//   - Agent 库 tab 不渲染 L2 区（仅 workspace tab）；
//   - CapabilityConfig 的 IPC 链路（allocation:get）被触发一次。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// CapabilityConfig 子组件桩：渲染稳定的根元素并暴露 capability-config-root
const capabilityConfigMock = vi.fn();
vi.mock('./CapabilityConfig', () => ({
  CapabilityConfig: (props: { workspaceId: string }) => {
    capabilityConfigMock(props);
    return (
      <div data-testid="capability-config-root">
        <span>CapabilityConfig workspace={props.workspaceId}</span>
      </div>
    );
  },
}));

// WorkspaceAgentsPanel 子组件桩：避免其内部 store/IPC 依赖影响测试
vi.mock('./WorkspaceAgentsPanel', () => ({
  WorkspaceAgentsPanel: () => <div data-testid="workspace-agents-panel" />,
}));

const { AgentsView } = await import('./AgentsView');
const { useAgentStore } = await import('../../stores/agent.store');
const { useWorkspaceStore } = await import('../../stores/workspace.store');
const { useCapabilityStore } = await import('../../stores/capability.store');

// IPC 桩：AgentsView 本身不直接调 allocation，但 CapabilityConfig 会通过 store 触发
const allocationGet = vi.fn();
beforeEach(() => {
  capabilityConfigMock.mockClear();
  allocationGet.mockReset();
  allocationGet.mockResolvedValue({
    workspaceId: 'ws-1',
    tools: [],
    mcps: [],
    skills: [],
  });
  (globalThis as unknown as { window: { api: { allocation: { get: typeof allocationGet } } } }).window.api = {
    allocation: { get: allocationGet },
  };

  useWorkspaceStore.setState({
    workspaces: [{
      id: 'ws-1',
      name: '测试工作空间',
      description: '',
      directoryPath: '/tmp/ws',
      gitInitialized: true,
      createdAt: '',
      ownerId: 'u',
      iconEmoji: '📁',
      defaultAgentInstanceId: null,
    }],
    activeWorkspaceId: 'ws-1',
    loading: false,
    error: null,
  });

  useAgentStore.setState({
    definitions: [],
    assignments: [],
    builtinSuggestions: {},
    loading: false,
    error: null,
    loadDefinitions: vi.fn().mockResolvedValue(undefined),
    loadAssignments: vi.fn().mockResolvedValue(undefined),
    loadBuiltinSuggestions: vi.fn().mockResolvedValue(undefined),
    addAgent: vi.fn(),
    deleteDefinition: vi.fn(),
    updateAssignmentApiKey: vi.fn(),
    getAssignmentDeltas: vi.fn(),
    setAssignmentDeltas: vi.fn(),
    stopAgent: vi.fn(),
    startAgent: vi.fn(),
    reset: vi.fn(),
  });

  useCapabilityStore.setState({
    allocation: null,
    loading: false,
    error: null,
  });
});

describe('AgentsView — L2 工作空间共享能力区挂载', () => {
  it('workspace tab 内渲染「工作空间共享能力（L2）」区，含 CapabilityConfig', async () => {
    render(<AgentsView />);

    // 等 useEffect 触发 CapabilityConfig mount（其内部会 load allocation）
    await waitFor(() => {
      expect(capabilityConfigMock).toHaveBeenCalled();
    });

    expect(screen.getByText(/工作空间共享能力.*L2/)).toBeInTheDocument();
    expect(screen.getByTestId('workspace-agents-panel')).toBeInTheDocument();
    expect(screen.getByTestId('capability-config-root')).toBeInTheDocument();
    // CapabilityConfig 收到的 workspaceId 是当前 active workspace
    const props = capabilityConfigMock.mock.calls.at(-1)![0];
    expect(props.workspaceId).toBe('ws-1');
  });

  it('切换到 Agent 库 tab → 不渲染 L2 区', async () => {
    render(<AgentsView />);

    await waitFor(() => {
      expect(capabilityConfigMock).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Agent 库' }));

    await waitFor(() => {
      expect(screen.queryByTestId('capability-config-root')).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/工作空间共享能力.*L2/)).not.toBeInTheDocument();
  });
});