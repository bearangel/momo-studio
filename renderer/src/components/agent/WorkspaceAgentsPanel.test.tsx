// renderer/src/components/agent/WorkspaceAgentsPanel.test.tsx
//
// v1.6 Task 12：WorkspaceAgentsPanel「⚙ 调整能力」按钮测试。
// 每个 assignment 行右侧按钮组新增「⚙ 调整能力」按钮，点击打开
// AssignmentCapabilitiesDialog（T10 已实现）。Dialog onClose 清空 state
// 并刷新 assignments 列表。
//
// Mock 策略：
//   - vi.mock AssignmentCapabilitiesDialog 为简单占位组件，隔离 panel ↔ dialog 的耦合，
//     让测试聚焦于 panel 的按钮渲染、回调传递、onClose 触发的列表刷新。
//   - useAgentStore / useWorkspaceStore.setState 注入 mock 状态与 actions。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AgentAssignment, AgentDefinition, Workspace } from '../../ipc/types';

// ---- mock AssignmentCapabilitiesDialog：占位渲染 + 暴露 onClose 触发点 ----
const dialogMock = vi.fn();
vi.mock('./AssignmentCapabilitiesDialog', () => ({
  AssignmentCapabilitiesDialog: (props: { assignment: AgentAssignment; def: AgentDefinition; onClose: () => void }) => {
    dialogMock(props);
    return (
      <div data-testid="caps-dialog">
        <span>能力覆盖：{props.def.name}</span>
        <button type="button" onClick={props.onClose}>close-dialog</button>
      </div>
    );
  },
}));

// 延迟导入，确保 mock 已注册
const { WorkspaceAgentsPanel } = await import('./WorkspaceAgentsPanel');
const { useAgentStore } = await import('../../stores/agent.store');
const { useWorkspaceStore } = await import('../../stores/workspace.store');

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

const DEF: AgentDefinition = {
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
};

const ASSIGNMENT: AgentAssignment = {
  instanceId: 'inst-1',
  workspaceId: 'ws-1',
  agentDefinitionId: 'def-1',
  botMatrixUserId: '@bot:server',
  enabled: true,
  createdAt: '',
  role: 'standalone',
  parentInstanceId: null,
  hasApiKeyOverride: false,
};

// store action 桩
const loadAssignmentsMock = vi.fn();
const syncRunningStatesMock = vi.fn();

beforeEach(() => {
  dialogMock.mockReset();
  loadAssignmentsMock.mockReset();
  syncRunningStatesMock.mockReset();

  loadAssignmentsMock.mockResolvedValue(undefined);
  syncRunningStatesMock.mockResolvedValue(undefined);

  useWorkspaceStore.setState({
    workspaces: [WS],
    activeWorkspaceId: 'ws-1',
    loading: false,
    error: null,
  });

  useAgentStore.setState({
    definitions: [DEF],
    assignments: [ASSIGNMENT],
    running: {},
    builtinSuggestions: {},
    loading: false,
    error: null,
    loadDefinitions: vi.fn(),
    loadAssignments: loadAssignmentsMock,
    loadBuiltinSuggestions: vi.fn(),
    syncRunningStates: syncRunningStatesMock,
    addAgent: vi.fn(),
    assignMainAgent: vi.fn(),
    deleteDefinition: vi.fn(),
    updateAssignmentRole: vi.fn(),
    updateAssignmentApiKey: vi.fn(),
    getAssignmentDeltas: vi.fn(),
    setAssignmentDeltas: vi.fn(),
    stopAgent: vi.fn(),
    startAgent: vi.fn(),
    reset: vi.fn(),
  });
});

describe('WorkspaceAgentsPanel — 「⚙ 调整能力」按钮', () => {
  it('每个 assignment 行渲染「⚙ 调整能力」按钮', async () => {
    render(<WorkspaceAgentsPanel />);
    // 等待 useEffect 触发的 loadAssignments 完成
    await waitFor(() => {
      expect(loadAssignmentsMock).toHaveBeenCalledWith('ws-1');
    });
    expect(screen.getByText('⚙ 调整能力')).toBeInTheDocument();
  });

  it('点击「⚙ 调整能力」→ 渲染 AssignmentCapabilitiesDialog，传入 assignment + def', async () => {
    render(<WorkspaceAgentsPanel />);
    await waitFor(() => {
      expect(loadAssignmentsMock).toHaveBeenCalledWith('ws-1');
    });
    fireEvent.click(screen.getByText('⚙ 调整能力'));

    await waitFor(() => {
      expect(dialogMock).toHaveBeenCalledTimes(1);
    });
    const props = dialogMock.mock.calls[0]![0];
    expect(props.assignment.instanceId).toBe('inst-1');
    expect(props.def.id).toBe('def-1');
    expect(props.def.name).toBe('测试 agent');
    // 占位组件渲染出来
    expect(screen.getByTestId('caps-dialog')).toBeInTheDocument();
    expect(screen.getByText('能力覆盖：测试 agent')).toBeInTheDocument();
  });

  it('Dialog onClose → 清空 state（弹窗消失）+ 刷新 assignments 列表', async () => {
    render(<WorkspaceAgentsPanel />);
    await waitFor(() => {
      expect(loadAssignmentsMock).toHaveBeenCalledWith('ws-1');
    });
    // 初始 mount 已调用一次 loadAssignments（useEffect 触发）
    loadAssignmentsMock.mockClear();

    fireEvent.click(screen.getByText('⚙ 调整能力'));
    await waitFor(() => {
      expect(screen.getByTestId('caps-dialog')).toBeInTheDocument();
    });

    // 触发 dialog 的 onClose
    fireEvent.click(screen.getByText('close-dialog'));

    // 弹窗消失
    await waitFor(() => {
      expect(screen.queryByTestId('caps-dialog')).not.toBeInTheDocument();
    });
    // assignments 列表刷新
    await waitFor(() => {
      expect(loadAssignmentsMock).toHaveBeenCalledWith('ws-1');
    });
  });
});
